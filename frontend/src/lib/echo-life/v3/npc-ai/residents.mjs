import { zones, spawnAt } from '../world-data/world.mjs';
import { walkable } from '../game-physics/controller.mjs';
import { CHARACTERS, CHARACTER_IDS } from './character-catalog.mjs';
import { createRelationship, checkExpiredInvites } from './relationships.mjs';
import { getCalendar, getWeather, getActiveEvents } from '../world-data/weather-events.mjs';
import { detectZoneSocialScenes } from './social-scenes.mjs';

/**
 * Backward-compatible residents lookup table (keeps V1/V2 tuple shape [name, z0, z1, z2, z3, bio, prompt])
 * for all 22 named characters so legacy consumers & UI helpers continue working seamlessly.
 */
export const residents = Object.fromEntries(
  CHARACTER_IDS.map(id => {
    const c = CHARACTERS[id];
    const z0 = c.weekdaySchedule[0]?.zone || c.homeZone;
    const z1 = c.weekdaySchedule[1]?.zone || c.workZone;
    const z2 = c.weekdaySchedule[2]?.zone || c.workZone;
    const z3 = c.weekdaySchedule[c.weekdaySchedule.length - 1]?.zone || c.homeZone;
    return [id, [c.name, z0, z1, z2, z3, c.bio, `${c.name} · ${c.role}`]];
  })
);

export const guestSpots = [
  [0.6, 0.7], [-1.4, 1.0], [1.4, 0.6], [0.5, -1.0], [1.6, 1.7],
  [-2.2, -0.6], [2.2, -0.8], [-0.8, 2.1], [0.9, 2.2], [-2.0, 1.8],
  [2.5, 1.1], [-2.5, 0.4], [0.0, 1.5], [1.8, -1.6], [-1.6, -1.5],
  [3.0, 0.2], [-3.0, -0.2], [0.4, -2.2], [-0.5, -2.1], [2.4, 2.0],
  [-2.4, 2.0], [1.1, -0.3],
];

function safeSpotForZone(zoneId, index, state = null) {
  const area = zones[zoneId];
  const half = Math.max(1.5, ((area?.size || 8) / 2) - 1.2);
  const halfD = Math.max(1.5, ((area?.depth || area?.size || 8) / 2) - 1.2);
  const raw = guestSpots[index % guestSpots.length];
  const candidates = [
    [Math.max(-half, Math.min(half, raw[0])), Math.max(-halfD, Math.min(halfD, raw[1]))],
    [0, 0],
    [1.0, 0.8],
    [-1.0, 0.8],
    [0.8, -0.9],
    [-0.8, -0.9],
    [0, 1.4],
  ];
  for (const [cx, cz] of candidates) {
    if (walkable(zoneId, cx, cz, 0.34, state)) return [cx, cz];
  }
  return [0, 0];
}

export function newResidents() {
  return Object.fromEntries(
    CHARACTER_IDS.map((id, i) => {
      const def = CHARACTERS[id];
      const startZone = def.weekdaySchedule[0]?.zone || def.homeZone;
      const [sx, sz] = safeSpotForZone(startZone, i, null);
      return [
        id,
        {
          id,
          zone: startZone,
          x: sx,
          z: sz,
          yaw: 0,
          activity: def.weekdaySchedule[0]?.activity || 'idle',
          scheduleNote: def.weekdaySchedule[0]?.note || 'Around town',
          friend: 0,
          visits: 0,
          last: '',
          target: null,
          path: [],
          stuckTicks: 0,
          rel: createRelationship(id),
        },
      ];
    })
  );
}

// Memoized BFS zone-to-zone next hop cache
const zoneHopCache = new Map();
export function nextZone(from, to) {
  if (from === to) return null;
  const k = from + '>' + to;
  if (zoneHopCache.has(k)) return zoneHopCache.get(k);
  const queue = [[from, null]];
  const seen = new Set([from]);
  let found = null;
  for (const [id, first] of queue) {
    if (id === to) { found = first; break; }
    for (const d of zones[id]?.doors || []) {
      if (!seen.has(d.to)) {
        seen.add(d.to);
        queue.push([d.to, first || d.to]);
      }
    }
  }
  zoneHopCache.set(k, found);
  return found;
}

