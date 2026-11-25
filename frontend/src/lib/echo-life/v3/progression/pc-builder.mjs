import { CATALOG, getPcPart } from './catalog.mjs';
import { awardSkillXp, checkSkillRequirements, unlockAchievement } from './skills.mjs';

export function validatePcConfiguration(caseId, comp = {}) {
  const pcCase = getPcPart('case', caseId);
  if (!pcCase) return { ok: false, errors: [`Unknown PC case: ${caseId}`] };
  const errors = [];

  const mb = comp.motherboard ? getPcPart('motherboard', comp.motherboard) : null;
  if (!mb) errors.push('Motherboard is required.');
  else {
    const allowed = CATALOG.pc.formFactorCompatibility[pcCase.formFactor] || [];
    if (!allowed.includes(mb.formFactor)) {
      errors.push(`${mb.name} (${mb.formFactor}) does not fit in ${pcCase.name} (${pcCase.formFactor}).`);
    }
  }

  const cpu = comp.cpu ? getPcPart('cpu', comp.cpu) : null;
  if (!cpu) errors.push('CPU is required.');
  else if (mb && cpu.socket !== mb.cpuSocket) {
    errors.push(`${cpu.name} (${cpu.socket}) is incompatible with ${mb.name} (${mb.cpuSocket}).`);
  }

  const gpu = comp.gpu ? getPcPart('gpu', comp.gpu) : getPcPart('gpu', 'gpu_igpu_basic');
  if (!gpu) errors.push(`Unknown GPU: ${comp.gpu}`);
  else if (gpu.lengthMm > pcCase.maxGpuLengthMm) {
    errors.push(`${gpu.name} (${gpu.lengthMm}mm) exceeds ${pcCase.name} GPU clearance (${pcCase.maxGpuLengthMm}mm).`);
  }

  const ramIds = Array.isArray(comp.ram) ? comp.ram : [];
  if (ramIds.length === 0) errors.push('At least one RAM module is required.');
  if (mb && ramIds.length > mb.ramSlots) {
    errors.push(`Installed RAM modules (${ramIds.length}) exceed ${mb.name} slot count (${mb.ramSlots}).`);
  }
  for (const rid of ramIds) {
    const r = getPcPart('ram', rid);
    if (!r) { errors.push(`Unknown RAM module: ${rid}`); continue; }
    if (mb && r.ramType !== mb.ramType) {
      errors.push(`${r.name} (${r.ramType}) does not match ${mb.name} (${mb.ramType}).`);
    }
  }

  const ssdIds = Array.isArray(comp.storage) ? comp.storage : [];
  if (mb && ssdIds.length > mb.m2Slots) {
    errors.push(`Installed SSDs (${ssdIds.length}) exceed ${mb.name} M.2 slots (${mb.m2Slots}).`);
  }
  for (const sid of ssdIds) {
    if (!getPcPart('storage', sid)) errors.push(`Unknown storage module: ${sid}`);
  }

  const cool = comp.cooling ? getPcPart('cooling', comp.cooling) : getPcPart('cooling', 'cool_stock_air');
  if (!cool) errors.push(`Unknown cooler: ${comp.cooling}`);
  else if (cool.radMm > pcCase.maxRadMm) {
    errors.push(`${cool.name} (${cool.radMm}mm radiator) exceeds ${pcCase.name} radiator clearance (${pcCase.maxRadMm}mm).`);
  }

  const rgb = comp.rgb ? getPcPart('rgb', comp.rgb) : getPcPart('rgb', 'rgb_none');
  if (rgb && rgb.id !== 'rgb_none' && !pcCase.rgbSupport) {
    errors.push(`${pcCase.name} does not support internal RGB lighting kits.`);
  }

  const mon = comp.monitors ? getPcPart('monitors', comp.monitors) : getPcPart('monitors', 'mon_dorm_single');
  if (!mon) errors.push(`Unknown monitor configuration: ${comp.monitors}`);
  else if (gpu && mon.screenCount > gpu.maxMonitors) {
    errors.push(`${mon.name} (${mon.screenCount} displays) exceeds ${gpu.name} output limit (${gpu.maxMonitors} display${gpu.maxMonitors === 1 ? '' : 's'}). Install a higher-tier GPU first.`);
  }

  const totalTdp = (cpu?.tdpWatts || 0) + (gpu?.tdpWatts || 0) + 70;
  if (totalTdp > pcCase.psuWatts) {
    errors.push(`Estimated power draw (${totalTdp}W) exceeds ${pcCase.name} PSU capacity (${pcCase.psuWatts}W). Upgrade your PC case/PSU.`);
  }

  return { ok: errors.length === 0, errors };
}

