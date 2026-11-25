'use client';
import React, { useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { Play, Plus, Trash2 } from 'lucide-react';
import { apiClient } from '@/services/api-client';
import { useAccount, useFocus, useTasks } from './data';
import s from './studySpace.module.css';

type Block={id:string;taskId:string|null;title:string;start:string;end:string;timeZone:string;recurrence:'NONE'|'DAILY'|'WEEKLY';until:string|null;project:string;notes:string;priority:number;revision:number;focusedSeconds:number};
type Occurrence={block:Block;start:string;end:string};
const base='/study-space/time-blocks';
const localDay=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
export function wallInput(iso:string,zone:string){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(iso)).map(p=>[p.type,p.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function wallTimeToISO(value:string,zone:string){
  const desired=Date.parse(value+'Z');if(!Number.isFinite(desired))throw Error('Thời gian chưa hợp lệ.');
  let guess=desired;for(let i=0;i<4;i++){const shown=Date.parse(wallInput(new Date(guess).toISOString(),zone)+'Z');guess+=desired-shown;}
  const iso=new Date(guess).toISOString();if(wallInput(iso,zone)!==value)throw Error('Giờ này không tồn tại khi đổi giờ mùa hè. Hãy chọn giờ khác.');return iso;
}
const overlap=(a:Occurrence,b:Occurrence)=>a.block.id!==b.block.id&&Date.parse(a.start)<Date.parse(b.end)&&Date.parse(b.start)<Date.parse(a.end);

export default function TimePlanner(){
  const account=useAccount(),{tasks}=useTasks(),{engine,state}=useFocus();
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [date,setDate]=useState(localDay(new Date())),[view,setView]=useState<'day'|'week'>(()=>window.innerWidth<760?'day':'week');
  const [draft,setDraft]=useState<Block|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const from=new Date(date+'T00:00:00'),to=new Date(from);to.setDate(to.getDate()+(view==='day'?1:7));
  const key=account?['study-space/time-blocks',account,from.toISOString(),to.toISOString()]:null;
  const swr=useSWR<Occurrence[]>(key,()=>apiClient.get(base,{params:{from:from.toISOString(),to:to.toISOString()}}).then(r=>r.data));
  const occurrences=swr.data??[];
  const days=Array.from({length:view==='day'?1:7},(_,i)=>{const d=new Date(from);d.setDate(d.getDate()+i);return d;});
  const drag=useRef<{occ:Occurrence;y:number;end:Date}|null>(null);
  const [preview,setPreview]=useState<{id:string;end:string}|null>(null);
  const newBlock=(start:Date,taskId:string|null=null)=>{
    const task=tasks.find(t=>t.id===taskId);const end=new Date(+start+3600000);
    setDraft({id:'',taskId,title:task?.title??'',start:start.toISOString(),end:end.toISOString(),timeZone:zone,recurrence:'NONE',until:null,project:task?.project??'',notes:task?.notes??'',priority:task?.priority??0,revision:0,focusedSeconds:0});setError('');
  };
  const save=async(b:Block)=>{
    if(busy)return;setBusy(true);setError('');
    try{if(b.id)await apiClient.put(`${base}/${b.id}`,b);else await apiClient.post(base,b);await swr.mutate();setDraft(null);}
    catch(e){setError((e as {response?:{status:number}}).response?.status===409?'Lịch đã đổi ở tab khác. Mở lại khối trước khi sửa.':'Chưa lưu được. Kiểm tra giờ kết thúc, thời hạn lặp và thử lại.');}
    finally{setBusy(false);}
  };
  const move=(occ:Occurrence,start:Date)=>{
    const delta=+start-Date.parse(occ.start);
    const b={...occ.block,start:new Date(Date.parse(occ.block.start)+delta).toISOString(),end:new Date(Date.parse(occ.block.end)+delta).toISOString()};
    if(b.recurrence!=='NONE'){setDraft(b);setError('Bạn đang dời cả chuỗi lịch lặp. Kiểm tra rồi lưu.');}else void save(b);
  };
  const editTime=(field:'start'|'end',value:string)=>{if(!draft)return;try{setDraft({...draft,[field]:wallTimeToISO(value,draft.timeZone)});setError('');}catch(e){setError((e as Error).message);}};
  const conflicts=useMemo(()=>occurrences.filter((a,i)=>occurrences.some((b,j)=>i!==j&&overlap(a,b))),[occurrences]);
  return <div className={s.timePlanner}>
    <div className={s.fieldRow}>
      <button type="button" className={s.btn} onClick={()=>{const d=new Date(from);d.setDate(d.getDate()-(view==='week'?7:1));setDate(localDay(d));}}>←</button>
      <input className={s.input} style={{width:156}} aria-label="Ngày bắt đầu lịch" type="date" value={date} onChange={e=>{if(e.target.value)setDate(e.target.value);}}/>
      <button type="button" className={s.btn} onClick={()=>{const d=new Date(from);d.setDate(d.getDate()+(view==='week'?7:1));setDate(localDay(d));}}>→</button>
      <button type="button" className={s.btn} aria-pressed={view==='day'} onClick={()=>setView('day')}>Ngày</button><button type="button" className={s.btn} aria-pressed={view==='week'} onClick={()=>setView('week')}>Tuần</button>
      <button type="button" className={`${s.btn} ${s.primary}`} onClick={()=>{const d=new Date(from);d.setHours(8);newBlock(d);}}><Plus size={15}/> Khung giờ</button>
      <span className={s.hint}>{zone}</span>
    </div>
    <p className={s.hint}>Kéo việc vào lịch; kéo khối để dời, kéo cạnh dưới để đổi thời lượng. Bấm khối để sửa bằng bàn phím.</p>
    {conflicts.length>0&&<p role="status" className={s.scheduleConflict}>{conflicts.length} khung giờ đang trùng lịch. Bạn có thể dời hoặc chỉnh giờ.</p>}
    {error&&<p role="alert" className={s.scheduleConflict}>{error}</p>}
    {swr.error&&<p role="alert">Chưa tải được lịch. <button className={s.btn} onClick={()=>void swr.mutate()}>Thử lại</button></p>}
    <div className={s.taskTray} aria-label="Việc kéo vào lịch">{tasks.filter(t=>t.status!=='DONE').map(t=><button key={t.id} type="button" className={s.btn} draggable onDragStart={e=>e.dataTransfer.setData('text/study-task',t.id)} onClick={()=>{const d=new Date(from);d.setHours(8);newBlock(d,t.id);}}>{t.title}</button>)}</div>
    {draft&&<form className={s.blockEditor} aria-label="Sửa khung giờ" onSubmit={e=>{e.preventDefault();void save(draft);}}>
      <label className={s.field}>Tên khung giờ<input autoFocus required maxLength={200} className={s.input} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
      <label className={s.field}>Việc cần làm<select className={s.select} value={draft.taskId??''} onChange={e=>setDraft({...draft,taskId:e.target.value||null})}><option value="">Không gắn việc</option>{tasks.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
      <label className={s.field}>Bắt đầu<input required className={s.input} type="datetime-local" value={wallInput(draft.start,draft.timeZone)} onChange={e=>editTime('start',e.target.value)}/></label>
      <label className={s.field}>Kết thúc<input required className={s.input} type="datetime-local" value={wallInput(draft.end,draft.timeZone)} onChange={e=>editTime('end',e.target.value)}/></label>
      <label className={s.field}>Môn hoặc dự án<input maxLength={60} className={s.input} value={draft.project} onChange={e=>setDraft({...draft,project:e.target.value})}/></label>
      <label className={s.field}>Ưu tiên<select className={s.select} value={draft.priority} onChange={e=>setDraft({...draft,priority:+e.target.value})}>{['Thường','Thấp','Vừa','Cao'].map((p,i)=><option key={p} value={i}>{p}</option>)}</select></label>
      <label className={s.field}>Lặp lại<select className={s.select} value={draft.recurrence} onChange={e=>{const until=new Date(draft.start);until.setDate(until.getDate()+30);setDraft({...draft,recurrence:e.target.value as Block['recurrence'],until:e.target.value==='NONE'?null:localDay(until)});}}><option value="NONE">Không lặp</option><option value="DAILY">Hằng ngày</option><option value="WEEKLY">Hằng tuần</option></select></label>
      {draft.recurrence!=='NONE'&&<label className={s.field}>Lặp đến ngày<input required className={s.input} type="date" value={draft.until??''} onChange={e=>setDraft({...draft,until:e.target.value})}/></label>}
      <label className={s.field}>Ghi chú<textarea maxLength={4000} className={s.textarea} value={draft.notes} onChange={e=>setDraft({...draft,notes:e.target.value})}/></label>
      <div className={s.fieldRow}><button disabled={busy} className={`${s.btn} ${s.primary}`}>Lưu khung giờ</button><button type="button" className={s.btn} onClick={()=>setDraft(null)}>Đóng</button>
        {draft.id&&<button type="button" className={s.btn} onClick={()=>{if(state.status!=='idle'&&!confirm('Kết thúc phiên đang có để bắt đầu khung giờ này?'))return;engine.start({mode:'COUNTDOWN',minutes:Math.min(720,Math.max(5,Math.round((Date.parse(draft.end)-Date.parse(draft.start))/60000))),taskId:draft.taskId,label:draft.title,subject:draft.project,blockId:draft.id});}}><Play size={14}/> Bắt đầu tập trung</button>}
        {draft.id&&<button type="button" className={`${s.btn} ${s.danger}`} disabled={busy} onClick={async()=>{if(!confirm('Xóa khung giờ này và các lần lặp? Lịch sử tập trung vẫn được giữ.'))return;try{await apiClient.delete(`${base}/${draft.id}`);setDraft(null);await swr.mutate();}catch{setError('Chưa xóa được khung giờ.');}}}><Trash2 size={15}/> Xóa</button>}
      </div>
      <p className={s.hint}>Múi giờ của khối: {draft.timeZone}. Sửa khối lặp sẽ áp dụng cho cả chuỗi.</p>
      {draft.id&&<p className={s.hint}>Đã tập trung: {Math.floor(draft.focusedSeconds/60)} phút từ các phiên thực tế gắn với khung giờ này.</p>}
    </form>}
    <div className={s.scheduleScroll}>
      <div className={s.scheduleGrid} style={{gridTemplateColumns:`48px repeat(${days.length},minmax(130px,1fr))`}}>
        <div className={s.hourScale}>{Array.from({length:24},(_,i)=><span key={i} style={{top:40+i*48}}>{String(i).padStart(2,'0')}:00</span>)}</div>
        {days.map(day=>{const end=new Date(day);end.setDate(end.getDate()+1);return <div key={localDay(day)}>
          <div className={s.scheduleDayTitle}>{day.toLocaleDateString('vi-VN',{weekday:'short',day:'numeric',month:'numeric'})}</div>
          <div className={s.scheduleDay} data-day={localDay(day)} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const minute=Math.max(0,Math.min(1380,Math.round((e.clientY-e.currentTarget.getBoundingClientRect().top)/48*60/15)*15));const start=new Date(day);start.setMinutes(minute);const task=e.dataTransfer.getData('text/study-task'),id=e.dataTransfer.getData('text/study-block');if(task)newBlock(start,task);else{const occ=occurrences.find(o=>`${o.block.id}:${o.start}`===id);if(occ)move(occ,start);}}}>
            {occurrences.filter(o=>Date.parse(o.start)<+end&&Date.parse(o.end)>+day).map(o=>{
              const start=new Date(Math.max(+day,Date.parse(o.start))),finish=new Date(preview?.id===`${o.block.id}:${o.start}`?preview.end:o.end);
              const top=(start.getHours()*60+start.getMinutes())*.8,height=Math.max(22,Math.min(+end,+finish)-+start)/60000*.8;
              const conflict=conflicts.includes(o);return <div key={`${o.block.id}:${o.start}`} className={`${s.timeBlock} ${conflict?s.timeBlockConflict:''}`} style={{top,height:Math.max(28,height)}} draggable onDragStart={e=>e.dataTransfer.setData('text/study-block',`${o.block.id}:${o.start}`)}>
                <button type="button" className={s.blockTitle} onClick={()=>{setDraft(o.block);setError('');}} title={`${o.block.title} · ${o.block.notes??''}`}>{o.block.title}<small>{new Date(o.start).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'})}–{new Date(o.end).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'})}</small></button>
                {height>74&&<button type="button" className={s.blockFocus} aria-label={`Tập trung: ${o.block.title}`} onClick={()=>{if(state.status!=='idle'&&!confirm('Kết thúc phiên đang có để bắt đầu khung giờ này?'))return;engine.start({mode:'COUNTDOWN',minutes:Math.max(5,Math.round((Date.parse(o.end)-Date.parse(o.start))/60000)),taskId:o.block.taskId,label:o.block.title,subject:o.block.project,blockId:o.block.id});}}><Play size={12}/> Tập trung</button>}
                <button type="button" className={s.blockResize} aria-label={`Đổi thời lượng: ${o.block.title}`} onPointerDown={e=>{e.preventDefault();e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);drag.current={occ:o,y:e.clientY,end:new Date(o.end)};}} onPointerMove={e=>{const d=drag.current;if(!d)return;const delta=Math.round((e.clientY-d.y)/48*60/15)*15;const end=new Date(Math.max(Date.parse(d.occ.start)+900000,+d.end+delta*60000));setPreview({id:`${o.block.id}:${o.start}`,end:end.toISOString()});}} onPointerUp={()=>{const d=drag.current;drag.current=null;if(d&&preview){const b={...d.occ.block,end:new Date(Date.parse(d.occ.block.end)+Date.parse(preview.end)-+d.end).toISOString()};setDraft(b);}setPreview(null);}} onPointerCancel={()=>{drag.current=null;setPreview(null);}} onClick={e=>{if(e.detail===0)setDraft(o.block);}}/>
              </div>;
            })}
          </div>
        </div>;})}
      </div>
    </div>
  </div>;
}
