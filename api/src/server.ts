import 'dotenv/config';
import { clerkMiddleware, getAuth } from '@clerk/express';
import cors from 'cors';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pool, query } from './db.js';
import { identity, requirePermission, requireUser } from './auth.js';
import { queueEmail } from './outbox.js';
import { promoteWaitlist } from './waitlist.js';

const app = express();

app.get('/health', async (_q, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (error) {
    console.error(error);
    res.status(503).json({ status: 'unavailable', code: 'DATABASE_UNAVAILABLE' });
  }
});

app.use(
  clerkMiddleware({
    authorizedParties: (
      process.env.CLERK_AUTHORIZED_PARTIES ?? 'http://localhost:5173'
    ).split(','),
  })
);
app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' }));
app.use(express.json({ limit: '64kb' }));

const leg = z.object({
  runId: z.coerce.number().int().positive(),
  originId: z.coerce.number().int().positive(),
  destinationId: z.coerce.number().int().positive(),
});

const fail = (
  res: express.Response,
  status: number,
  code: string,
  message: string
) => res.status(status).json({ code, message });

app.get('/api/runs', async (_q, res) => {
  const { rows } = await query(`
    SELECT sr.id::int id, sr.service_code "serviceCode", sr.departure_at "departureAt", sr.status, r.name "routeName"
    FROM service_runs sr 
    JOIN routes r ON r.id = sr.route_id 
    WHERE sr.departure_at > now() AND sr.status = 'open' 
    ORDER BY sr.departure_at
  `);
  res.json(rows);
});

app.get('/api/runs/:id/stations', async (req, res) => {
  const { rows } = await query(
    `
    SELECT s.id::int id, s.code, s.name, rs.position 
    FROM service_runs sr
    JOIN route_stations rs ON rs.route_id = sr.route_id 
    JOIN stations s ON s.id = rs.station_id 
    WHERE sr.id = $1 
    ORDER BY rs.position
  `,
    [req.params.id]
  );
  res.json(rows);
});

app.get('/api/availability', async (req, res) => {
  const p = leg.safeParse(req.query);
  if (!p.success)
    return fail(res, 422, 'INVALID_LEG', 'Choose a valid origin and destination.');
  
  const x = p.data;

  const { rows } = await query(
    `
    WITH leg AS(
      SELECT ro.position a, rd.position b 
      FROM service_runs sr
      JOIN route_stations ro ON ro.route_id = sr.route_id AND ro.station_id = $2 
      JOIN route_stations rd ON rd.route_id = sr.route_id AND rd.station_id = $3
      WHERE sr.id = $1 AND sr.status = 'open' AND sr.departure_at > now() AND ro.position < rd.position
    )
    SELECT s.id::int id, s.seat_number "seatNumber", s.row_number "rowNumber", s.column_number "columnNumber", s.accessible,
           c.coach_code "coachCode", c.class_name "className", 
           round((
             SELECT sum(rs.distance_to_next_km) 
             FROM route_stations rs 
             JOIN service_runs sr ON sr.route_id = rs.route_id
             WHERE sr.id = $1 AND rs.position >= leg.a AND rs.position < leg.b
           ) * c.rate_per_km_lkr)::int "fareLkr",
           NOT EXISTS(
             SELECT 1 FROM bookings b 
             WHERE b.run_id = $1 AND b.seat_id = s.id AND b.status IN('held','confirmed') AND b.segment && int4range(leg.a, leg.b, '[)')
           ) available
    FROM seats s 
    JOIN coaches c ON c.id = s.coach_id 
    CROSS JOIN leg 
    WHERE c.run_id = $1 AND c.reserved AND s.active 
    ORDER BY c.display_order, s.row_number, s.column_number
  `,
    [x.runId, x.originId, x.destinationId]
  );

  if (!rows.length) {
    return fail(
      res,
      422,
      'INVALID_LEG',
      'Origin must come before destination on an open service.'
    );
  }
  
  res.json(rows);
});

const bookingInput = z.object({
  runId: z.number().int().positive(),
  seatId: z.number().int().positive(),
  originId: z.number().int().positive(),
  destinationId: z.number().int().positive(),
});

