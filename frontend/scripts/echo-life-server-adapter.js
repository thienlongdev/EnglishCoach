// Only an event already attended in the organizer's saved story can be shared.
function attendedRoomEvent(inputJson) {
  const parsed = JSON.parse(inputJson);
  const save = parsed?.save, eventId = parsed?.eventId;
  if (!save || typeof save !== 'object' || typeof eventId !== 'string') return 'null';
  if (!Number.isFinite(save.clock) || save.clock < 0 || !Number.isFinite(save.day)) return 'null';
  if (save.done !== undefined && save.done !== null && !Array.isArray(save.done)) return 'null';
  if (!save.worldV3 || typeof save.worldV3 !== 'object' || !Array.isArray(save.worldV3.eventsAttended)) return 'null';
  const normalizedSave = { ...save, done: Array.isArray(save.done) ? save.done : [] };
  const {getActiveEvents}=require('world-data/weather-events.mjs');
  const event=getActiveEvents(normalizedSave).find(e=>e.id===eventId);
  if(!event || !save.worldV3.eventsAttended.includes(eventId+'@day'+save.day))return 'null';
  const remainingMinutes=event.endHour*60-(save.clock%1440);
  if (!Number.isFinite(remainingMinutes) || remainingMinutes <= 0) return 'null';
  return JSON.stringify({id:event.id,title:event.title,zone:event.zone,durationMs:Math.floor(remainingMinutes*2000)});
}

// Restore the documented V2 visual change on reapplication, keeping the first design reward.
function applyDesign(progression, receipts, key, change) {
  const prior={skill:{...progression.skills.diy_design},xp:progression.totalXp,
    level:progression.playerLevel,hosting:progression.reputation.hosting};
  const result=change();
  if (!result.ok) return result;
  if (receipts.includes(key)) {
    progression.skills.diy_design=prior.skill;
    progression.totalXp=prior.xp;
    progression.playerLevel=prior.level;
    progression.reputation.hosting=prior.hosting;
  } else receipts.push(key);
  return result;
}

const SHIFT_QUALITY_MULT = { ok: 1.0, great: 1.12, perfect: 1.25 };
const SHIFT_QUALITY_RANK = { ok: 1, great: 2, perfect: 3 };

function tierForShifts(shifts) {
  if (shifts >= 18) return 5;
  if (shifts >= 10) return 4;
  if (shifts >= 5) return 3;
  if (shifts >= 2) return 2;
  return 1;
}

function shiftStationMatches(station, jobId, zoneId, stationId) {
  if (!station) return false;
  if (Array.isArray(station)) {
    if (station[0] === zoneId && (station[1] === stationId || (Array.isArray(station[3]) && station[3].includes(stationId)))) {
      return true;
    }
    // Rainy-day fallback for Fountain Plaza Busker inside Riverside Atelier (jobs.json tuple format).
    if (jobId === 'busker' && zoneId === 'atelier' && Array.isArray(station[3]) && station[3].includes(stationId)) {
      return true;
    }
    const rainMeta = station[4];
    if (rainMeta && typeof rainMeta === 'object' && rainMeta.rainZone === zoneId
        && (rainMeta.rainStation === stationId || (Array.isArray(rainMeta.rainStation) && rainMeta.rainStation.includes(stationId)))) {
      return true;
    }
    return false;
  }
  if (typeof station === 'object') {
    if (station.zone === zoneId
        && (station.station === stationId || (Array.isArray(station.altStations) && station.altStations.includes(stationId)))) {
      return true;
    }
    if (station.rainZone && station.rainZone === zoneId
        && (station.rainStation === stationId || (Array.isArray(station.rainStation) && station.rainStation.includes(stationId)))) {
      return true;
    }
  }
  return false;
}