export function computePcStats(obj) {
  const c = obj?.installedComponents || {};
  const pcCase = getPcPart('case', obj?.selectedVariantId) || CATALOG.pc.cases[1];
  const cpu = getPcPart('cpu', c.cpu) || CATALOG.pc.cpus[0];
  const gpu = getPcPart('gpu', c.gpu) || CATALOG.pc.gpus[0];
  const ramList = (Array.isArray(c.ram) ? c.ram : []).map(id => getPcPart('ram', id)).filter(Boolean);
  const ssdList = (Array.isArray(c.storage) ? c.storage : []).map(id => getPcPart('storage', id)).filter(Boolean);
  const cool = getPcPart('cooling', c.cooling) || CATALOG.pc.cooling[0];
  const fans = getPcPart('fans', c.fans) || CATALOG.pc.fans[0];
  const rgb = getPcPart('rgb', c.rgb) || CATALOG.pc.rgb[0];
  const mon = getPcPart('monitors', c.monitors) || CATALOG.pc.monitors[0];
  const desk = getPcPart('desk', c.desk) || CATALOG.pc.desks[0];

  const memoryGb = ramList.reduce((a, r) => a + r.capacityGb, 0);
  const memoryScore = ramList.reduce((a, r) => a + r.memoryScore, 0);
  const storageTb = Number(ssdList.reduce((a, s) => a + s.capacityTb, 0).toFixed(2));
  const powerDrawWatts = cpu.tdpWatts + gpu.tdpWatts + 70;
  const thermalHeadroom = cool.coolingCapacityWatts + fans.thermalBonus - Math.round((cpu.tdpWatts + gpu.tdpWatts) * 0.65);
  const workstationRating = Math.round(cpu.computeScore + gpu.graphicsScore + memoryScore + mon.focusBonus * 2 + (rgb.glowColor ? 8 : 0) + (c.accessories?.length || 0) * 6);

  const tierLabel = workstationRating >= 340 ? 'Flagship Showcase'
    : workstationRating >= 220 ? 'Creator Pro'
    : workstationRating >= 135 ? 'Upgraded Studio'
    : workstationRating >= 75 ? 'Starter Upgraded'
    : 'Basic Student';

  return {
    caseName: pcCase.name,
    deskName: desk.name,
    cpuName: cpu.name,
    gpuName: gpu.name,
    monitorName: mon.name,
    screenCount: mon.screenCount,
    maxMonitors: gpu.maxMonitors,
    memoryGb,
    ramModules: ramList.length,
    storageTb,
    computeScore: cpu.computeScore,
    graphicsScore: gpu.graphicsScore,
    powerDrawWatts,
    psuWatts: pcCase.psuWatts,
    thermalHeadroom,
    rgbGlow: rgb.glowColor || null,
    workstationRating,
    tierLabel,
    studyFocusBonus: Math.min(35, Math.round(mon.focusBonus + workstationRating / 35)),
    techXpMultiplier: Number((1 + Math.min(0.8, workstationRating / 400)).toFixed(2)),
  };
}