app.post('/api/bookings', requireUser, async (req, res) => {
  const p = bookingInput.safeParse(req.body);
  if (!p.success) {
    return fail(res, 422, 'INVALID_BOOKING', 'Check your journey and seat selection.');
  }
  
  const b = p.data;
  const who = await identity(req);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    
    const {
      rows: [x],
    } = await client.query(
      `
      SELECT ro.position a, rd.position b, r.currency, round(sum(rs.distance_to_next_km) * c.rate_per_km_lkr)::int fare
      FROM service_runs sr 
      JOIN routes r ON r.id = sr.route_id 
      JOIN route_stations ro ON ro.route_id = r.id AND ro.station_id = $2
      JOIN route_stations rd ON rd.route_id = r.id AND rd.station_id = $3 
      JOIN route_stations rs ON rs.route_id = r.id AND rs.position >= ro.position AND rs.position < rd.position
      JOIN seats s ON s.id = $4 AND s.active 
      JOIN coaches c ON c.id = s.coach_id AND c.run_id = sr.id AND c.reserved
      WHERE sr.id = $1 AND sr.status = 'open' AND sr.departure_at > now() AND ro.position < rd.position 
      GROUP BY ro.position, rd.position, r.currency, c.rate_per_km_lkr
    `,
      [b.runId, b.originId, b.destinationId, b.seatId]
    );

    if (!x) {
      await client.query('ROLLBACK');
      return fail(res, 422, 'INVALID_LEG_OR_SEAT', 'This journey or seat is no longer bookable.');
    }

    const reference = `SLR-${randomBytes(4).toString('hex').toUpperCase()}`;
    
    const {
      rows: [saved],
    } = await client.query(
      `
      INSERT INTO bookings(reference, run_id, seat_id, origin_station_id, destination_station_id, segment, clerk_user_id, passenger_name, passenger_email, fare_lkr, currency)
      VALUES($1, $2, $3, $4, $5, int4range($6, $7, '[)'), $8, $9, $10, $11, $12) 
      RETURNING id, reference, fare_lkr "fareLkr", currency, status, qr_token "qrToken", created_at "createdAt"
    `,
      [
        reference,
        b.runId,
        b.seatId,
        b.originId,
        b.destinationId,
        x.a,
        x.b,
        who.userId,
        who.name,
        who.email,
        x.fare,
        x.currency,
      ]
    );

    await queueEmail(client, 'booking_confirmed', who.email, {
      name: who.name,
      reference,
      bookingId: saved.id,
      qrToken: saved.qrToken,
    });
    
    await client.query('COMMIT');
    res.status(201).json({ ...saved, emailStatus: 'queued' });
  } catch (e: any) {
    await client.query('ROLLBACK');
    if (e?.constraint === 'no_overlapping_active_allocations') {
      return fail(
        res,
        409,
        'SEAT_CONFLICT',
        'That seat was booked while you were confirming. Choose another seat or join the waitlist.'
      );
    }
    console.error(e);
    fail(res, 500, 'BOOKING_FAILED', 'We could not complete the booking. No booking was created.');
  } finally {
    client.release();
  }
});

app.get('/api/me/bookings', requireUser, async (req, res) => {
  const { userId } = getAuth(req);
  const { rows } = await query(
    `
    SELECT b.id, b.reference, b.status, b.fare_lkr "fareLkr", b.currency, b.offer_expires_at "offerExpiresAt", b.created_at "createdAt",
           o.name origin, d.name destination, c.coach_code "coachCode", s.seat_number "seatNumber", sr.service_code "serviceCode", sr.departure_at "departureAt"
    FROM bookings b 
    JOIN stations o ON o.id = b.origin_station_id 
    JOIN stations d ON d.id = b.destination_station_id 
    JOIN seats s ON s.id = b.seat_id
    JOIN coaches c ON c.id = s.coach_id 
    JOIN service_runs sr ON sr.id = b.run_id 
    WHERE b.clerk_user_id = $1 
    ORDER BY b.created_at DESC
  `,
    [userId]
  );
  res.json(rows);
});