function applyShiftStep(p, input, action) {
  const jobs=require('host/jobs.json'), job=Object.hasOwn(jobs,action.jobId) && jobs[action.jobId];
  if (!job || !Number.isFinite(input.serverNow)) return {ok:false,msg:'Shift unavailable.'};
  if (action.quality !== undefined && action.quality !== null && !Object.hasOwn(SHIFT_QUALITY_MULT, action.quality)) {
    return {ok:false,msg:'Invalid shift quality.'};
  }
  let shift=p.activeShift;
  if (shift && input.serverNow-shift.started>30*60000) shift=null;
  if (shift && shift.job!==action.jobId) return {ok:false,msg:'Finish your current shift first.'};
  const step=shift?.step ?? 0, station=job.steps[step];
  if (!shiftStationMatches(station, action.jobId, action.zoneId, action.station))
    return {ok:false,msg:'Visit the station named on your shift card.'};
  if (shift && input.serverNow-shift.last<1500) return {ok:false,msg:'Finish moving to the next station.'};
  const stepQuality = (action.quality && Object.hasOwn(SHIFT_QUALITY_MULT, action.quality))
    ? action.quality
    : (shift?.quality && Object.hasOwn(SHIFT_QUALITY_MULT, shift.quality) ? shift.quality : undefined);
  const next=step+1;
  if(next===job.steps.length) {
    const finalQuality = stepQuality ?? 'ok';
    const qualityMult = Math.min(1.25, SHIFT_QUALITY_MULT[finalQuality] ?? 1.0);
    const careerTiers = p.careerTiers ??= {};
    const prevCareer = Object.hasOwn(careerTiers, action.jobId) && careerTiers[action.jobId] && typeof careerTiers[action.jobId] === 'object'
      ? careerTiers[action.jobId]
      : null;
    const prevShifts = Number.isInteger(prevCareer?.shifts) && prevCareer.shifts >= 0 ? prevCareer.shifts : 0;
    const activeTier = tierForShifts(prevShifts);
    const tierBonus = Math.min(0.20, Math.max(0, (activeTier - 1) * 0.05));
    const qualityPay = Math.min(Math.round(job.pay * 1.25), Math.round(job.pay * qualityMult));
    const combinedMult = Math.min(1.45, qualityMult + tierBonus);
    const computedPay = activeTier === 1
      ? qualityPay
      : Math.min(Math.round(job.pay * 1.45), Math.round(job.pay * combinedMult));
    const grant=Math.min(computedPay,input.shiftAllowance);
    if (!Number.isFinite(grant) || grant<1) return {ok:false,msg:'Daily work allowance reached.'};
    p.economy.credits+=grant;
    p.economy.lifetimeEarned+=grant;
    const nextShifts = prevShifts + 1;
    const prevBest = prevCareer?.bestQuality && Object.hasOwn(SHIFT_QUALITY_RANK, prevCareer.bestQuality) ? prevCareer.bestQuality : 'ok';
    const bestQuality = SHIFT_QUALITY_RANK[finalQuality] > SHIFT_QUALITY_RANK[prevBest] ? finalQuality : prevBest;
    careerTiers[action.jobId] = {
      shifts: nextShifts,
      bestQuality,
      lastDoneAt: input.serverNow,
      tier: tierForShifts(nextShifts),
    };
    delete p.activeShift;
    return {ok:true,msg:'Shift complete. Earned '+grant+' Campus Credits.'};
  } else {
    const nextStep = job.steps[next];
    const nextLabel = Array.isArray(nextStep) ? nextStep[2] : (nextStep?.label || 'Continue your shift');
    p.activeShift = stepQuality
      ? {job:action.jobId,step:next,started:shift?.started ?? input.serverNow,last:input.serverNow,quality:stepQuality}
      : {job:action.jobId,step:next,started:shift?.started ?? input.serverNow,last:input.serverNow};
    return {ok:true,msg:nextLabel+'.'};
  }
}

