'use client';
import { useState } from 'react';
import { CATALOG, MATERIAL_FINISHES, type V3OwnedObject } from '@/lib/echo-life/v3/game-core/index.mjs';
import {computePcStats} from '@/lib/echo-life/v3/progression/pc-builder.mjs';
import {getOwnedDrivableCars} from '@/lib/echo-life/v3/vehicles/car.mjs';
import type { WorkshopAction } from '@/lib/echo-life/game/saver';
import { cleanDisplayCopy } from '@/lib/echo-life/game/session';
import type {EchoLifeGameHost} from '../world/echoLife/gameHost';
import {propertyList} from '../world/echoLife/workshopView';
import s from './echoLife.module.css';

interface Part {id:string;name:string;price:number;slot?:string;appliesTo?:string[]}
const upgrades=CATALOG.upgrades as {id:string;sourceVariant:string;targetVariant:string;creditsCost:number}[];
const pc=CATALOG.pc as Record<string,Part[]>;
const vehicleParts=(CATALOG.vehicles as {components:Part[]}).components;
const homes=CATALOG.properties as {roomTypes:string[];properties:{id:string;unlockedRooms:string[]}[];roomStyleFamilies:Record<string,{id:string;name:string;unlockCost:number}>};
const slots:Record<string,string>={cases:'case',motherboards:'motherboard',cpus:'cpu',gpus:'gpu',ram:'ram',storage:'storage',cooling:'cooling',fans:'fans',rgb:'rgb',monitors:'monitors',keyboards:'keyboard',mice:'mouse',speakers:'speakers',microphones:'microphone',accessories:'accessories',desks:'desk'};
export function Workshop({host,close,initialId}:{initialId:string;host:EchoLifeGameHost;close:()=>void}) {
  const game=host.game!;
  const [id,setId]=useState(initialId),[busy,setBusy]=useState(false),[msg,setMsg]=useState('');
  const [selection,setSelection]=useState('');
  const [room,setRoom]=useState('living'),[style,setStyle]=useState('cozy');
  const [finish,setFinish]=useState('natural_oak');
  const objects=game.s.progression.ownedObjects;
  const item=objects.find(o=>o.instanceId===id)??objects[0];
  const drivableCar=item && getOwnedDrivableCars(game.s).includes(item);
  const perform=async(action:WorkshopAction)=>{
    if(!host.saverNow||busy)return;
    setBusy(true);
    try {
      const r=await host.saverNow.configure(action);setMsg(cleanDisplayCopy(r.msg));
      if(r.ok)game.workshopEvent(action.type);
    }finally{setBusy(false);}
  };
  const parts=item?.category==='electronics_pc' ? Object.entries(slots).flatMap(([group,slot])=>(pc[group]??[]).map(p=>({...p,slot}))) :
    item?.category.startsWith('vehicle') ? vehicleParts.filter(p=>p.appliesTo?.includes(String(item.interactionState.vehicleClass))) : [];
  const part=parts.find(p=>p.id===selection)??parts[0];
  const active=game.s.progression.properties.activePropertyId;
  const rooms=homes.properties.find(p=>p.id===active)?.unlockedRooms.filter(zone=>homes.roomTypes.includes(zone)) ?? [];
  const selectedRoom=rooms.includes(room)?room:rooms[0];
  const roomStyles=game.s.progression.roomStyles as Record<string,string>;
  const unlockedStyles=game.s.progression.unlockedStyles as string[];
  const label=(o:V3OwnedObject)=>cleanDisplayCopy(o.selectedVariantId.replaceAll('_',' '));
  return <div className={s.settings} data-testid="echo-life-workshop">
    <h3>Furniture and equipment</h3>
    <div>
      {(['undo','redo'] as const).map(command=>{
        const history=game.s.progression[command+'Stack'];
        return <button key={command} disabled={busy || !Array.isArray(history) || !history.length}
          onClick={()=>void perform({type:command+'_build'})}>{command==='undo'?'Undo build change':'Redo build change'}</button>;
      })}
    </div>
    <label>Owned item <select value={item?.instanceId??''} onChange={e=>{setId(e.target.value);setSelection('');setMsg('');}}>
      {objects.map(o=><option key={o.instanceId} value={o.instanceId}>{label(o)} · {o.location.inStorage?'Storage':game.zoneName(o.location.zoneId??'')}</option>)}
    </select></label>
    {item && <div>
      {drivableCar && <button disabled={busy || game.riding || !!game.drivenVehicle || game.car.spec?.instanceId===item.instanceId}
        onClick={()=>void perform({type:'select_vehicle',instanceId:item.instanceId})}>
        {game.car.spec?.instanceId===item.instanceId ? 'Active car' : 'Select car'}
      </button>}
      {item.category === 'vehicle_rideable' && <button disabled={busy || game.riding || !!game.drivenVehicle || item.instanceId===game.s.progression.activeVehicleId}
        onClick={()=>void perform({type:'select_vehicle',instanceId:item.instanceId})}>
        {item.instanceId===game.s.progression.activeVehicleId ? 'Active ride' : 'Select for riding'}
      </button>}
      {!item.category.startsWith('vehicle') && <>
        <label>Material finish <select value={finish} onChange={e=>setFinish(e.target.value)}>
          {Object.values(MATERIAL_FINISHES).map(f=><option key={f.id} value={f.id}>{cleanDisplayCopy(f.name)}</option>)}
        </select></label>
        <button disabled={busy || (item.customAppearance as {finishId?:string})?.finishId===finish}
          onClick={()=>void perform({type:'customize_material',instanceId:item.instanceId,finishId:finish})}>Apply finish</button>
      </>}
      {item.instanceId.startsWith('ec_') && !item.category.startsWith('vehicle') && <>
        <button className={s.primary} onClick={()=>{host.beginBuild(item.instanceId);close();}}>Carry and place</button>
        {!item.location.inStorage && <button disabled={busy} onClick={()=>void perform({type:'store_object',instanceId:item.instanceId})}>Return to storage</button>}
      </>}
      {upgrades.filter(u=>u.sourceVariant===item.selectedVariantId).map(u=><button className={s.primary} disabled={busy} key={u.id} onClick={()=>void perform({type:'upgrade_object',instanceId:item.instanceId,upgradeId:u.id})}>Upgrade to {cleanDisplayCopy(u.targetVariant.replaceAll('_',' '))} · {u.creditsCost} CC before discount</button>)}
      {item.category==='electronics_pc' && <p>{computePcStats(item).memoryGb} GB RAM · {computePcStats(item).powerDrawWatts} W</p>}
      {!!part && <p><label>Component <select value={part.id} onChange={e=>setSelection(e.target.value)}>
        {parts.map(p=><option value={p.id} key={p.id}>{cleanDisplayCopy(p.name)} · {p.price} CC before discount</option>)}</select></label>
        <button className={s.primary} disabled={busy} onClick={()=>void perform({type:item.category==='electronics_pc'?'install_pc_part':'customize_vehicle',instanceId:item.instanceId,componentId:part.id,...(part.slot?{slot:part.slot}:{})})}>Install</button></p>}
    </div>}
    <h3>Residence</h3>
    <label>Room <select aria-label="Room" value={selectedRoom || ''} onChange={e=>setRoom(e.target.value)}>
      {rooms.map(zone=><option key={zone} value={zone}>{game.zoneName(zone)}</option>)}
    </select></label>
    <label>Room style <select aria-label="Room style" value={style} onChange={e=>setStyle(e.target.value)}>
      {Object.values(homes.roomStyleFamilies).map(st=><option key={st.id} value={st.id}>{cleanDisplayCopy(st.name)}{unlockedStyles?.includes(st.id)?'':' · '+st.unlockCost+' CC before discount'}</option>)}
    </select></label>
    <button disabled={busy || !selectedRoom || roomStyles?.[selectedRoom]===style}
      onClick={()=>void perform({type:'apply_room_style',zoneId:selectedRoom,styleId:style})}>Apply room style</button>
    <ul className={s.items}>{propertyList.map((p,index)=><li key={p.id}><b>{cleanDisplayCopy(p.name)}</b>
      <span>{index===0?'Lantern Street':index+' Market Boulevard'}</span>
      <button disabled={busy||p.id===active} onClick={()=>void perform({type:'buy_switch_property',propertyId:p.id})}>{p.id===active?'Current home':(game.s.progression.properties.ownedIds as string[]).includes(p.id)?'Move here':p.price+' CC before discount'}</button></li>)}</ul>
    <p role="status">{cleanDisplayCopy(msg)}</p>
  </div>;
}