app.get('/api/tickets/verify/:token', requirePermission('org:rail:view'), async (req, res) => {
  const {
    rows: [x],
  } = await query(
    `
    SELECT b.reference, b.status, b.passenger_name "passengerName", b.fare_lkr "fareLkr", b.currency, o.name origin, d.name destination, c.coach_code "coachCode", s.seat_number "seatNumber", sr.service_code "serviceCode", sr.departure_at "departureAt"
    FROM bookings b 
    JOIN stations o ON o.id = b.origin_station_id 
    JOIN stations d ON d.id = b.destination_station_id 
    JOIN seats s ON s.id = b.seat_id 
    JOIN coaches c ON c.id = s.coach_id 
    JOIN service_runs sr ON sr.id = b.run_id 
    WHERE b.qr_token = $1
  `,
    [req.params.token]
  );
  
  if (!x) return fail(res, 404, 'TICKET_NOT_FOUND', 'This QR code does not match a ticket.');
  res.json(x);
});

app.post('/api/me/bookings/:reference/cancel', requireUser, async (req, res) => {
  const { userId } = getAuth(req);
  const client = await pool.connect();
  let runId: number | undefined;

  try {
    await client.query('BEGIN');
    
    const {
      rows: [b],
    } = await client.query(
      `
      SELECT b.*, sr.departure_at 
      FROM bookings b 
      JOIN service_runs sr ON sr.id = b.run_id 
      WHERE b.reference = $1 FOR UPDATE OF b
    `,
      [req.params.reference]
    );

    if (!b || b.clerk_user_id !== userId) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'BOOKING_NOT_FOUND', 'No booking was found for your account.');
    }

    if (b.status === 'cancelled') {
      await client.query('COMMIT');
      return res.json({ reference: b.reference, status: 'cancelled' });
    }
    
    if (b.status !== 'confirmed') {
      await client.query('ROLLBACK');
      return fail(res, 409, 'NOT_CANCELLABLE', 'This booking cannot be cancelled.');
    }

    if (new Date(b.departure_at) <= new Date()) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'TRAIN_DEPARTED', 'This service has already departed.');
    }

    await client.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
      [b.id]
    );
    
    await queueEmail(client, 'booking_cancelled', b.passenger_email, {
      name: b.passenger_name,
      reference: b.reference,
    });
    
    runId = Number(b.run_id);
    await client.query('COMMIT');
    res.json({ reference: b.reference, status: 'cancelled' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    fail(res, 500, 'CANCELLATION_FAILED', 'Cancellation could not be completed. Please try again.');
  } finally {
    client.release();
    if (runId) void promoteWaitlist(runId);
  }
});

const waitInput = z.object({
  runId: z.number().int().positive(),
  originId: z.number().int().positive(),
  destinationId: z.number().int().positive(),
  className: z.string().min(1).max(80),
});

