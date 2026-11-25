import type { RushQuestion, RushReview, RushSetup } from './quizRush';
import type { Hazard } from '@/components/features/games/echo-quiz-rush/rushTrials';
import type { Orb, Wall6 } from '@/components/features/games/echo-quiz-rush/rushReforged';
export type CompetitiveMode='BOTS'|'QUICK'|'PRIVATE';
export interface CompetitivePlayer {
  id:string;name:string;bot:boolean;ready:boolean;connected:boolean;phase:string;x:number;y:number;vx:number;speed:number;
  checkpoint:number;effect:string;effectRemaining:number;rank:number;finishAt:number;skillSerial:number;lastSkill:string;streak?:number;
  /** Version 5: height above the road and remaining protection after a hit or respawn. */
  z?:number;guard?:number;
  /** Version 6: forward velocity, an orb shield and an active speed orb. */
  vy?:number;shield?:number;boosted?:boolean;
  /** Version 7: vertical speed (rivals' jumps are drawn as smooth arcs). */
  vz?:number;
  /** The racer's chosen hero (server allow-list; cosmetic only). Missing on older rooms = Lyra. */
  hero?:'LYRA'|'KAI';
  /** What a real player wears. Bots have none. */
  look?:string;
}
export interface CompetitiveState {
  roomId:string;matchId:string;mode:CompetitiveMode;status:string;reason:string;revision:number;serverNow:number;elapsed:number;
  total:number;setup:RushSetup&{botLevel?:string};recovery:string;invitation:string;
  /** Private rooms: the short room code (6 characters) another player can type to join; '' elsewhere / older rooms. */
  code?:string;host:boolean;you:string;rematchVotes:number;
  players:CompetitivePlayer[];question:RushQuestion|null;review:RushReview[];courseVersion:number;spacing:number;boundaries?:number[];
  /** Version 5 course plan: present in command answers and outside the running phases (keep the last one per match). */
  hazards?:Hazard[];rising?:boolean[];
  /** Version 6 course plan (same rule as hazards): wall motion and orbs. */
  walls?:Wall6[];orbs?:Orb[];
  personal:{stamina:number;energy:number;dashCooldown:number;dashTime:number;rushTime:number;charges:number;lastSeq:number;
    selected:number;openGate:number;rejected:number;phaseTime:number;recoilFrom:number;mistakes:number;cooldowns:Record<string,number>;bestStreak?:number;
    vz?:number;jumpSeq?:number;dodgeSeq?:number;dodgeTime?:number;dodgeDir?:number;dodgeCooldown?:number;guard?:number;kvx?:number;kvy?:number;
    riseCheckpoint?:number;riseStart?:number;dropStart?:number;dropFrom?:number;hold?:number;jumps?:number;dodges?:number;knocks?:number;falls?:number;
    vy?:number;floorY?:number;lastSlide?:number;orbs?:number[];orbSerial?:number;lastOrb?:string;speedLeft?:number;shield?:number;shieldLeft?:number;shieldBlocks?:number;dashX?:number;dashY?:number;
    /** Version 7: where this racer left the road (the respawn is chosen from there). */
    fallX?:number;fallY?:number;
    /** Race time the server applied this racer's latest input (`lastSeq`) at (−100 before any), a jump it accepted but has
     *  not applied yet (−1 none) and its last landing: the snapshot is then a complete start for the browser's replay. */
    inputAt?:number;jumpAt?:number;landAt?:number};
}
/** `jump` / `dodge` are monotonic request counters (a higher value asks for one jump / dodge); `forward` (version 6) is −1..1. */
export interface CompetitiveInput {horizontal:number;target:number|null;sprint:boolean;jump?:number;dodge?:number;forward?:number}
