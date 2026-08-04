import cors from 'cors';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pool, query } from './db.js';

const app = express();
app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' }));
app.use(express.json({ limit: '32kb' }));

app.get('/health', async (_req, res) => {
  await query('SELECT 1');
  res.json({ status: 'ok' });
});

app.get('/api/runs', async (_req, res) => {
  const { rows } = await query(`SELECT sr.id::int AS id, sr.service_code AS "serviceCode", sr.departure_at AS "departureAt",
    r.name AS "routeName" FROM service_runs sr JOIN routes r ON r.id=sr.route_id ORDER BY departure_at`);
  res.json(rows);
});

app.get('/api/runs/:runId/stations', async (req, res) => {
  const { rows } = await query(`SELECT s.id::int AS id, s.code, s.name, rs.position
    FROM service_runs sr JOIN route_stations rs ON rs.route_id=sr.route_id
    JOIN stations s ON s.id=rs.station_id WHERE sr.id=$1 ORDER BY rs.position`, [req.params.runId]);
  res.json(rows);
});

const legSchema = z.object({
  runId: z.coerce.number().int().positive(),
  originId: z.coerce.number().int().positive(),
  destinationId: z.coerce.number().int().positive()
});

app.get('/api/availability', async (req, res) => {
  const parsed = legSchema.safeParse(req.query);
  if (!parsed.success) return res.status(422).json({ code: 'INVALID_LEG', issues: parsed.error.issues });
  const { runId, originId, destinationId } = parsed.data;
  const { rows } = await query(`WITH leg AS (
      SELECT ro.position origin_pos, rd.position destination_pos
      FROM service_runs sr
      JOIN route_stations ro ON ro.route_id=sr.route_id AND ro.station_id=$2
      JOIN route_stations rd ON rd.route_id=sr.route_id AND rd.station_id=$3
      WHERE sr.id=$1 AND ro.position < rd.position
    )
    SELECT s.id::int AS id, s.seat_number AS "seatNumber", s.row_number AS "rowNumber", s.column_number AS "columnNumber",
      c.coach_code AS "coachCode", c.class_name AS "className",
      round((SELECT sum(rs.distance_km) FROM route_stations rs JOIN service_runs sr ON sr.route_id=rs.route_id
        WHERE sr.id=$1 AND rs.position >= leg.origin_pos AND rs.position < leg.destination_pos) * c.rate_per_km_cents)::int AS "fareCents",
      NOT EXISTS (SELECT 1 FROM bookings b WHERE b.run_id=$1 AND b.seat_id=s.id AND b.status='confirmed'
        AND b.segment && int4range(leg.origin_pos, leg.destination_pos, '[)')) AS available
    FROM seats s JOIN coaches c ON c.id=s.coach_id CROSS JOIN leg
    WHERE c.run_id=$1 AND c.reserved ORDER BY c.coach_code,s.row_number,s.column_number`, [runId, originId, destinationId]);
  if (!rows.length) return res.status(422).json({ code: 'INVALID_LEG', message: 'Origin must precede destination on this route.' });
  res.json(rows);
});

const bookingSchema = z.object({
  runId: z.number().int().positive(), seatId: z.number().int().positive(),
  originId: z.number().int().positive(), destinationId: z.number().int().positive(),
  passengerName: z.string().trim().min(2).max(120), passengerEmail: z.string().email().max(254)
});

app.post('/api/bookings', async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ code: 'INVALID_BOOKING', issues: parsed.error.issues });
  const b = parsed.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const calculation = await client.query(`SELECT ro.position origin_pos, rd.position destination_pos, r.currency,
      round(sum(rs.distance_km) * c.rate_per_km_cents)::int fare_cents
      FROM service_runs sr JOIN routes r ON r.id=sr.route_id
      JOIN route_stations ro ON ro.route_id=r.id AND ro.station_id=$2
      JOIN route_stations rd ON rd.route_id=r.id AND rd.station_id=$3
      JOIN route_stations rs ON rs.route_id=r.id AND rs.position>=ro.position AND rs.position<rd.position
      JOIN seats s ON s.id=$4 JOIN coaches c ON c.id=s.coach_id AND c.run_id=sr.id AND c.reserved
      WHERE sr.id=$1 AND ro.position<rd.position
      GROUP BY ro.position,rd.position,r.currency,c.rate_per_km_cents`, [b.runId,b.originId,b.destinationId,b.seatId]);
    if (!calculation.rowCount) { await client.query('ROLLBACK'); return res.status(422).json({ code: 'INVALID_LEG_OR_SEAT' }); }
    const x = calculation.rows[0];
    const reference = `SLR-${randomBytes(4).toString('hex').toUpperCase()}`;
    const saved = await client.query(`INSERT INTO bookings
      (reference,run_id,seat_id,origin_station_id,destination_station_id,segment,passenger_name,passenger_email,fare_cents,currency)
      VALUES ($1,$2,$3,$4,$5,int4range($6,$7,'[)'),$8,$9,$10,$11)
      RETURNING reference,fare_cents AS "fareCents",currency,status,created_at AS "createdAt"`,
      [reference,b.runId,b.seatId,b.originId,b.destinationId,x.origin_pos,x.destination_pos,b.passengerName,b.passengerEmail.toLowerCase(),x.fare_cents,x.currency]);
    await client.query('COMMIT');
    res.status(201).json(saved.rows[0]);
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error?.constraint === 'no_overlapping_confirmed_bookings')
      return res.status(409).json({ code: 'SEAT_CONFLICT', message: 'This seat was just booked for part of your journey.' });
    console.error(error);
    res.status(500).json({ code: 'INTERNAL_ERROR' });
  } finally { client.release(); }
});

app.get('/api/bookings/:reference', async (req, res) => {
  const { rows } = await query(`SELECT b.reference,b.passenger_name AS "passengerName",b.fare_cents AS "fareCents",b.currency,b.status,
    o.name AS origin,d.name AS destination,c.coach_code AS "coachCode",s.seat_number AS "seatNumber",sr.departure_at AS "departureAt"
    FROM bookings b JOIN stations o ON o.id=b.origin_station_id JOIN stations d ON d.id=b.destination_station_id
    JOIN seats s ON s.id=b.seat_id JOIN coaches c ON c.id=s.coach_id JOIN service_runs sr ON sr.id=b.run_id
    WHERE b.reference=$1`, [req.params.reference]);
  if (!rows[0]) return res.status(404).json({ code: 'NOT_FOUND' });
  res.json(rows[0]);
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error); res.status(500).json({ code: 'INTERNAL_ERROR' });
});

const port = Number(process.env.API_PORT ?? 4000);
app.listen(port, '0.0.0.0', () => console.log(`API listening on ${port}`));