app.post('/api/waitlist', requireUser, async (req, res) => {
  const p = waitInput.safeParse(req.body);
  if (!p.success) {
    return fail(res, 422, 'INVALID_WAITLIST', 'Check the journey and travel class.');
  }
  
  const w = p.data;
  const who = await identity(req);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    
    const {
      rows: [x],
    } = await client.query(
      `
      SELECT ro.position a, rd.position b, round(
        (SELECT sum(rs.distance_to_next_km) FROM route_stations rs WHERE rs.route_id = sr.route_id AND rs.position >= ro.position AND rs.position < rd.position) *
        (SELECT min(c.rate_per_km_lkr) FROM coaches c WHERE c.run_id = sr.id AND c.class_name = $4 AND c.reserved)
      )::int fare
      FROM service_runs sr 
      JOIN route_stations ro ON ro.route_id = sr.route_id AND ro.station_id = $2 
      JOIN route_stations rd ON rd.route_id = sr.route_id AND rd.station_id = $3
      WHERE sr.id = $1 AND sr.status = 'open' AND sr.departure_at > now() AND ro.position < rd.position
    `,
      [w.runId, w.originId, w.destinationId, w.className]
    );

    if (!x || x.fare == null) {
      await client.query('ROLLBACK');
      return fail(res, 422, 'INVALID_WAITLIST', 'This service and class cannot be waitlisted.');
    }

    const available = await client.query(
      `
      SELECT 1 FROM seats s 
      JOIN coaches c ON c.id = s.coach_id 
      WHERE c.run_id = $1 AND c.class_name = $2 AND c.reserved AND s.active
      AND NOT EXISTS(
        SELECT 1 FROM bookings b 
        WHERE b.run_id = $1 AND b.seat_id = s.id AND b.status IN('held','confirmed') AND b.segment && int4range($3, $4, '[)')
      ) LIMIT 1
    `,
      [w.runId, w.className, x.a, x.b]
    );

    if (available.rowCount) {
      await client.query('ROLLBACK');
      return fail(
        res,
        409,
        'SEATS_AVAILABLE',
        'Seats are currently available in this class. Choose a seat instead.'
      );
    }

    const {
      rows: [saved],
    } = await client.query(
      `
      INSERT INTO waitlist_entries(run_id, clerk_user_id, passenger_name, passenger_email, origin_station_id, destination_station_id, segment, class_name, quoted_fare_lkr)
      VALUES($1, $2, $3, $4, $5, $6, int4range($7, $8, '[)'), $9, $10) 
      RETURNING id, status, joined_at "joinedAt"
    `,
      [
        w.runId,
        who.userId,
        who.name,
        who.email,
        w.originId,
        w.destinationId,
        x.a,
        x.b,
        w.className,
        x.fare,
      ]
    );

    await queueEmail(client, 'waitlist_joined', who.email, {
      name: who.name,
      waitlistId: saved.id,
    });
    
    await client.query('COMMIT');
    res.status(201).json(saved);
  } catch (e: any) {
    await client.query('ROLLBACK');
    if (e?.code === '23505')
      return fail(res, 409, 'ALREADY_WAITLISTED', 'You are already on this waitlist.');
    console.error(e);
    fail(res, 500, 'WAITLIST_FAILED', 'We could not add you to the waitlist.');
  } finally {
    client.release();
  }
});

app.get('/api/me/waitlist', requireUser, async (req, res) => {
  const { userId } = getAuth(req);
  const { rows } = await query(
    `
    SELECT w.id, w.status, w.class_name "className", w.quoted_fare_lkr "quotedFareLkr", w.joined_at "joinedAt", w.offer_expires_at "offerExpiresAt", b.reference,
           o.name origin, d.name destination, sr.service_code "serviceCode", sr.departure_at "departureAt" 
    FROM waitlist_entries w 
    JOIN service_runs sr ON sr.id = w.run_id
    JOIN stations o ON o.id = w.origin_station_id 
    JOIN stations d ON d.id = w.destination_station_id 
    LEFT JOIN bookings b ON b.waitlist_entry_id = w.id
    WHERE w.clerk_user_id = $1 
    ORDER BY w.joined_at DESC
  `,
    [userId]
  );
  res.json(rows);
});

