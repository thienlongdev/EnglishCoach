"use client";

import React, { useRef, useEffect, useState, useCallback } from "react";
import { cardBlastAudio } from "./cardBlastAudio";
import {
  checkWordMatch,
  getMaskedHint,
  getLetterBoxesData,
  checkPrefixMatch,
  getPrimaryTarget,
  truncatePromptText,
  LetterBoxSlot,
} from "./cardBlastUtils";
import {
  Flame,
  Lightbulb,
  Heart,
  ShieldAlert,
  Volume2,
  VolumeX,
  Pause,
  Play,
  Zap,
  Link as LinkIcon,
  Clock,
  Lock,
  Trophy,
  Award,
  RotateCcw,
  Settings2,
} from "lucide-react";
import { PvPOpponentHud, REACTION_MAP } from "../pvp/PvPOpponentHud";
import { PvPRulesModal } from "../pvp/PvPRulesModal";
import {
  ScheduledWord,
  PlayerState,
  IncomingAttackPayload,
  AttackParriedPayload,
  GoldenWordPayload,
  GoldenTakenPayload,
  ReactionPayload,
  ShieldAbsorbedPayload,
  EchoChainPayload,
  MatchResultData,
} from "../pvp/useCardBlastPvP";

/** Canvas text uses the product typeface (Quicksand, the body font), read once from the page. */
let cachedUiFont = "";
function uiFont(): string {
  if (!cachedUiFont && typeof document !== "undefined") {
    try { cachedUiFont = getComputedStyle(document.body).fontFamily; } catch { /* detached */ }
  }
  return cachedUiFont || "system-ui, sans-serif";
}

export interface BlastWord {
  id: number;
  word: string;
  ipa?: string;
  vietnamese: string;
  allMeanings: string[];
  example?: string;
}

export type GameDirection = "EN_VI" | "VI_EN";
export type GameDifficulty = "easy" | "normal" | "hard";

export interface CardBlastPvPProp {
  schedule: ScheduledWord[];
  matchStartServerMs: number;
  clockOffset: number;
  myState: PlayerState | null;
  opponent: PlayerState | null;
  sendHit: (seq: number, tMs: number) => void;
  sendGameOver?: (reason?: string) => void;
  phase: "COUNTDOWN" | "PLAYING" | "RESULT";
  result?: MatchResultData | null;
  incomingAttack?: IncomingAttackPayload | null;
  parryEvent?: AttackParriedPayload | null;
  goldenWord?: ScheduledWord | null;
  goldenTaken?: GoldenTakenPayload | null;
  lastStandPlayers?: Set<string>;
  isLocalPlayerInLastStand?: boolean;
  suddenDeath?: boolean;
  latestReaction?: ReactionPayload | null;
  sendReaction?: (reactionId: string) => void;
  shieldAbsorbed?: ShieldAbsorbedPayload | null;
  echoChainEvent?: EchoChainPayload | null;
  fogActiveUntilMs?: number | null;
  fogOpponentUntilMs?: number | null;
  shieldActiveUntilMs?: number | null;
  sendSkill?: (skillId: string) => void;
  hintLevel?: "EASY" | "NORMAL" | "HARD";
  speedLevel?: number;
}

export interface CardBlastEngineProps {
  words: BlastWord[];
  direction: GameDirection;
  difficulty: GameDifficulty;
  speedLevel: number; // 1 to 5
  deckTitle: string;
  onGameOver?: (results: {
    score: number;
    accuracy: number;
    maxStreak: number;
    hits: number;
    totalAttempts: number;
    missedWords: BlastWord[];
  }) => void;
  onExit: () => void;
  onChangeConfig?: () => void;
  pvp?: CardBlastPvPProp;
}

interface ActiveFallingWord {
  uid: string;
  data: BlastWord;
  laneIndex: number;
  x: number;
  y: number;
  targetX: number;
  width: number;
  height: number;
  speed: number;
  displayText: string;
  subText: string;
  primaryTarget: string;
  targetAnswers: string[];
  isRevenge: boolean;
  isFrozen: boolean;
  frozenRemainingMs: number;
  hintMaskedText: string | null;
  revealedLetterIndices: number[];
  pvpSeq?: number;
  pvpSpawnAtMs?: number;
  pvpFallDurationMs?: number;
  isGarbage?: boolean;
  isGolden?: boolean;
  targetPlayerId?: string;
  spawnTime?: number;
  word?: string;
  english?: string;
  meaning?: string;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  alpha: number;
  maxLife: number;
  currentLife: number;
}

interface Shockwave {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  color: string;
  alpha: number;
}

interface LaserRay {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  life: number;
  color: string;
}

interface LightningBolt {
  life: number;
  maxLife: number;
  color: string;
  segments: { x: number; y: number }[];
}

interface FloatingText {
  id: string;
  text: string;
  x: number;
  y: number;
  color: string;
  fontSize: number;
  opacity: number;
  vy: number;
  life: number;
}

interface EscapedFlashBanner {
  id: string;
  word: string;
  meaning: string;
  expiresAt: number;
}

interface ParallaxStar {
  x: number;
  y: number;
  r: number;
  alpha: number;
  speed: number;
  layer: 1 | 2; // 1 = distant, 2 = near
  pulsePhase: number;
  pulseSpeed: number;
}

