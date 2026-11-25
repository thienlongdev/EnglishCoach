/**
 * The one authority on what the body is doing. Everything else (a focus timer, a panel, a saved layout, the camera)
 * may ask, but only this says yes: a request for the seat already being used changes nothing, so no caller can make a
 * seated body stand up and sit down again.
 *
 *   standing -> approaching -> lowering -> seated | lying -> rising -> standing
 */
export type Posture = 'standing' | 'approaching' | 'lowering' | 'seated' | 'lying' | 'rising' | 'acting';

export type SeatSubPhase = 'none' | 'approaching' | 'turn_in' | 'lowering' | 'settled' | 'rising';

export type CharacterActionMode =
  | 'idle'
  | 'locomoting'
  | 'seat_approach'
  | 'seat_turn_lower'
  | 'seated'
  | 'seat_rise'
  | 'floor_motion'
  | 'carrying'
  | 'tool_working'
  | 'embodied_action'
  | 'vehicle_riding'
  | 'studio';

export class PostureMachine {
  state: Posture = 'standing';
  seat: string | null = null;
  action: string | null = null;
  /** Every change of state, for the tests that prove there is no sit/stand loop. */
  changes = 0;
  private lying = false;
  private subPhase: SeatSubPhase = 'none';
  private go(next: Posture) { if (next !== this.state) { this.state = next; this.changes++; } }
  get seatPhase(): SeatSubPhase { return this.subPhase; }
  get occupied() { return this.state === 'seated' || this.state === 'lying' || this.state === 'lowering'; }
  get approaching() { return this.state === 'approaching'; }
  get transitioning() { return this.state === 'approaching' || this.state === 'lowering' || this.state === 'rising'; }
  /** False: already there, or on the way there. Nothing to do. */
  request(seat: string, lying: boolean) {
    if (this.action) return false;
    if (this.seat === seat && this.lying === lying && ['approaching', 'lowering', 'seated', 'lying'].includes(this.state)) return false;
    const wasOccupied = this.state === 'seated' || this.state === 'lying';
    this.seat = seat;
    this.lying = lying;
    this.subPhase = wasOccupied ? 'rising' : 'approaching';
    this.go(wasOccupied ? 'rising' : 'approaching');
    return true;
  }
  arrived() {
    if (this.state === 'approaching' || this.state === 'rising') {
      this.subPhase = this.lying ? 'lowering' : 'turn_in';
      this.go('lowering');
    }
  }
  beginTurnIn() {
    if (this.state === 'lowering' && !this.lying) this.subPhase = 'turn_in';
  }
  beginDescent() {
    if (this.state === 'lowering') this.subPhase = 'lowering';
  }
  settled() {
    if (this.state === 'lowering') {
      this.subPhase = 'settled';
      this.go(this.lying ? 'lying' : 'seated');
    }
  }
  /** The body gets up. Only an explicit action, or leaving for another seat, comes here. */
  stand() {
    this.seat = null;
    if (this.state === 'seated' || this.state === 'lying' || this.state === 'lowering') {
      this.subPhase = 'rising';
      this.go('rising');
    } else if (this.state === 'approaching') {
      this.subPhase = 'none';
      this.go('standing');
    }
  }
  risen() {
    if (this.state === 'rising') {
      this.subPhase = this.seat ? 'approaching' : 'none';
      this.go(this.seat ? 'approaching' : 'standing');
    }
  }
  /** Safely aborts an in-flight seat approach (or queued seat switch while rising) without deadlocking. */
  cancelApproach(): boolean {
    if (this.state === 'approaching') {
      this.seat = null;
      this.lying = false;
      this.subPhase = 'none';
      this.go('standing');
      return true;
    }
    if (this.state === 'rising' && this.seat !== null) {
      this.seat = null;
      this.lying = false;
      this.subPhase = 'rising';
      return true;
    }
    return false;
  }
  /** Immediate emergency recovery to `'standing'`, clearing any stale seat or action token. */
  abortToStanding(): void {
    this.seat = null;
    this.action = null;
    this.lying = false;
    this.subPhase = 'none';
    this.go('standing');
  }
  /** Self-healing invariant guard: clears orphaned `'approaching'`, `'lowering'`, or `'rising'` states. */
  recoverStuck(hasActiveWalk: boolean, hasActiveSit: boolean, hasActiveRise: boolean): boolean {
    if (this.state === 'approaching' && !hasActiveWalk) {
      this.abortToStanding();
      return true;
    }
    if (this.state === 'lowering' && !hasActiveSit && !this.seat) {
      this.abortToStanding();
      return true;
    }
    if (this.state === 'rising' && !hasActiveRise) {
      this.seat = null;
      this.lying = false;
      this.subPhase = 'none';
      this.go('standing');
      return true;
    }
    return false;
  }
  beginAction(name: string) {
    if (this.state !== 'standing' || this.seat || this.action) return false;
    this.action = name;
    this.subPhase = 'none';
    this.go('acting');
    return true;
  }
  endAction(name: string) {
    if (this.action === name) {
      this.action = null;
      this.subPhase = 'none';
      this.go('standing');
    }
  }
  reset() {
    this.seat = null;
    this.action = null;
    this.lying = false;
    this.subPhase = 'none';
    this.go('standing');
  }
}
export type FloorPose = 'Kneel' | 'FloorSit' | 'Prone' | 'SideLying';
export function isFloorPose(name: unknown): name is FloorPose {
  return name === 'Kneel' || name === 'FloorSit' || name === 'Prone' || name === 'SideLying';
}
export interface FloorEnvelope { minX: number; maxX: number; minZ: number; maxZ: number; top: number }

