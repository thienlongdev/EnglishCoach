/**
 * Echo Life Total Rebirth — Emergent Multi-NPC Social Graph & Spontaneous Gatherings (A06).
 *
 * Layered cleanly beneath V3's 14 scripted `SOCIAL_SCENES` (`detectZoneSocialScenes` always gets first pick):
 * - 22×22 `Int8Array` pairwise affinity graph seeded from V3 connections, shared interests, Big-5 compatibility & story state.
 * - Organic 2–3 resident gatherings in the same zone with floor-proven semicircular/open-triangle formations.
 * - Extraversion-weighted turn-taking choreography (`chat`, `laugh`, `nod`, `sit`, `idle`) and head look-at targets.
 * - Unobtrusive proximity-gated (`< 7.5 m`, max 1 on-screen) deterministic English overheard banter (ZERO LLM calls).
 */
import type { V3State } from '../v3/game-core/index.mjs';
import { CHARACTERS } from '../v3/game-core/index.mjs';
import type { V3ZoneId } from '../zones';
import type { LifeNav, P } from './nav';
import {
  RESIDENT_IDS,
  RESIDENT_PROFILES,
  type EnvSnapshot,
  type EpisodicMemory,
  type ExpressiveActivity,
  type NpcMindEngine,
  type ResidentId,
} from './npcMind';
import {
  composeBanterBeat,
  resolveBanterTone,
  type BanterMicroCue,
} from './banterGrammar';

const N = RESIDENT_IDS.length; // 22
const ID_TO_INDEX = new Map<ResidentId, number>(RESIDENT_IDS.map((id, i) => [id, i]));

export interface SocialParticipantView {
  id: ResidentId;
  x: number;
  z: number;
  yaw: number;
  zone: V3ZoneId;
  moving: boolean;
  seated: boolean;
  seatId: string | null;
  v3SceneLocked: boolean;
  talking: boolean;
}

export interface GroupSlot {
  x: number;
  z: number;
  yaw: number;
  seatId: string | null;
}

export interface EmergentGroup {
  readonly id: string;
  readonly zone: V3ZoneId;
  readonly members: ResidentId[];
  readonly center: P;
  readonly slots: Record<string, GroupSlot>;
  readonly topic: string;
  speakerIndex: number;
  nextTurnElapsed: number;
  startedElapsed: number;
  expiresElapsed: number;
  affinityAwarded: boolean;
  banterText: string | null;
  banterUntilElapsed: number;
  nextBanterAllowedElapsed: number;
  turnCount: number;
  beat: 0 | 1 | 2 | 3;
  banterMicroCue: BanterMicroCue;
  gossipPropagatedInArc: boolean;
}

export interface SocialMemberDirective {
  groupId: string;
  slot: GroupSlot;
  /** Position of the active speaker (or group center for the speaker) for smooth head look-at. */
  lookAt: P;
  /** Yaw the body should gently orient toward. */
  faceYaw: number;
  /** Expressive activity for this member (`chat`, `laugh`, `nod`, `sit`, `idle`). */
  activity: ExpressiveActivity;
  /** True if this member is currently holding the conversational floor. */
  isSpeaker: boolean;
}

export interface OverheardBanter {
  groupId: string;
  speakerId: ResidentId;
  text: string;
  dist: number;
  speakerName?: string;
  beat?: number;
  topic?: string;
}