export function CardBlastEngine({
  words,
  direction,
  difficulty,
  speedLevel: initialSpeedLevel,
  deckTitle,
  onGameOver,
  onExit,
  onChangeConfig,
  pvp,
}: CardBlastEngineProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastShotTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const spawnedPvpSeqsRef = useRef<Set<number>>(new Set());
  const attackLaneAlarmRef = useRef<{ lane: number; expiresAt: number } | null>(null);
  const prevShieldAbsorbedRef = useRef<ShieldAbsorbedPayload | null>(null);
  const pvpRef = useRef(pvp);
  useEffect(() => {
    pvpRef.current = pvp;
  }, [pvp]);

  // Sound mute state
  const [isMuted, setIsMuted] = useState(false);

  // Pause state & in-game speed level adjustment
  const [isPaused, setIsPaused] = useState(false);
  const [currentSpeedLevel, setCurrentSpeedLevel] = useState<number>(initialSpeedLevel);
  const [showRulesModal, setShowRulesModal] = useState(false);

  // Pre-game 3-2-1 Countdown state: 3 -> 2 -> 1 -> "ready" -> null
  const [countdown, setCountdown] = useState<number | "ready" | null>(3);

  // Mana System & 3 Tactical Skills State for UI
  const [mana, setMana] = useState(30); // 0 - 100
  const [echoChainArmed, setEchoChainArmed] = useState(false);
  const [slowMoActive, setSlowMoActive] = useState(false);

  // Game stats state (synced for React HUD)
  const [hp, setHp] = useState(100);
  const effectiveHp = pvp?.myState?.hp != null ? pvp.myState.hp : hp;
  const isLocalPlayerInLastStand = Boolean(effectiveHp <= 30 && effectiveHp > 0);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [maxStreak, setMaxStreak] = useState(0);
  const [hits, setHits] = useState(0);
  const [hintsRemaining, setHintsRemaining] = useState(3);
  const [inputValue, setInputValue] = useState("");
  const [escapedBanners, setEscapedBanners] = useState<EscapedFlashBanner[]>([]);
  const [screenShake, setScreenShake] = useState(false);
  const [redVignette, setRedVignette] = useState(false);

  // Feedback strip: last shot status (auto-dismisses after 3.5s)
  const [lastShotStatus, setLastShotStatus] = useState<{
    type: "hit" | "miss";
    vietnamese: string;
    english: string;
  } | null>(null);

  // Big streak & combo callout banner
  const [comboBanner, setComboBanner] = useState<{ text: string; id: number } | null>(null);

  // In-Game Frozen Game Over state
  const [isGameOver, setIsGameOver] = useState(false);
  const [gameOverSummary, setGameOverSummary] = useState<{
    score: number;
    accuracy: number;
    maxStreak: number;
    hits: number;
    totalAttempts: number;
    missedWords: BlastWord[];
    isCleared: boolean;
  } | null>(null);

  // Whale reactions & Phase 2 PvP Combat states
  const [reactionCooldown, setReactionCooldown] = useState(false);
  const [selfReaction, setSelfReaction] = useState<{ id: string; emoji: string; text: string } | null>(null);
  const lastReactionSentAtRef = useRef<number>(0);
  const lastGoldenTakenSeqRef = useRef<number | null>(null);
  const [goldenLostToast, setGoldenLostToast] = useState<string | null>(null);
  const attackStartRef = useRef<number>(0);
  const lastPvpMatchStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (pvp?.incomingAttack) {
      const myId = pvp.myState?.userId;
      const targetId = pvp.incomingAttack.targetUserId || pvp.incomingAttack.targetPlayerId;
      const isVictim = !targetId || !myId || String(targetId) === String(myId);
      if (isVictim) {
        attackStartRef.current = Date.now();
      }
    }
  }, [pvp?.incomingAttack, pvp?.myState?.userId]);

  // Shield absorbed attack sound & spark particle explosion
  useEffect(() => {
    if (pvp?.shieldAbsorbed && pvp.shieldAbsorbed !== prevShieldAbsorbedRef.current) {
      prevShieldAbsorbedRef.current = pvp.shieldAbsorbed;
      cardBlastAudio.playShieldDeflectSound();

      // Trigger spark particles, shockwave, and floating text around whale cannon
      const canvas = canvasRef.current;
      if (canvas) {
        const wX = canvas.width / 2;
        const wY = canvas.height - 44;

        for (let i = 0; i < 30; i++) {
          const angle = Math.random() * Math.PI * 2;
          const spd = 2 + Math.random() * 6;
          engineRef.current.particles.push({
            x: wX,
            y: wY,
            vx: Math.cos(angle) * spd,
            vy: Math.sin(angle) * spd,
            color: i % 2 === 0 ? "#00f0ff" : "#38bdf8",
            size: 2.5 + Math.random() * 3,
            alpha: 1.0,
            maxLife: 35,
            currentLife: 0,
          });
        }

        engineRef.current.shockwaves.push({
          x: wX,
          y: wY,
          radius: 10,
          maxRadius: 75,
          color: "#00f0ff",
          alpha: 1.0,
        });

        engineRef.current.floatingTexts.push({
          id: `shield-${Date.now()}`,
          text: "🛡️ ĐÃ CHẶN ĐÒN TẤN CÔNG!",
          x: wX,
          y: wY - 50,
          color: "#38bdf8",
          fontSize: 16,
          opacity: 1.0,
          vy: -1.2,
          life: 0,
        });
      }
    }
  }, [pvp?.shieldAbsorbed]);

  const handleSendReaction = useCallback((reactionId: string) => {
    if (!pvp?.sendReaction) return;
    const now = Date.now();
    if (now - lastReactionSentAtRef.current < 1500) return;
    lastReactionSentAtRef.current = now;
    pvp.sendReaction(reactionId);
    setReactionCooldown(true);
    setTimeout(() => setReactionCooldown(false), 1500);

    const rx = REACTION_MAP[reactionId];
    if (rx) {
      setSelfReaction({ id: reactionId, ...rx });
      setTimeout(() => setSelfReaction(null), 2500);
    }
  }, [pvp]);

  // ==============================================================
  // AUTHORITATIVE MUTABLE ENGINE REF (Fixes Stale Closure)
  // ==============================================================
  const engineRef = useRef({
    mana: 30,
    hp: 100,
    slowMoUntil: 0,
    echoChainArmed: false,
    calloutText: "",
    calloutUntil: 0,
    empFlashUntil: 0,
    score: 0,
    streak: 0,
    maxStreak: 0,
    hintsRemaining: 3,
    hits: 0,
    misses: 0,
    totalReactionMs: 0,
    reactionCount: 0,
    totalSpawns: 0,
    isOver: false,
    isPaused: false,
    currentSpeedLevel: initialSpeedLevel,
    wordsPool: [...words],
    availablePool: [...words].sort(() => 0.5 - Math.random()),
    revengeQueue: [] as BlastWord[],
    spawnsSinceMiss: 0,
    missedWordsMap: new Map<number, BlastWord>(),
    activeWords: [] as ActiveFallingWord[],
    particles: [] as Particle[],
    shockwaves: [] as Shockwave[],
    laserRays: [] as LaserRay[],
    lightningBolts: [] as LightningBolt[],
    floatingTexts: [] as FloatingText[],
    stars: [] as ParallaxStar[],
    lastSpawnTime: 0,
    shakeFrames: 0,
    cannonAngle: -Math.PI / 2, // pointing upward initially
    muzzleFlashFrames: 0,
  });

  // Keep engineRef synced with isPaused and speedLevel
  useEffect(() => {
    engineRef.current.isPaused = isPaused;
  }, [isPaused]);

  useEffect(() => {
    engineRef.current.currentSpeedLevel = currentSpeedLevel;
  }, [currentSpeedLevel]);

  // Calculate difficulty constants
  const diffParams = {
    easy: { hpMiss: 6, hpHit: 6, maxSimultaneous: 2, baseInterval: 3200, speedMult: 0.9 },
    normal: { hpMiss: 12, hpHit: 12, maxSimultaneous: 3, baseInterval: 2400, speedMult: 1.3 },
    hard: { hpMiss: 20, hpHit: 20, maxSimultaneous: 4, baseInterval: 1700, speedMult: 1.8 },
  }[difficulty];

  // ==============================================================
  // PRE-GAME 3-2-1 READY COUNTDOWN SEQUENCE
  // ==============================================================
  const runCountdownSequence = useCallback(() => {
    setCountdown(3);
    cardBlastAudio.playCountdownTick();

    const t1 = setTimeout(() => {
      setCountdown(2);
      cardBlastAudio.playCountdownTick();
    }, 1000);

    const t2 = setTimeout(() => {
      setCountdown(1);
      cardBlastAudio.playCountdownTick();
    }, 2000);

    const t3 = setTimeout(() => {
      setCountdown("ready");
      cardBlastAudio.playCountdownGo();
    }, 3000);

    const t4 = setTimeout(() => {
      setCountdown(null);
      engineRef.current.lastSpawnTime = performance.now();
      inputRef.current?.focus();
    }, 3800);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, []);

  useEffect(() => {
    if (!pvp) {
      const cancel = runCountdownSequence();
      return cancel;
    }
  }, [runCountdownSequence, pvp]);

  // Synchronized PvP Countdown
  useEffect(() => {
    if (!pvp || !pvp.matchStartServerMs) return;

    if (lastPvpMatchStartRef.current !== pvp.matchStartServerMs) {
      lastPvpMatchStartRef.current = pvp.matchStartServerMs;
      spawnedPvpSeqsRef.current.clear();
      const sInit = engineRef.current;
      sInit.activeWords = [];
      sInit.hp = 100;
      sInit.score = 0;
      sInit.streak = 0;
      sInit.maxStreak = 0;
      sInit.hits = 0;
      sInit.misses = 0;
      sInit.mana = 0;
      sInit.totalReactionMs = 0;
      sInit.reactionCount = 0;
      sInit.isOver = false;
      sInit.echoChainArmed = false;
      sInit.slowMoUntil = 0;
      sInit.shockwaves = [];
      sInit.laserRays = [];
      sInit.lightningBolts = [];
      sInit.particles = [];
      sInit.floatingTexts = [];
      setHp(100);
      setScore(0);
      setStreak(0);
      setMaxStreak(0);
      setHits(0);
      setMana(0);
      setEchoChainArmed(false);
      setSlowMoActive(false);
      setIsGameOver(false);
      setRedVignette(false);
      setGoldenActiveBanner(false);
    }

    let hasFocused = false;
    let prevCountdown: number | "ready" | null = 3;

    const updateCountdown = () => {
      const currentSyncedMs = Date.now() + pvp.clockOffset;
      const remaining = pvp.matchStartServerMs - currentSyncedMs;
      let nextCountdown: number | "ready" | null = null;

      if (remaining > 3000) {
        nextCountdown = 3;
      } else if (remaining > 2000) {
        nextCountdown = 2;
      } else if (remaining > 1000) {
        nextCountdown = 1;
      } else if (remaining > 0) {
        nextCountdown = "ready";
      } else {
        nextCountdown = null;
      }

      if (nextCountdown !== prevCountdown) {
        if (nextCountdown === "ready") {
          cardBlastAudio.playCountdownGo();
        } else if (nextCountdown !== null) {
          cardBlastAudio.playCountdownTick();
        }
        prevCountdown = nextCountdown;
        setCountdown(nextCountdown);
      }

      if (nextCountdown === null && !hasFocused) {
        hasFocused = true;
        inputRef.current?.focus();
      }
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 50);
    return () => clearInterval(timer);
  }, [pvp?.matchStartServerMs, pvp?.clockOffset]);

  // Synchronize HP with Server Authoritative Value
  useEffect(() => {
    if (pvp?.myState?.hp != null) {
      const serverHp = Math.max(0, Math.min(100, pvp.myState.hp));
      engineRef.current.hp = serverHp;
      setHp(serverHp);
    }
  }, [pvp?.myState?.hp]);

  // Lockstep Authoritative PvP Match Termination
  useEffect(() => {
    if (pvp?.phase === "RESULT" || pvp?.result) {
      const s = engineRef.current;
      s.isOver = true;
      setIsGameOver(true);
      s.activeWords = [];
    }
  }, [pvp?.phase, pvp?.result]);

  // Disintegrate golden word when taken by either player/bot
  useEffect(() => {
    if (!pvp?.goldenTaken) return;
    if (lastGoldenTakenSeqRef.current === pvp.goldenTaken.seq) return;
    lastGoldenTakenSeqRef.current = pvp.goldenTaken.seq;

    // Immediately dismiss golden banner
    setGoldenActiveBanner(false);

    const s = engineRef.current;
    if (pvp.goldenTaken.winnerId !== pvp.myState?.userId) {
      setGoldenLostToast(`Đối thủ đã giành từ vàng: "${pvp.goldenTaken.word}"`);
      setTimeout(() => setGoldenLostToast(null), 3000);
    }

    // Immediately despawn golden word from active words regardless of who captured it
    for (let i = s.activeWords.length - 1; i >= 0; i--) {
      const w = s.activeWords[i];
      if (
        w.pvpSeq === pvp.goldenTaken?.seq ||
        (w.isGolden && w.data.word.toLowerCase() === pvp.goldenTaken?.word.toLowerCase())
      ) {
        const cx = w.x + w.width / 2;
        const cy = w.y + w.height / 2;
        for (let p = 0; p < 35; p++) {
          const angle = Math.random() * Math.PI * 2;
          const spd = 2 + Math.random() * 5;
          s.particles.push({
            x: cx,
            y: cy,
            vx: Math.cos(angle) * spd,
            vy: Math.sin(angle) * spd,
            color: Math.random() > 0.3 ? "#fbbf24" : "#ffffff",
            size: 2.5 + Math.random() * 3,
            alpha: 1,
            maxLife: 35 + Math.floor(Math.random() * 20),
            currentLife: 0,
          });
        }
        s.activeWords.splice(i, 1);
      }
    }
  }, [pvp?.goldenTaken, pvp?.myState?.userId]);

  // Phase 3 Early Golden Word Notification Banner (T+12s & every 25s)
  const [goldenActiveBanner, setGoldenActiveBanner] = useState<boolean>(false);
  const prevGoldenSeqRef = useRef<number | null>(null);

  useEffect(() => {
    if (pvp?.goldenWord && pvp.goldenWord.seq !== prevGoldenSeqRef.current) {
      prevGoldenSeqRef.current = pvp.goldenWord.seq;
      setGoldenActiveBanner(true);
      const timer = setTimeout(() => setGoldenActiveBanner(false), 3500);
      return () => clearTimeout(timer);
    }
  }, [pvp?.goldenWord]);

  // ==============================================================
  // LOW HP CRITICAL VIGNETTE & HEARTBEAT SOUND (HP <= 30 FOR LOCAL PLAYER)
  // ==============================================================
  useEffect(() => {
    if (isLocalPlayerInLastStand && !isPaused && countdown === null && !isGameOver) {
      cardBlastAudio.playHeartbeatSound();
      const interval = setInterval(() => {
        cardBlastAudio.playHeartbeatSound();
      }, 1300);
      return () => clearInterval(interval);
    }
  }, [isLocalPlayerInLastStand, isPaused, countdown, isGameOver]);

  // Listen to remote echoChainEvent (e.g. from server confirmation)
  useEffect(() => {
    if (pvp?.echoChainEvent?.detonatedSeq) {
      const seq = pvp.echoChainEvent.detonatedSeq;
      const s = engineRef.current;
      const targetIdx = s.activeWords.findIndex((w) => w.pvpSeq === seq);
      if (targetIdx !== -1) {
        const w = s.activeWords[targetIdx];
        const wx = w.x + w.width / 2;
        const wy = w.y + w.height / 2;
        cardBlastAudio.playEchoChainSound();
        s.shockwaves.push({
          x: wx,
          y: wy,
          radius: 12,
          maxRadius: 70,
          color: "#c084fc",
          alpha: 0.95,
        });
        s.activeWords.splice(targetIdx, 1);
      }
    }
  }, [pvp?.echoChainEvent]);

  // Trigger screen shake & red vignette
  const triggerMissImpact = useCallback(() => {
    engineRef.current.shakeFrames = 12;
    setScreenShake(true);
    setRedVignette(true);
    setTimeout(() => setScreenShake(false), 280);
    setTimeout(() => setRedVignette(false), 450);
  }, []);

  // ==============================================================
  // UPGRADED HINT MECHANIC (Tab / 💡): Freeze 2.5s + Unveil 1 Letter
  // ==============================================================
  const triggerHint = useCallback(() => {
    const s = engineRef.current;
    if (s.hintsRemaining <= 0 || s.isOver || s.isPaused || countdown !== null) return;

    // Find lowest falling word (highest y) that is not already frozen
    const candidates = s.activeWords.filter((w) => !w.isFrozen && w.y > 20);
    if (candidates.length === 0) return;

    candidates.sort((a, b) => b.y - a.y);
    const target = candidates[0];

    target.isFrozen = true;
    target.frozenRemainingMs = 2500;
    target.hintMaskedText = getMaskedHint(target.primaryTarget || target.targetAnswers[0] || "");

    // Unveil 1 random unrevealed letter in letter boxes
    const primary = target.primaryTarget || target.targetAnswers[0] || "";
    const cleanLetters = primary.replace(/\s+/g, "");
    const totalLetters = cleanLetters.length;
    const revealBaseCount = difficulty === "easy" ? 2 : difficulty === "normal" ? 1 : 0;

    const unrevealedIndices: number[] = [];
    for (let idx = revealBaseCount; idx < totalLetters; idx++) {
      if (!target.revealedLetterIndices.includes(idx)) {
        unrevealedIndices.push(idx);
      }
    }

    if (unrevealedIndices.length > 0) {
      const chosen = unrevealedIndices[Math.floor(Math.random() * unrevealedIndices.length)];
      target.revealedLetterIndices.push(chosen);
    }

    s.hintsRemaining -= 1;
    setHintsRemaining(s.hintsRemaining);
    cardBlastAudio.playFreezeHintSound();

    s.floatingTexts.push({
      id: Math.random().toString(),
      text: "💡 BĂNG GIÁ 2.5s • MỞ 1 CHỮ!",
      x: target.x + target.width / 2,
      y: target.y - 15,
      color: "#38bdf8",
      fontSize: 16,
      opacity: 1,
      vy: -1.2,
      life: 50,
    });
  }, [countdown, difficulty]);

  // ==============================================================
  // TACTICAL SKILL 1: ECHO CHAIN (HotKey 1 • 40 Mana in PvP / 25 in Solo)
  // ==============================================================
  const triggerEchoChain = useCallback(() => {
    const s = engineRef.current;
    const cost = pvp ? 40 : 25;
    if (s.mana < cost || s.isOver || s.isPaused || countdown !== null || s.echoChainArmed) return;

    s.mana -= cost;
    s.echoChainArmed = true;
    s.calloutText = "⚡ ECHO CHAIN: Phát bắn tiếp theo sẽ lan truyền!";
    s.calloutUntil = Date.now() + 2500;

    setEchoChainArmed(true);
    setMana(Math.floor(s.mana));
    cardBlastAudio.playEchoChainSound();
  }, [countdown, pvp]);

  // ==============================================================
  // TACTICAL SKILL 2: SLOW-MO (HotKey 2 • 50 Mana)
  // ==============================================================
  const triggerSlowMo = useCallback(() => {
    const s = engineRef.current;
    const cost = 50;
    if (s.mana < cost || s.isOver || s.isPaused || countdown !== null) return;

    s.mana -= cost;
    s.slowMoUntil = Date.now() + 6000;
    s.calloutText = "⏳ SLOW-MO: Tốc độ rơi giảm 65% trong 6 giây!";
    s.calloutUntil = Date.now() + 2500;

    setSlowMoActive(true);
    setMana(Math.floor(s.mana));
    cardBlastAudio.playSlowMoSound();
  }, [countdown]);

  // ==============================================================
  // TACTICAL SKILL 3: EMP BLAST (HotKey 3 • 80 Mana in PvP / 100 in Solo)
  // ==============================================================
  const triggerEmpBlast = useCallback(() => {
    const s = engineRef.current;
    const cost = pvp ? 80 : 100;
    if (s.mana < cost || s.isOver || s.isPaused || countdown !== null) return;

    s.mana -= cost;
    s.empFlashUntil = Date.now() + 250;
    s.shakeFrames = 12;
    setScreenShake(true);
    setTimeout(() => setScreenShake(false), 280);

    cardBlastAudio.playEmpBlastSound();

    // Detonate all active falling words on screen
    s.activeWords.forEach((w) => {
      const cx = w.x + w.width / 2;
      const cy = w.y + w.height / 2;

      for (let p = 0; p < 24; p++) {
        const angle = Math.random() * Math.PI * 2;
        const spd = 3.0 + Math.random() * 6.0;
        s.particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * spd,
          vy: Math.sin(angle) * spd - 1,
          color: ["#38bdf8", "#818cf8", "#facc15", "#ffffff"][Math.floor(Math.random() * 4)],
          size: 3 + Math.random() * 3,
          alpha: 1,
          maxLife: 35,
          currentLife: 0,
        });
      }

      s.shockwaves.push({
        x: cx,
        y: cy,
        radius: 10,
        maxRadius: 65,
        color: "#38bdf8",
        alpha: 0.9,
      });

      if (pvp && w.pvpSeq !== undefined) {
        const matchStart = pvp.matchStartServerMs > 0 ? pvp.matchStartServerMs : (Date.now() + (pvp.clockOffset || 0));
        const currentSyncedMs = Date.now() + (pvp.clockOffset || 0);
        const tMs = Math.max(0, currentSyncedMs - matchStart);
        pvp.sendHit(w.pvpSeq, tMs);
      }

      s.score += 15;
      s.hits += 1;
    });

    s.activeWords = [];

    // Restore +15 HP
    s.hp = Math.min(100, s.hp + 15);
    s.calloutText = "💥 EMP BLAST: Dọn sạch màn hình và Hồi +15 HP!";
    s.calloutUntil = Date.now() + 2500;

    setHp(s.hp);
    setScore(s.score);
    setMana(Math.floor(s.mana));
  }, [countdown, pvp]);

  const equippedSkills = pvp
    ? pvp.myState?.skills || ["ECHO_CHAIN", "SLOW_MO", "EMP_BLAST"]
    : ["ECHO_CHAIN", "SLOW_MO", "EMP_BLAST"];

  const currentMana = pvp ? Math.max(mana, pvp.myState?.mana ?? 0) : mana;

  const triggerSkillSlot = useCallback(
    (slotIdx: number) => {
      const skillId = equippedSkills[slotIdx];
      if (!skillId) return;
      const costs: Record<string, number> = {
        ECHO_CHAIN: 40,
        SLOW_MO: 50,
        EMP_BLAST: 80,
        FOG: 50,
        SHIELD: 35,
      };
      const cost = costs[skillId] || 50;
      if (currentMana < cost) return;

      if (pvp) {
        if (pvp.sendSkill) {
          pvp.sendSkill(skillId);
        }
        // Deduct mana locally immediately
        const s = engineRef.current;
        s.mana = Math.max(0, s.mana - cost);
        setMana(Math.floor(s.mana));

        // Trigger local visual effect immediately
        if (skillId === "SLOW_MO") {
          cardBlastAudio.playSlowMoSound();
          s.slowMoUntil = Date.now() + 5000;
          setSlowMoActive(true);
          s.calloutText = "⏳ SLOW-MO: Làm chậm từ vựng 65% trong 5 giây!";
          s.calloutUntil = Date.now() + 2500;
          setTimeout(() => setSlowMoActive(false), 5000);
        } else if (skillId === "EMP_BLAST") {
          cardBlastAudio.playEmpBlastSound();
          s.empFlashUntil = Date.now() + 350;
          s.shakeFrames = 15;
          setScreenShake(true);
          setTimeout(() => setScreenShake(false), 300);

          s.calloutText = "💥 EMP BLAST: Dọn sạch màn hình và Hồi +15 HP!";
          s.calloutUntil = Date.now() + 2500;

          const canvas = canvasRef.current;
          const cw = canvas ? canvas.clientWidth : window.innerWidth;
          const ch = canvas ? canvas.clientHeight : window.innerHeight;
          s.shockwaves.push({
            x: cw / 2,
            y: ch / 2,
            radius: 20,
            maxRadius: Math.max(cw, ch) * 1.2,
            color: "#38bdf8",
            alpha: 1,
          });
          s.shockwaves.push({
            x: cw / 2,
            y: ch / 2,
            radius: 10,
            maxRadius: Math.max(cw, ch),
            color: "#ffffff",
            alpha: 1,
          });

          // Detonate and clear ALL active words on screen immediately!
          s.activeWords.forEach((w) => {
            const cx = w.x + w.width / 2;
            const cy = w.y + w.height / 2;

            for (let p = 0; p < 24; p++) {
              const angle = Math.random() * Math.PI * 2;
              const spd = 3.0 + Math.random() * 6.0;
              s.particles.push({
                x: cx,
                y: cy,
                vx: Math.cos(angle) * spd,
                vy: Math.sin(angle) * spd - 1,
                color: ["#38bdf8", "#818cf8", "#facc15", "#ffffff"][Math.floor(Math.random() * 4)],
                size: 3 + Math.random() * 3,
                alpha: 1,
                maxLife: 35,
                currentLife: 0,
              });
            }

            s.shockwaves.push({
              x: cx,
              y: cy,
              radius: 10,
              maxRadius: 65,
              color: "#38bdf8",
              alpha: 0.9,
            });

            s.score += 15;
            s.hits += 1;
          });

          s.activeWords = [];

          // Heal player for +15 HP (up to 100 max)
          s.hp = Math.min(100, s.hp + 15);
          setHp(s.hp);
          setScore(s.score);
          setHits(s.hits);
        } else if (skillId === "ECHO_CHAIN") {
          cardBlastAudio.playEchoChainSound();
          s.echoChainArmed = true;
          setEchoChainArmed(true);
          s.calloutText = "⚡ ECHO CHAIN: Chuẩn bị kích nổ từ liên hoàn!";
          s.calloutUntil = Date.now() + 2500;
          setTimeout(() => {
            s.echoChainArmed = false;
            setEchoChainArmed(false);
          }, 8000);
        } else if (skillId === "FOG") {
          s.calloutText = "🌫️ MÙ SƯƠNG: Che khuất 60% ký tự đối thủ!";
          s.calloutUntil = Date.now() + 2500;
        } else if (skillId === "SHIELD") {
          s.calloutText = "🛡️ KHIÊN CHẮN: Sẵn sàng chặn đòn tấn công!";
          s.calloutUntil = Date.now() + 2500;
        }
        return;
      }
      if (slotIdx === 0) triggerEchoChain();
      else if (slotIdx === 1) triggerSlowMo();
      else if (slotIdx === 2) triggerEmpBlast();
    },
    [pvp, equippedSkills, currentMana, triggerEchoChain, triggerSlowMo, triggerEmpBlast]
  );

  // Keyboard shortcut listener (1, 2, 3 for skills, Tab for hint, Esc for Pause)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isNumberKey = e.key === "1" || e.key === "2" || e.key === "3";
      if (isNumberKey) {
        // Only allow typing numbers if an active word answer literally contains that digit
        const digitNeeded = engineRef.current.activeWords.some((w) =>
          w.targetAnswers.some((ans) => ans.includes(e.key))
        );
        if (!digitNeeded) {
          e.preventDefault();
          if (e.key === "1") triggerSkillSlot(0);
          else if (e.key === "2") triggerSkillSlot(1);
          else if (e.key === "3") triggerSkillSlot(2);
          return;
        }
      }

      if (e.key === "Tab") {
        e.preventDefault();
        triggerHint();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setIsPaused((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [triggerSkillSlot, triggerHint]);

  // Audio mute toggle
  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    cardBlastAudio.setMuted(next);
  };

  // TTS speech player for weak words review in Game Over modal
  const playWordAudio = useCallback((text: string) => {
    if (!text || typeof window === "undefined") return;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      window.speechSynthesis.speak(utterance);
    }
  }, []);

  // Restart battleground after Game Over
  const handleRestartBattle = useCallback(() => {
    const s = engineRef.current;
    s.hp = 100;
    s.mana = 30;
    s.score = 0;
    s.streak = 0;
    s.maxStreak = 0;
    s.hintsRemaining = 3;
    s.hits = 0;
    s.misses = 0;
    s.totalSpawns = 0;
    s.isOver = false;
    s.echoChainArmed = false;
    s.slowMoUntil = 0;
    s.calloutText = "";
    s.calloutUntil = 0;
    s.empFlashUntil = 0;
    s.activeWords = [];
    s.particles = [];
    s.shockwaves = [];
    s.laserRays = [];
    s.lightningBolts = [];
    s.floatingTexts = [];
    s.revengeQueue = [];
    s.missedWordsMap.clear();
    s.availablePool = [...s.wordsPool].sort(() => 0.5 - Math.random());

    setHp(100);
    setMana(30);
    setScore(0);
    setStreak(0);
    setMaxStreak(0);
    setHintsRemaining(3);
    setInputValue("");
    setEchoChainArmed(false);
    setSlowMoActive(false);
    setIsGameOver(false);
    setGameOverSummary(null);

    runCountdownSequence();
  }, [runCountdownSequence]);

  // ==============================================================
  // MAIN CANVAS GAME LOOP (60 FPS COSMIC NEBULA ARENA)
  // ==============================================================
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    let animationFrameId: number;
    let lastTimestamp = performance.now();

    // Auto-resize canvas with Hi-DPI
    const resizeCanvas = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.scale(dpr, dpr);

      // Initialize 80 Parallax Drifting Stars (speed 0.3 - 1.5 px/frame)
      if (engineRef.current.stars.length === 0) {
        const stars: ParallaxStar[] = [];
        for (let i = 0; i < 80; i++) {
          stars.push({
            x: Math.random() * rect.width,
            y: Math.random() * rect.height,
            r: Math.random() * 1.2 + 0.6,
            alpha: Math.random() * 0.45 + 0.3,
            speed: 0.3 + Math.random() * 1.2, // 0.3 - 1.5 px/frame drifting downward
            layer: Math.random() > 0.45 ? 1 : 2,
            pulsePhase: Math.random() * Math.PI * 2,
            pulseSpeed: 0.02 + Math.random() * 0.03,
          });
        }
        engineRef.current.stars = stars;
      }
    };

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    // Game loop step
    const loop = (timestamp: number) => {
      const delta = Math.min(64, timestamp - lastTimestamp);
      lastTimestamp = timestamp;

      const s = engineRef.current;
      const displayWidth = canvas.clientWidth;
      const displayHeight = canvas.clientHeight;
      const dangerY = displayHeight - 96;

      const whaleX = displayWidth / 2;
      const whaleY = displayHeight - 44;

      if (pvpRef.current?.phase === "RESULT" || pvpRef.current?.result) {
        s.isOver = true;
        s.activeWords = [];
        return;
      }

      if (!s.isOver && !s.isPaused && countdown === null) {
        // --- 1. MANA PASSIVE REGENERATION (+2.0 mana/second) ---
        const passiveManaGain = 2.0 * (delta / 1000);
        s.mana = Math.min(100, s.mana + passiveManaGain);
        setMana(Math.floor(s.mana));

        // --- 2. SLOW-MO SKILL ACTIVE CHECK & SPEED FACTOR ---
        const isSlowMo = Date.now() < s.slowMoUntil;
        if (!isSlowMo && slowMoActive) {
          setSlowMoActive(false);
        }
        // 65% speed reduction when Slow-Mo active (speedFactor 0.35)
        const speedReductionFactor = isSlowMo ? 0.35 : 1.0;
        const speedFactor = (0.6 + (s.currentSpeedLevel - 1) * 0.22) * speedReductionFactor;

        // --- 3. MULTI-LANE SPAWNING & ANTI-OVERLAP COLLISION ENGINE ---
        if (pvp) {
          const currentSyncedMs = Date.now() + pvp.clockOffset;
          const t = currentSyncedMs - pvp.matchStartServerMs;

          if (t >= 0 && Array.isArray(pvp.schedule)) {
            const numLanes = 4;
            const padding = 140;
            const laneWidth = (displayWidth - padding * 2) / numLanes;

            for (const sw of pvp.schedule) {
              if (sw.spawnAtMs <= t && !spawnedPvpSeqsRef.current.has(sw.seq)) {
                // Garbage word check: ignore if targeted to opponent
                if (sw.isGarbage && sw.targetPlayerId && sw.targetPlayerId !== pvp.myState?.userId) {
                  continue;
                }

                spawnedPvpSeqsRef.current.add(sw.seq);

                // Subtle screen shake, vibration, and 1s lane alarm on incoming garbage word spawn
                if (sw.isGarbage) {
                  setScreenShake(true);
                  setTimeout(() => setScreenShake(false), 300);
                  if (typeof navigator !== "undefined" && navigator.vibrate) {
                    try {
                      navigator.vibrate(200);
                    } catch (_) {}
                  }
                  attackLaneAlarmRef.current = {
                    lane: sw.lane,
                    expiresAt: Date.now() + 1000,
                  };
                }

                const isEnVi = direction === "EN_VI";
                const displayText = isEnVi ? sw.word : truncatePromptText(sw.vietnamese);
                const subText = isEnVi ? sw.ipa || "" : sw.word;
                const primaryTarget = getPrimaryTarget(sw.targetAnswers);

                const isWordGolden = !!(sw.isGolden || (sw as any).golden);
                const isWordGarbage = !!(sw.isGarbage || (sw as any).garbage);

                ctx.font = `bold 15px ${uiFont()}`;
                const textWidth = ctx.measureText(displayText).width;
                const cleanTargetLen = primaryTarget.replace(/\s+/g, "").length;
                const letterBoxesWidth = cleanTargetLen * 18 + 24;
                const goldenBadgeWidth = 230;
                const garbageBadgeWidth = 220;

                const pillWidth = Math.max(
                  170,
                  Math.min(
                    laneWidth - 12,
                    Math.max(
                      textWidth + 48,
                      letterBoxesWidth,
                      isWordGolden ? goldenBadgeWidth : isWordGarbage ? garbageBadgeWidth : 0
                    )
                  )
                );
                const pillHeight = 68;

                const lane = Math.min(numLanes - 1, Math.max(0, sw.lane));
                const laneCenterX = padding + lane * laneWidth + laneWidth / 2;
                const rawX = laneCenterX - pillWidth / 2;
                const spawnX = Math.max(120, Math.min(displayWidth - pillWidth - 120, rawX));

                const speedPxPerMs = (dangerY + pillHeight) / (sw.fallDurationMs || 6000);

                s.activeWords.push({
                  uid: `pvp-${sw.seq}`,
                  data: {
                    id: Number(sw.wordId) || sw.wordId,
                    word: sw.word,
                    ipa: sw.ipa,
                    vietnamese: sw.vietnamese,
                    allMeanings: sw.targetAnswers || [],
                  },
                  laneIndex: lane,
                  x: spawnX,
                  y: -pillHeight,
                  targetX: spawnX,
                  width: pillWidth,
                  height: pillHeight,
                  speed: speedPxPerMs * 16.66,
                  displayText,
                  subText,
                  primaryTarget,
                  targetAnswers: sw.targetAnswers,
                  isRevenge: false,
                  isFrozen: false,
                  frozenRemainingMs: 0,
                  hintMaskedText: null,
                  revealedLetterIndices: [],
                  pvpSeq: sw.seq,
                  pvpSpawnAtMs: sw.spawnAtMs,
                  pvpFallDurationMs: sw.fallDurationMs,
                  isGarbage: isWordGarbage,
                  isGolden: isWordGolden,
                  targetPlayerId: sw.targetPlayerId,
                  spawnTime: Date.now(),
                  word: sw.word,
                  english: sw.word,
                  meaning: sw.vietnamese,
                });
              }
            }
          }
        } else {
          const numLanes = displayWidth < 640 ? 3 : displayWidth < 900 ? 4 : 5;
          const laneWidth = displayWidth / numLanes;

          // Anti-collision rule: Lane is occupied if ANY existing word in it has y < 160px
          const occupiedLanes = new Set(
            s.activeWords
              .filter((w) => w.y < 160)
              .map((w) => w.laneIndex)
          );

          const availableLanes: number[] = [];
          for (let l = 0; l < numLanes; l++) {
            if (!occupiedLanes.has(l)) {
              availableLanes.push(l);
            }
          }

          const canSpawnMore = s.activeWords.length < diffParams.maxSimultaneous;
          const timeSinceLastSpawn = timestamp - s.lastSpawnTime;
          const spawnThreshold = diffParams.baseInterval / (isSlowMo ? 0.6 : 1.0);

          if (
            canSpawnMore &&
            availableLanes.length > 0 &&
            (timeSinceLastSpawn >= spawnThreshold || s.activeWords.length === 0)
          ) {
            let nextWordData: BlastWord | null = null;
            let isRevengeSpawn = false;

            if (s.revengeQueue.length > 0 && s.spawnsSinceMiss >= 3) {
              nextWordData = s.revengeQueue.shift()!;
              isRevengeSpawn = true;
              s.spawnsSinceMiss = 0;
            } else {
              if (s.availablePool.length === 0) {
                s.availablePool = [...s.wordsPool].sort(() => 0.5 - Math.random());
              }
              if (s.availablePool.length > 0) {
                nextWordData = s.availablePool.pop()!;
                s.spawnsSinceMiss += 1;
              }
            }

            if (nextWordData) {
              s.totalSpawns += 1;
              s.lastSpawnTime = timestamp;

              const isEnVi = direction === "EN_VI";
              const displayText = isEnVi ? nextWordData.word : truncatePromptText(nextWordData.vietnamese);
              const subText = isEnVi ? nextWordData.ipa || "" : nextWordData.word;

              const targetAnswers = isEnVi
                ? [nextWordData.vietnamese, ...nextWordData.allMeanings]
                : [nextWordData.word];

              const primaryTarget = getPrimaryTarget(targetAnswers);

              // Compute pill width based on text length and letter boxes width
              ctx.font = `bold 15px ${uiFont()}`;
              const textWidth = ctx.measureText(displayText).width;
              const cleanTargetLen = primaryTarget.replace(/\s+/g, "").length;
              const letterBoxesWidth = cleanTargetLen * 18 + 24;

              const pillWidth = Math.max(
                160,
                Math.min(laneWidth - 12, Math.max(textWidth + 48, letterBoxesWidth))
              );
              const pillHeight = 68;

              // Pick random eligible lane
              const chosenLane = availableLanes[Math.floor(Math.random() * availableLanes.length)];
              const laneCenterX = laneWidth * (chosenLane + 0.5);
              const spawnX = Math.max(120, Math.min(displayWidth - pillWidth - 120, laneCenterX - pillWidth / 2));

              const baseFallSpeed = (0.7 + Math.random() * 0.35) * diffParams.speedMult * (0.6 + (s.currentSpeedLevel - 1) * 0.22);

              s.activeWords.push({
                uid: Math.random().toString(),
                data: nextWordData,
                laneIndex: chosenLane,
                x: spawnX,
                y: -pillHeight,
                targetX: spawnX,
                width: pillWidth,
                height: pillHeight,
                speed: baseFallSpeed,
                displayText,
                subText,
                primaryTarget,
                targetAnswers,
                isRevenge: isRevengeSpawn,
                isFrozen: false,
                frozenRemainingMs: 0,
                hintMaskedText: null,
                revealedLetterIndices: [],
                spawnTime: Date.now(),
                word: nextWordData.word,
                english: nextWordData.word,
                meaning: nextWordData.vietnamese,
              });
            }
          }
        }

        // --- 4. UPDATE ACTIVE FALLING WORDS ---
        for (let i = s.activeWords.length - 1; i >= 0; i--) {
          const w = s.activeWords[i];

          if (pvp && w.pvpSpawnAtMs !== undefined && w.pvpFallDurationMs !== undefined) {
            if (!w.speed) {
              w.speed = ((dangerY + w.height) / (w.pvpFallDurationMs || 6000)) * 16.66;
            }
            w.y += w.speed * speedReductionFactor * (delta / 16.66);
            w.x = Math.max(120, Math.min(displayWidth - w.width - 120, w.x));

            if (w.y + w.height >= dangerY) {
              s.activeWords.splice(i, 1);

              if (w.isGolden) {
                // Unclaimed golden words expire with 0 HP penalty
                cardBlastAudio.playFreezeHintSound();
                s.floatingTexts.push({
                  id: Math.random().toString(),
                  text: `HẾT HẠN ◆`,
                  x: w.x + w.width / 2,
                  y: dangerY - 10,
                  color: "#facc15",
                  fontSize: 16,
                  opacity: 1,
                  vy: -1.4,
                  life: 45,
                });
              } else {
                cardBlastAudio.playMissSound();
                triggerMissImpact();

                const hpLoss = pvp?.suddenDeath ? 24 : 12;
                s.hp = Math.max(0, s.hp - hpLoss);
                s.streak = 0;
                s.misses += 1;
                setHp(s.hp);
                setStreak(0);

                // Record last shot status: MISS (auto-dismiss in exactly 3.5s)
                if (lastShotTimeoutRef.current) {
                  clearTimeout(lastShotTimeoutRef.current);
                }
                setLastShotStatus({
                  type: "miss",
                  vietnamese: w.data.vietnamese,
                  english: w.data.word,
                });
                lastShotTimeoutRef.current = setTimeout(() => {
                  setLastShotStatus(null);
                }, 3500);

                // Escaped banner (auto-fade after 3.0s)
                const bannerId = Math.random().toString();
                setEscapedBanners((prev) => [
                  ...prev.slice(-2),
                  {
                    id: bannerId,
                    word: w.data.word,
                    meaning: w.data.vietnamese,
                    expiresAt: Date.now() + 3000,
                  },
                ]);

                s.floatingTexts.push({
                  id: Math.random().toString(),
                  text: `-${hpLoss} HP ❌`,
                  x: w.x + w.width / 2,
                  y: dangerY - 10,
                  color: "#f87171",
                  fontSize: 18,
                  opacity: 1,
                  vy: -1.4,
                  life: 45,
                });
              }
            }
          } else {
            if (w.isFrozen) {
              w.frozenRemainingMs -= delta;
              if (w.frozenRemainingMs <= 0) {
                w.isFrozen = false;
                w.hintMaskedText = null;
              }
            } else {
              // Apply authentic 65% Slow-Mo factor if active
              w.y += w.speed * speedReductionFactor * (delta / 16.66);
            }

            // Check Danger Line breach (Miss / Escape)
            if (w.y + w.height >= dangerY) {
              const hpLoss = diffParams.hpMiss;
              s.hp = Math.max(0, s.hp - hpLoss);
              s.streak = 0;
              s.misses += 1;
              setHp(s.hp);
              setStreak(0);

              cardBlastAudio.playMissSound();
              triggerMissImpact();

              s.revengeQueue.push(w.data);
              s.missedWordsMap.set(w.data.id, w.data);

              // Record last shot status: MISS (auto-dismiss in exactly 3.5s)
              if (lastShotTimeoutRef.current) {
                clearTimeout(lastShotTimeoutRef.current);
              }
              setLastShotStatus({
                type: "miss",
                vietnamese: w.data.vietnamese,
                english: w.data.word,
              });
              lastShotTimeoutRef.current = setTimeout(() => {
                setLastShotStatus(null);
              }, 3500);

              // Escaped banner (auto-fade after 3.0s)
              const bannerId = Math.random().toString();
              setEscapedBanners((prev) => [
                ...prev.slice(-2),
                {
                  id: bannerId,
                  word: w.data.word,
                  meaning: w.data.vietnamese,
                  expiresAt: Date.now() + 3000,
                },
              ]);

              s.floatingTexts.push({
                id: Math.random().toString(),
                text: `-${hpLoss} HP ❌`,
                x: w.x + w.width / 2,
                y: dangerY - 10,
                color: "#f87171",
                fontSize: 18,
                opacity: 1,
                vy: -1.4,
                life: 45,
              });

              s.activeWords.splice(i, 1);
            }
          }
        }

        // Check Game Over in Single Player (In PvP, termination is 100% server-authoritative)
        if (!pvp) {
          if (s.hp <= 0 && !s.isOver) {
            s.hp = 0;
            s.isOver = true;
            setIsGameOver(true);
            cardBlastAudio.playGameOverSound();

            const accuracy =
              s.hits + s.misses > 0 ? Math.round((s.hits / (s.hits + s.misses)) * 100) : 0;

            const summaryData = {
              score: s.score,
              accuracy,
              maxStreak: s.maxStreak,
              hits: s.hits,
              totalAttempts: s.hits + s.misses,
              missedWords: Array.from(s.missedWordsMap.values()),
              isCleared: false,
            };

            setGameOverSummary(summaryData);
            if (onGameOver) {
              onGameOver(summaryData);
            }
            return;
          }
        }
    }

      // --- 5. UPDATE PARALLAX MOVING STARFIELD ---
      s.stars.forEach((star) => {
        if (!s.isOver && !s.isPaused && countdown === null) {
          star.y += star.speed * (delta / 16.66);
          // Seamless loop back to top
          if (star.y > displayHeight) {
            star.y = 0;
            star.x = Math.random() * displayWidth;
          }
        }
        star.pulsePhase += star.pulseSpeed;
      });

      // --- AIM MASCOT CANNON TOWARD LOWEST OR MATCHING TARGET ---
      let aimTargetWord: ActiveFallingWord | null = null;
      if (inputValue.trim()) {
        aimTargetWord =
          s.activeWords.find((w) => checkPrefixMatch(inputValue, w.targetAnswers).isPrefixMatch) || null;
      }
      if (!aimTargetWord && s.activeWords.length > 0) {
        aimTargetWord = [...s.activeWords].sort((a, b) => b.y - a.y)[0];
      }

      if (aimTargetWord) {
        const targetCenterX = aimTargetWord.x + aimTargetWord.width / 2;
        const targetCenterY = aimTargetWord.y + aimTargetWord.height / 2;
        const desiredAngle = Math.atan2(targetCenterY - whaleY, targetCenterX - whaleX);
        s.cannonAngle += (desiredAngle - s.cannonAngle) * 0.15;
      }

      if (s.muzzleFlashFrames > 0) {
        s.muzzleFlashFrames -= 1;
      }

      // --- 6. RENDER COSMIC NEBULA CANVAS ---
      ctx.save();

      // Screen shake
      if (s.shakeFrames > 0) {
        const shakeMag = (s.shakeFrames / 12) * 5;
        const offsetX = (Math.random() - 0.5) * shakeMag * 2;
        const offsetY = (Math.random() - 0.5) * shakeMag * 2;
        ctx.translate(offsetX, offsetY);
        s.shakeFrames -= 1;
      }

      // A. BASE CANVAS FILL: DEEP COSMIC MIDNIGHT GRADIENT (#050716 to #090d26)
      const bgGrad = ctx.createLinearGradient(0, 0, 0, displayHeight);
      bgGrad.addColorStop(0, "#050716");
      bgGrad.addColorStop(1, "#090d26");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, displayWidth, displayHeight);

      // B. NEBULA DUST: 3 SOFT, SUBTLE RADIAL COLOR CLOUDS
      // Nebula 1 (Upper-left): Soft cosmic indigo/violet aura (rgba(99, 102, 241, 0.09) fading to 0)
      const neb1X = displayWidth * 0.22;
      const neb1Y = displayHeight * 0.26;
      const neb1R = Math.max(displayWidth, displayHeight) * 0.48;
      const neb1Grad = ctx.createRadialGradient(neb1X, neb1Y, 0, neb1X, neb1Y, neb1R);
      neb1Grad.addColorStop(0, "rgba(99, 102, 241, 0.09)");
      neb1Grad.addColorStop(1, "rgba(99, 102, 241, 0)");
      ctx.fillStyle = neb1Grad;
      ctx.fillRect(0, 0, displayWidth, displayHeight);

      // Nebula 2 (Lower-right): Soft cyan/teal star nebula (rgba(20, 184, 166, 0.07) fading to 0)
      const neb2X = displayWidth * 0.78;
      const neb2Y = displayHeight * 0.72;
      const neb2R = Math.max(displayWidth, displayHeight) * 0.48;
      const neb2Grad = ctx.createRadialGradient(neb2X, neb2Y, 0, neb2X, neb2Y, neb2R);
      neb2Grad.addColorStop(0, "rgba(20, 184, 166, 0.07)");
      neb2Grad.addColorStop(1, "rgba(20, 184, 166, 0)");
      ctx.fillStyle = neb2Grad;
      ctx.fillRect(0, 0, displayWidth, displayHeight);

      // Nebula 3 (Center subtle cosmic purple aura)
      const neb3X = displayWidth * 0.52;
      const neb3Y = displayHeight * 0.48;
      const neb3R = Math.max(displayWidth, displayHeight) * 0.38;
      const neb3Grad = ctx.createRadialGradient(neb3X, neb3Y, 0, neb3X, neb3Y, neb3R);
      neb3Grad.addColorStop(0, "rgba(168, 85, 247, 0.05)");
      neb3Grad.addColorStop(1, "rgba(168, 85, 247, 0)");
      ctx.fillStyle = neb3Grad;
      ctx.fillRect(0, 0, displayWidth, displayHeight);

      // C. PARALLAX DRIFTING STARS (70-90 stars drifting downward, wrapping smoothly with subtle twinkling)
      s.stars.forEach((star) => {
        ctx.save();
        const pulseAlpha = Math.max(0.2, Math.min(1.0, star.alpha + Math.sin(star.pulsePhase) * 0.28));
        ctx.globalAlpha = pulseAlpha;

        if (star.layer === 1) {
          ctx.fillStyle = "#94a3b8";
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = "#ffffff";
          ctx.shadowColor = "#38bdf8";
          ctx.shadowBlur = 6;
          ctx.beginPath();
          ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      });

      // D. TIME-DILATION CYAN AURA & FLOATING TIMER DURING SLOW-MO
      if (Date.now() < s.slowMoUntil) {
        const remainingMs = Math.max(0, s.slowMoUntil - Date.now());
        ctx.save();
        ctx.fillStyle = "rgba(6, 182, 212, 0.09)";
        ctx.fillRect(0, 0, displayWidth, displayHeight);
        ctx.strokeStyle = "rgba(6, 182, 212, 0.45)";
        ctx.lineWidth = 3;
        ctx.strokeRect(0, 0, displayWidth, displayHeight);

        // Floating countdown timer on canvas
        ctx.fillStyle = "#38bdf8";
        ctx.shadowColor = "#06b6d4";
        ctx.shadowBlur = 12;
        ctx.font = "bold 14px monospace";
        ctx.textAlign = "center";
        ctx.fillText(`⏳ SLOW-MO: ${(remainingMs / 1000).toFixed(1)}s`, displayWidth / 2, 70);
        ctx.restore();
      }

      // Sudden Death dark amethyst/purple tint shift (no red)
      if (pvp && pvp.suddenDeath && countdown === null) {
        ctx.save();
        ctx.fillStyle = "rgba(147, 51, 234, 0.08)";
        ctx.fillRect(0, 0, displayWidth, displayHeight);
        ctx.restore();
      }

      // Incoming Attack Lane Alarm (1-second red/purple lane highlight)
      if (attackLaneAlarmRef.current && Date.now() < attackLaneAlarmRef.current.expiresAt) {
        const lane = attackLaneAlarmRef.current.lane;
        const numLanes = 4;
        const laneW = displayWidth / numLanes;
        const lx = lane * laneW;
        const remainingRatio = Math.max(0, (attackLaneAlarmRef.current.expiresAt - Date.now()) / 1000);

        ctx.save();
        const alarmGrad = ctx.createLinearGradient(lx, 0, lx, displayHeight);
        alarmGrad.addColorStop(0, `rgba(225, 29, 72, ${0.45 * remainingRatio})`);
        alarmGrad.addColorStop(0.4, `rgba(168, 85, 247, ${0.3 * remainingRatio})`);
        alarmGrad.addColorStop(1, "transparent");

        ctx.fillStyle = alarmGrad;
        ctx.fillRect(lx, 0, laneW, displayHeight);

        // Warning pulsating border along the lane
        ctx.strokeStyle = `rgba(244, 63, 94, ${0.85 * remainingRatio})`;
        ctx.shadowColor = "#f43f5e";
        ctx.shadowBlur = 15;
        ctx.lineWidth = 3;
        ctx.strokeRect(lx + 2, 0, laneW - 4, displayHeight);

        // Warning icon at top of lane
        ctx.fillStyle = `rgba(255, 255, 255, ${remainingRatio})`;
        ctx.font = `bold 13px ${uiFont()}`;
        ctx.textAlign = "center";
        ctx.fillText("⚠️ CẢNH BÁO TẤN CÔNG!", lx + laneW / 2, 40);
        ctx.restore();
      }

      // Incoming Attack Telegraph Energy Beam & 2s Countdown Ring (Exclusively for victim)
      if (pvp && pvp.incomingAttack) {
        const attack = pvp.incomingAttack;
        const myId = pvp.myState?.userId;
        const targetId = attack.targetUserId || attack.targetPlayerId;
        const isVictim = !targetId || !myId || String(targetId) === String(myId);
        if (isVictim) {
          const telegraphMs = attack.telegraphMs || 2000;
        const elapsed = Date.now() - attackStartRef.current;
        if (elapsed < telegraphMs) {
          const progress = Math.max(0, Math.min(1, elapsed / telegraphMs));
          const hudX = displayWidth - 110;
          const hudY = 45;
          const targetX = displayWidth * 0.5;
          const targetY = 160;

          ctx.save();
          // Glowing arcing purple energy beam
          ctx.strokeStyle = "rgba(168, 85, 247, 0.85)";
          ctx.shadowColor = "#c084fc";
          ctx.shadowBlur = 18;
          ctx.lineWidth = 3.5 + Math.sin(timestamp * 0.015) * 1.5;
          ctx.setLineDash([14, 8]);
          ctx.lineDashOffset = -timestamp * 0.05;
          ctx.beginPath();
          ctx.moveTo(hudX, hudY);
          const cpX = displayWidth * 0.75;
          const cpY = 25;
          ctx.quadraticCurveTo(cpX, cpY, targetX, targetY);
          ctx.stroke();

          // Circular countdown ring at destination
          ctx.setLineDash([]);
          const ringR = 26;
          // Background ring
          ctx.strokeStyle = "rgba(168, 85, 247, 0.35)";
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(targetX, targetY, ringR, 0, Math.PI * 2);
          ctx.stroke();

          // Progress remaining arc
          ctx.strokeStyle = "#e879f9";
          ctx.lineWidth = 4.5;
          ctx.shadowColor = "#f0abfc";
          ctx.shadowBlur = 14;
          ctx.beginPath();
          ctx.arc(
            targetX,
            targetY,
            ringR,
            -Math.PI / 2,
            -Math.PI / 2 + (1 - progress) * Math.PI * 2
          );
          ctx.stroke();

          // Center countdown text
          ctx.fillStyle = "#ffffff";
          ctx.shadowColor = "#a855f7";
          ctx.shadowBlur = 8;
          ctx.font = `bold 11px ${uiFont()}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
            const remSec = Math.max(0, (attack.telegraphMs - elapsed) / 1000).toFixed(1);
            ctx.fillText(`⚡ ${remSec}s`, targetX, targetY);
            ctx.restore();
          }
        }
      }

      // E. EMP FLASH EFFECT (White/cyan screen flash for 250ms)
      if (Date.now() < s.empFlashUntil) {
        const flashRemaining = s.empFlashUntil - Date.now();
        const flashAlpha = Math.min(1, flashRemaining / 250);
        ctx.save();
        ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha * 0.85})`;
        ctx.fillRect(0, 0, displayWidth, displayHeight);
        ctx.strokeStyle = `rgba(6, 182, 212, ${flashAlpha})`;
        ctx.lineWidth = 14;
        ctx.strokeRect(0, 0, displayWidth, displayHeight);
        ctx.restore();
      }

      // F. RADIANT SKILL ANNOUNCEMENT BANNER ACROSS UPPER CANVAS (2.5 full seconds)
      if (Date.now() < s.calloutUntil && s.calloutText) {
        const timeLeft = s.calloutUntil - Date.now();
        const bannerAlpha = Math.min(1, timeLeft / 400);
        ctx.save();
        ctx.globalAlpha = bannerAlpha;
        ctx.font = `bold 15px ${uiFont()}`;
        const tw = ctx.measureText(s.calloutText).width;
        const bw = tw + 44;
        const bh = 36;
        const bx = (displayWidth - bw) / 2;
        const by = 24;

        const isEmp = s.calloutText.includes("EMP");
        const isSlow = s.calloutText.includes("SLOW");

        ctx.shadowColor = isEmp
          ? "rgba(245, 158, 11, 0.75)"
          : isSlow
          ? "rgba(6, 182, 212, 0.75)"
          : "rgba(168, 85, 247, 0.75)";
        ctx.shadowBlur = 18;

        ctx.fillStyle = "rgba(15, 23, 42, 0.94)";
        ctx.strokeStyle = isEmp ? "#fbbf24" : isSlow ? "#38bdf8" : "#c084fc";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 18);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(s.calloutText, displayWidth / 2, by + bh / 2);
        ctx.restore();
      }

      // Floating Slow-Mo Timer Badge: ⏳ LÀM CHẬM (5s)
      const isSlowMoActive = Date.now() < s.slowMoUntil || slowMoActive;
      if (isSlowMoActive) {
        ctx.save();
        const slowMoSec = Math.max(1, Math.ceil((s.slowMoUntil - Date.now()) / 1000));
        const badgeText = `⏳ LÀM CHẬM (${slowMoSec}s)`;
        ctx.font = `bold 13px ${uiFont()}`;
        const tw = ctx.measureText(badgeText).width;
        const bw = tw + 28;
        const bh = 30;
        const bx = (displayWidth - bw) / 2;
        const by = 68;

        ctx.shadowColor = "#38bdf8";
        ctx.shadowBlur = 20;
        ctx.fillStyle = "rgba(12, 74, 110, 0.95)";
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 15);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(badgeText, displayWidth / 2, by + bh / 2 + 0.5);
        ctx.restore();
      }

      // G. SLEEK RED DASHED LASER LINE (NO "DEFEND HERE", ONLY "⚠ VẠCH NGUY HIỂM")
      ctx.save();
      ctx.shadowColor = "rgba(239, 68, 68, 0.95)";
      ctx.shadowBlur = 8 + Math.sin(timestamp * 0.006) * 4;
      ctx.strokeStyle = "rgba(239, 68, 68, 0.85)";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([12, 6]);
      ctx.beginPath();
      ctx.moveTo(10, dangerY);
      ctx.lineTo(displayWidth - 10, dangerY);
      ctx.stroke();

      ctx.fillStyle = "rgba(239, 68, 68, 0.95)";
      ctx.font = `bold 11px ${uiFont()}`;
      ctx.fillText("⚠ VẠCH NGUY HIỂM", 20, dangerY - 6);
      ctx.restore();

      // H. JAGGED LIGHTNING BEAMS (ECHO CHAIN DETONATION)
      for (let lbIdx = s.lightningBolts.length - 1; lbIdx >= 0; lbIdx--) {
        const bolt = s.lightningBolts[lbIdx];
        ctx.save();
        ctx.globalAlpha = Math.max(0, bolt.life / bolt.maxLife);
        ctx.strokeStyle = bolt.color;
        ctx.shadowColor = "#a855f7";
        ctx.shadowBlur = 18;
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        bolt.segments.forEach((pt, pIdx) => {
          if (pIdx === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        });
        ctx.stroke();

        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();

        bolt.life -= 1;
        if (bolt.life <= 0) {
          s.lightningBolts.splice(lbIdx, 1);
        }
      }

      // I. DRAW CANNON LASER RAYS
      for (let l = s.laserRays.length - 1; l >= 0; l--) {
        const ray = s.laserRays[l];
        ctx.save();
        ctx.globalAlpha = Math.max(0, ray.life / 8);
        ctx.strokeStyle = ray.color;
        ctx.shadowColor = ray.color;
        ctx.shadowBlur = 15;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(ray.startX, ray.startY);
        ctx.lineTo(ray.endX, ray.endY);
        ctx.stroke();
        ctx.restore();

        ray.life -= 1;
        if (ray.life <= 0) {
          s.laserRays.splice(l, 1);
        }
      }

      // J. DRAW EXPANDING SHOCKWAVES
      for (let swIdx = s.shockwaves.length - 1; swIdx >= 0; swIdx--) {
        const sw = s.shockwaves[swIdx];
        sw.radius += 3.2;
        sw.alpha = Math.max(0, 1 - sw.radius / sw.maxRadius);

        if (sw.radius >= sw.maxRadius) {
          s.shockwaves.splice(swIdx, 1);
          continue;
        }

        ctx.save();
        ctx.strokeStyle = sw.color;
        ctx.shadowColor = sw.color;
        ctx.shadowBlur = 12;
        ctx.lineWidth = 2.5;
        ctx.globalAlpha = sw.alpha;
        ctx.beginPath();
        ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // K. DRAW FALLING WORD CAPSULES
      s.activeWords.forEach((w) => {
        ctx.save();

        const x = w.x;
        const y = w.y;
        const width = w.width;
        const height = w.height;

        const prefixResult = checkPrefixMatch(inputValue, w.targetAnswers);
        const isTargetedMatch = prefixResult.isPrefixMatch;

        if (w.isGolden) {
          ctx.shadowColor = "#f59e0b";
          ctx.shadowBlur = 30;
          ctx.strokeStyle = "#fbbf24";
          const goldGrad = ctx.createLinearGradient(x, y, x, y + height);
          goldGrad.addColorStop(0, "rgba(250, 204, 21, 0.45)");
          goldGrad.addColorStop(0.5, "rgba(245, 158, 11, 0.45)");
          goldGrad.addColorStop(1, "rgba(217, 119, 6, 0.55)");
          ctx.fillStyle = goldGrad;
          ctx.lineWidth = 3.5;
        } else if (w.isGarbage) {
          const pulse = (Math.sin(Date.now() / 120) + 1) / 2;
          const borderColor = pulse > 0.5 ? "#c084fc" : "#f43f5e";
          ctx.shadowColor = borderColor;
          ctx.shadowBlur = 24 + pulse * 8;
          ctx.strokeStyle = borderColor;
          const garbGrad = ctx.createLinearGradient(x, y, x, y + height);
          garbGrad.addColorStop(0, "rgba(168, 85, 247, 0.4)");
          garbGrad.addColorStop(1, "rgba(225, 29, 72, 0.5)");
          ctx.fillStyle = garbGrad;
          ctx.lineWidth = 3;
        } else if (isTargetedMatch) {
          ctx.shadowColor = "#f59e0b";
          ctx.shadowBlur = 24;
          ctx.strokeStyle = "#fbbf24";
          ctx.fillStyle = "rgba(40, 25, 5, 0.92)";
        } else if (w.isFrozen) {
          ctx.shadowColor = "rgba(56, 189, 248, 0.95)";
          ctx.shadowBlur = 20;
          ctx.strokeStyle = "#38bdf8";
          ctx.fillStyle = "rgba(12, 74, 110, 0.92)";
        } else if (w.isRevenge) {
          ctx.shadowColor = "rgba(239, 68, 68, 0.95)";
          ctx.shadowBlur = 22;
          ctx.strokeStyle = "#ef4444";
          ctx.fillStyle = "rgba(69, 10, 10, 0.94)";
        } else {
          ctx.shadowColor = "rgba(6, 182, 212, 0.65)";
          ctx.shadowBlur = 14;
          ctx.strokeStyle = "#06b6d4";
          ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
        }

        ctx.lineWidth = w.isGolden ? 3.5 : (isTargetedMatch || w.isGarbage ? 3 : 2);

        ctx.beginPath();
        ctx.roundRect(x, y, width, height, 18);
        ctx.fill();
        ctx.stroke();

        // Dark contrast background inside golden card for crisp text readability
        if (w.isGolden) {
          ctx.save();
          ctx.fillStyle = "rgba(15, 23, 42, 0.78)";
          ctx.beginPath();
          ctx.roundRect(x + 5, y + 5, width - 10, height - 10, 14);
          ctx.fill();
          ctx.restore();
        }

        // Thruster flame
        if (!w.isFrozen) {
          ctx.save();
          const flameH = 4 + Math.random() * 4;
          ctx.fillStyle = w.isGolden ? "#facc15" : w.isGarbage ? "#c084fc" : w.isRevenge ? "#f87171" : "#38bdf8";
          ctx.beginPath();
          ctx.moveTo(x + width / 2 - 8, y);
          ctx.lineTo(x + width / 2 + 8, y);
          ctx.lineTo(x + width / 2, y - flameH);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }

        // Target Lock Brackets
        if (isTargetedMatch) {
          ctx.save();
          ctx.strokeStyle = "#f59e0b";
          ctx.lineWidth = 2.5;
          const cornerLen = 8;
          ctx.beginPath();
          ctx.moveTo(x - 4, y + cornerLen);
          ctx.lineTo(x - 4, y - 4);
          ctx.lineTo(x + cornerLen, y - 4);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x + width + 4 - cornerLen, y - 4);
          ctx.lineTo(x + width + 4, y - 4);
          ctx.lineTo(x + width + 4, y + cornerLen);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x - 4, y + height - cornerLen);
          ctx.lineTo(x - 4, y + height + 4);
          ctx.lineTo(x + cornerLen, y + height + 4);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x + width + 4 - cornerLen, y + height + 4);
          ctx.lineTo(x + width + 4, y + height + 4);
          ctx.lineTo(x + width + 4, y + height - cornerLen);
          ctx.stroke();
          ctx.restore();
        }

        // Badges
        if (w.isGolden) {
          ctx.save();
          const badgeText = "[ ◆ TỪ VÀNG TRANH ĐOẠT ]";
          ctx.font = `bold 11px ${uiFont()}`;
          const bw = ctx.measureText(badgeText).width + 18;
          const bh = 22;
          const bx = x + (width - bw) / 2;
          const by = y - bh - 5;

          ctx.shadowColor = "#f59e0b";
          ctx.shadowBlur = 24;
          ctx.fillStyle = "#f59e0b";
          ctx.strokeStyle = "#fbbf24";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(bx, by, bw, bh, 8);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = "#0f172a";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(badgeText, x + width / 2, by + bh / 2 + 0.5);
          ctx.restore();

          // Floating Particle Dust: Spawn ambient sparkling gold dots around the golden card
          ctx.save();
          const now = Date.now();
          for (let pIdx = 0; pIdx < 6; pIdx++) {
            const angle = (now / 350 + (pIdx * Math.PI) / 3) % (Math.PI * 2);
            const radiusOffset = 6 + (pIdx % 3) * 5;
            const px = x + width / 2 + Math.cos(angle) * (width / 2 + radiusOffset);
            const py = y + height / 2 + Math.sin(angle) * (height / 2 + radiusOffset);
            const pSize = 1.5 + (pIdx % 2) * 1.5;
            const pAlpha = 0.5 + 0.5 * Math.sin(now / 180 + pIdx);

            ctx.fillStyle = `rgba(250, 204, 21, ${pAlpha})`;
            ctx.shadowColor = "#facc15";
            ctx.shadowBlur = 10;
            ctx.beginPath();
            ctx.arc(px, py, pSize, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        } else if (w.isGarbage) {
          ctx.save();
          const badgeText = "[ ⚠️ TỪ PHẠT: BOT GỬI ĐẾN! ]";
          ctx.font = `bold 10px ${uiFont()}`;
          const bw = ctx.measureText(badgeText).width + 16;
          const bh = 20;
          const bx = x + (width - bw) / 2;
          const by = y - bh - 4;

          ctx.shadowColor = "#f43f5e";
          ctx.shadowBlur = 18;
          ctx.fillStyle = "#881337";
          ctx.strokeStyle = "#f43f5e";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.roundRect(bx, by, bw, bh, 8);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = "#ffe4e6";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(badgeText, x + width / 2, by + bh / 2 + 0.5);
          ctx.restore();
        } else if (w.isRevenge) {
          ctx.save();
          ctx.fillStyle = "#ef4444";
          ctx.font = `bold 9px ${uiFont()}`;
          const badgeText = "⚠ PHỤC THÙ";
          const bw = ctx.measureText(badgeText).width + 10;
          ctx.beginPath();
          ctx.roundRect(x + (width - bw) / 2, y - 9, bw, 16, 8);
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.fillText(badgeText, x + (width - bw) / 2 + 5, y + 3);
          ctx.restore();
        }

        if (w.isFrozen) {
          ctx.save();
          ctx.fillStyle = "#0284c7";
          ctx.font = "bold 9px monospace";
          const freezeText = `❄ ${(w.frozenRemainingMs / 1000).toFixed(1)}s`;
          const bw = ctx.measureText(freezeText).width + 10;
          ctx.beginPath();
          ctx.roundRect(x + (width - bw) / 2, y - 9, bw, 16, 8);
          ctx.fill();
          ctx.fillStyle = "#ffffff";
          ctx.fillText(freezeText, x + (width - bw) / 2 + 5, y + 3);
          ctx.restore();
        }

        // Letter Boxes based on hintLevel:
        // EASY: reveals first 2 letters + blanks
        // NORMAL: reveals first 1 letter + blanks
        // HARD: no blanks rendered at all
        let slots: LetterBoxSlot[] = [];
        if (pvp ? pvp.hintLevel === "HARD" : difficulty === "hard") {
          slots = [];
        } else {
          const effectiveDiff = pvp
            ? pvp.hintLevel === "EASY"
              ? "easy"
              : "normal"
            : difficulty;
          const letterBoxes = getLetterBoxesData(
            w.primaryTarget,
            isTargetedMatch ? inputValue : "",
            effectiveDiff,
            w.revealedLetterIndices
          );
          slots = letterBoxes.slots;
        }

        // Render Prompt Text
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = w.isGolden ? "#fef08a" : w.isGarbage ? "#f3e8ff" : w.isRevenge ? "#fecaca" : isTargetedMatch ? "#fef3c7" : "#ffffff";
        ctx.font = w.isGolden ? `900 16px ${uiFont()}` : `bold 15px ${uiFont()}`;
        if (w.isGolden) {
          ctx.shadowColor = "#000000";
          ctx.shadowBlur = 8;
        }
        const textCenterY = slots.length > 0 ? y + 21 : y + height / 2;

        let promptToRender = w.displayText;
        const isFogged = Boolean(pvp && pvp.fogActiveUntilMs && Date.now() < pvp.fogActiveUntilMs);
        if (isFogged) {
          promptToRender = promptToRender
            .split("")
            .map((ch, idx) => (ch === " " ? " " : idx % 5 < 3 ? "•" : ch))
            .join("");
        }
        ctx.fillText(promptToRender, x + width / 2, textCenterY);

        if (isFogged) {
          ctx.save();
          ctx.fillStyle = "rgba(100, 116, 139, 0.35)";
          ctx.beginPath();
          ctx.roundRect(x, y, width, height, 12);
          ctx.fill();
          ctx.restore();
        }

        if (w.subText && direction === "EN_VI" && slots.length > 0) {
          ctx.fillStyle = "rgba(148, 163, 184, 0.85)";
          ctx.font = "10px monospace";
          ctx.fillText(w.subText, x + width / 2, y + 36);
        }

        if (slots.length > 0) {
          const slotW = 15;
          const slotH = 17;
          const slotGap = 2.5;
          const spaceGap = 6;

          let totalBoxesWidth = 0;
          slots.forEach((sSlot) => {
            totalBoxesWidth += sSlot.isSpace ? spaceGap : slotW + slotGap;
          });
          totalBoxesWidth -= slotGap;

          let startBoxX = x + (width - totalBoxesWidth) / 2;
          const boxY = y + 43;

          slots.forEach((slot) => {
            if (slot.isSpace) {
              startBoxX += spaceGap;
              return;
            }

            ctx.save();
            if (slot.isTyped) {
              ctx.fillStyle = "#f59e0b";
              ctx.strokeStyle = "#fbbf24";
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.roundRect(startBoxX, boxY, slotW, slotH, 4);
              ctx.fill();
              ctx.stroke();

              ctx.fillStyle = "#ffffff";
              ctx.font = `bold 11px ${uiFont()}`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillText(slot.displayChar, startBoxX + slotW / 2, boxY + slotH / 2 + 0.5);
            } else if (slot.isRevealed) {
              ctx.fillStyle = "rgba(14, 165, 233, 0.2)";
              ctx.strokeStyle = "#38bdf8";
              ctx.lineWidth = 1.2;
              ctx.beginPath();
              ctx.roundRect(startBoxX, boxY, slotW, slotH, 4);
              ctx.fill();
              ctx.stroke();

              ctx.fillStyle = "#7dd3fc";
              ctx.font = `bold 11px ${uiFont()}`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              const charToDraw = isFogged ? "•" : slot.displayChar;
              ctx.fillText(charToDraw, startBoxX + slotW / 2, boxY + slotH / 2 + 0.5);
            } else {
              ctx.fillStyle = "rgba(15, 23, 42, 0.6)";
              ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.roundRect(startBoxX, boxY, slotW, slotH, 4);
              ctx.fill();
              ctx.stroke();
            }
            ctx.restore();

            startBoxX += slotW + slotGap;
          });
        }

        ctx.restore();
      });

      // L. PARTICLES
      for (let i = s.particles.length - 1; i >= 0; i--) {
        const p = s.particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.14;
        p.currentLife += 1;
        p.alpha = Math.max(0, 1 - p.currentLife / p.maxLife);

        if (p.currentLife >= p.maxLife) {
          s.particles.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // M. FLOATING TEXTS
      for (let i = s.floatingTexts.length - 1; i >= 0; i--) {
        const ft = s.floatingTexts[i];
        ft.y += ft.vy;
        ft.life -= 1;
        ft.opacity = Math.max(0, ft.life / 45);

        if (ft.life <= 0) {
          s.floatingTexts.splice(i, 1);
          continue;
        }

        ctx.save();
        ctx.globalAlpha = ft.opacity;
        ctx.fillStyle = ft.color;
        ctx.shadowColor = ft.color;
        ctx.shadowBlur = 12;
        ctx.font = `bold ${ft.fontSize}px ${uiFont()}`;
        ctx.textAlign = "center";
        ctx.fillText(ft.text, ft.x, ft.y);
        ctx.restore();
      }

      // N. MASCOT CANNON & CHIBI WHALE
      ctx.save();
      ctx.translate(whaleX, whaleY);

      // Cannon barrel
      ctx.save();
      ctx.rotate(s.cannonAngle);

      const barrelGrad = ctx.createLinearGradient(0, -5, 32, 5);
      barrelGrad.addColorStop(0, "#334155");
      barrelGrad.addColorStop(0.5, "#64748b");
      barrelGrad.addColorStop(1, "#94a3b8");
      ctx.fillStyle = barrelGrad;
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(0, -6, 32, 12, 3);
      ctx.fill();
      ctx.stroke();

      ctx.strokeStyle = "#00f0ff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(16, 0, 7, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(26, 0, 7, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();

      if (s.muzzleFlashFrames > 0) {
        ctx.save();
        ctx.fillStyle = "#fef08a";
        ctx.shadowColor = "#f59e0b";
        ctx.shadowBlur = 20;
        ctx.beginPath();
        ctx.arc(36, 0, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();

      // Chibi Whale Mascot
      ctx.fillStyle = "#0284c7";
      ctx.beginPath();
      ctx.ellipse(-26, 2, 9, 5, -Math.PI / 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(-26, 8, 9, 5, Math.PI / 6, 0, Math.PI * 2);
      ctx.fill();

      const whaleGrad = ctx.createLinearGradient(-22, -18, 22, 18);
      whaleGrad.addColorStop(0, "#38bdf8");
      whaleGrad.addColorStop(0.6, "#0284c7");
      whaleGrad.addColorStop(1, "#0369a1");
      ctx.fillStyle = whaleGrad;
      ctx.beginPath();
      ctx.ellipse(0, 4, 25, 18, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#f0fdfa";
      ctx.beginPath();
      ctx.ellipse(4, 11, 16, 8, 0.1, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "#cbd5e1";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-4, 12);
      ctx.lineTo(-4, 17);
      ctx.moveTo(3, 11);
      ctx.lineTo(3, 18);
      ctx.moveTo(10, 10);
      ctx.lineTo(10, 17);
      ctx.stroke();

      ctx.fillStyle = "#0284c7";
      ctx.beginPath();
      ctx.ellipse(-2, 12, 8, 4, Math.PI / 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#0f172a";
      ctx.beginPath();
      ctx.arc(14, -2, 3.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(15.2, -3.2, 1.3, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(244, 114, 182, 0.75)";
      ctx.beginPath();
      ctx.ellipse(10, 3, 4, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(18, 3, 3, 0.1, Math.PI * 0.75);
      ctx.stroke();

      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(2, -14);
      ctx.lineTo(2, -22);
      ctx.stroke();
      ctx.fillStyle = "#facc15";
      ctx.shadowColor = "#facc15";
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(2, -23, 3.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
      ctx.restore();

      // Shield Protection Bubble around Whale Cannon
      if (pvp?.shieldActiveUntilMs && Date.now() < pvp.shieldActiveUntilMs) {
        ctx.save();
        const pulse = Math.sin(Date.now() / 150) * 3;
        const shieldR = 48 + pulse;

        // Translucent glowing cyan bubble
        ctx.shadowColor = "#00f0ff";
        ctx.shadowBlur = 25;
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 3;
        ctx.fillStyle = "rgba(6, 182, 212, 0.22)";

        ctx.beginPath();
        ctx.arc(whaleX, whaleY, shieldR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Pulsating shield hex ring / energy lines
        ctx.strokeStyle = "rgba(125, 211, 252, 0.6)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(whaleX, whaleY, shieldR - 6, 0, Math.PI * 2);
        ctx.stroke();

        // Shield badge: [ 🛡️ KHIÊN BẢO VỆ ]
        const badgeText = "[ 🛡️ KHIÊN BẢO VỆ ]";
        ctx.font = `bold 11px ${uiFont()}`;
        const bw = ctx.measureText(badgeText).width + 16;
        const bh = 22;
        const bx = whaleX - bw / 2;
        const by = whaleY - shieldR - 26;

        ctx.shadowColor = "#00f0ff";
        ctx.shadowBlur = 15;
        ctx.fillStyle = "rgba(8, 51, 68, 0.95)";
        ctx.strokeStyle = "#00f0ff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 8);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#38bdf8";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(badgeText, whaleX, by + bh / 2);
        ctx.restore();
      }

      if (!s.isOver) {
        animationFrameId = requestAnimationFrame(loop);
      }
    };

    animationFrameId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", resizeCanvas);
    };
  }, [diffParams, direction, difficulty, inputValue, countdown, slowMoActive, triggerMissImpact, onGameOver]);

  // Clean up expired flash banners
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setEscapedBanners((prev) => prev.filter((b) => b.expiresAt > now));
    }, 200);
    return () => clearInterval(timer);
  }, []);

  // ==============================================================
  // SMART INPUT HANDLER (INSTANT MATCH, NO ENTER KEY REQUIRED)
  // ==============================================================
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInputValue(val);

    const s = engineRef.current;
    if (s.isOver || s.isPaused || countdown !== null || !val.trim()) return;

    const inputClean = val.toLowerCase().trim();
    if (!inputClean) return;

    for (let i = 0; i < s.activeWords.length; i++) {
      const targetWord = s.activeWords[i];

      const answerCandidates: string[] = [];
      if (targetWord.targetAnswers && targetWord.targetAnswers.length > 0) {
        answerCandidates.push(...targetWord.targetAnswers);
      }
      if (targetWord.primaryTarget) {
        answerCandidates.push(targetWord.primaryTarget);
      }
      if (direction === "VI_EN") {
        if (targetWord.data?.word) answerCandidates.push(targetWord.data.word);
        if (targetWord.word) answerCandidates.push(targetWord.word);
        if (targetWord.english) answerCandidates.push(targetWord.english);
        if (targetWord.subText) answerCandidates.push(targetWord.subText);
      } else {
        if (targetWord.data?.vietnamese) answerCandidates.push(targetWord.data.vietnamese);
        if (targetWord.meaning) answerCandidates.push(targetWord.meaning);
        if (targetWord.displayText) answerCandidates.push(targetWord.displayText);
      }

      // Check against actual English target strings in VI_EN mode or candidates
      const isEnglishMatch =
        (targetWord.word && inputClean === targetWord.word.toLowerCase().trim()) ||
        (targetWord.english && inputClean === targetWord.english.toLowerCase().trim()) ||
        (targetWord.data?.word && inputClean === targetWord.data.word.toLowerCase().trim()) ||
        (targetWord.primaryTarget && inputClean === targetWord.primaryTarget.toLowerCase().trim()) ||
        (targetWord.targetAnswers && targetWord.targetAnswers.some((a) => a.toLowerCase().trim() === inputClean));

      const isCorrect = isEnglishMatch || checkWordMatch(val, answerCandidates);

      if (isCorrect) {
        if (pvp && targetWord.pvpSeq !== undefined) {
          const matchStart = pvp.matchStartServerMs > 0 ? pvp.matchStartServerMs : (Date.now() + (pvp.clockOffset || 0));
          const currentSyncedMs = Date.now() + (pvp.clockOffset || 0);
          const tMs = Math.max(0, currentSyncedMs - matchStart);
          pvp.sendHit(targetWord.pvpSeq, tMs);

          cardBlastAudio.playHitSound();

          const centerX = targetWord.x + targetWord.width / 2;
          const centerY = targetWord.y + targetWord.height / 2;

          s.muzzleFlashFrames = 8;
          const canvas = canvasRef.current;
          if (canvas) {
            const displayWidth = canvas.clientWidth;
            const displayHeight = canvas.clientHeight;
            s.laserRays.push({
              startX: displayWidth / 2,
              startY: displayHeight - 44,
              endX: centerX,
              endY: centerY,
              life: 8,
              color: "#38bdf8",
            });
          }

          s.shockwaves.push({
            x: centerX,
            y: centerY,
            radius: 12,
            maxRadius: 70,
            color: "#38bdf8",
            alpha: 0.95,
          });

          const baseColors = targetWord.isGolden
            ? ["#fbbf24", "#f59e0b", "#fde047", "#ffffff"]
            : targetWord.isGarbage
            ? ["#c084fc", "#a855f7", "#e879f9", "#ffffff"]
            : ["#10b981", "#34d399", "#38bdf8", "#facc15"];
          for (let p = 0; p < 28; p++) {
            const angle = Math.random() * Math.PI * 2;
            const spd = 2.5 + Math.random() * 6.5;
            s.particles.push({
              x: centerX,
              y: centerY,
              vx: Math.cos(angle) * spd,
              vy: Math.sin(angle) * spd - 1.2,
              color: baseColors[Math.floor(Math.random() * baseColors.length)],
              size: 2.5 + Math.random() * 3.5,
              alpha: 1,
              maxLife: 32 + Math.floor(Math.random() * 20),
              currentLife: 0,
            });
          }

          // Reaction time calculation (now - word.spawnTime)
          const now = Date.now();
          const wordSpawn = targetWord.spawnTime || (targetWord.pvpSpawnAtMs ? pvp.matchStartServerMs + targetWord.pvpSpawnAtMs : now);
          const reactionMs = Math.max(0, now - wordSpawn);
          s.totalReactionMs += reactionMs;
          s.reactionCount += 1;

          // +10 Mana on correct hit in PvP (or +20 in Last Stand)
          const manaGain = effectiveHp <= 30 ? 20 : 10;
          s.mana = Math.min(100, s.mana + manaGain);
          setMana(Math.floor(s.mana));

          // Increment local hit counter & streak
          s.hits += 1;
          s.streak += 1;
          if (s.streak > s.maxStreak) {
            s.maxStreak = s.streak;
            setMaxStreak(s.maxStreak);
          }
          setStreak(s.streak);
          setHits(s.hits);

          // Add score: matches server CardBlastPvPConstants.BASE_SCORE_PER_HIT (20) * streak * (golden ? 3 : 1)
          const earnedScore = 20 * Math.max(1, s.streak) * (targetWord.isGolden ? 3 : 1);
          s.score += earnedScore;
          setScore(s.score);

          s.floatingTexts.push({
            id: Math.random().toString(),
            text: targetWord.isGolden
              ? `+${earnedScore} ◆ TỪ VÀNG!`
              : targetWord.isGarbage
              ? `+${earnedScore} ⚡ PHÁ TỪ PHẠT!`
              : `+${earnedScore}`,
            x: centerX,
            y: centerY - 20,
            color: targetWord.isGolden ? "#facc15" : targetWord.isGarbage ? "#d8b4fe" : "#38bdf8",
            fontSize: 18,
            opacity: 1,
            vy: -1.4,
            life: 45,
          });

          // Echo Chain skill trigger in PvP
          if (s.echoChainArmed) {
            let nearestAdj: ActiveFallingWord | null = null;
            let minDist = Infinity;
            for (let j = 0; j < s.activeWords.length; j++) {
              if (j === i) continue;
              const other = s.activeWords[j];
              const d = Math.hypot(other.x - centerX, other.y - centerY);
              if (d < minDist) {
                minDist = d;
                nearestAdj = other;
              }
            }

            if (nearestAdj) {
              s.echoChainArmed = false;
              setEchoChainArmed(false);

              cardBlastAudio.playEchoChainSound();

              const adjX = nearestAdj.x + nearestAdj.width / 2;
              const adjY = nearestAdj.y + nearestAdj.height / 2;

              const steps = 6;
              const dx = (adjX - centerX) / steps;
              const dy = (adjY - centerY) / steps;
              const segs: { x: number; y: number }[] = [{ x: centerX, y: centerY }];
              const normX = -dy;
              const normY = dx;
              const len = Math.hypot(normX, normY) || 1;
              for (let st = 1; st < steps; st++) {
                const offset = (Math.random() - 0.5) * 32;
                segs.push({
                  x: centerX + dx * st + (normX / len) * offset,
                  y: centerY + dy * st + (normY / len) * offset,
                });
              }
              segs.push({ x: adjX, y: adjY });

              s.lightningBolts.push({
                life: 14,
                maxLife: 14,
                color: "#c084fc",
                segments: segs,
              });

              s.shockwaves.push({
                x: adjX,
                y: adjY,
                radius: 12,
                maxRadius: 70,
                color: "#c084fc",
                alpha: 0.95,
              });

              for (let p = 0; p < 26; p++) {
                const angle = Math.random() * Math.PI * 2;
                const spd = 3.0 + Math.random() * 5.0;
                s.particles.push({
                  x: adjX,
                  y: adjY,
                  vx: Math.cos(angle) * spd,
                  vy: Math.sin(angle) * spd - 1,
                  color: "#c084fc",
                  size: 3,
                  alpha: 1,
                  maxLife: 32,
                  currentLife: 0,
                });
              }

              if (nearestAdj.pvpSeq !== undefined) {
                pvp.sendHit(nearestAdj.pvpSeq, tMs);
              }

              s.hits += 1;
              s.streak += 1;
              if (s.streak > s.maxStreak) {
                s.maxStreak = s.streak;
                setMaxStreak(s.maxStreak);
              }
              const chainScore = 20 * Math.max(1, s.streak) * (nearestAdj.isGolden ? 3 : 1);
              s.score += chainScore;
              setScore(s.score);
              setStreak(s.streak);
              setHits(s.hits);

              s.floatingTexts.push({
                id: Math.random().toString(),
                text: `⚡ CHAIN KILL! +${chainScore}`,
                x: adjX,
                y: adjY - 20,
                color: "#c084fc",
                fontSize: 20,
                opacity: 1,
                vy: -1.5,
                life: 50,
              });

              const adjIdx = s.activeWords.indexOf(nearestAdj);
              if (adjIdx !== -1) {
                s.activeWords.splice(adjIdx, 1);
              }
            }
          }

          s.activeWords.splice(i, 1);
          setInputValue("");
          break;
        }

        const isRevenge = targetWord.isRevenge;

        if (isRevenge) {
          cardBlastAudio.playRevengeHitSound();
        } else {
          cardBlastAudio.playHitSound();
        }

        const centerX = targetWord.x + targetWord.width / 2;
        const centerY = targetWord.y + targetWord.height / 2;

        s.muzzleFlashFrames = 8;
        const canvas = canvasRef.current;
        if (canvas) {
          const displayWidth = canvas.clientWidth;
          const displayHeight = canvas.clientHeight;
          s.laserRays.push({
            startX: displayWidth / 2,
            startY: displayHeight - 44,
            endX: centerX,
            endY: centerY,
            life: 8,
            color: isRevenge ? "#ef4444" : "#38bdf8",
          });
        }

        s.shockwaves.push({
          x: centerX,
          y: centerY,
          radius: 12,
          maxRadius: 70,
          color: isRevenge ? "#ef4444" : "#38bdf8",
          alpha: 0.95,
        });

        const count = isRevenge ? 40 : 28;
        const baseColors = isRevenge
          ? ["#ef4444", "#f97316", "#fbbf24", "#ffffff"]
          : ["#10b981", "#34d399", "#38bdf8", "#facc15"];

        for (let p = 0; p < count; p++) {
          const angle = Math.random() * Math.PI * 2;
          const spd = 2.5 + Math.random() * 6.5;
          s.particles.push({
            x: centerX,
            y: centerY,
            vx: Math.cos(angle) * spd,
            vy: Math.sin(angle) * spd - 1.2,
            color: baseColors[Math.floor(Math.random() * baseColors.length)],
            size: 2.5 + Math.random() * 3.5,
            alpha: 1,
            maxLife: 32 + Math.floor(Math.random() * 20),
            currentLife: 0,
          });
        }

        s.streak += 1;
        s.hits += 1;
        if (s.streak > s.maxStreak) {
          s.maxStreak = s.streak;
          setMaxStreak(s.maxStreak);
        }
        setStreak(s.streak);

        const earnedScore = 20 * Math.max(1, s.streak);
        s.score += earnedScore;
        setScore(s.score);

        // MANA GENERATION (+6 mana per hit + 2 on combo streak)
        const manaGain = 6 + (s.streak > 1 ? 2 : 0);
        s.mana = Math.min(100, s.mana + manaGain);
        setMana(Math.floor(s.mana));

        if (s.streak % 10 === 0 || s.streak === 5) {
          cardBlastAudio.playComboSound();
          setComboBanner({ text: `CHUỖI ${s.streak} 🔥`, id: Date.now() });
          setTimeout(() => setComboBanner(null), 1800);
        }

        let hpGain = diffParams.hpHit;
        if (isRevenge) {
          hpGain += 12;
        }
        s.hp = Math.min(100, s.hp + hpGain);
        setHp(s.hp);

        // Record last shot status: HIT (auto-dismiss after 2.5s)
        if (lastShotTimeoutRef.current) {
          clearTimeout(lastShotTimeoutRef.current);
        }
        setLastShotStatus({
          type: "hit",
          vietnamese: targetWord.data.vietnamese,
          english: targetWord.data.word,
        });
        lastShotTimeoutRef.current = setTimeout(() => {
          setLastShotStatus(null);
        }, 2500);

        if (isRevenge) {
          s.floatingTexts.push({
            id: Math.random().toString(),
            text: "🧠 ĐÃ NHỚ! +12 HP",
            x: centerX,
            y: centerY - 25,
            color: "#34d399",
            fontSize: 20,
            opacity: 1,
            vy: -1.6,
            life: 55,
          });
        } else {
          s.floatingTexts.push({
            id: Math.random().toString(),
            text: `+${earnedScore} 🔥x${s.streak} • +${manaGain} 💧`,
            x: centerX,
            y: centerY - 20,
            color: s.streak > 3 ? "#fbbf24" : "#10b981",
            fontSize: 18,
            opacity: 1,
            vy: -1.4,
            life: 45,
          });
        }

        // --- SKILL 1: ECHO CHAIN TRIGGER ON HIT ---
        if (s.echoChainArmed) {
          s.echoChainArmed = false;
          setEchoChainArmed(false);

          let nearestAdj: ActiveFallingWord | null = null;
          let minDist = Infinity;
          for (let j = 0; j < s.activeWords.length; j++) {
            if (j === i) continue;
            const other = s.activeWords[j];
            const d = Math.hypot(other.x - centerX, other.y - centerY);
            if (d < minDist) {
              minDist = d;
              nearestAdj = other;
            }
          }

          if (nearestAdj) {
            const adjX = nearestAdj.x + nearestAdj.width / 2;
            const adjY = nearestAdj.y + nearestAdj.height / 2;

            cardBlastAudio.playEchoChainSound();

            // Jagged lightning beam connecting both words
            const steps = 6;
            const dx = (adjX - centerX) / steps;
            const dy = (adjY - centerY) / steps;
            const segs: { x: number; y: number }[] = [{ x: centerX, y: centerY }];
            const normX = -dy;
            const normY = dx;
            const len = Math.hypot(normX, normY) || 1;
            for (let st = 1; st < steps; st++) {
              const offset = (Math.random() - 0.5) * 32;
              segs.push({
                x: centerX + dx * st + (normX / len) * offset,
                y: centerY + dy * st + (normY / len) * offset,
              });
            }
            segs.push({ x: adjX, y: adjY });

            s.lightningBolts.push({
              life: 14,
              maxLife: 14,
              color: "#c084fc",
              segments: segs,
            });

            s.shockwaves.push({
              x: adjX,
              y: adjY,
              radius: 12,
              maxRadius: 70,
              color: "#c084fc",
              alpha: 0.95,
            });

            for (let p = 0; p < 26; p++) {
              const angle = Math.random() * Math.PI * 2;
              const spd = 3.0 + Math.random() * 5.0;
              s.particles.push({
                x: adjX,
                y: adjY,
                vx: Math.cos(angle) * spd,
                vy: Math.sin(angle) * spd - 1,
                color: "#c084fc",
                size: 3,
                alpha: 1,
                maxLife: 32,
                currentLife: 0,
              });
            }

            s.score += 25;
            s.hits += 1;
            setScore(s.score);

            s.floatingTexts.push({
              id: Math.random().toString(),
              text: "⚡ CHAIN KILL! +25",
              x: adjX,
              y: adjY - 20,
              color: "#c084fc",
              fontSize: 20,
              opacity: 1,
              vy: -1.5,
              life: 50,
            });

            const adjIdx = s.activeWords.indexOf(nearestAdj);
            if (adjIdx !== -1) {
              s.activeWords.splice(adjIdx, 1);
            }
          }
        }

        s.activeWords.splice(i, 1);
        setInputValue("");
        break;
      }
    }
  };

  // Authoritative synchronized PvP stats (binding directly to active player's synchronized score)
  const effectiveScore = pvp?.myState ? (pvp.myState.score !== undefined ? pvp.myState.score : score) : score;
  const effectiveStreak = pvp?.myState ? (pvp.myState.streak !== undefined ? pvp.myState.streak : streak) : streak;

  // Reconcile server STATE smoothly without divergence
  useEffect(() => {
    if (pvp?.myState) {
      if (pvp.myState.score !== undefined) {
        engineRef.current.score = pvp.myState.score;
        setScore(pvp.myState.score);
      }
      if (pvp.myState.streak !== undefined) {
        engineRef.current.streak = pvp.myState.streak;
        setStreak(pvp.myState.streak);
      }
      if (pvp.myState.mana !== undefined) {
        engineRef.current.mana = pvp.myState.mana;
        setMana(pvp.myState.mana);
      }
      if (pvp.myState.hits !== undefined) {
        engineRef.current.hits = pvp.myState.hits;
        setHits(pvp.myState.hits);
      }
    }
  }, [pvp?.myState?.score, pvp?.myState?.streak, pvp?.myState?.mana, pvp?.myState?.hits]);

  const echoChainCost = pvp ? 40 : 25;
  const slowMoCost = 50;
  const empBlastCost = pvp ? 80 : 100;

  const hpGradient =
    effectiveHp > 60
      ? "from-emerald-500 via-teal-400 to-green-500"
      : effectiveHp >= 30
      ? "from-amber-500 via-yellow-400 to-orange-500"
      : "from-red-600 via-rose-500 to-red-500 animate-pulse";

  // Calculate live accuracy percentage
  const accuracy =
    engineRef.current.hits + engineRef.current.misses > 0
      ? Math.round((engineRef.current.hits / (engineRef.current.hits + engineRef.current.misses)) * 100)
      : 100;

  // Calculate Rank Badge for Game Over
  const getRankBadge = (acc: number, maxStrk: number) => {
    if (acc >= 85 && maxStrk >= 8) {
      return { title: "Thiện xạ", icon: "🎯", color: "from-amber-400 to-yellow-500 text-amber-950" };
    }
    if (acc >= 60) {
      return { title: "Xạ thủ", icon: "🏹", color: "from-sky-400 to-indigo-500 text-white" };
    }
    return { title: "Tân binh", icon: "🔰", color: "from-slate-400 to-slate-600 text-white" };
  };

  return (
    <div
      className={`relative w-full h-full flex flex-col bg-slate-950 text-white overflow-hidden select-none ${
        screenShake ? "animate-wiggle" : ""
      }`}
    >
      {/* Red Vignette Damage Overlay on Miss */}
      <div
        className={`pointer-events-none absolute inset-0 z-30 transition-opacity duration-300 ${
          redVignette
            ? "opacity-100 ring-8 ring-inset ring-red-600/70 bg-red-950/20"
            : "opacity-0"
        }`}
      />

      {/* Critical Low HP Vignette & Heartbeat Pulse (HP <= 30 strictly during active match for LOCAL player) */}
      {isLocalPlayerInLastStand && !isGameOver && countdown === null && (
        <div className="pointer-events-none absolute inset-0 z-30 ring-8 ring-inset ring-red-600/70 bg-red-950/20 animate-pulse duration-700 shadow-[inset_0_0_50px_rgba(220,38,38,0.5)]" />
      )}

      {/* Sudden Death Purple Ambient Boundary Aura (180s continuous play, strictly no red) */}
      {pvp && pvp.suddenDeath && !isGameOver && countdown === null && (
        <div className="pointer-events-none absolute inset-0 z-20 ring-2 ring-purple-600/30 shadow-[inset_0_0_60px_rgba(168,85,247,0.18)]" />
      )}

      {/* PRE-GAME 3-2-1 READY COUNTDOWN OVERLAY */}
      {countdown !== null && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center text-center pointer-events-none bg-slate-950/50 backdrop-blur-xs select-none">
          <div className="flex flex-col items-center justify-center text-center gap-4 animate-in zoom-in-75 fade-in duration-200">
            <div className="flex items-center justify-center text-center pt-6 pb-2 overflow-visible">
              <span className="inline-block text-6xl sm:text-8xl md:text-9xl font-black text-transparent bg-clip-text bg-gradient-to-b from-yellow-300 via-amber-400 to-orange-500 drop-shadow-[0_0_40px_rgba(245,158,11,0.85)] tracking-normal whitespace-nowrap leading-relaxed pt-6 pb-2 px-6">
                {countdown === "ready" ? "\u0053\u1EB4\u004E \u0053\u00C0\u004E\u0047\u0021" : countdown}
              </span>
            </div>
            <div className="px-6 py-2 rounded-2xl bg-slate-900/90 border border-slate-700/80 text-cyan-400 font-mono text-sm sm:text-base font-bold tracking-widest shadow-xl text-center">
              {direction === "VI_EN" ? "GÕ TỪ TIẾNG ANH" : "GÕ NGHĨA TIẾNG VIỆT"}
            </div>
          </div>
        </div>
      )}

      {/* BIG STREAK & COMBO CALLOUT BANNER */}
      {comboBanner && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center animate-in zoom-in-50 fade-in duration-300">
          <div className="px-8 py-4 rounded-3xl bg-gradient-to-r from-amber-500/90 via-orange-500/95 to-red-500/90 border-2 border-yellow-300 text-white shadow-[0_0_50px_rgba(245,158,11,0.8)] flex items-center gap-3">
            <Zap className="w-8 h-8 fill-yellow-200 text-yellow-200 animate-bounce" />
            <span className="text-3xl sm:text-5xl font-black tracking-wider drop-shadow-md">
              {comboBanner.text}
            </span>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* TASK 2: TOP HUD - CENTERED DUAL HP & MANA BARS (340px - 420px) */}
      {/* ============================================================== */}
      <header className="relative z-20 flex items-center justify-between px-3 sm:px-6 py-2.5 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 gap-3">
        {/* TOP LEFT: Exit, Pause, Deck info & Combo Streak */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <button
            type="button"
            onClick={onExit}
            className="px-2.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-semibold transition cursor-pointer"
          >
            {pvp ? "← Rời trận" : "← Thoát"}
          </button>
          <button
            type="button"
            onClick={() => setShowRulesModal(true)}
            className="w-7 h-7 rounded-full bg-slate-800/90 hover:bg-indigo-600 border border-slate-600 hover:border-indigo-400 text-slate-200 hover:text-white font-black text-xs flex items-center justify-center transition-all shadow-md cursor-pointer active:scale-95"
            title="Luật chơi và Cơ chế 1v1"
            aria-label="Luật chơi và Cơ chế 1v1"
          >
            ?
          </button>
          {!pvp && (
            <button
              type="button"
              onClick={() => setIsPaused((p) => !p)}
              className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
              title="Tạm dừng (Esc)"
            >
              {isPaused ? (
                <Play className="w-4 h-4 fill-emerald-400 text-emerald-400" />
              ) : (
                <Pause className="w-4 h-4 text-slate-300" />
              )}
            </button>
          )}

          <div className="hidden md:block max-w-[150px]">
            <h1 className="text-xs font-bold text-slate-200 tracking-wide truncate">
              {deckTitle}
            </h1>
            <p className="text-[10px] text-cyan-400 font-mono">
              {direction === "VI_EN" ? "VI → EN" : "EN → VI"} {!pvp ? `• Cấp ${currentSpeedLevel}` : `• PvP Cấp ${pvp.speedLevel || 2} (${pvp.hintLevel === "EASY" ? "Dễ" : pvp.hintLevel === "HARD" ? "Siêu khó" : "Bình thường"})`}
            </p>
          </div>

          {/* Streak pill */}
          <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-orange-500/10 border border-orange-500/30 text-orange-400 text-xs font-bold shadow-xs">
            <Flame className={`w-3.5 h-3.5 ${effectiveStreak > 0 ? "fill-orange-500 animate-bounce" : ""}`} />
            <span>{effectiveStreak}</span>
          </div>
        </div>

        {/* TOP CENTER: EXTENDED DUAL HP & MANA BARS (340px - 420px wide) */}
        {/* TOP CENTER: EXTENDED DUAL HP & MANA BARS (340px - 420px wide) */}
        <div className="flex flex-col items-center gap-1.5 w-80 sm:w-[340px] md:w-[400px] shrink-0">
          {/* ❤️ HP Bar */}
          <div className="w-full flex flex-col gap-0.5">
            <div className="flex items-center justify-between text-[11px] font-mono font-bold leading-none px-1">
              <span className="flex items-center gap-1.5 text-slate-200">
                <Heart className={`w-3.5 h-3.5 ${effectiveHp < 30 ? "text-red-500 fill-red-500 animate-ping" : "text-emerald-400 fill-emerald-400"}`} />
                <span>HP</span>
              </span>
              <span className={effectiveHp < 30 ? "text-red-400 font-black animate-pulse" : "text-emerald-400 font-bold"}>
                HP: {effectiveHp}/100
              </span>
            </div>
            <div className="w-full h-3.5 rounded-full bg-slate-900/80 border border-slate-700/50 overflow-hidden p-[2px] shadow-inner">
              <div
                className={`h-full rounded-full bg-gradient-to-r ${hpGradient} transition-all duration-300 shadow-[0_0_10px_rgba(16,185,129,0.5)]`}
                style={{ width: `${Math.max(0, Math.min(100, effectiveHp))}%` }}
              />
            </div>
          </div>

          {/* 💧 MANA Bar */}
          <div className="w-full flex flex-col gap-0.5">
            <div className="flex items-center justify-between text-[11px] font-mono font-bold leading-none px-1">
              <span className="flex items-center gap-1.5 text-cyan-300">
                <span className="text-xs">💧</span>
                <span>MANA</span>
              </span>
              <span className="text-cyan-300 font-bold">
                MANA: {Math.round(currentMana)}/100
              </span>
            </div>
            <div className="w-full h-3.5 rounded-full bg-slate-900/80 border border-slate-700/50 overflow-hidden p-[2px] shadow-inner">
              <div
                className="h-full rounded-full bg-gradient-to-r from-purple-500 via-indigo-400 to-cyan-400 shadow-[0_0_12px_rgba(168,85,247,0.7)] transition-all duration-200"
                style={{ width: `${Math.max(0, Math.min(100, currentMana))}%` }}
              />
            </div>
          </div>
        </div>

        {/* TOP RIGHT: Score, Accuracy, Hint & Audio */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <div className="text-right hidden sm:block">
            <p className="text-[10px] uppercase text-slate-400 font-bold tracking-wider">Điểm</p>
            <p className="text-sm font-black text-amber-400 font-mono tracking-tight leading-none">
              {effectiveScore}
            </p>
          </div>

          {!pvp && (
            <div className="text-right hidden md:block">
              <p className="text-[10px] uppercase text-slate-400 font-bold tracking-wider">Chính xác</p>
              <p className="text-xs font-black text-cyan-400 font-mono tracking-tight leading-none">
                {accuracy}%
              </p>
            </div>
          )}

          {/* Hint Button (Tab) - Single player only */}
          {!pvp && (
            <button
              type="button"
              onClick={triggerHint}
              disabled={hintsRemaining <= 0}
              title="Nhấn Tab hoặc click để đóng băng từ và mở gợi ý"
              className={`flex items-center gap-1 px-2 py-1.5 rounded-xl border text-xs font-bold transition cursor-pointer active:scale-95 ${
                hintsRemaining > 0
                  ? "bg-sky-500/15 border-sky-500/40 text-sky-300 hover:bg-sky-500/25 shadow-[0_0_10px_rgba(14,165,233,0.2)]"
                  : "bg-slate-800/40 border-slate-800 text-slate-500 cursor-not-allowed"
              }`}
            >
              <Lightbulb className={`w-3.5 h-3.5 ${hintsRemaining > 0 ? "fill-sky-400 text-sky-400" : ""}`} />
              <span>x{hintsRemaining}</span>
            </button>
          )}

          {/* Mute button */}
          <button
            type="button"
            onClick={toggleMute}
            className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition cursor-pointer"
            title={isMuted ? "Bật âm thanh" : "Tắt âm thanh"}
          >
            {isMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4 text-emerald-400" />}
          </button>
        </div>
      </header>

      {/* ESCAPED WORDS FLASH BANNER OVERLAY (Relocated below center HP & Mana HUD) */}
      <div className="pointer-events-none absolute top-20 sm:top-[88px] left-0 right-0 z-20 flex flex-col items-center gap-1.5 px-4">
        {escapedBanners.map((banner) => (
          <div
            key={banner.id}
            className="animate-in fade-in slide-in-from-top-3 duration-200 flex items-center gap-2 px-4 py-1.5 rounded-full bg-red-950/90 border border-red-500/60 shadow-[0_0_15px_rgba(239,68,68,0.5)] text-red-200 text-xs sm:text-sm font-semibold"
          >
            <ShieldAlert className="w-4 h-4 text-red-400 shrink-0" />
            <span>
              Bỏ lỡ: <strong className="text-white">{banner.word}</strong> ={" "}
              <span className="text-amber-300 font-bold">{banner.meaning}</span>
            </span>
          </div>
        ))}
      </div>

      {/* IN-GAME PAUSE OVERLAY (ESC) */}
      {isPaused && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
          <div className="w-full max-w-sm mx-4 p-6 rounded-3xl bg-slate-900 border border-slate-700 shadow-2xl flex flex-col items-center gap-5 text-center">
            <div className="w-12 h-12 rounded-2xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/40 flex items-center justify-center">
              <Pause className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-black text-white">Tạm dừng</h2>
              <p className="text-xs text-slate-400 mt-1">
                Chữ đứng yên, không ai mất mạng.
              </p>
            </div>

            {/* Adjust speed on the fly */}
            <div className="w-full flex flex-col gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Điều chỉnh tốc độ rơi (Cấp {currentSpeedLevel})
              </span>
              <div className="grid grid-cols-5 gap-1.5">
                {[1, 2, 3, 4, 5].map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => setCurrentSpeedLevel(lvl)}
                    className={`py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                      currentSpeedLevel === lvl
                        ? "bg-indigo-600 text-white border border-indigo-400"
                        : "bg-slate-800 text-slate-400 hover:text-white"
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            </div>

            <div className="w-full flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setIsPaused(false);
                  inputRef.current?.focus();
                }}
                className="flex-1 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm shadow-md transition cursor-pointer"
              >
                Chơi tiếp
              </button>
              <button
                type="button"
                onClick={onExit}
                className="px-4 py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-sm font-semibold transition cursor-pointer"
              >
                Thoát
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* IN-GAME GAME OVER MODAL CENTERED OVER FROZEN CANVAS (Task 5) */}
      {/* ============================================================== */}
      {isGameOver && gameOverSummary && (
        <div className="absolute inset-0 z-40 flex items-center justify-center p-4 backdrop-blur-md bg-slate-950/75 animate-in fade-in duration-300 overflow-y-auto">
          <div className="relative w-full max-w-xl p-6 sm:p-8 rounded-3xl bg-slate-900/95 border border-slate-700/80 shadow-[0_0_60px_rgba(239,68,68,0.35)] flex flex-col gap-5 text-center animate-in zoom-in-95 duration-200">
            {/* Header Icon & Title */}
            <div className="flex flex-col items-center gap-2">
              <div
                className={`w-14 h-14 rounded-2xl flex items-center justify-center ${
                  gameOverSummary.isCleared
                    ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 shadow-[0_0_20px_rgba(16,185,129,0.4)]"
                    : "bg-red-500/20 text-red-400 border border-red-500/40 shadow-[0_0_20px_rgba(239,68,68,0.4)]"
                }`}
              >
                {gameOverSummary.isCleared ? <Trophy className="w-7 h-7" /> : <ShieldAlert className="w-7 h-7" />}
              </div>
              <h2 className="text-2xl sm:text-3xl font-black text-white">
                {gameOverSummary.isCleared ? "CHIẾN THẮNG! 🏆" : "HẾT MẠNG 💥"}
              </h2>

              {/* Rank badge */}
              {(() => {
                const badge = getRankBadge(gameOverSummary.accuracy, gameOverSummary.maxStreak);
                return (
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-800 border border-slate-700 text-xs font-bold text-slate-200">
                    <Award className="w-4 h-4 text-amber-400" />
                    <span>
                      Danh hiệu: <strong className="text-amber-400">{badge.title} {badge.icon}</strong>
                    </span>
                  </div>
                );
              })()}
              <p className="text-xs text-slate-400 max-w-md">
                {gameOverSummary.isCleared
                  ? "Bạn đã tiêu diệt toàn bộ từ vựng mà không để cạn kiệt năng lượng!"
                  : "Chiến trường tạm dừng. Ôn lại các từ bị lọt để phản xạ nhạy bén hơn lần sau."}
              </p>
            </div>

            {/* Stat Grid */}
            <div className="grid grid-cols-4 gap-2 p-3.5 rounded-2xl bg-slate-950/80 border border-slate-800 text-center">
              <div>
                <p className="text-[10px] uppercase font-bold text-slate-500">Điểm</p>
                <p className="text-lg sm:text-xl font-black text-amber-400 font-mono mt-0.5">
                  {gameOverSummary.score}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-slate-500">Bắn trúng</p>
                <p className="text-lg sm:text-xl font-black text-emerald-400 font-mono mt-0.5">
                  {gameOverSummary.hits}/{gameOverSummary.totalAttempts}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-slate-500">Chuỗi cao</p>
                <p className="text-lg sm:text-xl font-black text-orange-400 font-mono mt-0.5">
                  🔥 {gameOverSummary.maxStreak}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-slate-500">Chính xác</p>
                <p className="text-lg sm:text-xl font-black text-cyan-400 font-mono mt-0.5">
                  {gameOverSummary.accuracy}%
                </p>
              </div>
            </div>

            {/* Missed Words Review List */}
            {gameOverSummary.missedWords.length > 0 && (
              <div className="flex flex-col gap-2 text-left">
                <span className="text-[11px] font-bold uppercase tracking-wider text-rose-400">
                  Từ cần ôn luyện ({gameOverSummary.missedWords.length} từ)
                </span>
                <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1">
                  {gameOverSummary.missedWords.map((w) => (
                    <div
                      key={w.id}
                      className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white">{w.word}</span>
                        {w.ipa && <span className="text-[10px] text-slate-400 font-mono">/{w.ipa}/</span>}
                        <span className="text-slate-400">→</span>
                        <span className="text-amber-300 font-semibold">{w.vietnamese}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => playWordAudio(w.word)}
                        className="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                        title="Nghe phát âm"
                      >
                        <Volume2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleRestartBattle}
                className="flex-1 py-3.5 rounded-2xl bg-gradient-to-r from-blue-600 via-indigo-600 to-violet-600 hover:brightness-110 text-white font-black text-sm shadow-[0_0_25px_rgba(79,70,229,0.5)] flex items-center justify-center gap-2 transition cursor-pointer active:scale-98"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Chơi lại</span>
              </button>
              {onChangeConfig && (
                <button
                  type="button"
                  onClick={onChangeConfig}
                  className="px-4 py-3.5 rounded-2xl bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-500/40 font-bold text-sm tracking-wider flex items-center justify-center gap-2 transition cursor-pointer active:scale-98"
                >
                  <Settings2 className="w-4 h-4 text-indigo-300" />
                  <span>Đổi chiều • mức</span>
                </button>
              )}
              <button
                type="button"
                onClick={onExit}
                className="px-5 py-3.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white font-semibold text-sm transition cursor-pointer"
              >
                Thoát
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* CENTRAL 60 FPS HTML5 CANVAS ARENA (TASK 1: COSMIC NEBULA) */}
      {/* ============================================================== */}
      <div className="relative flex-1 w-full h-full overflow-hidden">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full block cursor-crosshair"
        />
        {/* Opponent Mini HUD for PvP mode */}
        {pvp && (
          <PvPOpponentHud
            opponent={pvp.opponent}
            latestReaction={pvp.latestReaction}
            isLastStand={
              Boolean(
                pvp.opponent &&
                ((pvp.opponent.hp <= 30 && pvp.opponent.hp > 0) ||
                 (pvp.opponent.userId && pvp.lastStandPlayers?.has(String(pvp.opponent.userId))))
              )
            }
          />
        )}
        {/* Last Stand Vignette Border (HP <= 30 strictly during active match for LOCAL player) */}
        {isLocalPlayerInLastStand && !isGameOver && countdown === null && (
          <div className="pointer-events-none absolute inset-0 z-20 border-4 border-red-500/80 shadow-[inset_0_0_80px_rgba(239,68,68,0.55)] animate-pulse" />
        )}
        {/* Phase 2 Combat Banners & Toasts */}
        <div className="pointer-events-none absolute top-16 left-0 right-0 z-25 flex flex-col items-center gap-1.5 px-4">
          {isLocalPlayerInLastStand && !isGameOver && (
            <div className="animate-in fade-in slide-in-from-top-2 duration-200 px-3.5 py-1 rounded-full bg-red-950/90 border border-red-500 text-red-200 text-xs font-black shadow-[0_0_20px_rgba(239,68,68,0.6)] animate-pulse">
              🔥 LAST STAND - PHÒNG THỦ TỐI ĐA!
            </div>
          )}
          {pvp && pvp.suddenDeath && !isGameOver && countdown === null && (
            <div className="animate-in fade-in slide-in-from-top-2 duration-200 px-3.5 py-1 rounded-full border border-purple-500/80 bg-purple-950/85 text-purple-200 text-xs font-black shadow-[0_0_25px_rgba(147,51,234,0.5)] shadow-purple-900/50 animate-pulse">
              ☠️ SUDDEN DEATH - SÁT THƯƠNG NHÂN ĐÔI!
            </div>
          )}
          {goldenActiveBanner && (
            <div className="animate-in fade-in zoom-in-95 duration-300 flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-amber-950/95 border-2 border-amber-400 text-amber-200 text-xs sm:text-sm font-black shadow-[0_0_35px_rgba(245,158,11,0.8)] animate-pulse">
              <span className="text-xl">◆</span>
              <span className="tracking-wide">TỪ VÀNG XUẤT HIỆN - TRANH ĐOẠT!</span>
              <span className="text-xl">◆</span>
            </div>
          )}
          {pvp && pvp.incomingAttack && (() => {
            const myId = pvp.myState?.userId;
            const targetId = pvp.incomingAttack.targetUserId || pvp.incomingAttack.targetPlayerId;
            const isVictim = !targetId || !myId || String(targetId) === String(myId);
            if (!isVictim) return null;
            return (
              <div className="animate-in fade-in zoom-in-95 duration-200 flex items-center gap-2 px-4 py-2 rounded-2xl bg-purple-950/95 border-2 border-purple-400 text-purple-200 text-xs sm:text-sm font-bold shadow-[0_0_30px_rgba(168,85,247,0.7)] animate-pulse">
                <span className="text-base">⚠️</span>
                <span>
                  <strong className="text-white">{pvp.incomingAttack.fromName || "Đối thủ"}</strong> gửi từ phạt!
                </span>
              </div>
            );
          })()}
          {pvp && pvp.parryEvent && (
            <div className="animate-in fade-in zoom-in-95 duration-200 flex items-center gap-2 px-4 py-2 rounded-2xl bg-cyan-950/95 border-2 border-cyan-400 text-cyan-200 text-xs sm:text-sm font-bold shadow-[0_0_30px_rgba(6,182,212,0.7)]">
              <span className="text-base">🛡️</span>
              <span>ĐỠ ĐÒN THÀNH CÔNG! Hóa giải từ phạt từ {pvp.parryEvent.parriedByName || "đối thủ"}!</span>
            </div>
          )}
          {pvp && pvp.shieldAbsorbed && (
            <div className="animate-in fade-in zoom-in-95 duration-200 flex items-center gap-2 px-4 py-2 rounded-2xl bg-emerald-950/95 border-2 border-emerald-400 text-emerald-200 text-xs sm:text-sm font-bold shadow-[0_0_30px_rgba(16,185,129,0.7)]">
              <span className="text-base">🛡️</span>
              <span>KHIÊN PHẢN KÍCH: Đã chặn thành công 1 đòn tấn công của đối thủ!</span>
            </div>
          )}
          {pvp && pvp.echoChainEvent && (
            <div className="animate-in fade-in zoom-in-95 duration-200 flex items-center gap-2 px-4 py-2 rounded-2xl bg-purple-950/95 border-2 border-purple-400 text-purple-200 text-xs sm:text-sm font-bold shadow-[0_0_30px_rgba(168,85,247,0.7)]">
              <span className="text-base">⚡</span>
              <span>ECHO CHAIN: Đã kích nổ từ liên hoàn (+{pvp.echoChainEvent.earnedScore} điểm)!</span>
            </div>
          )}
          {pvp && pvp.fogActiveUntilMs && Date.now() < pvp.fogActiveUntilMs && (
            <div className="animate-in fade-in zoom-in-95 duration-200 flex items-center gap-2 px-4 py-2 rounded-2xl bg-purple-950/95 border-2 border-purple-400 text-purple-200 text-xs sm:text-sm font-bold shadow-[0_0_25px_rgba(168,85,247,0.7)] animate-pulse">
              <span className="text-base">🌫️</span>
              <span>BỊ MÙ SƯƠNG! 60% ký tự trên các thẻ rơi bị che khuất!</span>
            </div>
          )}
          {pvp && pvp.fogOpponentUntilMs && Date.now() < pvp.fogOpponentUntilMs && (
            <div className="animate-in fade-in zoom-in-95 duration-200 flex items-center gap-2 px-4 py-2 rounded-2xl bg-cyan-950/95 border-2 border-cyan-400 text-cyan-200 text-xs sm:text-sm font-bold shadow-[0_0_25px_rgba(6,182,212,0.7)] animate-pulse">
              <span className="text-base">🌫️</span>
              <span>ĐÃ THI TRIỂN MÙ SƯƠNG! Đối thủ bị che 60% ký tự!</span>
            </div>
          )}
          {goldenLostToast && (
            <div className="animate-in fade-in zoom-in-95 duration-200 flex items-center gap-2 px-4 py-2 rounded-2xl bg-amber-950/95 border-2 border-amber-400 text-amber-200 text-xs sm:text-sm font-bold shadow-[0_0_30px_rgba(245,158,11,0.6)]">
              <span className="text-base">◆</span>
              <span>{goldenLostToast}</span>
            </div>
          )}
        </div>
      </div>

      {/* ============================================================== */}
      {/* TASK 3: BOTTOM DOCK - 3 SKILLS AT TYPING CONSOLE COCKPIT */}
      {/* ============================================================== */}
      <footer className="relative z-20 w-full px-4 py-3 bg-slate-900/90 backdrop-blur-md border-t border-slate-800 flex flex-col items-center gap-2.5">
        {/* 3 TACTICAL SKILLS DOCKED DIRECTLY ABOVE TYPING INPUT */}
        <div className="flex items-center gap-2 sm:gap-3 justify-center w-full max-w-xl">
          {equippedSkills.slice(0, 3).map((skillId, idx) => {
            const meta = (
              {
                ECHO_CHAIN: { name: "Echo Chain", cost: pvp ? 40 : 25, icon: "⚡", desc: "Kích nổ từ gần nhất" },
                SLOW_MO: { name: "Slow-Mo", cost: 50, icon: "⏳", desc: "+5s cho từ đang rơi" },
                EMP_BLAST: { name: "EMP Blast", cost: pvp ? 80 : 100, icon: "💥", desc: "Quét sạch từ trên màn hình" },
                FOG: { name: "Mù Sương", cost: 50, icon: "🌫️", desc: "Che khuất 60% chữ của đối thủ 5s" },
                SHIELD: { name: "Khiên Chắn", cost: 35, icon: "🛡️", desc: "Chặn 1 đòn trong 8s" },
              } as Record<string, { name: string; cost: number; icon: string; desc: string }>
            )[skillId] || { name: skillId, cost: 50, icon: "⚔️", desc: "" };

            const cost = meta.cost;
            const isAvailable = currentMana >= cost;
            const isArmed =
              (skillId === "ECHO_CHAIN" && echoChainArmed) ||
              (skillId === "SLOW_MO" && slowMoActive) ||
              (skillId === "SHIELD" && Boolean(pvp?.shieldActiveUntilMs && Date.now() < pvp.shieldActiveUntilMs));

            return (
              <button
                key={skillId + idx}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => triggerSkillSlot(idx)}
                disabled={!isAvailable}
                title={`Nhấn phím ${idx + 1}: ${meta.name} - ${meta.desc} (${cost} Mana)`}
                className={`flex-1 flex items-center justify-center gap-1.5 sm:gap-2 rounded-xl px-2.5 sm:px-4 py-2 border backdrop-blur-md text-xs font-bold transition cursor-pointer active:scale-95 ${
                  isArmed
                    ? "bg-purple-600/40 border-purple-400 text-purple-100 shadow-[0_0_20px_rgba(168,85,247,0.8)] ring-2 ring-purple-400 animate-pulse"
                    : isAvailable
                    ? "bg-gradient-to-r from-slate-900/90 via-indigo-950/80 to-slate-900/90 hover:from-indigo-900/90 hover:to-purple-900/90 text-white border-cyan-500/60 hover:border-cyan-400 shadow-[0_0_15px_rgba(6,182,212,0.35)] ring-1 ring-cyan-500/30 hover:shadow-[0_0_20px_rgba(6,182,212,0.6)]"
                    : "bg-slate-900/60 border-slate-800 text-slate-500 opacity-60 cursor-not-allowed"
                }`}
              >
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-black border ${
                    isAvailable
                      ? "bg-indigo-900/90 border-cyan-400/80 text-amber-300 shadow-[0_0_8px_rgba(245,158,11,0.5)]"
                      : "bg-slate-950 border-slate-800 text-slate-600"
                  }`}
                >
                  {idx + 1}
                </span>
                <span className="flex items-center gap-1">
                  <span>{meta.icon}</span>
                  <span className="truncate">{meta.name}</span>
                </span>
                <span className="px-1.5 py-0.2 rounded-full bg-slate-950/80 border border-slate-700/60 text-[10px] font-mono text-cyan-300 font-extrabold shadow-inner">
                  {cost}
                </span>
                {!isAvailable && !pvp && <Lock className="w-3 h-3 text-slate-500 shrink-0" />}
              </button>
            );
          })}
        </div>

        {/* Local player reaction popup */}
        {selfReaction && (
          <div
            data-testid="player-reaction-bubble"
            className="flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900/95 border border-amber-400/50 shadow-[0_0_15px_rgba(245,158,11,0.4)] animate-bounce"
          >
            <span className="text-xl">{selfReaction.emoji}</span>
            <span className="text-xs font-bold text-amber-300">{selfReaction.text}</span>
          </div>
        )}

        {/* Dedicated Typing Input Box (Centered & Matching 3 Skill Buttons Span) & Repositioned Reaction Bar */}
        <div className="w-full relative flex items-center justify-center">
          <div className="w-full max-w-xl relative flex items-center">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={handleInputChange}
              disabled={isGameOver || pvp?.phase === "RESULT"}
              placeholder={
                direction === "VI_EN"
                  ? "Gõ từ tiếng Anh..."
                  : "Gõ đáp án tiếng Việt..."
              }
              autoFocus
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              className="w-full px-5 py-3 rounded-2xl bg-slate-950/95 border-2 border-indigo-500/60 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/20 text-white font-medium text-base sm:text-lg placeholder:text-slate-500 outline-none transition shadow-[0_0_20px_rgba(99,102,241,0.25)] text-center tracking-wide disabled:opacity-50 disabled:cursor-not-allowed"
            />
            {inputValue && (
              <button
                type="button"
                onClick={() => setInputValue("")}
                className="absolute right-3 px-2 py-1 text-xs text-slate-400 hover:text-white rounded bg-slate-800 transition cursor-pointer"
              >
                ✕
              </button>
            )}
          </div>

          {/* Whale Reaction Bar (Docked to the right side of the screen/controls area) */}
          {pvp && pvp.sendReaction && (
            <div className="hidden lg:flex lg:absolute lg:right-2 xl:right-4 2xl:right-8 items-center gap-1.5 shrink-0 bg-slate-950/90 border border-slate-800/90 rounded-2xl p-1.5 shadow-lg">
              {[
                { id: "GG", emoji: "💛", label: "GG" },
                { id: "NICE", emoji: "👍", label: "NICE" },
                { id: "OOPS", emoji: "😜", label: "OOPS" },
                { id: "FIRE", emoji: "🔥", label: "FIRE" },
              ].map((rx) => (
                <button
                  key={rx.id}
                  type="button"
                  disabled={reactionCooldown}
                  onClick={() => handleSendReaction(rx.id)}
                  title={`Gửi biểu cảm ${rx.label}`}
                  className={`p-2 rounded-xl text-xs flex items-center gap-1.5 transition cursor-pointer active:scale-95 ${
                    reactionCooldown
                      ? "opacity-40 cursor-not-allowed text-slate-500"
                      : "hover:bg-slate-800/90 text-slate-300 hover:text-white hover:shadow-sm"
                  }`}
                >
                  <span className="text-base leading-none">{rx.emoji}</span>
                  <span className="hidden xl:inline text-[11px] font-bold uppercase">{rx.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Compact Reaction Bar on Mobile / Narrow Viewports (< lg) */}
        {pvp && pvp.sendReaction && (
          <div className="flex lg:hidden items-center justify-center gap-1.5 shrink-0 bg-slate-950/90 border border-slate-800/90 rounded-2xl p-1 shadow-sm">
            {[
              { id: "GG", emoji: "💛", label: "GG" },
              { id: "NICE", emoji: "👍", label: "NICE" },
              { id: "OOPS", emoji: "😜", label: "OOPS" },
              { id: "FIRE", emoji: "🔥", label: "FIRE" },
            ].map((rx) => (
              <button
                key={rx.id}
                type="button"
                disabled={reactionCooldown}
                onClick={() => handleSendReaction(rx.id)}
                title={`Gửi biểu cảm ${rx.label}`}
                className={`p-1.5 sm:p-2 rounded-xl text-xs flex items-center gap-1 transition cursor-pointer active:scale-95 ${
                  reactionCooldown
                    ? "opacity-40 cursor-not-allowed text-slate-500"
                    : "hover:bg-slate-800/90 text-slate-300 hover:text-white hover:shadow-sm"
                }`}
              >
                <span className="text-sm sm:text-base leading-none">{rx.emoji}</span>
                <span className="text-[10px] sm:text-[11px] font-bold uppercase">{rx.label}</span>
              </button>
            ))}
          </div>
        )}

        <p className="text-[11px] text-slate-400 text-center">
          ⚡ Tự nổ khi gõ đúng • Kỹ năng: <kbd className="px-1 py-0.5 rounded bg-slate-800 text-purple-300 border border-slate-700 font-mono text-[10px]">1</kbd> Echo ({echoChainCost}) • <kbd className="px-1 py-0.5 rounded bg-slate-800 text-cyan-300 border border-slate-700 font-mono text-[10px]">2</kbd> Slow-mo ({slowMoCost}) • <kbd className="px-1 py-0.5 rounded bg-slate-800 text-yellow-300 border border-slate-700 font-mono text-[10px]">3</kbd> EMP ({empBlastCost}) {!pvp ? <>• <kbd className="px-1 py-0.5 rounded bg-slate-800 text-sky-300 border border-slate-700 font-mono text-[10px]">Tab</kbd> Gợi ý</> : "• 1v1 PvP Realtime"}
        </p>
      </footer>

      {/* Rules & Mechanics Modal */}
      <PvPRulesModal isOpen={showRulesModal} onClose={() => setShowRulesModal(false)} />
    </div>
  );
}
