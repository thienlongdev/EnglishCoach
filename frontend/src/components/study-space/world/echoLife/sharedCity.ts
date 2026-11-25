import { Client } from '@stomp/stompjs';
import { apiClient } from '@/services/api-client';
import * as T from 'three';
import { authEnding, authEpoch, subscribeAuthLifecycle } from '@/lib/auth-lifecycle';
import { csrfToken, refreshApiSessionOutcome } from '@/lib/api-session';
import { getWsUrl } from '@/services/stompClient';
import { ArenaCharacter } from '@/components/features/speaking/arena/ArenaCharacter';
import { loadCast } from '../character';
import { decodeLookV2 } from '@/lib/avatar/characterCreator';
import { Wardrobe } from '@/lib/avatar/wardrobe';
import { setSkinToneUniform } from './characterMaterials';
import type { EchoLifeWorld } from './world';
import type { Label } from './gameView';
import type { EchoLifeGame } from '@/lib/echo-life/game/session';
import {
  acquireLifeAsset,
  bicycleModel,
  installGltfTextureDedupPlugin,
  releaseLifeAsset,
  stripTransmissionFromHierarchy,
} from './assets';
import {
  KICKSTAND_FOLD_RAD,
  extractVehicleRig,
  type VehicleRigSockets,
} from './vehicleRigExtractor';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { rideModels } from '@/lib/echo-life/game/twoWheeler';
import { SharedCourt, type CourtFrame } from './sharedCourt';
import type { HumanRig } from '@/lib/embodiment/human';
import { disposeObjectTree } from './scratch';

const sharedBikeLoader = new GLTFLoader();
installGltfTextureDedupPlugin(sharedBikeLoader, { isHero: false });

type Model = 'KAI' | 'LYRA';

export type SharedVehicleModel = 'mango' | 'lotus' | 'river' | 'halo' | 'vesper' | 'cafe_racer' | 'bike';
export type SharedEmote = 'wave' | 'clap' | 'cheer' | 'laugh' | 'dance' | 'point' | 'toast';
export type SharedQuickChatId =
  | 'qc_hi'
  | 'qc_good_morning'
  | 'qc_nice_look'
  | 'qc_study_together'
  | 'qc_bistro_coffee'
  | 'qc_library_quiet'
  | 'qc_great_job'
  | 'qc_practice_english'
  | 'qc_follow_me'
  | 'qc_wait_a_sec'
  | 'qc_badminton'
  | 'qc_basketball'
  | 'qc_listen_music'
  | 'qc_take_photo'
  | 'qc_thank_you'
  | 'qc_bye';

export const SHARED_EMOTES: ReadonlySet<string> = new Set<SharedEmote>([
  'wave', 'clap', 'cheer', 'laugh', 'dance', 'point', 'toast',
]);

export const QUICK_CHAT_LABELS: Readonly<Record<SharedQuickChatId, string>> = {
  qc_hi: 'Hi there!',
  qc_good_morning: 'Good morning!',
  qc_nice_look: 'Nice outfit!',
  qc_study_together: 'Want to study together?',
  qc_bistro_coffee: 'Coffee at Willow Bistro?',
  qc_library_quiet: 'Heading to the library.',
  qc_great_job: 'Great job!',
  qc_practice_english: 'Let us practice English!',
  qc_follow_me: 'Follow me!',
  qc_wait_a_sec: 'Wait a second!',
  qc_badminton: 'Up for badminton?',
  qc_basketball: 'Shoot some hoops?',
  qc_listen_music: 'Love this music!',
  qc_take_photo: 'Let us take a photo!',
  qc_thank_you: 'Thank you!',
  qc_bye: 'See you later!',
};

export interface VehiclePoseWire {
  model: SharedVehicleModel;
  paint: string;
  lights: number;
}

type Pose = {
  zone: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  model: Model;
  roomSize?: number;
  posture?: 'seated' | 'mounted' | 'airborne';
  vehicle?: VehiclePoseWire;
};

type Peer = {
  id: number;
  name: string;
  pose: Pose;
  emote: string | null;
  emoteAt: number;
  look?: string | null;
  quickChat?: string | null;
  quickChatAt?: number | null;
};

export interface PeerQuickChatBubble {
  peerId: number;
  name: string;
  code: string;
  text: string;
  x: number;
  y: number;
  dist: number;
  at: number;
}

type Equipment = { id: string; zone: string; x: number; z: number; yaw: number; holder?: number | null; revision: number };
type Intent = { action: 'claim' | 'release'; item: string; revision: number };
type Gathering = {
  invitation: string;
  id: string;
  title: string;
  zone: string;
  x: number;
  z: number;
  present: number;
  ready: number;
  nearby: boolean;
  joined: boolean;
  readySelf: boolean;
  organizer: boolean;
  celebrated: boolean;
};
export type GatheringAction = 'join' | 'ready' | 'leave' | 'end';
type Frame = {
  room: string;
  seq: number;
  peers: Peer[];
  equipment: Equipment[];
  actionResult?: string | null;
  court?: CourtFrame | null;
  event?: Gathering | null;
};

interface PeerVehicleShell {
  group: T.Group;
  kind: 'car' | 'two';
  bodyMat: T.MeshStandardMaterial;
  headMat: T.MeshStandardMaterial;
  tailMat: T.MeshStandardMaterial;
  ownedGeos: T.BufferGeometry[];
  ownedMats: T.Material[];
}

type Remote = {
  model: Model;
  body?: ArenaCharacter;
  v2Wardrobe?: Wardrobe | null;
  look?: string | null;
  shell?: PeerVehicleShell | null;
  retryAt?: number;
};