app.post('/api/me/waitlist/:id/leave', requireUser, async (req, res) => {
  const { userId } = getAuth(req);
  const client = await pool.connect();
  let runId: number | undefined;
  
  try {
    await client.query('BEGIN');
    
    const {
      rows: [w],
    } = await client.query(
      `SELECT * FROM waitlist_entries WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    
    if (!w || w.clerk_user_id !== userId) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'WAITLIST_NOT_FOUND', 'No waitlist entry was found for your account.');
    }
    
    if (!['waiting', 'offered'].includes(w.status)) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'WAITLIST_CLOSED', 'This waitlist entry can no longer be changed.');
    }
    
    await client.query(`UPDATE waitlist_entries SET status = 'cancelled' WHERE id = $1`, [w.id]);
    await client.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE waitlist_entry_id = $1 AND status = 'held'`,
      [w.id]
    );
    
    runId = Number(w.run_id);
    await client.query('COMMIT');
    res.json({ id: w.id, status: 'cancelled' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    fail(res, 500, 'WAITLIST_LEAVE_FAILED', 'We could not remove you from the waitlist.');
  } finally {
    client.release();
    if (runId) void promoteWaitlist(runId);
  }
});

app.post('/api/me/waitlist/:id/accept', requireUser, async (req, res) => {
  const { userId } = getAuth(req);
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const {
      rows: [w],
    } = await client.query(
      `
      SELECT w.*, b.id booking_id, b.reference, b.passenger_email, b.passenger_name 
      FROM waitlist_entries w 
      JOIN bookings b ON b.waitlist_entry_id = w.id 
      WHERE w.id = $1 FOR UPDATE OF w, b
    `,
      [req.params.id]
    );

    if (!w || w.clerk_user_id !== userId) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'OFFER_NOT_FOUND', 'No waitlist offer was found.');
    }
    
    if (w.status !== 'offered' || new Date(w.offer_expires_at) <= new Date()) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'OFFER_EXPIRED', 'This offer has expired.');
    }

    await client.query(
      `UPDATE bookings SET status = 'confirmed', offer_expires_at = NULL WHERE id = $1`,
      [w.booking_id]
    );
    await client.query(`UPDATE waitlist_entries SET status = 'converted' WHERE id = $1`, [w.id]);
    
    const {
      rows: [ticket],
    } = await client.query(`SELECT qr_token "qrToken" FROM bookings WHERE id = $1`, [w.booking_id]);
    
    await queueEmail(client, 'booking_confirmed', w.passenger_email, {
      name: w.passenger_name,
      reference: w.reference,
      bookingId: w.booking_id,
      qrToken: ticket.qrToken,
    });
    
    await client.query('COMMIT');
    res.json({ reference: w.reference, status: 'confirmed' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    fail(res, 500, 'OFFER_ACCEPT_FAILED', 'The offer could not be accepted.');
  } finally {
    client.release();
  }
});

const viewer = requirePermission('org:rail:view');
const admin = requirePermission('org:rail:admin');

app.get('/api/admin/summary', viewer, async (_q, res) => {
  const {
    rows: [x],
  } = await query(`
    SELECT 
      (SELECT count(*) FROM service_runs WHERE departure_at::date = current_date)::int "runsToday",
      (SELECT count(*) FROM bookings WHERE status = 'confirmed')::int bookings,
      (SELECT coalesce(sum(fare_lkr), 0) FROM bookings WHERE status = 'confirmed')::int "revenueLkr",
      (SELECT count(*) FROM waitlist_entries WHERE status IN('waiting', 'offered'))::int waitlisted
  `);
  res.json(x);
});

app.get('/api/admin/templates', viewer, async (_q, res) => {
  const { rows } = await query(`
    SELECT t.id::int, t.name, t.active, coalesce(json_agg(
             json_build_object(
               'id', c.id::int, 'coachCode', c.coach_code, 'className', c.class_name,
               'reserved', c.reserved, 'ratePerKmLkr', c.rate_per_km_lkr, 'displayOrder', c.display_order
             )
           ) FILTER(WHERE c.id IS NOT NULL), '[]') coaches
    FROM train_templates t 
    LEFT JOIN coach_templates c ON c.train_template_id = t.id 
    GROUP BY t.id 
    ORDER BY t.name
  `);
  res.json(rows);
});

app.post('/api/admin/templates', admin, async (req, res) => {
  const p = z.object({ name: z.string().trim().min(2).max(120) }).safeParse(req.body);
  if (!p.success) return fail(res, 422, 'INVALID_TEMPLATE', 'Enter a template name.');
  
  const { userId } = getAuth(req);
  
  const {
    rows: [x],
  } = await query(`INSERT INTO train_templates(name) VALUES($1) RETURNING id::int, name, active`, [
    p.data.name,
  ]);
  
  await query(
    `INSERT INTO audit_events(actor_clerk_user_id, action, entity_type, entity_id, after_data) VALUES($1, 'create', 'train_template', $2, $3)`,
    [userId, String(x.id), x]
  );
  
  res.status(201).json(x);
});

