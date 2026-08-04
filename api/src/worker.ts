import 'dotenv/config';
import QRCode from 'qrcode';
import { Resend } from 'resend';
import { pool } from './db.js';
import { promoteWaitlist } from './waitlist.js';

const resend=process.env.RESEND_API_KEY?new Resend(process.env.RESEND_API_KEY):null;
const appUrl=process.env.PUBLIC_APP_URL??'http://localhost:5173';

async function expireAndPromote(){
 const client=await pool.connect();const runIds=new Set<number>();
 try{await client.query('BEGIN');
  const expired=await client.query(`UPDATE bookings SET status='expired' WHERE status='held' AND offer_expires_at<=now() RETURNING run_id,waitlist_entry_id`);
  for(const row of expired.rows){runIds.add(Number(row.run_id));await client.query(`UPDATE waitlist_entries SET status='expired' WHERE id=$1 AND status='offered'`,[row.waitlist_entry_id]);}
  const departed=await client.query(`UPDATE service_runs SET status='departed' WHERE status IN('open','closed') AND departure_at<=now() RETURNING id`);
  for(const row of departed.rows){runIds.add(Number(row.id));await client.query(`UPDATE bookings SET status='expired' WHERE run_id=$1 AND status='held'`,[row.id]);await client.query(`UPDATE waitlist_entries SET status='expired' WHERE run_id=$1 AND status IN('waiting','offered')`,[row.id]);}
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');console.error(e)}finally{client.release()}
 const waiting=await pool.query(`SELECT DISTINCT run_id FROM waitlist_entries WHERE status='waiting'`);for(const x of waiting.rows)runIds.add(Number(x.run_id));
 for(const id of runIds)await promoteWaitlist(id);
}

function emailBody(event:string,p:any,qr?:string){
 const title:{[k:string]:string}={booking_confirmed:'Your train booking is confirmed',booking_cancelled:'Your booking was cancelled',waitlist_joined:'You joined the waitlist',waitlist_offer:'A seat is available for you'};
 return `<div style="font-family:Arial;max-width:560px;margin:auto;color:#17322c"><h1>${title[event]??'Udarata Rail update'}</h1><p>Hello ${p.name??'traveller'},</p>
 ${p.reference?`<p>Your reference is <strong>${p.reference}</strong>.</p>`:''}${p.expiresAt?`<p>This offer expires at <strong>${new Date(p.expiresAt).toLocaleString()}</strong>.</p>`:''}
 ${event==='waitlist_offer'?`<p><a href="${appUrl}/account">Sign in to accept your offer</a></p>`:''}
 ${qr?`<p>Present this QR code with your ticket:</p><img width="180" height="180" src="${qr}" alt="Ticket verification QR code"/>`:''}<p>Udarata Rail</p></div>`;
}
async function sendEmails(){
 const client=await pool.connect();
 try{await client.query('BEGIN');const{rows}=await client.query(`SELECT * FROM email_outbox WHERE status IN('pending','failed') AND next_attempt_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10`);
  for(const job of rows){try{await client.query(`UPDATE email_outbox SET status='sending',attempts=attempts+1 WHERE id=$1`,[job.id]);const p=job.payload;let qr:string|undefined;
    if(job.event_type==='booking_confirmed'&&p.qrToken)qr=await QRCode.toDataURL(`${appUrl}/verify/${p.qrToken}`);
    if(!resend){console.log(`[development email] ${job.event_type} -> ${job.recipient}`);await client.query(`UPDATE email_outbox SET status='sent',sent_at=now(),provider_message_id='development-console' WHERE id=$1`,[job.id]);continue;}
    const result=await resend.emails.send({from:process.env.EMAIL_FROM??'Udarata Rail <onboarding@resend.dev>',to:job.recipient,subject:({booking_confirmed:'Booking confirmed',booking_cancelled:'Booking cancelled',waitlist_joined:'Waitlist joined',waitlist_offer:'Your seat offer'} as any)[job.event_type]??'Journey update',html:emailBody(job.event_type,p,qr)},{idempotencyKey:job.id});
    if(result.error)throw result.error;await client.query(`UPDATE email_outbox SET status='sent',sent_at=now(),provider_message_id=$2,last_error=NULL WHERE id=$1`,[job.id,result.data?.id]);
   }catch(e:any){await client.query(`UPDATE email_outbox SET status='failed',last_error=$2,next_attempt_at=now()+(LEAST(attempts,8)||' minutes')::interval WHERE id=$1`,[job.id,String(e?.message??e).slice(0,1000)]);}}
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');console.error(e)}finally{client.release()}
}
async function tick(){await expireAndPromote();await sendEmails()}
console.log('Worker started');void tick();setInterval(()=>void tick(),30_000);
