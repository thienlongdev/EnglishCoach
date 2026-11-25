export type SpellingMode = 'MULTIPLAYER' | 'ENDLESS' | 'SPRINT' | 'PRACTICE';
export type SpellingDifficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type SpellingPhase = 'LOBBY' | 'COUNTDOWN' | 'APPROACH' | 'LOADING_AUDIO' | 'HEAR' | 'SPELL' | 'RESULT' | 'FINISHED' | 'ABORTED';
export interface SpellingPlayer {
  id:string;userId:number;name:string;hero:'LYRA'|'KAI';look:string;online:boolean;ready:boolean;eliminated:boolean;spectator:boolean;returning:boolean;
  x:number;z:number;yaw:number;sequence:number;sampledAt:number;jumpAt:number;jumpFloor:number;
  score:number;correct:number;wrong:number;streak:number;maxStreak:number;highestWpm:number;integrity:string;
}
export interface SpellingReview { player:string;answer:string;typed:string;correct:boolean;reason:string;wpm:number;earned:number;tier:number;at:number }
export interface SpellingTurn { id:string;player:string;tier:number;audioUrl:string|null;audioDurationMs:number;openedAt:number;deadline:number;typed:string;repeats:number;audioRevision:number }
export interface SpellingState {
  roomId:string;matchId:string;code:string;mode:SpellingMode;difficulty:SpellingDifficulty;phase:SpellingPhase;host:string;self:string;
  revision:number;serverTime:number;deadline:number;round:number;capacity:number;publicMatch:boolean;startedAt:number;sprintDeadline:number;
  winner:string|null;reason:string|null;players:SpellingPlayer[];turn:SpellingTurn|null;result:SpellingReview|null;review:SpellingReview[];saved:boolean;newRecords:string[];
}
export interface SpellingCommand {requestId?:string;roomId?:string;turnId?:string;mode?:SpellingMode;difficulty?:SpellingDifficulty;code?:string;hero?:'LYRA'|'KAI';look?:string;text?:string;sentinel?:string;sequence?:number;x?:number;z?:number;yaw?:number;value?:boolean;capacity?:number}
export interface SpellingEvent {type:string;requestId:string|null;code:string|null;state:SpellingState|null}
export interface SpellingBest {mode:SpellingMode;difficulty:SpellingDifficulty;highestScore:number;longestStreak:number;mostCorrect:number;highestWpm:number;bestAccuracy:number;bestSurvivalMs:number;attempts:number;wins:number}
export interface SpellingRun {matchId:string;mode:SpellingMode;difficulty:SpellingDifficulty;score:number;correct:number;wrong:number;maxStreak:number;highestWpm:number;accuracy:number;durationMs:number;won:boolean;integrity:string;finishedAt:string;review:SpellingReview[]}
export interface SpellingRecords {best:SpellingBest[];recent:SpellingRun[]}
export interface SpellingConfig {available:boolean;capacity:number;answerMs:number;sprintMs:number;counts:number[];voice:string;rules:string}

