import type pg from 'pg';
export async function queueEmail(client:pg.PoolClient,eventType:string,recipient:string,payload:Record<string,unknown>){
  await client.query('INSERT INTO email_outbox(event_type,recipient,payload) VALUES($1,$2,$3)',[eventType,recipient,payload]);
}