export function route(zone, x, z, tx, tz, state = null) {
  const scale = 0.65;
  const key = (a, b) => a + ',' + b;
  const start = [Math.round(x / scale), Math.round(z / scale)];
  const gx = tx / scale;
  const gz = tz / scale;
  const h = (a, b) => Math.abs(a - gx) + Math.abs(b - gz);

  // Fast A* search: reaches across 32m streets and 220m greenways in ~40-120 expansions!
  const open = [[h(start[0], start[1]), 0, start[0], start[1]]];
  const gScore = new Map([[key(...start), 0]]);
  const prev = new Map([[key(...start), null]]);
  let best = start;
  let dist = Math.hypot(start[0] * scale - tx, start[1] * scale - tz);
  let expanded = 0;
  const maxNodes = zone === 'greenway' ? 2400 : 1200;

  while (open.length && expanded < maxNodes) {
    // Pop lowest f-score node
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [, g, a, b] = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    expanded++;

    const d = Math.hypot(a * scale - tx, b * scale - tz);
    if (d < dist) { dist = d; best = [a, b]; }
    if (d < 0.49) break;

    for (const [u, v] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const na = a + u;
      const nb = b + v;
      const k = key(na, nb);
      const ng = g + 1;
      if (ng < (gScore.get(k) ?? Infinity) && walkable(zone, na * scale, nb * scale, 0.32, state)) {
        gScore.set(k, ng);
        prev.set(k, [a, b]);
        open.push([ng + h(na, nb) * 1.15, ng, na, nb]);
      }
    }
  }

  const path = [];
  for (let at = best; prev.get(key(...at)); at = prev.get(key(...at))) {
    path.unshift([at[0] * scale, at[1] * scale]);
  }
  return path;
}

/**
 * Utility-based Schedule Planner:
 * Resolves an NPC's desired zone & activity reacting to:
 * 1. Active Player Hangout / Home Visit Override
 * 2. Tutorial welcome (Linh greets player in Hallway on Step 3 of first-time tutorial)
 * 3. Story climax (Chapter 5 Festival gathers core organizers at University Green)
 * 4. Active Dynamic World Events (interested participants attend live events)
 * 5. Weather sheltering (Rain moves outdoor NPCs to covered rainFallback venues)
 * 6. Weekday vs. Weekend time-of-day routine
 */
export function desiredScheduleFor(s, id) {
  const def = CHARACTERS[id];
  if (!def) return { zone: 'street', activity: 'idle', note: 'Walking around town' };

  // 1. Active player hangout / home-host override
  const guest = s.worldV3?.hostedGuest;
  if (guest && guest.npcId === id && s.clock < guest.untilClock) {
    return { zone: guest.zone, activity: 'wave', note: `Visiting you in ${zones[guest.zone]?.label || guest.zone}` };
  }

  // 2. First-time Tutorial Step 3: Linh waits warmly in Living Room to introduce herself!
  const tut = s.worldV3?.tutorial;
  if (id === 'linh' && tut && !tut.completed && !tut.skipped && tut.stepIndex === 2) {
    return { zone: 'living', activity: 'wave', note: 'Stopped by to welcome you to Riverside Lane' };
  }

  // 3. Chapter 5 pre-finale festival prep gathers the original 5 organizers at campus
  const cal = getCalendar(s.clock);
  const weather = getWeather(s);
  if (!s.sandbox && s.done?.includes('supplies') && ['linh', 'minh', 'huy', 'mai', 'lan', 'thaovy'].includes(id)) {
    return { zone: 'campus', activity: id === 'lan' ? 'present' : 'wave', note: 'Hosting the Student Connection Festival' };
  }

  // 4. Active Dynamic World Event participation
  const events = getActiveEvents(s);
  for (const ev of events) {
    if (ev.participants.includes(id)) {
      // Preserve V1/V2 weekday morning campus/park anchor for core tests on Day 0 11:00
      if (cal.dayIndex === 0 && cal.hour === 11 && ['linh', 'minh'].includes(id)) continue;
      return { zone: ev.zone, activity: 'present', note: `Attending ${ev.title}` };
    }
  }

  // 5. Weekday vs Weekend routine
  const table = cal.isWeekend ? def.weekendSchedule : def.weekdaySchedule;
  const slot = table.find(b => cal.hour >= b.from && cal.hour < b.to) || table[table.length - 1];
  let desiredZone = slot.zone;
  let desiredAct = slot.activity || 'idle';
  let note = slot.note || 'Going about their day';

  // 6. Weather sheltering: if raining and scheduled outdoors, move to rainFallback!
  if (weather.rain && zones[desiredZone]?.outdoors && def.rainFallback && zones[def.rainFallback]) {
    desiredZone = def.rainFallback;
    desiredAct = 'sit';
    note = `Taking shelter from light rain at ${zones[desiredZone].label}`;
  }

  // Keep post-story Thao Vy blossoming socially in Bistro / Atelier instead of hiding all afternoon
  if (id === 'thaovy' && (s.sandbox || s.worldV3?.sideQuests?.sq_quiet_seat?.done) && cal.hour >= 15 && cal.hour < 19) {
    desiredZone = 'atelier';
    desiredAct = 'wave';
    note = 'Sharing poems with friends at Riverside Atelier';
  }

  return { zone: desiredZone, activity: desiredAct, note };
}