export type CityConnection = 'connecting' | 'connected' | 'offline' | 'full';
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const BASE_RECONNECT_MS = 1800;
const MAX_RECONNECT_MS = 15000;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const publicZones = new Set([
  'street', 'yard', 'park', 'campus', 'fair', 'greenway', 'botanical',
  'lantern_garden', 'fountain_plaza', 'cafe', 'bistro', 'market', 'electronics_shop',
  'furniture_shop', 'clothing_shop', 'vehicle_dealer', 'home_center', 'repair_shop', 'library', 'atelier',
]);

function mapGameVehicleModel(raw: string | undefined): SharedVehicleModel {
  const s = (raw || '').toLowerCase();
  if (s.includes('mango')) return 'mango';
  if (s.includes('lotus')) return 'lotus';
  if (s.includes('river')) return 'river';
  if (s.includes('halo')) return 'halo';
  if (s.includes('vesper') || s.includes('scooter')) return 'vesper';
  if (s.includes('cafe') || s.includes('racer') || s.includes('moto')) return 'cafe_racer';
  return 'bike';
}

function buildPeerVehicleShell(kind: 'car' | 'two'): PeerVehicleShell {
  const group = new T.Group();
  group.name = `echo-life-peer-vehicle-${kind}`;
  const ownedGeos: T.BufferGeometry[] = [];
  const ownedMats: T.Material[] = [];

  const bodyMat = new T.MeshStandardMaterial({ color: '#e6a817', roughness: 0.24, metalness: 0.45 });
  const glassMat = new T.MeshStandardMaterial({ color: '#1b2b38', roughness: 0.12, metalness: 0.2, transparent: true, opacity: 0.62 });
  const wheelMat = new T.MeshStandardMaterial({ color: '#181b20', roughness: 0.85, metalness: 0.05 });
  const headMat = new T.MeshStandardMaterial({ color: '#fff7e0', emissive: '#ffe9b8', emissiveIntensity: 0.4, roughness: 0.15 });
  const tailMat = new T.MeshStandardMaterial({ color: '#b81414', emissive: '#ff1818', emissiveIntensity: 0.55, roughness: 0.12 });
  ownedMats.push(bodyMat, glassMat, wheelMat, headMat, tailMat);

  if (kind === 'car') {
    const chassisGeo = new T.BoxGeometry(1.66, 0.58, 3.35);
    const cabinGeo = new T.BoxGeometry(1.42, 0.54, 1.72);
    const wheelGeo = new T.CylinderGeometry(0.31, 0.31, 0.22, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    const lampGeo = new T.BoxGeometry(0.32, 0.10, 0.06);
    ownedGeos.push(chassisGeo, cabinGeo, wheelGeo, lampGeo);

    const chassis = new T.Mesh(chassisGeo, bodyMat);
    chassis.position.set(0, 0.56, 0);
    chassis.castShadow = true;
    const cabin = new T.Mesh(cabinGeo, glassMat);
    cabin.position.set(0, 1.06, -0.10);
    group.add(chassis, cabin);

    for (const [wx, wz] of [[-0.80, 1.06], [0.80, 1.06], [-0.80, -1.06], [0.80, -1.06]]) {
      const w = new T.Mesh(wheelGeo, wheelMat);
      w.position.set(wx, 0.31, wz);
      group.add(w);
    }
    for (const lx of [-0.54, 0.54]) {
      const hl = new T.Mesh(lampGeo, headMat);
      hl.position.set(lx, 0.58, 1.68);
      const tl = new T.Mesh(lampGeo, tailMat);
      tl.position.set(lx, 0.60, -1.68);
      group.add(hl, tl);
    }
  } else {
    const frameGeo = new T.BoxGeometry(0.38, 0.44, 1.48);
    const wheelGeo = new T.CylinderGeometry(0.30, 0.30, 0.12, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    const lampGeo = new T.BoxGeometry(0.16, 0.10, 0.06);
    ownedGeos.push(frameGeo, wheelGeo, lampGeo);

    const frame = new T.Mesh(frameGeo, bodyMat);
    frame.position.set(0, 0.56, 0);
    frame.castShadow = true;
    const wf = new T.Mesh(wheelGeo, wheelMat);
    wf.position.set(0, 0.30, 0.62);
    const wr = new T.Mesh(wheelGeo, wheelMat);
    wr.position.set(0, 0.30, -0.62);
    const hl = new T.Mesh(lampGeo, headMat);
    hl.position.set(0, 0.72, 0.76);
    const tl = new T.Mesh(lampGeo, tailMat);
    tl.position.set(0, 0.68, -0.76);
    group.add(frame, wf, wr, hl, tl);
  }

  group.visible = false;
  return { group, kind, bodyMat, headMat, tailMat, ownedGeos, ownedMats };
}

function disposePeerVehicleShell(shell: PeerVehicleShell): void {
  shell.group.removeFromParent();
  for (const g of shell.ownedGeos) g.dispose();
  for (const m of shell.ownedMats) m.dispose();
}

/** A room member opts in. This connection owns remote visual replicas only. */
export class SharedCityPresence {
  readonly court = new SharedCourt();
  readonly group = new T.Group();
  private readonly socket: Client;
  private readonly unbindAuth: () => void;
  private readonly epoch = authEpoch();
  private readonly remotes = new Map<number, Remote>();
  private readonly shellPool: { car: PeerVehicleShell[]; two: PeerVehicleShell[] } = { car: [], two: [] };
  private readonly target = new T.Vector3();
  private frame: Frame | null = null;
  private lastReceived = 0;
  private lastSent = -Infinity;
  private lastSentPose: Pose | null = null;
  private worldFullUntil = 0;
  private reconnectAttempts = 0;
  private seq = 0;
  private emote: SharedEmote | null = null;
  private quickChat: SharedQuickChatId | null = null;
  private localLookWire: string | null = null;
  private lookDirty = false;
  private status: CityConnection = 'connecting';
  private disposed = false;
  private bike: T.Group | null = null;
  private bikeAcquired = false;
  private bikeUsedAsset = false;
  private game: EchoLifeGame | null = null;
  private nearby: Equipment | null = null;
  private intent: Intent | null = null;
  private waitingUntil = 0;

  constructor(
    readonly room: string,
    readonly learner: number,
    private onStatus: (s: CityConnection) => void,
    readonly clockOffset = 0,
  ) {
    this.group.name = 'echo-life-shared-city';
    this.socket = new Client({
      brokerURL: getWsUrl(),
      heartbeatIncoming: 10000,
      heartbeatOutgoing: 10000,
      reconnectDelay: BASE_RECONNECT_MS,
      debug: () => {},
      beforeConnect: async () => {
        while (this.current() && this.socket.active) {
          if (csrfToken()) return;
          const session = await refreshApiSessionOutcome();
          if (session === 'ok' && this.current()) return;
          if (session === 'ended' || !this.current()) break;
          this.setStatus('offline');
          await new Promise(resolve => setTimeout(resolve, this.nextBackoffMs()));
        }
        this.dispose();
      },
      onConnect: () => {
        if (!this.current()) return;
        this.reconnectAttempts = 0;
        this.socket.reconnectDelay = BASE_RECONNECT_MS;
        this.worldFullUntil = 0;
        if (this.localLookWire) this.lookDirty = true;
        this.setStatus('connecting');
        this.lastReceived = performance.now();
        this.socket.subscribe('/user/queue/echo-life', message => {
          if (!this.current()) return;
          const frame = JSON.parse(message.body) as Frame;
          if (frame.room !== room || frame.seq <= (this.frame?.seq ?? -1)) return;
          if (frame.actionResult === 'WORLD_FULL') {
            this.frame = null;
            this.removeAll();
            this.withdrawBike();
            this.court.clear();
            this.lastReceived = performance.now();
            this.worldFullUntil = this.lastReceived + 5000;
            this.setStatus('full');
            return;
          }
          this.frame = frame;
          if (frame.actionResult) {
            this.waitingUntil = 0;
            if (
              (frame.actionResult === 'EQUIPMENT_BUSY' || frame.actionResult === 'INVALID_ACTION') &&
              this.optimisticBikeState === 'claimed'
            ) {
              this.optimisticBikeState = null;
              this.optimisticBikeUntil = 0;
            }
          }
          this.lastReceived = performance.now();
          this.setStatus('connected');
        });
      },
      onWebSocketClose: () => {
        if (this.disposed) return;
        this.eventIntent = null;
        this.frame = null;
        this.lastSentPose = null;
        this.removeAll();
        this.withdrawBike();
        this.court.clear();
        this.socket.reconnectDelay = this.nextBackoffMs();
        this.setStatus('offline');
      },
    });
    this.unbindAuth = subscribeAuthLifecycle(() => { if (!this.current()) this.dispose(); });
    document.addEventListener('visibilitychange', this.visibility);
    this.socket.activate();
  }

  private nextBackoffMs() {
    const exp = Math.min(MAX_RECONNECT_MS, BASE_RECONNECT_MS * Math.pow(2, Math.min(this.reconnectAttempts++, 4)));
    return Math.round(exp * (0.85 + Math.random() * 0.3));
  }

  private current() { return !this.disposed && !authEnding() && this.epoch === authEpoch(); }
  private setStatus(next: CityConnection) {
    if (this.status !== next) { this.status = next; this.onStatus(next); }
  }

  /** Queues any of the 7 backend-verified social emotes (`wave`, `clap`, `cheer`, `laugh`, `dance`, `point`, `toast`). */
  express(action: string) {
    if (SHARED_EMOTES.has(action)) this.emote = action as SharedEmote;
  }

  /** Queues one of the 16 backend-verified English quick-chat phrases (`qc_*`). */
  sendQuickChat(code: string): boolean {
    if (!Object.prototype.hasOwnProperty.call(QUICK_CHAT_LABELS, code)) return false;
    this.quickChat = code as SharedQuickChatId;
    return true;
  }

  /** Updates the local player's compact V2/V1 look wire string (sent once on connect and only when changed!). */
  setLocalLook(wire: string | null | undefined) {
    const next = wire && wire.length <= 256 ? wire : null;
    if (next === this.localLookWire) return;
    this.localLookWire = next;
    if (next) this.lookDirty = true;
  }

  get connected() { return this.current() && this.status === 'connected' && !document.hidden; }
  get gathering() { return this.connected ? this.frame?.event ?? null : null; }
  async inviteToEvent(id: string) {
    if (!this.connected) throw new Error('offline');
    await apiClient.post(`/study-space/shared/${this.room}/events/${encodeURIComponent(id)}`);
  }
  private eventIntent: { invitation: string; action: GatheringAction } | null = null;
  respondToEvent(invitation: string, action: GatheringAction) {
    if (this.gathering?.invitation === invitation) this.eventIntent = { invitation, action };
  }

  private publish(pose: Pose | null) {
    if (!this.socket.connected || !this.current()) return;
    const sendLook = this.lookDirty && this.localLookWire ? this.localLookWire : null;
    this.socket.publish({
      destination: '/app/echo-life/presence',
      body: JSON.stringify({
        room: this.room,
        seq: ++this.seq,
        pose,
        emote: pose ? this.emote : null,
        intent: pose ? this.intent : null,
        court: pose ? this.court.takeIntent() : null,
        event: pose ? this.eventIntent : null,
        look: sendLook,
        quickChat: pose ? this.quickChat : null,
      }),
    });
    if (sendLook) this.lookDirty = false;
    this.eventIntent = null;
    this.intent = null;
    this.emote = null;
    this.quickChat = null;
  }

  private visibility = () => {
    if (document.hidden) {
      this.publish(null);
      this.removeAll();
      this.withdrawBike();
      this.court.clear();
      this.frame = null;
    }
  };

  private poseMoved(prev: Pose | null, next: Pose | null) {
    if (prev === next) return false;
    if (!prev || !next) return true;
    return (
      prev.zone !== next.zone ||
      prev.model !== next.model ||
      prev.posture !== next.posture ||
      prev.vehicle?.model !== next.vehicle?.model ||
      prev.vehicle?.paint !== next.vehicle?.paint ||
      prev.vehicle?.lights !== next.vehicle?.lights ||
      Math.abs(prev.x - next.x) >= 0.01 ||
      Math.abs(prev.z - next.z) >= 0.01 ||
      Math.abs(prev.y - next.y) >= 0.01 ||
      Math.abs(prev.yaw - next.yaw) >= 0.02
    );
  }

  private acquireVehicleShell(kind: 'car' | 'two'): PeerVehicleShell {
    const bucket = this.shellPool[kind];
    const shell = bucket.pop() ?? buildPeerVehicleShell(kind);
    if (shell.group.parent !== this.group) this.group.add(shell.group);
    shell.group.visible = true;
    return shell;
  }

  private releaseVehicleShell(shell: PeerVehicleShell | null | undefined) {
    if (!shell) return;
    shell.group.visible = false;
    this.shellPool[shell.kind].push(shell);
  }

  update(
    dt: number,
    stage: T.Object3D,
    world: EchoLifeWorld,
    body: T.Vector3 | null,
    yaw: number,
    model: Model,
    reduced: boolean,
    game: EchoLifeGame | null,
    rig: HumanRig | null,
    posture?: Pose['posture'],
  ) {
    if (!this.current() || document.hidden) return;
    if (this.group.parent !== stage) stage.add(this.group);
    const now = performance.now();
    const zoneId = body && world.ready ? world.walk.zone(body) : null;
    const zone = zoneId && publicZones.has(zoneId) ? world.city.zones.find(z => z.id === zoneId) : undefined;
    const base = zone?.waypoint;
    if (this.game !== game) { this.withdrawBike(); this.game = game; }
    const floor = body && base ? world.walk.groundAt(body.x, body.z) : null;

    let vehicleWire: VehiclePoseWire | undefined;
    const driven = game?.drivenVehicle;
    const drivenSpec = driven?.spec;
    if (posture === 'mounted' && driven && drivenSpec) {
      const paintRaw = drivenSpec.paintHex ?? '#e6a817';
      const paint = HEX_COLOR_RE.test(paintRaw) ? paintRaw.toLowerCase() : '#e6a817';
      const lights =
        (driven.lights.headlightsOn ? 1 : 0) |
        (driven.lights.braking ? 2 : 0) |
        (driven.lights.blinker === -1 && driven.lights.blinkerLit ? 4 : 0) |
        (driven.lights.blinker === 1 && driven.lights.blinkerLit ? 8 : 0);
      vehicleWire = {
        model: mapGameVehicleModel(drivenSpec.model),
        paint,
        lights,
      };
    } else if (posture === 'mounted' && game?.riding) {
      vehicleWire = { model: 'bike', paint: '#3b6ea5', lights: 0 };
    }

    const nextPose: Pose | null = body && zone && base && floor !== null ? {
      zone: zone.id,
      x: round3(body.x - base.x),
      z: round3(body.z - base.z),
      y: round3(body.y - floor),
      yaw: round3(Math.atan2(Math.sin(yaw), Math.cos(yaw))),
      model,
      roomSize: round3(world.size),
      posture,
      ...(vehicleWire ? { vehicle: vehicleWire } : {}),
    } : null;

    const hasUrgentIntent = !!(this.intent || this.eventIntent);
    const hasPendingAction = !!(this.emote || this.quickChat || this.lookDirty || hasUrgentIntent);
    const moved = this.poseMoved(this.lastSentPose, nextPose);
    const zoneChanged = (this.lastSentPose?.zone ?? null) !== (nextPose?.zone ?? null);
    const activeScene = !!(this.frame && (this.frame.peers.length > 0 || this.frame.court || this.frame.event || this.frame.equipment.some(e => e.holder != null)));
    const interval = now < this.worldFullUntil ? 5000
      : (hasUrgentIntent || zoneChanged) ? 0
      : hasPendingAction ? 90
      : nextPose === null ? 1500
      : (moved || activeScene || this.status !== 'connected') ? 200
      : 1000;
    if (now - this.lastSent >= interval) {
      this.lastSent = now;
      this.lastSentPose = nextPose;
      this.publish(nextPose);
    }
    if (this.socket.connected && this.status !== 'full' && now - this.lastReceived > 3500) this.setStatus('offline');
    const peers = zone && this.status === 'connected' && this.frame ? this.frame.peers : [];
    const item = this.frame?.equipment?.find(
      e => e.id === 'bike' && (e.holder === this.learner || (this.status === 'connected' && !!zone && e.zone === zone.id)),
    );
    this.updateBike(item, base, body, yaw, world, now);
    const court = zoneId === 'park' && this.status === 'connected' ? this.frame?.court ?? null : null;
    this.court.update(court, this.lastReceived, this.group, world, body, base, this.learner, rig,
      id => this.remotes.get(id)?.body?.rig, reduced);
    for (const id of this.remotes.keys()) {
      if (!peers.some(p => p.id === id && p.pose.zone === zoneId)) this.remove(id);
    }
    if (!base) return;
    for (const peer of peers) {
      if (peer.id === this.learner || peer.pose.zone !== zoneId) continue;
      const { x, y, z, yaw: angle, model: hero } = peer.pose;
      const peerFloor = world.walk.groundAt(x + base.x, z + base.z);
      if (peerFloor === null) { this.remove(peer.id); continue; }
      let remote = this.remotes.get(peer.id);
      if (!remote || remote.model !== hero || (remote.retryAt && now >= remote.retryAt)) {
        this.remove(peer.id);
        const entry: Remote = { model: hero, look: peer.look ?? null };
        this.remotes.set(peer.id, entry);
        void loadCast(hero).then(template => {
          if (this.remotes.get(peer.id) !== entry) return;
          const actor = new ArenaCharacter(template, 1, hero);
          actor.root.name = 'echo-life-peer-' + peer.id;
          actor.root.position.set(x + base.x, peerFloor + y, z + base.z);
          actor.root.rotation.y = angle;
          if (entry.look) this.applyPeerLookWire(entry, actor, hero, entry.look);
          entry.body = actor;
          this.group.add(actor.root);
        }).catch(() => { entry.retryAt = performance.now() + 3000; });
        continue;
      }
      const actor = remote.body;
      if (!actor) continue;

      // Sync customized peer look wire live whenever it arrives or changes
      const incomingLook = peer.look ?? null;
      if (incomingLook && incomingLook !== remote.look) {
        remote.look = incomingLook;
        this.applyPeerLookWire(remote, actor, hero, incomingLook);
      }

      const blend = reduced ? 1 : 1 - Math.exp(-12 * dt);
      const atNet = court && (peer.id === court.north || peer.id === court.south);
      const planOffset = atNet ? world.size - (peer.pose.roomSize ?? 6) : 0;
      const seated = peer.pose.posture === 'seated' || peer.pose.posture === 'mounted' || item?.holder === peer.id;
      const mountedVehicle = peer.pose.posture === 'mounted' ? peer.pose.vehicle ?? null : null;
      const isCarVehicle = mountedVehicle && !['vesper', 'cafe_racer', 'bike'].includes(mountedVehicle.model);
      const seatOffsetY = peer.pose.posture === 'seated' ? actor.seatDrop : isCarVehicle ? -0.34 : mountedVehicle ? 0.08 : 0;
      actor.root.position.lerp(this.target.set(x + base.x + planOffset, peerFloor + y + seatOffsetY, z + base.z), blend);
      const delta = angle - actor.root.rotation.y;
      actor.root.rotation.y += Math.atan2(Math.sin(delta), Math.cos(delta)) * blend;

      // Render pooled lightweight peer vehicle shell when mounted in a vehicle
      if (mountedVehicle) {
        const wantKind: 'car' | 'two' = isCarVehicle ? 'car' : 'two';
        if (remote.shell && remote.shell.kind !== wantKind) {
          this.releaseVehicleShell(remote.shell);
          remote.shell = null;
        }
        if (!remote.shell) remote.shell = this.acquireVehicleShell(wantKind);
        remote.shell.group.position.set(actor.root.position.x, peerFloor, actor.root.position.z);
        remote.shell.group.rotation.y = actor.root.rotation.y;
        remote.shell.bodyMat.color.set(mountedVehicle.paint);
        remote.shell.headMat.emissiveIntensity = (mountedVehicle.lights & 1) ? 3.2 : 0.45;
        remote.shell.tailMat.emissiveIntensity = (mountedVehicle.lights & 2) ? 4.0 : 0.55;
      } else if (remote.shell) {
        this.releaseVehicleShell(remote.shell);
        remote.shell = null;
      }

      actor.update(
        dt,
        {
          team: 1,
          ready: false,
          online: true,
          seat: seated ? 'city-seat' : null,
          gesture: peer.emote?.toUpperCase() ?? '',
          gestureAt: peer.emoteAt,
        },
        false,
        false,
        false,
        reduced,
        undefined,
        0,
        peer.pose.posture === 'airborne',
      );
    }
  }

  private withdrawBike() {
    if (this.game?.ridingShared) this.game.dismount(this.game.bike, this.game.bike.yaw);
    if (this.bike) {
      this.bike.visible = false;
      delete this.bike.userData.__ecExternalRigSynced;
    }
    this.nearby = null;
    this.intent = null;
    this.waitingUntil = 0;
    this.optimisticBikeState = null;
    this.optimisticBikeUntil = 0;
    this.wasServerOwnedLastTick = false;
  }
  private disposeBikeModel() {
    if (!this.bike) return;
    this.bike.removeFromParent();
    if (!this.bikeUsedAsset) {
      disposeObjectTree(this.bike, { clearChildren: true });
    }
    this.bike = null;
    this.bikeSockets = null;
    this.bikeWheels = [];
    this.bikeCrankAngle = 0;
    this.lastBikePos = null;
  }
  private bikeSockets: VehicleRigSockets | null = null;
  private bikeWheels: T.Object3D[] = [];
  private bikeSpin = 0;
  private bikeCrankAngle = 0;
  private lastBikePos: { x: number; z: number } | null = null;
  private lastBodyPos: { x: number; z: number } | null = null;
  private lastBodyYaw = 0;
  private cachedBikeEquip: Equipment | null = null;
  private optimisticBikeState: 'claimed' | 'released' | null = null;
  private optimisticBikeUntil = 0;
  private wasServerOwnedLastTick = false;

  private ensureBikeModelLoaded() {
    if (this.bikeAcquired) return;
    this.bikeAcquired = true;
    const articulatedUrl = rideModels.veh_bike_basket?.url;
    if (articulatedUrl) {
      void sharedBikeLoader.loadAsync(articulatedUrl).then(gltf => {
        if (this.disposed) {
          disposeObjectTree(gltf.scene, { clearChildren: true });
          return;
        }
        this.disposeBikeModel();
        stripTransmissionFromHierarchy(gltf.scene);
        const root = new T.Group();
        root.name = 'echo-life-room-bicycle';
        root.add(gltf.scene);
        this.bikeSockets = extractVehicleRig(root, 'veh_bike_basket');
        this.bikeWheels = [...this.bikeSockets.wheelPivots];
        root.traverse(o => {
          const mesh = o as T.Mesh;
          if (mesh.isMesh) mesh.frustumCulled = false;
        });
        root.visible = false;
        this.bikeUsedAsset = false;
        this.bike = root;
        this.group.add(root);
      }).catch(() => {
        if (this.disposed) return;
        this.disposeBikeModel();
        this.bikeUsedAsset = true;
        void acquireLifeAsset('bicycle').then(p => {
          if (!p || this.disposed) {
            if (this.bikeUsedAsset) { releaseLifeAsset('bicycle'); this.bikeUsedAsset = false; }
            return;
          }
          this.bike = bicycleModel(p);
          this.bike.name = 'echo-life-room-bicycle';
          this.bikeSockets = extractVehicleRig(this.bike, 'bicycle');
          this.bikeWheels = [...this.bikeSockets.wheelPivots];
          this.bike.visible = false;
          this.group.add(this.bike);
        });
      });
    }
  }

  private updateBike(
    item: Equipment | undefined,
    base: { x: number; z: number } | undefined,
    body: T.Vector3 | null,
    yaw: number,
    world: EchoLifeWorld,
    now = performance.now(),
  ) {
    if (!this.game) { this.withdrawBike(); return; }
    if (!body) return;

    this.lastBodyPos = { x: body.x, z: body.z };
    this.lastBodyYaw = yaw;

    if (item) {
      this.cachedBikeEquip = item;
      if (this.optimisticBikeState === 'claimed' && item.holder === this.learner) {
        this.optimisticBikeState = null;
        this.optimisticBikeUntil = 0;
      } else if (this.optimisticBikeState === 'released' && item.holder !== this.learner) {
        this.optimisticBikeState = null;
        this.optimisticBikeUntil = 0;
      }
    }

    const optimisticClaimActive = this.optimisticBikeState === 'claimed' && now < this.optimisticBikeUntil;
    const optimisticReleaseActive = this.optimisticBikeState === 'released' && now < this.optimisticBikeUntil;
    const activeEquip = item ?? ((this.game.ridingShared || optimisticClaimActive) ? this.cachedBikeEquip ?? undefined : undefined);

    // Never withdraw or hide the shared bicycle across zone seams or transient STOMP delays while riding or holding lease!
    if (!activeEquip && !this.game.ridingShared && !optimisticClaimActive) {
      this.withdrawBike();
      return;
    }

    const serverOwns = item?.holder === this.learner;
    if (serverOwns && !optimisticReleaseActive) {
      if (!this.game.ridingShared) {
        if (this.wasServerOwnedLastTick) {
          // Local session dismounted (e.g. entered an indoor building): release server lease cleanly instead of re-mounting!
          if (item) {
            this.intent = { action: 'release', item: item.id, revision: item.revision };
            this.optimisticBikeState = 'released';
            this.optimisticBikeUntil = now + 1500;
            this.lastSent = 0;
          }
          this.wasServerOwnedLastTick = false;
        } else if (item) {
          const equipBase = world.city.zones.find(z => z.id === item.zone)?.waypoint ?? base;
          const mountAt = equipBase ? { x: equipBase.x + item.x, z: equipBase.z + item.z } : { x: body.x, z: body.z };
          if (!this.game.mount(body, mountAt).ok) {
            this.intent = { action: 'release', item: item.id, revision: item.revision };
            this.lastSent = 0;
          } else {
            this.wasServerOwnedLastTick = true;
          }
        }
      } else {
        this.wasServerOwnedLastTick = true;
      }
    } else if (item && item.holder !== this.learner && !optimisticClaimActive) {
      this.wasServerOwnedLastTick = false;
      if (this.game.ridingShared) {
        this.game.dismount(body, yaw);
      }
    }

    const owns = !optimisticReleaseActive && (Boolean(this.game.ridingShared) || serverOwns || optimisticClaimActive);
    const equipZoneBase =
      (activeEquip ? world.city.zones.find(z => z.id === activeEquip.zone)?.waypoint : undefined) ?? base;
    const parkedX = activeEquip && equipZoneBase ? equipZoneBase.x + activeEquip.x : body.x;
    const parkedZ = activeEquip && equipZoneBase ? equipZoneBase.z + activeEquip.z : body.z;

    if (activeEquip) {
      this.nearby =
        owns ||
        (activeEquip.holder == null &&
          !this.game.riding &&
          !this.game.drivenVehicle &&
          !this.game.s.held &&
          Math.hypot(body.x - parkedX, body.z - parkedZ) <= 2.4)
          ? activeEquip
          : null;
    } else {
      this.nearby = null;
    }

    this.ensureBikeModelLoaded();
    if (!this.bike) return;

    const bx = owns ? body.x : parkedX;
    const bz = owns ? body.z : parkedZ;
    const byaw = owns ? yaw : (activeEquip?.yaw ?? yaw);

    // Single visual authority: when `gameHost.syncSharedRoomBicycle` drives full 3D lean/fork/crank kinematics,
    // do NOT overwrite `position`/`rotation` or double-spin wheels here!
    if (owns && this.bike.userData.__ecExternalRigSynced === true) {
      this.lastBikePos = { x: bx, z: bz };
      this.bike.visible = true;
      return;
    }

    delete this.bike.userData.__ecExternalRigSynced;
    const wheelR = Math.max(0.12, this.bikeSockets?.wheelRadius ?? 0.337);
    const wheelGroundY = this.bikeSockets?.wheelGroundY ?? 0;
    const riddenByPeer = activeEquip?.holder != null;
    if (this.lastBikePos) {
      const dx = bx - this.lastBikePos.x, dz = bz - this.lastBikePos.z;
      const stepDist = Math.hypot(dx, dz);
      const forward = stepDist < 5 ? dx * Math.sin(byaw) + dz * Math.cos(byaw) : 0;
      this.bikeSpin = (this.bikeSpin + forward / wheelR) % (Math.PI * 2000);
      for (const w of this.bikeWheels) w.rotation.x = this.bikeSpin;
      if (this.bikeSockets && riddenByPeer && Math.abs(forward) > 1e-4) {
        const gear = Math.max(1.0, this.bikeSockets.gearRatio || 2.35);
        this.bikeCrankAngle = (this.bikeCrankAngle + Math.max(0, forward) / (wheelR * gear)) % (Math.PI * 2);
        if (this.bikeSockets.crankPivot) this.bikeSockets.crankPivot.rotation.x = this.bikeCrankAngle;
        if (this.bikeSockets.pedalPivotLeft) this.bikeSockets.pedalPivotLeft.rotation.x = -this.bikeCrankAngle;
        if (this.bikeSockets.pedalPivotRight) this.bikeSockets.pedalPivotRight.rotation.x = -this.bikeCrankAngle;
      }
    }
    if (this.bikeSockets?.kickstandPivot) {
      this.bikeSockets.kickstandPivot.rotation.x = riddenByPeer ? KICKSTAND_FOLD_RAD : 0;
    }
    this.lastBikePos = { x: bx, z: bz };
    this.bike.position.set(bx, (world.walk.groundAt(bx, bz) ?? 0) + wheelGroundY, bz);
    this.bike.rotation.set(0, byaw, 0, 'YXZ');
    this.bike.visible = true;
  }

  bikePrompt() {
    if (!this.bike?.visible) return null;
    if (this.game?.ridingShared) return 'Park shared bicycle';
    if (!this.nearby) return null;
    const now = performance.now();
    const optimisticOwned = this.optimisticBikeState === 'claimed' && now < this.optimisticBikeUntil;
    const optimisticReleased = this.optimisticBikeState === 'released' && now < this.optimisticBikeUntil;
    const heldByMe = !optimisticReleased && (optimisticOwned || this.nearby.holder === this.learner);
    return heldByMe ? 'Park shared bicycle' : 'Ride shared bicycle';
  }

  interactBike() {
    const item = this.nearby ?? (this.game?.ridingShared ? this.cachedBikeEquip : null);
    if (!item || !this.bike?.visible) return false;
    const now = performance.now();
    if (now < this.waitingUntil) return true;

    const optimisticOwned = this.optimisticBikeState === 'claimed' && now < this.optimisticBikeUntil;
    const optimisticReleased = this.optimisticBikeState === 'released' && now < this.optimisticBikeUntil;
    const currentlyOwned =
      Boolean(this.game?.ridingShared) || (!optimisticReleased && (optimisticOwned || item.holder === this.learner));

    if (currentlyOwned) {
      if (this.game?.ridingShared && this.lastBodyPos) {
        this.game.dismount(this.lastBodyPos, this.lastBodyYaw);
      }
      this.optimisticBikeState = 'released';
      this.optimisticBikeUntil = now + 1500;
      this.wasServerOwnedLastTick = false;
      this.intent = { action: 'release', item: item.id, revision: item.revision };
      this.waitingUntil = now + 250;
      this.lastSent = 0;
      return true;
    }

    if (this.game && this.lastBodyPos) {
      const bikePos = { x: this.bike.position.x, z: this.bike.position.z };
      const mounted = this.game.mount(this.lastBodyPos, bikePos);
      if (!mounted.ok) return false;
      this.optimisticBikeState = 'claimed';
      this.optimisticBikeUntil = now + 2000;
    }
    this.intent = { action: 'claim', item: item.id, revision: item.revision };
    this.waitingUntil = now + 250;
    this.lastSent = 0;
    return true;
  }

  /**
   * Applies either a Wave 11 V2 avatar look (`v2:...`: modular 3D hair, layered coats, fabrics, patterns,
   * 10 quantized face morphs, skin/iris/hair tints, and shear-free stature) or a legacy V1 look wire cleanly.
   */
  private applyPeerLookWire(entry: Remote, actor: ArenaCharacter, hero: Model, wire: string): void {
    if (!wire.startsWith('v2:')) {
      if (entry.v2Wardrobe) {
        entry.v2Wardrobe.dispose();
        entry.v2Wardrobe = null;
        actor.look.setBuiltinHairVisible(true);
        actor.look.bindExternalHair(null);
      }
      actor.dress(hero, wire);
      return;
    }

    const profile = decodeLookV2(wire, hero);
    actor.look.setFaceSculpt(profile.faceMorphs);
    actor.look.setSkinTone(profile.skinHex);
    actor.look.setIrisColor(profile.irisHex);
    actor.look.setHairColor(profile.hairColor);
    actor.look.setHairTipColor(profile.hairTipColor, profile.hairTipMix);

    actor.model.traverse(node => {
      const mesh = node as T.Mesh;
      if (!mesh.isMesh || !mesh.name.includes('Hands')) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) setSkinToneUniform(m, profile.skinHex);
    });

    // Shear-free uniform stature scale (never apply non-uniform scale above rotated limbs!)
    const h = T.MathUtils.clamp(profile.body.heightScale, 0.92, 1.12);
    actor.model.scale.setScalar(1.06 * h);
    actor.rig.recalibrateProportions(1.06 * h);

    if (!entry.v2Wardrobe) {
      entry.v2Wardrobe = new Wardrobe(actor.model, hero, 'high', true);
    }
    void entry.v2Wardrobe
      .applyProfile(profile, undefined, {
        attachWorldShaders: true,
        onBuiltinHairVisible: vis => actor.look.setBuiltinHairVisible(vis),
        onExternalHair: grp => actor.look.bindExternalHair(grp),
      })
      .then(() => {
        actor.setShadowLodDistance();
      });
  }

  private remove(id: number) {
    const remote = this.remotes.get(id);
    if (remote?.shell) {
      this.releaseVehicleShell(remote.shell);
      remote.shell = null;
    }
    if (remote?.v2Wardrobe) {
      remote.v2Wardrobe.dispose();
      remote.v2Wardrobe = null;
    }
    const actor = remote?.body;
    if (actor) {
      actor.root.removeFromParent();
      const skeletons = new Set<T.Skeleton>();
      actor.model.traverse(node => { if (node instanceof T.SkinnedMesh) skeletons.add(node.skeleton); });
      actor.dispose();
      skeletons.forEach(s => s.dispose());
    }
    this.remotes.delete(id);
  }
  private removeAll() { for (const id of this.remotes.keys()) this.remove(id); }

  /** Screen-projected quick-chat speech bubbles for nearby remote peers (4 s server TTL). */
  peerQuickChats(camera: T.Camera, width: number, height: number): PeerQuickChatBubble[] {
    const out: PeerQuickChatBubble[] = [];
    for (const peer of this.frame?.peers ?? []) {
      if (!peer.quickChat) continue;
      const text = QUICK_CHAT_LABELS[peer.quickChat as SharedQuickChatId];
      if (!text) continue;
      const actor = this.remotes.get(peer.id)?.body;
      if (!actor) continue;
      actor.root.localToWorld(this.target.set(0, actor.eyeHeight + 0.40, 0));
      const dist = this.target.distanceTo(camera.position);
      if (dist > 18) continue;
      this.target.project(camera);
      if (Math.abs(this.target.z) > 1 || Math.abs(this.target.x) > 1 || Math.abs(this.target.y) > 1) continue;
      out.push({
        peerId: peer.id,
        name: peer.name,
        code: peer.quickChat,
        text,
        x: (this.target.x + 1) * width / 2,
        y: (1 - this.target.y) * height / 2,
        dist,
        at: peer.quickChatAt ?? 0,
      });
    }
    return out;
  }

  labels(camera: T.Camera, width: number, height: number): Label[] {
    const labels: Label[] = [];
    for (const peer of this.frame?.peers ?? []) {
      const actor = this.remotes.get(peer.id)?.body;
      if (!actor) continue;
      actor.root.localToWorld(this.target.set(0, actor.eyeHeight + 0.22, 0));
      const dist = this.target.distanceTo(camera.position);
      if (dist > 12) continue;
      this.target.project(camera);
      if (Math.abs(this.target.z) > 1 || Math.abs(this.target.x) > 1 || Math.abs(this.target.y) > 1) continue;
      const quickChatText = peer.quickChat ? QUICK_CHAT_LABELS[peer.quickChat as SharedQuickChatId] ?? null : null;
      labels.push({
        id: 'peer:' + peer.id,
        name: peer.name,
        role: 'Fellow learner',
        dist,
        focus: false,
        scene: quickChatText,
        x: (this.target.x + 1) * width / 2,
        y: (1 - this.target.y) * height / 2,
      });
    }
    return labels;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unbindAuth();
    document.removeEventListener('visibilitychange', this.visibility);
    void this.socket.deactivate();
    this.removeAll();
    for (const s of this.shellPool.car) disposePeerVehicleShell(s);
    for (const s of this.shellPool.two) disposePeerVehicleShell(s);
    this.shellPool.car.length = 0;
    this.shellPool.two.length = 0;
    this.withdrawBike();
    this.game = null;
    this.court.clear();
    this.disposeBikeModel();
    if (this.bikeUsedAsset) { releaseLifeAsset('bicycle'); this.bikeUsedAsset = false; }
    this.frame = null;
    this.group.removeFromParent();
  }
}
