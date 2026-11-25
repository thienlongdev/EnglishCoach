export type KingChallengeFamily = 'LETTER_SCRAMBLE'|'MISSING_LETTER'|'SPELLING_CORRECTION'|'SPELLING_CHOICE'|'WORD_FAMILY'|'PART_OF_SPEECH'|'SYNONYM'|'ANTONYM'|'COLLOCATION'|'PHRASAL_VERB'|'IDIOM_FRAGMENT'|'GRAMMAR_TRAP'|'FIXED_EXPRESSION';
export type KingPresentation = { id:string;mode:'REORDER'|'REFLEX'|'EXPLAIN'|'CONQUEST';family:KingChallengeFamily|string;prompt:string;context:string|null;
  options:string[];tiles?:{id:number;text:string}[];difficulty:number;answer?:string;meaning?:string;occurrenceStart?:number;occurrenceEnd?:number };
export type KingState = {
  roomCode:string;mode:'REORDER'|'REFLEX'|'EXPLAIN'|'CONQUEST';variant?:'STANDARD'|'CHAMPIONSHIP';flow:'SOLO'|'ECHO'|'QUICK_MATCH'|'PRIVATE_ROOM';matchId:string;
  status:'WAITING'|'PLAYING'|'INTERMISSION'|'FINISHED';revision:number;youId:number;serverTimestamp:number;deadline:number;
  winnerId:number|null;reason:string|null;score:number;wrong:number;skipped:number;completed:number;
  inputRevision:number;lockUntil:number;done:boolean;round:number;count:number;resolved:boolean;revisiting:boolean;
  challenge:KingPresentation|null;accuracy?:number;durationMs?:number;responseMs:number;
  explain?:{role:'DESCRIBER'|'GUESSER';clues:string[];clueIndex:number;phase:'DESCRIBING'|'ROUND_RESULT';target?:string;meaning?:string;forbiddenForms?:string[];guessAttempts:number};
  conquest?:{boardId:string;size?:number;durationMs?:number;letters:string[];owners:number[];throne:number;territory:number;longestWord:number;wordPoints:number;usedWords:string[];yourUsedWordCount:number;opponentUsedWordCount:number;wordHistory:{sequence:number;playerId:number;word:string;meaningVi?:string;path:number[];wordPoints:number;territoryAfter:number;throneAfter:boolean;scoreAfter:number}[];playerBreakdown:Record<string,{wordCount:number;wordPoints:number;territory:number;throne:boolean;longestWord:number;score:number}>;lastWord:string;lastPath:number[];lastPlayer:number};
  /** Reflex only: the viewer's last resolved slot; the challenge carries answer/meaning only when `revealed` (safe to disclose). */
  lastResult?:{slot:number;correct:boolean;skipped:boolean;submitted:string|null;revealed:boolean;challenge:KingPresentation};
  /** Soán ngôi board size (5 for every other mode) and whether this match's result is stored for the rankings. */
  /** Echo Sentinel: the viewer's own ranked-attempt state (null = unranked play). */
  integrity?:{attemptId:string;state:string;detail:string|null}|null;
  size?:number;resultSaved?:boolean;bot?:string;difficulty?:number;length?:number;
  config:{resolutionMs?:number;conquestSizes?:{size:number;ms:number}[];explainMs:number;explainClueMax:number;explainGuessCap:number;conquestMs:number;conquestWordCap:number;conquestTerritoryPoint:number;conquestThroneBonus:number;reorderRounds:number;suddenMax:number;reorderMs:number;wrongLockMs:number;reflexMs:number;reflexSlots:number};
  championshipRound?:number;championshipTotal?:number;championshipRounds?:{mode:string;rawMax:number;players:Record<string,{raw:number;normalized:number;total:number}>}[];
  players:{id:number;name:string;score:number;wrong:number;completed:number;ready:boolean;rematch:boolean;connected:boolean}[];
  review?:{challenge:KingPresentation;correct:boolean;submitted?:string|null}[];
};
export type KingLaunch={mode:'REORDER'|'REFLEX'|'EXPLAIN'|'CONQUEST'|'CHAMPIONSHIP';flow:'SOLO'|'ECHO'|'QUICK_MATCH'|'PRIVATE_ROOM';length:number;difficulty:number;bot:string;size?:number;joinCode?:string;recover?:boolean};

