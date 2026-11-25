'use client';
import { useEffect,useState } from 'react';
import { useSession } from 'next-auth/react';
import dynamic from 'next/dynamic';
import { vfxReduced } from '@/lib/vfx/quality';
import { celebrateInWorld } from '@/lib/vfx/events';
const Burst=dynamic(()=>import('./BurstCanvas'),{ssr:false});
const previous=new Map<string,number>();
/** Only server projections are passed here. Initial/history hydration never celebrates. */
export default function MilestoneEffect({kind,value,identity=''}:{kind:'stage'|'streak';value:number|undefined;identity?:string}){
 const {data:session}=useSession();const account=String((session?.user as {id?:string}|undefined)?.id??'');
 const [event,setEvent]=useState(0);
 useEffect(()=>{
  if(!account||value===undefined||!Number.isInteger(value)||value<0)return;
  const key=`${account}:${kind}:${identity}`,before=previous.get(key);previous.set(key,value);
  if(previous.size>64)previous.delete(previous.keys().next().value!);
  const significant=kind==='stage'?value>=2:[7,14,30,60,100,180,365].some(n=>value>=n&&(before??value)<n);
  if(before!==undefined&&value>before&&significant&&!vfxReduced()&&!document.hidden&&!celebrateInWorld())setEvent(Date.now());
 },[account,kind,value,identity]);
 useEffect(()=>{if(!event)return;const timer=setTimeout(()=>setEvent(0),4200);return()=>clearTimeout(timer);},[event]);
 if(!event)return null;
 return <Burst key={event}/>;
}