function clampInt8(v: number): number {
  return v < -20 ? -20 : v > 100 ? 100 : Math.round(v);
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function pickTopic(members: readonly ResidentId[], zone: V3ZoneId, env: EnvSnapshot): string {
  if (env.rainIntensity > 0.1) return 'rain';
  if (env.snowIntensity > 0.4) return 'snow';
  if (env.phase === 'evening' || env.phase === 'night') {
    if (zone === 'street' || zone === 'lantern_garden' || zone === 'fountain_plaza') return 'evening';
  }
  if (zone === 'bistro') return 'coffee';
  if (zone === 'cafe' || zone === 'electronics_shop') return 'tech';
  if (zone === 'library') return 'books';
  if (zone === 'botanical' || zone === 'lantern_garden') return 'garden';
  if (zone === 'park' || zone === 'greenway') return 'sports';
  if (zone === 'atelier' || zone === 'furniture_shop' || zone === 'clothing_shop') return 'art';

  // Check shared V3 interests across members
  const counts = new Map<string, number>();
  for (const id of members) {
    const interests = CHARACTERS[id]?.interests ?? [];
    for (const item of interests) counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  for (const [interest, c] of counts) {
    if (c < 2) continue;
    const low = interest.toLowerCase();
    if (low.includes('music') || low.includes('guitar')) return 'music';
    if (low.includes('tea') || low.includes('coffee') || low.includes('cook')) return 'coffee';
    if (low.includes('paint') || low.includes('photo') || low.includes('arch') || low.includes('design')) return 'art';
    if (low.includes('gpu') || low.includes('pc') || low.includes('rhythm') || low.includes('esports')) return 'tech';
    if (low.includes('basket') || low.includes('cycl')) return 'sports';
    if (low.includes('book') || low.includes('archiv') || low.includes('study')) return 'books';
  }
  if (zone === 'campus' || zone === 'fountain_plaza') return 'campus';
  return 'general';
}

export class SocialSimEngine {
  readonly groups = new Map<string, EmergentGroup>();
  private readonly affinity = new Int8Array(N * N);
  private readonly baseAffinity = new Int8Array(N * N);
  private readonly memberToGroup = new Map<ResidentId, string>();
  private readonly pairCooldown = new Map<string, number>();
  private readonly directivesScratch = new Map<ResidentId, SocialMemberDirective>();
  /** Per-resident Uint16Array(8) non-repetition ring buffer for 4-beat banter grammar. */
  private readonly banterHistory = new Map<ResidentId, Uint16Array>();

  /** Seed the 22×22 affinity matrix from V3 character connections, interests, Big-5 compatibility, and saved deltas. */
  init(s: V3State, savedDeltas?: readonly [number, number, number][]): void {
    this.groups.clear();
    this.memberToGroup.clear();
    this.pairCooldown.clear();
    this.banterHistory.clear();
    for (let i = 0; i < N; i++) {
      this.banterHistory.set(RESIDENT_IDS[i], new Uint16Array(8));
    }
    this.affinity.fill(0);
    this.baseAffinity.fill(0);

    const budgetResolved =
      s.worldV3?.storyChoices?.ch3_budget === 'compromise_coalition' ||
      s.worldV3?.storyChoices?.ch3_budget === 'grassroots_fundraise' ||
      Boolean(s.worldV3?.sideQuests?.sq_treasurers_ledger?.done);

    for (let i = 0; i < N; i++) {
      const aId = RESIDENT_IDS[i];
      const aDef = CHARACTERS[aId];
      const aProf = RESIDENT_PROFILES[aId];
      for (let j = i + 1; j < N; j++) {
        const bId = RESIDENT_IDS[j];
        const bDef = CHARACTERS[bId];
        const bProf = RESIDENT_PROFILES[bId];

        let score = 0;
        if (aDef?.connections?.includes(bId) || bDef?.connections?.includes(aId)) {
          score += 42;
        }
        // Shared interests overlap
        if (aDef?.interests && bDef?.interests) {
          let overlap = 0;
          for (const interest of aDef.interests) {
            if (bDef.interests.includes(interest)) overlap++;
          }
          score += Math.min(28, overlap * 14);
        }
        // Big-5 compatibility (openness similarity + mutual agreeableness)
        const openSim = 1 - Math.abs(aProf.traits.openness - bProf.traits.openness);
        const agreeAvg = (aProf.traits.agreeableness + bProf.traits.agreeableness) * 0.5;
        score += Math.round(18 * openSim + 12 * agreeAvg);

        // Canonical story tension (Hoang Phuc vs festival organizers until resolved)
        const isBudgetPair =
          (aId === 'hoangphuc' && (bId === 'linh' || bId === 'yennhi')) ||
          (bId === 'hoangphuc' && (aId === 'linh' || aId === 'yennhi'));
        if (isBudgetPair) {
          score += budgetResolved ? 16 : -18;
        }

        const clamped = clampInt8(score);
        this.baseAffinity[i * N + j] = clamped;
        this.baseAffinity[j * N + i] = clamped;
        this.affinity[i * N + j] = clamped;
        this.affinity[j * N + i] = clamped;
      }
    }

    // Apply persisted sparse affinity deltas if present
    if (Array.isArray(savedDeltas)) {
      for (const tuple of savedDeltas) {
        if (!Array.isArray(tuple) || tuple.length < 3) continue;
        const [i, j, delta] = tuple;
        if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= N || j >= N || i === j) continue;
        const next = clampInt8(this.baseAffinity[i * N + j] + delta);
        this.affinity[i * N + j] = next;
        this.affinity[j * N + i] = next;
      }
    }
  }

  getAffinity(a: ResidentId, b: ResidentId): number {
    const i = ID_TO_INDEX.get(a);
    const j = ID_TO_INDEX.get(b);
    if (i === undefined || j === undefined || i === j) return 0;
    return this.affinity[i * N + j];
  }

  adjustAffinity(a: ResidentId, b: ResidentId, delta: number): number {
    const i = ID_TO_INDEX.get(a);
    const j = ID_TO_INDEX.get(b);
    if (i === undefined || j === undefined || i === j) return 0;
    const next = clampInt8(this.affinity[i * N + j] + delta);
    this.affinity[i * N + j] = next;
    this.affinity[j * N + i] = next;
    return next;
  }

  /** Export only pairs whose affinity shifted by >= 2 from deterministic baseline (compact save). */
  exportAffinityDeltas(): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const diff = this.affinity[i * N + j] - this.baseAffinity[i * N + j];
        if (Math.abs(diff) >= 2) out.push([i, j, diff]);
      }
    }
    return out;
  }

  /** Returns true if any compatible resident (affinity >= 28) is currently in `zone`. */
  hasCompatibleInZone(id: ResidentId, zone: V3ZoneId, participants: readonly SocialParticipantView[]): boolean {
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (p.id === id || p.zone !== zone || p.talking || p.v3SceneLocked) continue;
      if (this.getAffinity(id, p.id) >= 28) return true;
    }
    return false;
  }

  private pairKey(a: ResidentId, b: ResidentId): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  /**
   * Floor-proven natural semicircular / open-triangle formation solver for 2–3 residents.
   * Guarantees every non-seated slot satisfies `nav.walk.free(slot)`, floor-height delta < 0.15 m,
   * door clearance > 1.4 m, separation from non-members > 0.95 m, and `nav.clear` reachability.
   */
  private solveFormation(
    nav: LifeNav,
    members: readonly SocialParticipantView[],
    allParticipants: readonly SocialParticipantView[],
  ): { center: P; slots: Record<string, GroupSlot> } | null {
    if (members.length < 2 || members.length > 3) return null;
    const memberSet = new Set<ResidentId>(members.map(m => m.id));

    // Anchor around the first seated member if any, otherwise the first member
    const anchor = members.find(m => m.seated) ?? members[0];
    const anchorY = nav.walk.groundAt(anchor.x, anchor.z);
    if (anchorY === null) return null;

    const slotValid = (cand: P, from: P): boolean => {
      if (!nav.walk.free(cand)) return false;
      const cy = nav.walk.groundAt(cand.x, cand.z);
      if (cy === null || Math.abs(cy - anchorY) >= 0.15) return false;
      for (let i = 0; i < nav.doors.length; i++) {
        const dr = nav.doors[i];
        if (Math.hypot(cand.x - dr.x, cand.z - dr.z) <= 1.4) return false;
      }
      for (let i = 0; i < allParticipants.length; i++) {
        const o = allParticipants[i];
        if (memberSet.has(o.id)) continue;
        if (Math.hypot(cand.x - o.x, cand.z - o.z) < 0.95) return false;
      }
      return nav.clear(from, cand);
    };

    const baseAngle = Math.atan2(members[1].x - anchor.x, members[1].z - anchor.z);

    if (members.length === 2) {
      const [m0, m1] = [anchor, members.find(m => m.id !== anchor.id)!];
      // If both are already seated within comfortable conversational distance (<= 2.6 m), keep both seated!
      if (m0.seated && m1.seated && Math.hypot(m0.x - m1.x, m0.z - m1.z) <= 2.6) {
        const center = { x: (m0.x + m1.x) * 0.5, z: (m0.z + m1.z) * 0.5 };
        return {
          center,
          slots: {
            [m0.id]: { x: m0.x, z: m0.z, yaw: m0.yaw, seatId: m0.seatId },
            [m1.id]: { x: m1.x, z: m1.z, yaw: m1.yaw, seatId: m1.seatId },
          },
        };
      }
      for (let k = 0; k < 8; k++) {
        const ang = baseAngle + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 4);
        const dist = 1.28;
        const p1 = { x: m0.x + Math.sin(ang) * dist, z: m0.z + Math.cos(ang) * dist };
        if (!slotValid(p1, { x: m1.x, z: m1.z })) continue;
        const center = { x: (m0.x + p1.x) * 0.5, z: (m0.z + p1.z) * 0.5 };
        const yaw0 = m0.seated ? m0.yaw : Math.atan2(p1.x - m0.x, p1.z - m0.z) + 0.16;
        const yaw1 = Math.atan2(m0.x - p1.x, m0.z - p1.z) - 0.16;
        return {
          center,
          slots: {
            [m0.id]: { x: m0.x, z: m0.z, yaw: yaw0, seatId: m0.seatId },
            [m1.id]: { x: p1.x, z: p1.z, yaw: yaw1, seatId: null },
          },
        };
      }
      return null;
    }

    // 3-member open semicircle / casual triangle (angles 0°, 115°, 230° -> 130° open sightline gap)
    const others = members.filter(m => m.id !== anchor.id);
    const radius = 0.86;
    const arcOffsets = [0, (115 * Math.PI) / 180, (230 * Math.PI) / 180];

    for (let rotIdx = 0; rotIdx < 6; rotIdx++) {
      const rot = baseAngle + (rotIdx * Math.PI) / 3;
      // Place centroid offset from anchor along `rot` so anchor stays right where they are
      const cx = anchor.x + Math.sin(rot) * radius;
      const cz = anchor.z + Math.cos(rot) * radius;
      const a0 = Math.atan2(anchor.x - cx, anchor.z - cz);
      const p1 = { x: cx + Math.sin(a0 + arcOffsets[1]) * radius, z: cz + Math.cos(a0 + arcOffsets[1]) * radius };
      const p2 = { x: cx + Math.sin(a0 + arcOffsets[2]) * radius, z: cz + Math.cos(a0 + arcOffsets[2]) * radius };

      // Check mutual pairwise distance >= 1.05 m
      if (
        Math.hypot(p1.x - anchor.x, p1.z - anchor.z) < 1.05 ||
        Math.hypot(p2.x - anchor.x, p2.z - anchor.z) < 1.05 ||
        Math.hypot(p1.x - p2.x, p1.z - p2.z) < 1.05
      ) {
        continue;
      }

      const o1 = others[0];
      const o2 = others[1];
      const s1: GroupSlot | null = o1.seated && Math.hypot(o1.x - cx, o1.z - cz) <= 2.2
        ? { x: o1.x, z: o1.z, yaw: o1.yaw, seatId: o1.seatId }
        : slotValid(p1, { x: o1.x, z: o1.z })
          ? { x: p1.x, z: p1.z, yaw: Math.atan2(cx - p1.x, cz - p1.z), seatId: null }
          : null;
      if (!s1) continue;

      const s2: GroupSlot | null = o2.seated && Math.hypot(o2.x - cx, o2.z - cz) <= 2.2
        ? { x: o2.x, z: o2.z, yaw: o2.yaw, seatId: o2.seatId }
        : slotValid(p2, { x: o2.x, z: o2.z })
          ? { x: p2.x, z: p2.z, yaw: Math.atan2(cx - p2.x, cz - p2.z), seatId: null }
          : null;
      if (!s2) continue;

      // Ensure final chosen slots do not collide with each other
      if (Math.hypot(s1.x - s2.x, s1.z - s2.z) < 1.0) continue;

      const anchorYaw = anchor.seated ? anchor.yaw : Math.atan2(cx - anchor.x, cz - anchor.z);
      return {
        center: { x: cx, z: cz },
        slots: {
          [anchor.id]: { x: anchor.x, z: anchor.z, yaw: anchorYaw, seatId: anchor.seatId },
          [o1.id]: s1,
          [o2.id]: s2,
        },
      };
    }

    return null;
  }

  /**
   * Run social simulation tick (recommended cadence: 2 Hz / every 0.5 s).
   * Updates active emergent gatherings, dissolves broken ones, forms new 2–3 resident clusters,
   * and returns per-member choreography directives (`lookAt`, `faceYaw`, `activity`, `slot`).
   */
  step(
    s: V3State,
    nav: LifeNav,
    mind: NpcMindEngine,
    participants: readonly SocialParticipantView[],
    env: EnvSnapshot,
    elapsed: number,
  ): Map<ResidentId, SocialMemberDirective> {
    const byId = new Map<ResidentId, SocialParticipantView>();
    for (let i = 0; i < participants.length; i++) {
      byId.set(participants[i].id, participants[i]);
    }

    // 1. Validate & advance existing emergent groups
    for (const [gid, g] of [...this.groups.entries()]) {
      let valid = elapsed < g.expiresElapsed;
      if (valid) {
        for (const mid of g.members) {
          const p = byId.get(mid);
          const m = mind.minds.get(mid);
          if (!p || p.zone !== g.zone || p.talking || p.v3SceneLocked || !m || m.mood === 'tired' || m.needs.energy < 18) {
            valid = false;
            break;
          }
          // If member wandered > 4.5 m from their slot while moving away to a new goal, dissolve cleanly
          const sl = g.slots[mid];
          if (p.moving && sl && Math.hypot(p.x - sl.x, p.z - sl.z) > 4.5) {
            valid = false;
            break;
          }
        }
      }

      if (!valid) {
        // Record cooldown so the same pair doesn't immediately re-lock
        for (let i = 0; i < g.members.length; i++) {
          this.memberToGroup.delete(g.members[i]);
          for (let j = i + 1; j < g.members.length; j++) {
            this.pairCooldown.set(this.pairKey(g.members[i], g.members[j]), elapsed + 45);
          }
        }
        this.groups.delete(gid);
        continue;
      }

      // Award affinity & social/fun replenishment after >= 15 s together
      if (!g.affinityAwarded && elapsed - g.startedElapsed >= 15) {
        g.affinityAwarded = true;
        for (let i = 0; i < g.members.length; i++) {
          const a = g.members[i];
          const ma = mind.minds.get(a);
          if (ma) {
            ma.needs.social = Math.min(100, ma.needs.social + 14);
            ma.needs.fun = Math.min(100, ma.needs.fun + 8);
          }
          for (let j = i + 1; j < g.members.length; j++) {
            const b = g.members[j];
            this.adjustAffinity(a, b, 2);
            mind.recordMemory(a, {
              kind: 'social_chat',
              day: s.day,
              clock: s.clock,
              subject: b,
              valence: 0.45,
              salience: 0.4,
            });
            mind.recordMemory(b, {
              kind: 'social_chat',
              day: s.day,
              clock: s.clock,
              subject: a,
              valence: 0.45,
              salience: 0.4,
            });
          }
        }
      }

      // Speaker turn-taking rotation (extraversion-weighted) + 4-beat grammar & Beat 2 gossip
      if (elapsed >= g.nextTurnElapsed) {
        if (g.beat === 2 && !g.gossipPropagatedInArc) {
          this.propagateGroupGossip(s, g, mind);
        }
        g.turnCount++;
        const nextIdx = this.pickNextSpeaker(g.members, g.speakerIndex, g.turnCount);
        g.speakerIndex = nextIdx;
        const sp = RESIDENT_PROFILES[g.members[nextIdx]];
        const duration = 4.6 + sp.traits.extraversion * 2.4;
        g.nextTurnElapsed = elapsed + duration;

        if (elapsed >= g.nextBanterAllowedElapsed) {
          const nextBeat = ((g.beat + 1) % 4) as 0 | 1 | 2 | 3;
          if (nextBeat === 0) g.gossipPropagatedInArc = false;
          this.emitBanterBeat(s, g, mind, env, nextBeat, elapsed);
          if (nextBeat === 2 && !g.gossipPropagatedInArc) {
            this.propagateGroupGossip(s, g, mind);
          }
          if (nextBeat === 3) {
            // Pause gently after completing a full 4-beat exchange before starting another arc
            g.nextBanterAllowedElapsed = elapsed + 16;
          }
        }
      }

      if (g.banterText && elapsed >= g.banterUntilElapsed) {
        g.banterText = null;
      }
    }

    // 2. Discover new 2–3 resident emergent gatherings per zone among free settled residents
    const freeByZone = new Map<V3ZoneId, SocialParticipantView[]>();
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (p.moving || p.talking || p.v3SceneLocked || this.memberToGroup.has(p.id)) continue;
      const m = mind.minds.get(p.id);
      if (!m || m.needs.energy < 22 || m.needs.social >= 88 || m.mood === 'tired') continue;
      const list = freeByZone.get(p.zone);
      if (list) list.push(p);
      else freeByZone.set(p.zone, [p]);
    }

    for (const [zone, free] of freeByZone) {
      if (free.length < 2) continue;
      const used = new Set<ResidentId>();

      // Sort deterministically by resident id for stable clustering
      free.sort((a, b) => (a.id < b.id ? -1 : 1));

      for (let i = 0; i < free.length; i++) {
        const a = free[i];
        if (used.has(a.id)) continue;

        // Find best compatible partner within 12 m
        let bestB: SocialParticipantView | null = null;
        let bestAff = 27; // threshold >= 28
        for (let j = i + 1; j < free.length; j++) {
          const b = free[j];
          if (used.has(b.id)) continue;
          if ((this.pairCooldown.get(this.pairKey(a.id, b.id)) ?? 0) > elapsed) continue;
          if (Math.hypot(a.x - b.x, a.z - b.z) > 12) continue;
          const aff = this.getAffinity(a.id, b.id);
          if (aff > bestAff) {
            bestAff = aff;
            bestB = b;
          }
        }
        if (!bestB) continue;

        const cluster: SocialParticipantView[] = [a, bestB];

        // Optional 3rd compatible resident in the same zone within 12 m
        let bestC: SocialParticipantView | null = null;
        let bestAvg = 31; // threshold avg >= 32 & min >= 24
        for (let k = 0; k < free.length; k++) {
          const c = free[k];
          if (c.id === a.id || c.id === bestB.id || used.has(c.id)) continue;
          if (Math.hypot(a.x - c.x, a.z - c.z) > 12) continue;
          if ((this.pairCooldown.get(this.pairKey(a.id, c.id)) ?? 0) > elapsed) continue;
          if ((this.pairCooldown.get(this.pairKey(bestB.id, c.id)) ?? 0) > elapsed) continue;
          const affAC = this.getAffinity(a.id, c.id);
          const affBC = this.getAffinity(bestB.id, c.id);
          const avg = (affAC + affBC) * 0.5;
          if (Math.min(affAC, affBC) >= 24 && avg > bestAvg) {
            bestAvg = avg;
            bestC = c;
          }
        }
        if (bestC) cluster.push(bestC);

        // Try 3-person formation first; fall back gracefully to 2-person formation if space is tight
        let formation = this.solveFormation(nav, cluster, participants);
        if (!formation && cluster.length === 3) {
          cluster.pop();
          formation = this.solveFormation(nav, cluster, participants);
        }
        if (!formation) continue;

        const ids = cluster.map(c => c.id);
        const gid = `eg:${zone}:${[...ids].sort().join('+')}`;
        const topic = pickTopic(ids, zone, env);
        const firstSpeaker = this.pickNextSpeaker(ids, -1, 0);
        const spProf = RESIDENT_PROFILES[ids[firstSpeaker]];

        const group: EmergentGroup = {
          id: gid,
          zone,
          members: ids,
          center: formation.center,
          slots: formation.slots,
          topic,
          speakerIndex: firstSpeaker,
          nextTurnElapsed: elapsed + 4.8 + spProf.traits.extraversion * 2.2,
          startedElapsed: elapsed,
          expiresElapsed: elapsed + 40 + (hashStr(gid) % 25),
          affinityAwarded: false,
          banterText: null,
          banterUntilElapsed: elapsed + 4.0,
          nextBanterAllowedElapsed: elapsed,
          turnCount: 0,
          beat: 0,
          banterMicroCue: 'chat',
          gossipPropagatedInArc: false,
        };
        this.emitBanterBeat(s, group, mind, env, 0, elapsed);
        this.groups.set(gid, group);
        for (const id of ids) {
          used.add(id);
          this.memberToGroup.set(id, gid);
        }
      }
    }

    // 3. Emit per-member choreography directives
    this.directivesScratch.clear();
    for (const g of this.groups.values()) {
      const speakerId = g.members[g.speakerIndex];
      const speakerSlot = g.slots[speakerId] ?? g.center;
      const speakerMood = mind.minds.get(speakerId)?.mood ?? 'relaxed';

      for (let i = 0; i < g.members.length; i++) {
        const mid = g.members[i];
        const slot = g.slots[mid];
        const view = byId.get(mid);
        if (!slot || !view) continue;
        const isSpeaker = i === g.speakerIndex;
        const lookAt = isSpeaker
          ? g.center
          : { x: speakerSlot.x, z: speakerSlot.z };
        const faceYaw = slot.seatId
          ? slot.yaw
          : Math.atan2(lookAt.x - view.x, lookAt.z - view.z);

        let activity: ExpressiveActivity = view.seated ? 'sit' : 'idle';
        if (isSpeaker) {
          const laughBurst =
            (speakerMood === 'cheerful' || speakerMood === 'excited') &&
            g.nextTurnElapsed - elapsed < 1.2;
          activity = view.seated ? (laughBurst ? 'laugh' : 'chat') : laughBurst ? 'laugh' : 'chat';
        } else {
          // Subtle listener nod window during middle of speaker's turn
          const timeLeft = g.nextTurnElapsed - elapsed;
          const nodWindow = timeLeft > 1.6 && timeLeft < 2.9;
          activity = view.seated ? (nodWindow ? 'nod' : 'sit') : nodWindow ? 'nod' : 'idle';
        }

        this.directivesScratch.set(mid, {
          groupId: g.id,
          slot,
          lookAt,
          faceYaw,
          activity,
          isSpeaker,
        });
      }
    }

    return this.directivesScratch;
  }

  /**
   * Returns at most ONE unobtrusive overheard banter line for the closest qualifying group within 7.5 m.
   * Suppressed when player moves faster than 2.0 m/s so driving/sprinting stays clean.
   */
  overheardBanterNear(
    player: P | null,
    playerZone: V3ZoneId | null,
    playerSpeed: number,
    elapsed: number,
  ): OverheardBanter | null {
    if (!player || playerSpeed > 2.0) return null;
    let best: OverheardBanter | null = null;
    let bestDist = 7.5;

    for (const g of this.groups.values()) {
      if (!g.banterText || elapsed >= g.banterUntilElapsed) continue;
      // Indoor groups are only overheard when inside the same zone
      const indoorZone = !['street', 'park', 'fair', 'greenway', 'campus', 'botanical', 'lantern_garden', 'fountain_plaza', 'yard'].includes(g.zone);
      if (indoorZone && playerZone !== g.zone) continue;

      const d = Math.hypot(g.center.x - player.x, g.center.z - player.z);
      if (d < bestDist) {
        bestDist = d;
        const spId = g.members[g.speakerIndex];
        best = {
          groupId: g.id,
          speakerId: spId,
          speakerName: CHARACTERS[spId]?.name ?? spId,
          text: g.banterText,
          dist: d,
          beat: g.beat,
          topic: g.topic,
        };
      }
    }
    return best;
  }

  private recentRingFor(id: ResidentId): Uint16Array {
    let ring = this.banterHistory.get(id);
    if (!ring) {
      ring = new Uint16Array(8);
      this.banterHistory.set(id, ring);
    }
    return ring;
  }

  private pickBanterMemory(mind: NpcMindEngine, id: ResidentId, currentDay: number): EpisodicMemory | null {
    const mState = mind.minds.get(id);
    if (!mState) return null;
    let best: EpisodicMemory | null = null;
    let bestScore = -1;
    const scan = (list: readonly EpisodicMemory[]) => {
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m.kind === 'player_greet' || m.kind === 'social_chat') continue;
        if (currentDay - m.day > 3 || m.salience < 0.55) continue;
        const sc = m.salience * 2 - Math.max(0, currentDay - m.day) * 0.2;
        if (sc > bestScore) {
          bestScore = sc;
          best = m;
        }
      }
    };
    scan(mState.ltm);
    scan(mState.stm);
    return best;
  }

  private emitBanterBeat(
    s: V3State,
    g: EmergentGroup,
    mind: NpcMindEngine,
    env: EnvSnapshot,
    beat: 0 | 1 | 2 | 3,
    elapsed: number,
  ): void {
    const speakerId = g.members[g.speakerIndex];
    const partnerId = g.members[(g.speakerIndex + 1) % g.members.length];
    const spProf = RESIDENT_PROFILES[speakerId];
    const spMind = mind.minds.get(speakerId);
    const mem = beat === 0 || beat === 2 ? this.pickBanterMemory(mind, speakerId, s.day) : null;
    const witnessName = mem?.src ? CHARACTERS[mem.src]?.name ?? mem.src : undefined;
    const repScore = mind.getDistrictReputation(g.zone).score;

    const result = composeBanterBeat({
      beat,
      topic: g.topic,
      speakerId,
      speakerName: CHARACTERS[speakerId]?.name ?? speakerId,
      partnerId,
      partnerName: CHARACTERS[partnerId]?.name ?? partnerId,
      tone: resolveBanterTone(spProf.traits),
      mood: spMind?.mood ?? 'relaxed',
      zone: g.zone,
      weatherId: env.weatherId,
      rainIntensity: env.rainIntensity,
      snowIntensity: env.snowIntensity,
      season: env.season,
      phase: env.phase,
      affinity: this.getAffinity(speakerId, partnerId),
      currentDay: s.day,
      seed: (Number.isFinite(s.seed) ? Math.floor(s.seed) : 1) + hashStr(g.id) + g.turnCount * 31,
      activity: spMind?.goal.activity,
      memory: mem,
      witnessName,
      districtRep: repScore,
      recentIds: this.recentRingFor(speakerId),
    });

    g.beat = beat;
    g.banterText = result.text;
    g.banterMicroCue = result.microCue;
    g.banterUntilElapsed = elapsed + 4.0;
  }

  private propagateGroupGossip(s: V3State, g: EmergentGroup, mind: NpcMindEngine): void {
    g.gossipPropagatedInArc = true;
    const speakerId = g.members[g.speakerIndex];
    // Primary direction: active speaker shares with each listening friend (affinity >= 10)
    for (let i = 0; i < g.members.length; i++) {
      const other = g.members[i];
      if (other === speakerId) continue;
      const aff = this.getAffinity(speakerId, other);
      if (aff < 10) continue;
      const shared = mind.propagateGossip(speakerId, other, aff, s.day, s.clock);
      if (!shared) {
        // Fallback: allow friend to share their fresh witness memory with the speaker
        mind.propagateGossip(other, speakerId, aff, s.day, s.clock);
      }
    }
  }

  private pickNextSpeaker(members: readonly ResidentId[], prevIdx: number, turnCount: number): number {
    if (members.length <= 1) return 0;
    let bestIdx = (prevIdx + 1) % members.length;
    let bestScore = -Infinity;
    for (let i = 0; i < members.length; i++) {
      if (i === prevIdx) continue;
      const e = RESIDENT_PROFILES[members[i]].traits.extraversion;
      const noise = ((hashStr(`${members[i]}:${turnCount}`) % 100) / 100) * 0.45;
      const sc = e * 0.75 + noise;
      if (sc > bestScore) {
        bestScore = sc;
        bestIdx = i;
      }
    }
    return bestIdx;
  }
}