export function installPcPart(state, obj, slot, componentId, options = {}) {
  if (!obj || obj.category !== 'electronics_pc') return { ok: false, msg: 'Target object is not a modular PC workstation.' };
  const part = getPcPart(slot, componentId);
  if (!part) return { ok: false, msg: `Unknown PC component (${slot}: ${componentId}).` };

  const skillCheck = checkSkillRequirements(state, part.reqSkill, 1);
  if (!skillCheck.ok) return { ok: false, msg: skillCheck.reason };

  const nextComp = structuredClone(obj.installedComponents || {});
  let nextVariantId = obj.selectedVariantId;

  if (slot === 'case') {
    nextVariantId = componentId;
  } else if (slot === 'ram') {
    nextComp.ram = [...(nextComp.ram || []), componentId];
  } else if (slot === 'storage') {
    nextComp.storage = [...(nextComp.storage || []), componentId];
  } else if (slot === 'accessories') {
    const list = new Set(nextComp.accessories || []);
    if (list.has(componentId)) return { ok: false, msg: `${part.name} is already mounted on this workstation.` };
    list.add(componentId);
    nextComp.accessories = [...list];
  } else {
    if (nextComp[slot] === componentId) return { ok: false, msg: `${part.name} is already installed.` };
    nextComp[slot] = componentId;
  }

  const check = validatePcConfiguration(nextVariantId, nextComp);
  if (!check.ok) return { ok: false, msg: check.errors[0], errors: check.errors };

  // Charge price + materials if buying directly during configuration (unless pre-owned component from inventory)
  const useInventory = options.fromInventory === true;
  if (!useInventory) {
    const cost = options.priceOverride ?? part.price ?? 0;
    const econ = state.progression.economy;
    if (econ.credits < cost) return { ok: false, msg: `Need ${cost} CC (you have ${econ.credits} CC).` };
    for (const [m, q] of Object.entries(part.materials || {})) {
      if ((state.progression.materials[m] || 0) < q) {
        return { ok: false, msg: `Need ${q}x ${CATALOG.economy.materials[m]?.name || m}.` };
      }
    }
    econ.credits -= cost;
    econ.lifetimeSpent += cost;
    state.cash = econ.credits;
    for (const [m, q] of Object.entries(part.materials || {})) {
      state.progression.materials[m] -= q;
    }
    obj.upgradeInvestment = (obj.upgradeInvestment || 0) + cost;
  }

  obj.selectedVariantId = nextVariantId;
  obj.installedComponents = nextComp;
  obj.upgradeLevel = Math.min(10, (obj.upgradeLevel || 0) + 1);
  obj.revision = (obj.revision || 1) + 1;
  state.saveRevision = (state.saveRevision || 0) + 1;

  awardSkillXp(state, 'technology', 30);
  unlockAchievement(state, 'first_pc_build');
  if (slot === 'gpu' && componentId !== 'gpu_igpu_basic') unlockAchievement(state, 'gpu_installer');
  if (slot === 'ram' && (nextComp.ram?.length || 0) >= 2) unlockAchievement(state, 'ram_expander');
  if (slot === 'desk' && (componentId === 'desk_electric_lift' || componentId === 'desk_dual_motor')) unlockAchievement(state, 'standing_desk_pro');
  const mon = getPcPart('monitors', nextComp.monitors);
  if (mon?.screenCount === 2) unlockAchievement(state, 'dual_monitor_setup');
  if (mon?.screenCount === 3) unlockAchievement(state, 'triple_monitor_studio');
  if (mon?.screenCount >= 4) unlockAchievement(state, 'quad_command_center');

  if (state.progression.sideMissions?.pc_upgrade_arc) {
    const stats = computePcStats(obj);
    if (stats.graphicsScore >= 45 && stats.memoryGb >= 32 && stats.screenCount >= 2) {
      state.progression.sideMissions.pc_upgrade_arc = { stage: 3, done: true };
    } else if (stats.graphicsScore >= 45) {
      state.progression.sideMissions.pc_upgrade_arc.stage = Math.max(state.progression.sideMissions.pc_upgrade_arc.stage, 2);
    }
  }

  return { ok: true, msg: `Installed ${part.name} onto workstation.`, stats: computePcStats(obj) };
}
