import { randomBytes } from 'node:crypto';
import { pool } from './db.js';
import { queueEmail } from './outbox.js';

export async function promoteWaitlist(runId:number){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(7341,$1)',[runId]);
  const {rows:[entry]}=await client.query(`SELECT w.*,ss.waitlist_offer_minutes
    FROM waitlist_entries w CROSS JOIN system_settings ss
    JOIN service_runs sr ON sr.id=w.run_id
    WHERE w.run_id=$1 AND w.status='waiting' AND sr.departure_at>now() AND sr.status='open'
    ORDER BY w.joined_at,w.id FOR UPDATE OF w SKIP LOCKED LIMIT 1`,[runId]);
  if(!entry){await client.query('COMMIT');return false;}
  const {rows:[seat]}=await client.query(`SELECT s.id FROM seats s JOIN coaches c ON c.id=s.coach_id
    WHERE c.run_id=$1 AND c.class_name=$2 AND c.reserved AND s.active
    AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.run_id=$1 AND b.seat_id=s.id
      AND b.status IN('held','confirmed') AND b.segment && $3::int4range)
    ORDER BY c.display_order,s.row_number,s.column_number LIMIT 1`,[runId,entry.class_name,entry.segment]);
  if(!seat){await client.query('COMMIT');return false;}
  const expires=new Date(Date.now()+entry.waitlist_offer_minutes*60_000);
  const reference=`HOLD-${randomBytes(4).toString('hex').toUpperCase()}`;
  const {rows:[hold]}=await client.query(`INSERT INTO bookings(reference,run_id,seat_id,origin_station_id,destination_station_id,segment,
    clerk_user_id,passenger_name,passenger_email,fare_lkr,status,waitlist_entry_id,offer_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'held',$11,$12) RETURNING id`,
    [reference,runId,seat.id,entry.origin_station_id,entry.destination_station_id,entry.segment,entry.clerk_user_id,entry.passenger_name,entry.passenger_email,entry.quoted_fare_lkr,entry.id,expires]);
  await client.query(`UPDATE waitlist_entries SET status='offered',offered_at=now(),offer_expires_at=$2,converted_booking_id=$3 WHERE id=$1`,[entry.id,expires,hold.id]);
  await queueEmail(client,'waitlist_offer',entry.passenger_email,{name:entry.passenger_name,reference,expiresAt:expires.toISOString(),waitlistId:entry.id});
  await client.query('COMMIT'); return true;
 }catch(error){await client.query('ROLLBACK');console.error('waitlist promotion failed',error);return false}finally{client.release()}
}