app.post('/api/admin/templates/:id/coaches', admin, async (req, res) => {
  const p = z
    .object({
      coachCode: z.string().trim().min(1).max(20),
      className: z.string().trim().min(2).max(80),
      reserved: z.boolean(),
      ratePerKmLkr: z.number().nonnegative(),
      displayOrder: z.number().int().positive(),
    })
    .safeParse(req.body);
    
  if (!p.success) return fail(res, 422, 'INVALID_COACH', 'Check the coach configuration.');
  
  const x = p.data;
  const { userId } = getAuth(req);
  
  const {
    rows: [saved],
  } = await query(
    `
    INSERT INTO coach_templates(train_template_id, coach_code, class_name, reserved, rate_per_km_lkr, display_order) 
    VALUES($1, $2, $3, $4, $5, $6) 
    RETURNING id::int
  `,
    [req.params.id, x.coachCode, x.className, x.reserved, x.ratePerKmLkr, x.displayOrder]
  );
  
  await query(
    `INSERT INTO audit_events(actor_clerk_user_id, action, entity_type, entity_id, after_data) VALUES($1, 'create', 'coach_template', $2, $3)`,
    [userId, String(saved.id), x]
  );
  
  res.status(201).json(saved);
});

app.post('/api/admin/coaches/:id/seats/generate', admin, async (req, res) => {
  const p = z
    .object({
      rows: z.number().int().min(1).max(50),
      columns: z.number().int().min(1).max(8),
      startAt: z.number().int().min(1).default(1),
    })
    .safeParse(req.body);
    
  if (!p.success)
    return fail(res, 422, 'INVALID_LAYOUT', 'Rows must be 1–50 and columns 1–8.');
    
  const x = p.data;
  
  await query(
    `
    INSERT INTO seat_templates(coach_template_id, seat_number, row_number, column_number)
    SELECT $1, lpad(($4 + (r - 1) * $3 + c - 1)::text, 2, '0'), r, c 
    FROM generate_series(1, $2) r 
    CROSS JOIN generate_series(1, $3) c 
    ON CONFLICT DO NOTHING
  `,
    [req.params.id, x.rows, x.columns, x.startAt]
  );
  
  res.status(201).json({ generated: x.rows * x.columns });
});

app.get('/api/admin/routes', viewer, async (_q, res) => {
  const { rows } = await query(`SELECT id::int, name FROM routes ORDER BY name`);
  res.json(rows);
});

app.get('/api/admin/schedules', viewer, async (_q, res) => {
  const { rows } = await query(`
    SELECT s.id::int, s.service_code "serviceCode", s.departure_time "departureTime", s.operating_days "operatingDays", 
           s.active_from "activeFrom", s.active_until "activeUntil", s.active, r.name "routeName", t.name "templateName" 
    FROM service_schedules s 
    JOIN routes r ON r.id = s.route_id 
    JOIN train_templates t ON t.id = s.train_template_id 
    ORDER BY s.service_code
  `);
  res.json(rows);
});

app.post('/api/admin/schedules', admin, async (req, res) => {
  const p = z
    .object({
      routeId: z.number().int().positive(),
      trainTemplateId: z.number().int().positive(),
      serviceCode: z.string().trim().min(1).max(20),
      departureTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      operatingDays: z.array(z.number().int().min(1).max(7)).min(1),
      activeFrom: z.string().date(),
      activeUntil: z.string().date().nullable().optional(),
    })
    .safeParse(req.body);
    
  if (!p.success)
    return fail(res, 422, 'INVALID_SCHEDULE', 'Check the service code, time, dates, and operating days.');
    
  const x = p.data;
  const { userId } = getAuth(req);
  
  const {
    rows: [saved],
  } = await query(
    `
    INSERT INTO service_schedules(route_id, train_template_id, service_code, departure_time, operating_days, active_from, active_until) 
    VALUES($1, $2, $3, $4, $5, $6, $7) 
    RETURNING id::int
  `,
    [
      x.routeId,
      x.trainTemplateId,
      x.serviceCode,
      x.departureTime,
      x.operatingDays,
      x.activeFrom,
      x.activeUntil ?? null,
    ]
  );
  
  await query(
    `INSERT INTO audit_events(actor_clerk_user_id, action, entity_type, entity_id, after_data) VALUES($1, 'create', 'service_schedule', $2, $3)`,
    [userId, String(saved.id), x]
  );
  
  res.status(201).json(saved);
});

