import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';

const testEmail = 'concurrency-test@example.invalid';

async function fixture() {
  const { rows } = await pool.query(`SELECT sr.id run_id,s.id seat_id
    FROM service_runs sr JOIN coaches c ON c.run_id=sr.id
    JOIN seats s ON s.coach_id=c.id ORDER BY sr.id,s.id LIMIT 1`);
  if (!rows[0]) throw new Error('Run database seed before integration tests');
  return rows[0];
}

async function insert(runId:number, seatId:number, start:number, end:number) {
  return pool.query(`INSERT INTO bookings
    (reference,run_id,seat_id,origin_station_id,destination_station_id,segment,passenger_name,passenger_email,fare_cents,currency)
    SELECT $1,$2,$3,ro.station_id,rd.station_id,int4range($4,$5,'[)'),'Test Passenger',$6,1000,r.currency
    FROM service_runs sr JOIN routes r ON r.id=sr.route_id
    JOIN route_stations ro ON ro.route_id=r.id AND ro.position=$4
    JOIN route_stations rd ON rd.route_id=r.id AND rd.position=$5
    WHERE sr.id=$2`, [`TEST-${randomUUID()}`,runId,seatId,start,end,testEmail]);
}

describe('database booking invariant', () => {
  it('commits exactly one of simultaneous overlapping bookings', async () => {
    const f=await fixture();
    await pool.query('DELETE FROM bookings WHERE passenger_email=$1',[testEmail]);
    const outcomes=await Promise.allSettled([insert(f.run_id,f.seat_id,0,5),insert(f.run_id,f.seat_id,3,8)]);
    expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    const rejected=outcomes.find(x=>x.status==='rejected') as PromiseRejectedResult;
    expect(rejected.reason.constraint).toBe('no_overlapping_confirmed_bookings');
  });

  it('allows adjacent legs on the same physical seat', async () => {
    const f=await fixture();
    await pool.query('DELETE FROM bookings WHERE passenger_email=$1',[testEmail]);
    await expect(Promise.all([insert(f.run_id,f.seat_id,0,4),insert(f.run_id,f.seat_id,4,8)])).resolves.toHaveLength(2);
  });
});

afterAll(async()=>{await pool.query('DELETE FROM bookings WHERE passenger_email=$1',[testEmail]);await pool.end()});
