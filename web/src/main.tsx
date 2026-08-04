import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Armchair, ArrowRight, CheckCircle2, TrainFront } from 'lucide-react';
import './styles.css';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
type Run={id:number;serviceCode:string;departureAt:string;routeName:string};
type Station={id:number;code:string;name:string;position:number};
type Seat={id:number;seatNumber:string;rowNumber:number;columnNumber:number;coachCode:string;className:string;fareCents:number;available:boolean};

function App(){
 const [runs,setRuns]=useState<Run[]>([]),[runId,setRunId]=useState<number>();
 const [stations,setStations]=useState<Station[]>([]),[originId,setOriginId]=useState<number>(),[destinationId,setDestinationId]=useState<number>();
 const [seats,setSeats]=useState<Seat[]>([]),[selected,setSelected]=useState<Seat>(),[loading,setLoading]=useState(false);
 const [name,setName]=useState(''),[email,setEmail]=useState(''),[message,setMessage]=useState(''),[reference,setReference]=useState('');
 useEffect(()=>{fetch(`${API}/api/runs`).then(r=>r.json()).then((x:Run[])=>{setRuns(x);if(x[0])setRunId(x[0].id)})},[]);
 useEffect(()=>{if(!runId)return;fetch(`${API}/api/runs/${runId}/stations`).then(r=>r.json()).then((x:Station[])=>{setStations(x);setOriginId(x[0]?.id);setDestinationId(x.at(-1)?.id)})},[runId]);
 async function loadSeats(){if(!runId||!originId||!destinationId)return;setLoading(true);setMessage('');setSelected(undefined);const r=await fetch(`${API}/api/availability?runId=${runId}&originId=${originId}&destinationId=${destinationId}`);const body=await r.json();setSeats(r.ok?body:[]);if(!r.ok)setMessage(body.message??'Choose a valid journey.');setLoading(false)}
 useEffect(()=>{if(destinationId)loadSeats()},[destinationId,originId]);
 const coaches=useMemo(()=>[...new Set(seats.map(s=>s.coachCode))], [seats]);
 async function book(e:React.FormEvent){e.preventDefault();if(!selected||!runId||!originId||!destinationId)return;setLoading(true);setMessage('');const r=await fetch(`${API}/api/bookings`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runId,seatId:selected.id,originId,destinationId,passengerName:name,passengerEmail:email})});const body=await r.json();setLoading(false);if(r.ok){setSeats(current=>current.map(seat=>seat.id===selected.id?{...seat,available:false}:seat));setReference(body.reference);setMessage('Booking confirmed.');}else{setMessage(body.message??'We could not complete this booking.');if(r.status===409)loadSeats();}}
 const origin=stations.find(s=>s.id===originId),destination=stations.find(s=>s.id===destinationId);
 return <main>
  <header><div className="brand"><TrainFront/><span>Udarata Rail</span></div><span className="tag">Sri Lanka Railways · Reserved travel</span></header>
  <section className="hero"><p className="eyebrow">COLOMBO FORT — BADULLA</p><h1>Your seat. Only for the<br/>distance you need.</h1><p>Reserve a comfortable seat across the hill country. Fair fares, flexible segments, one unforgettable journey.</p></section>
  <section className="search card" aria-label="Journey selection">
   <label>Service<select value={runId??''} onChange={e=>setRunId(Number(e.target.value))}>{runs.map(r=><option key={r.id} value={r.id}>{r.serviceCode} · {new Date(r.departureAt).toLocaleString()}</option>)}</select></label>
   <label>From<select value={originId??''} onChange={e=>setOriginId(Number(e.target.value))}>{stations.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
   <ArrowRight className="arrow"/>
   <label>To<select value={destinationId??''} onChange={e=>setDestinationId(Number(e.target.value))}>{stations.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
   <button onClick={loadSeats} disabled={loading}>{loading?'Checking…':'Find seats'}</button>
  </section>
  {seats.length>0&&<section className="booking">
   <div className="map card"><div className="section-title"><div><p className="eyebrow">SELECT A SEAT</p><h2>{origin?.name} <span>to</span> {destination?.name}</h2></div><div className="legend"><i/>Available <i className="taken"/>Taken</div></div>
    {coaches.map(coach=><div className="coach" key={coach}><h3>Coach {coach} <small>{seats.find(s=>s.coachCode===coach)?.className}</small></h3><div className="seats">{seats.filter(s=>s.coachCode===coach).map((s,i)=><React.Fragment key={s.id}>{i%4===2&&<span className="aisle"/>}<button className={`seat ${!s.available?'unavailable':''} ${selected?.id===s.id&&!reference?'selected':''}`} disabled={!s.available} onClick={()=>setSelected(s)} aria-label={`Seat ${s.seatNumber}, ${s.available?'available':'taken'}`}><Armchair/><span>{s.seatNumber}</span></button></React.Fragment>)}</div></div>)}
   </div>
   <aside className="summary card"><p className="eyebrow">YOUR JOURNEY</p><h2>{origin?.code} <ArrowRight/> {destination?.code}</h2>{selected?<><div className="choice"><span>Coach <b>{selected.coachCode}</b></span><span>Seat <b>{selected.seatNumber}</b></span></div><div className="fare"><span>Total fare</span><strong>LKR {(selected.fareCents/100).toLocaleString()}</strong><small>Calculated only for your selected distance</small></div>{!reference&&<form onSubmit={book}><label>Passenger name<input required minLength={2} value={name} onChange={e=>setName(e.target.value)}/></label><label>Email<input required type="email" value={email} onChange={e=>setEmail(e.target.value)}/></label><button disabled={loading}>{loading?'Securing seat…':'Confirm booking'}</button></form>}</>:<p className="empty">Choose an available seat to see your fare and continue.</p>}{message&&<p className={reference?'success':'notice'}>{reference&&<CheckCircle2/>}{message}{reference&&<b>{reference}</b>}</p>}</aside>
  </section>}
 </main>
}
createRoot(document.getElementById('root')!).render(<App/>);
