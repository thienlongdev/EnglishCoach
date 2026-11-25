export type ArenaMode = 'DUEL' | 'TEAM' | 'GUIDED' | 'FREE';
export type ArenaPhase = 'LOBBY' | 'PREPARE' | 'TALK' | 'REVIEW' | 'FREE' | 'FINISHED';
export type ArenaBoatRole = 'ROWER' | 'PASSENGER';

export interface ArenaBoatState {
  engine?: boolean; throttle?: number; steering?: number; speed?: number;
  id: string;
  x: number;
  z: number;
  yaw: number;
  rowPhase: number;
  rower?: string | null;
  passenger?: string | null;
  sequence?: number;
  sampledAt?: number;
}

export interface ArenaPlayer {
  id: string; userId?: number; name: string; hero: 'LYRA' | 'KAI'; look?: string; team: number; ready: boolean;
  online: boolean; moderated: boolean; canSpeak: boolean; voiceIdentity: string;
  x: number; z: number; yaw: number; gesture: string; gestureAt?: number;
  sequence?: number; sampledAt?: number; jumpAt?: number; jumpFloor?: number; supportY?: number; jumpSpeed?: number; diveDepth?: number;
  seat?: string | null; boat?: string | null; boatRole?: ArenaBoatRole | null;
  artifact?: string | null; artifactTurn?: number;
}

export interface ArenaAward { round: number; team: number; points: number; reason: string }
/** Where a table object rests when nobody holds it (the server chooses the spot on a table). */
export interface ArenaItemState { id: string; table: string | null; x: number; z: number; y: number; yaw: number }

export interface ArenaState {
  roomId: string; code: string; mode: ArenaMode; phase: ArenaPhase; host: string; self: string;
  speaker: string | null; revision: number; serverTime: number; deadline: number;
  round: number; prompt: number; coral: number; lagoon: number;
  players: ArenaPlayer[]; awards: ArenaAward[]; publicMatch: boolean; capacity: number;
  title: string; topic: string; inviteOnly: boolean;
  boats?: ArenaBoatState[]; beacons?: string[]; items?: ArenaItemState[];
}

export interface ArenaConfig { available: boolean; provider: string; maxRoomSize: number; recording: false; reason?: string }
export interface ArenaTicket { url: string; token: string; identity: string; expiresAt: number }

export interface MotionPose extends ArenaPose {
  id: string; sequence: number; sampledAt: number; jumpAt: number; jumpFloor: number;
  supportY?: number; jumpSpeed?: number; diveDepth?: number; seat?: string | null;
  boat?: string | null; boatRole?: ArenaBoatRole | null;
}

export interface ArenaEvent {
  motion?: { roomId: string; serverTime: number; players: MotionPose[]; boats?: ArenaBoatState[] };
  type: string; requestId: string | null; code: string | null; state: ArenaState | null;
}

export interface ArenaCommand {
  title?: string; topic?: string; capacity?: number; mode?: ArenaMode; code?: string; nickname?: string;
  hero?: 'LYRA' | 'KAI'; look?: string;
  target?: string; team?: number; points?: number; reason?: string; prompt?: number; value?: boolean;
  x?: number; z?: number; yaw?: number; sequence?: number;
  item?: string; aux?: number; throttle?: number; steering?: number;
  /** put-item: the table to set the held object on. */
  place?: string;
}

export interface ArenaPose { x: number; z: number; yaw: number; y?: number; boat?: string | null }
export interface ArenaAudioSpace { listener: ArenaPose; players: Map<string, ArenaPose>; updatedAt?: number }