app.post('/api/admin/schedules/:id/generate-runs', admin, async (req, res) => {
  const p = z
    .object({
      from: z.string().date(),
      to: z.string().date(),
    })
    .safeParse(req.body);
    
  if (!p.success) return fail(res, 422, 'INVALID_DATE_RANGE', 'Choose valid start and end dates.');
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const generated = await client.query(
      `
      INSERT INTO service_runs(schedule_id, route_id, service_code, departure_at)
      SELECT s.id, s.route_id, s.service_code, (d::date + s.departure_time) AT TIME ZONE 'Asia/Colombo' 
      FROM service_schedules s 
      CROSS JOIN generate_series($2::date, $3::date, '1 day') d
      WHERE s.id = $1 AND s.active AND d::date >= s.active_from AND (s.active_until IS NULL OR d::date <= s.active_until) 
      AND extract(isodow FROM d)::int = ANY(s.operating_days)
      ON CONFLICT DO NOTHING 
      RETURNING id
    `,
      [req.params.id, p.data.from, p.data.to]
    );

    for (const row of generated.rows) {
      await client.query(
        `
        INSERT INTO coaches(run_id, source_template_id, coach_code, class_name, reserved, rate_per_km_lkr, display_order)
        SELECT $1, c.id, c.coach_code, c.class_name, c.reserved, c.rate_per_km_lkr, c.display_order 
        FROM service_schedules s 
        JOIN coach_templates c ON c.train_template_id = s.train_template_id 
        WHERE s.id = $2
      `,
        [row.id, req.params.id]
      );
      
      await client.query(
        `
        INSERT INTO seats(coach_id, source_template_id, seat_number, row_number, column_number, accessible, active)
        SELECT c.id, st.id, st.seat_number, st.row_number, st.column_number, st.accessible, st.active 
        FROM coaches c 
        JOIN seat_templates st ON st.coach_template_id = c.source_template_id 
        WHERE c.run_id = $1
      `,
        [row.id]
      );
    }
    
    await client.query('COMMIT');
    res.status(201).json({ generated: generated.rowCount });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    fail(res, 500, 'RUN_GENERATION_FAILED', 'Service runs could not be generated.');
  } finally {
    client.release();
  }
});

app.get('/api/admin/settings', viewer, async (_q, res) => {
  const {
    rows: [x],
  } = await query(`
    SELECT waitlist_offer_minutes "waitlistOfferMinutes", waitlist_retention_days "waitlistRetentionDays", updated_at "updatedAt" 
    FROM system_settings
  `);
  res.json(x);
});

app.patch('/api/admin/settings', admin, async (req, res) => {
  const p = z
    .object({ waitlistOfferMinutes: z.number().int().min(5).max(1440) })
    .safeParse(req.body);
    
  if (!p.success)
    return fail(res, 422, 'INVALID_SETTING', 'Offer time must be between 5 minutes and 24 hours.');
    
  const { userId } = getAuth(req);
  
  const {
    rows: [x],
  } = await query(
    `
    UPDATE system_settings 
    SET waitlist_offer_minutes = $1, updated_at = now(), updated_by = $2 
    RETURNING waitlist_offer_minutes "waitlistOfferMinutes"
  `,
    [p.data.waitlistOfferMinutes, userId]
  );
  
  res.json(x);
});

app.use((e: any, _q: express.Request, res: express.Response, _n: express.NextFunction) => {
  console.error(e);
  if (e?.code === '23505')
    return fail(res, 409, 'DUPLICATE_CONFIGURATION', 'A record with those identifying values already exists.');
  if (e?.code === '23503')
    return fail(res, 409, 'CONFIGURATION_IN_USE', 'This item is still used by another record and cannot be removed.');
  if (e?.status === 401)
    return fail(res, 401, 'SESSION_INVALID', 'Your session is no longer valid. Sign in again.');
    
  fail(res, 500, 'INTERNAL_ERROR', 'Something went wrong. No changes were applied. Please try again.');
});

app.listen(Number(process.env.API_PORT ?? 4000), '0.0.0.0', () =>
  console.log(`API listening on ${process.env.API_PORT ?? 4000}`)
);