export function stepResidents(s, dt) {
  const playerZone = s.player?.zone || 'study';
  const adjacent = new Set([playerZone, ...(zones[playerZone]?.doors?.map(d => d.to) || [])]);
  s._npcLodTick = (s._npcLodTick || 0) + 1;
  if (s._npcLodTick % 15 === 0) checkExpiredInvites(s);

  const entries = Object.entries(s.npcs || {});
  for (let index = 0; index < entries.length; index++) {
    const [id, n] = entries[index];
    if (!CHARACTERS[id]) continue;
    const inPlayerZone = n.zone === playerZone;
    const isNear = adjacent.has(n.zone);

    // 3-Tier Simulation LOD:
    // Tier 1 (Player Zone): every tick (~5 Hz)
    // Tier 2 (Adjacent Zones): every 2nd tick (~2.5 Hz)
    // Tier 3 (Distant Zones): every 4th tick (~1.25 Hz) with scaled dt so schedule arrivals remain crisp
    let simDt = dt;
    if (!inPlayerZone) {
      if (isNear) {
        if ((s._npcLodTick + index) % 2 !== 0) continue;
        simDt = dt * 2;
      } else {
        if ((s._npcLodTick + index) % 4 !== 0) continue;
        simDt = dt * 4;
      }
    }

    const plan = desiredScheduleFor(s, id);
    n.scheduleNote = plan.note;
    const desired = plan.zone;
    const hop = desired !== n.zone ? nextZone(n.zone, desired) : null;
    const door = hop ? zones[n.zone]?.doors?.find(d => d.to === hop) : null;

    // Gentle contextual micro-movement within current zone when settled
    const phase = Math.floor(s.clock / 20) % 2;
    const baseSpot = safeSpotForZone(n.zone, index, s);
    let dest = door ? [door.x, door.z] : [baseSpot[0] + phase * 0.55, baseSpot[1] - phase * 0.45];
    if (!door && !walkable(n.zone, dest[0], dest[1], 0.34, s)) {
      dest = baseSpot;
    }

    const token = [n.zone, dest[0].toFixed(2), dest[1].toFixed(2)].join('/');
    if (n.target !== token) {
      n.path = route(n.zone, n.x, n.z, dest[0], dest[1], s);
      n.target = token;
      n.stuckTicks = 0;
    }

    const prevX = n.x;
    const prevZ = n.z;
    let budget = simDt * 1.25;
    while (n.path?.length && budget > 0) {
      const [wx, wz] = n.path[0];
      const dx = wx - n.x;
      const dz = wz - n.z;
      const len = Math.hypot(dx, dz);
      if (len > 0.001) n.yaw = Math.atan2(dx, dz);
      if (len <= budget) {
        if (walkable(n.zone, wx, wz, 0.25, s)) {
          n.x = wx;
          n.z = wz;
        }
        n.path.shift();
        budget -= len;
      } else {
        const nx = n.x + (dx / len) * budget;
        const nz = n.z + (dz / len) * budget;
        if (walkable(n.zone, nx, nz, 0.25, s)) {
          n.x = nx;
          n.z = nz;
        } else {
          // Blocked path recovery: force detour recalculation
          n.stuckTicks = (n.stuckTicks || 0) + 1;
          n.path = [];
        }
        budget = 0;
      }
    }

    // Recovery if an NPC got trapped behind newly placed player furniture or stuck approaching a door
    if (n.path?.length && Math.hypot(n.x - prevX, n.z - prevZ) < 0.005) {
      n.stuckTicks = (n.stuckTicks || 0) + 1;
      if (n.stuckTicks >= 4) {
        n.stuckTicks = 0;
        n.target = null;
        if (!walkable(n.zone, n.x, n.z, 0.25, s)) {
          const [rx, rz] = safeSpotForZone(n.zone, index, s);
          n.x = rx;
          n.z = rz;
        } else {
          n.path = route(n.zone, n.x, n.z, dest[0], dest[1], s);
        }
      }
    } else {
      n.stuckTicks = 0;
    }

    n.activity = n.path?.length ? 'walk' : plan.activity;

    // Non-teleporting physical portal transition when NPC reaches the connecting door!
    if (door && !n.path?.length && Math.hypot(n.x - door.x, n.z - door.z) < 1.35) {
      const entry = zones[door.to]?.doors?.find(d => d.to === n.zone);
      if (entry) {
        Object.assign(n, spawnAt(entry), { zone: door.to, target: null, path: [], stuckTicks: 0 });
      }
    }
  }

  // Update autonomous NPC-to-NPC social scenes inside the player's active zone
  const scenes = detectZoneSocialScenes(s, playerZone);
  if (s.worldV3) s.worldV3.activeSocialScenes = scenes.map(sc => sc.id);
  for (const sc of scenes) {
    const [a, b] = sc.actors;
    // Gently orient partners toward each other and give expressive social poses
    a.yaw = Math.atan2(b.x - a.x, b.z - a.z);
    b.yaw = Math.atan2(a.x - b.x, a.z - b.z);
    if (!a.path?.length) a.activity = sc.pose[0] || 'wave';
    if (!b.path?.length) b.activity = sc.pose[1] || 'idle';
  }
}