// Java assembles this input from the authenticated ledger under the V130 owner lock.
function workshop(inputJson) {
  const V3 = require('game-core/index.mjs');
  const input = JSON.parse(inputJson);
  const state = V3.createGame(input.owner);
  if (input.previous) state.progression = input.previous;
  const p = state.progression;
  const receipts = p.shopReceipts ??= {};
  const owned = new Set(input.owned.map(o => o.instanceId));
  if (p.activeCarId && !owned.has(p.activeCarId)) delete p.activeCarId;
  p.ownedObjects = p.ownedObjects.filter(o => !o.instanceId.startsWith('ec_') || owned.has(o.instanceId));
  // Reconstruct already-paid receipts, including older V130 purchases. Eligibility was checked when purchased.
  for (const row of input.owned) {
    if (receipts[row.instanceId]) continue;
    for (const sk of Object.values(p.skills)) sk.level = 10;
    p.playerLevel = 30; p.economy.credits = 10000000;
    const r = V3.buyShopItem(state,row.storeId,row.sku,input.owner);
    if (!r.ok) throw Error('Cannot reconstruct catalogue item '+row.sku);
    if (r.instance) {
      if (p.activeVehicleId === r.instance.instanceId) p.activeVehicleId = row.instanceId;
      r.instance.instanceId = row.instanceId;
    }
    receipts[row.instanceId] = true;
  }
  const rewarded=p.materialReceipts??=[];
  for (const q of V3.SIDE_QUESTS) {
    if (!input.claimed?.includes('side:'+q.id) || rewarded.includes(q.id)) continue;
    for(const [material,quantity] of Object.entries(q.rewards.materials??{}))
      p.materials[material]=(p.materials[material]??0)+quantity;
    rewarded.push(q.id);
  }
  for (const [k,v] of Object.entries(input.skills)) p.skills[k] = {xp:v,level:V3.skillLevelFromXp(v)};
  p.totalXp = Object.values(input.skills).reduce((a,b)=>a+b,0);
  p.playerLevel = V3.playerLevelFromXp(p.totalXp);
  p.economy.credits = input.credits; state.cash=input.credits;
  let result = {ok:true,msg:''};
  const action = input.action;
  if (action) {
    if (action.type === 'undo_build' || action.type === 'redo_build') {
      const undo = action.type === 'undo_build';
      const stack = undo ? 'undoStack' : 'redoStack';
      const existing = new Set(p.ownedObjects.map(o=>o.instanceId));
      p[stack] = (p[stack] || []).filter(entry=>existing.has(entry.instanceId));
      const entry = p[stack][p[stack].length-1];
      const snapshot = entry && (undo ? entry.before : entry.after);
      if (entry?.type === 'placement' && snapshot?.location && !snapshot.location.inStorage) {
        if (snapshot.location.propertyId !== p.properties.activePropertyId)
          return JSON.stringify({ok:false,msg:'Return to the original residence to restore this placement.'});
        const {x,z,yaw}=snapshot.placement;
        const fit=V3.validatePlacement(state,entry.instanceId,snapshot.location.zoneId,x,z,yaw);
        if (!fit.ok) return JSON.stringify({ok:false,msg:fit.reason});
      }
    }
    const obj = p.ownedObjects.find(o=>o.instanceId===action.instanceId);
    if (action.type === 'install_pc_part' && obj?.category !== 'electronics_pc') return JSON.stringify({ok:false,msg:'Select a workstation.'});
    if (action.type === 'customize_vehicle' && obj && Object.values(obj.installedComponents).includes(action.componentId)) return JSON.stringify({ok:false,msg:'Already installed.'});
    if (action.type === 'job_step') {
      result = applyShiftStep(p, input, action);
    } else if (action.type === 'apply_room_style') {
      const property=V3.CATALOG.properties.properties.find(home=>home.id===p.properties.activePropertyId);
      if (!V3.CATALOG.properties.roomTypes.includes(action.zoneId) || !property?.unlockedRooms.includes(action.zoneId)
          || !Object.hasOwn(V3.CATALOG.properties.roomStyleFamilies,action.styleId || ''))
        return JSON.stringify({ok:false,msg:'Choose an available room and a catalogue style.'});
      if (p.roomStyles[action.zoneId] === action.styleId) return JSON.stringify({ok:false,msg:'This room already uses that style.'});
      const key=[property.id,action.zoneId,action.styleId].join('/');
      const earned=p.roomStyleRewards ??= [];
      result=applyDesign(p,earned,key,()=>V3.executeProgressionAction(state,action,input.owner));
    } else if (action.type==='customize_material') {
      if (!obj || obj.ownerAccountId!==input.owner || obj.category.startsWith('vehicle') ||
          !Object.hasOwn(V3.MATERIAL_FINISHES,action.finishId || '')) return JSON.stringify({ok:false,msg:'Choose an owned furnishing and a catalogue finish.'});
      if (obj.customAppearance?.finishId===action.finishId) return JSON.stringify({ok:false,msg:'That finish is already applied.'});
      result=applyDesign(p,obj.rewardedFinishes??=[],action.finishId,()=>V3.executeProgressionAction(state,action,input.owner));
    } else if (action.type==='select_vehicle' && owned.has(action.instanceId) &&
        require('vehicles/car.mjs').getOwnedDrivableCars(state).some(o=>o.instanceId===action.instanceId)) {
      const own=require('progression/engine.mjs').assertOwnership(state,action.instanceId,input.owner);
      if (!own.ok) return JSON.stringify(own);
      p.activeCarId=action.instanceId;
      result={ok:true,msg:'Selected the parked car.'};
    } else if (action.type==='customize_vehicle') {
      const idx=p.componentInventory.findIndex(c=>c.kind==='vehicle_component' && c.componentId===action.componentId);
      if(idx>=0) {
        const engine=require('progression/engine.mjs');
        result=engine.customizeVehicle(state,action.instanceId,action.componentId,input.owner,{fromInventory:true});
        if(result.ok)p.componentInventory.splice(idx,1);
      } else result=V3.executeProgressionAction(state,action,input.owner);
    } else result = V3.executeProgressionAction(state, action, input.owner);
  }
  if (!result.ok) return JSON.stringify({ok:false,msg:result.msg});
  return JSON.stringify({ok:true,msg:result.msg,progression:p,credits:p.economy.credits,skills:Object.fromEntries(Object.entries(p.skills).map(([k,v])=>[k,v.xp]))});
}
