"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Client, IMessage, TickerStrategy } from "@stomp/stompjs";
import { getSession } from "next-auth/react";
import { ensureApiSession } from "@/lib/api-session";

export interface ScheduledWord {
  seq: number;
  wordId: number;
  word: string;
  ipa?: string;
  vietnamese: string;
  targetAnswers: string[];
  lane: number;
  spawnAtMs: number;
  fallDurationMs: number;
  isGarbage?: boolean;
  garbage?: boolean;
  isGolden?: boolean;
  golden?: boolean;
  targetPlayerId?: string;
}

export interface PlayerState {
  userId: string;
  displayName: string;
  avatar: string;
  ready: boolean;
  connected: boolean;
  disconnectDeadlineMs?: number | null;
  hp: number;
  score: number;
  streak: number;
  bestStreak: number;
  hits: number;
  misses: number;
  rematchRequested?: boolean;
  lastStand?: boolean;
  mana?: number;
  skills?: string[];
  skillsUsed?: number;
  attacksSent?: number;
  attacksReceived?: number;
  goldenCaptured?: number;
  shieldActiveUntilMs?: number | null;
  fogActiveUntilMs?: number | null;
  deadlineBonusMs?: number;
  echoChainArmed?: boolean;
}

export interface CardBlastRoom {
  roomCode: string;
  deckId?: number | null;
  deckTitle: string;
  direction: "VI_EN" | "EN_VI";
  mode: "HUMAN" | "BOT";
  botLevel: "EASY" | "NORMAL" | "HARD";
  status: "WAITING" | "COUNTDOWN" | "IN_GAME" | "FINISHED";
  host: PlayerState;
  guest?: PlayerState | null;
  matchStartServerMs?: number | null;
  winnerId?: string | null;
  endReason?: string | null;
  speedLevel?: number;
  hintLevel?: "EASY" | "NORMAL" | "HARD";
  suddenDeath?: boolean;
}

export interface IncomingAttackPayload {
  attackId: string;
  fromUserId: string;
  fromName: string;
  targetPlayerId?: string;
  targetUserId?: string;
  telegraphMs: number;
}

export interface AttackParriedPayload {
  attackId: string;
  parriedBy: string;
  parriedByName: string;
  targetPlayerId: string;
}

export interface SpawnGarbagePayload {
  attackId: string;
  targetPlayerId?: string;
  targetUserId?: string;
  scheduledWord: ScheduledWord;
}

export interface GoldenWordPayload {
  scheduledWord: ScheduledWord;
}

export interface GoldenTakenPayload {
  seq: number;
  winnerId: string;
  winnerName: string;
  word: string;
}

export interface LastStandPayload {
  playerId: string;
}

export interface SuddenDeathPayload {
  roomCode: string;
  matchNowMs: number;
}

export interface ReactionPayload {
  playerId: string;
  reactionId: string;
}

export interface ShieldAbsorbedPayload {
  attackId?: string;
  targetPlayerId: string;
  attackerId?: string;
  fromUserId?: string;
}

export interface EchoChainPayload {
  userId: string;
  detonatedSeq: number;
  word: string;
  earnedScore: number;
}

export interface MissedWordDetail {
  wordId: number;
  word: string;
  vietnamese: string;
  ipa?: string;
  meanings?: string[];
}

export interface PlayerMatchStats {
  userId: string;
  displayName: string;
  score: number;
  accuracy: number;
  maxStreak: number;
  hits: number;
  misses: number;
  remainingHp: number;
  avgReactionMs?: number;
  goldenCaptured?: number;
  attacksSent?: number;
  attacksDeflected?: number;
  attacksReceived?: number;
  skillsUsed?: number;
  ratingDelta?: number;
  ratingChange?: number;
  missedWords?: MissedWordDetail[];
}

export interface MatchResultData {
  roomCode?: string;
  winnerId: string;
  loserId?: string | null;
  reason: string;
  hostStats: PlayerMatchStats;
  guestStats?: PlayerMatchStats | null;
  isRanked?: boolean;
  matchId?: number;
  durationMs?: number;
}

export type PvPPhase = "IDLE" | "LOBBY" | "COUNTDOWN" | "PLAYING" | "RESULT";

export function getWsUrl(): string {
  if (typeof window === "undefined") return "wss://englishcoach.io.vn/ws-card-blast";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  if (host.includes(":3000")) {
    return `${protocol}//${window.location.hostname}:8080/ws-card-blast`;
  }
  return `${protocol}//${host}/ws-card-blast`;
}

export interface UseCardBlastPvPOptions {
  onRoomDissolved?: (message: string) => void;
}

export function useCardBlastPvP(options?: UseCardBlastPvPOptions) {
  const [phase, setPhase] = useState<PvPPhase>("IDLE");
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState<CardBlastRoom | null>(null);
  const [schedule, setSchedule] = useState<ScheduledWord[]>([]);
  const [matchStartServerMs, setMatchStartServerMs] = useState<number | null>(null);
  const [clockOffset, setClockOffset] = useState<number>(0);
  const [currentUserId, setCurrentUserId] = useState<string>("");
  const [result, setResult] = useState<MatchResultData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dissolutionNotice, setDissolutionNotice] = useState<string | null>(null);

  // Phase 2 Combat States
  const [incomingAttack, setIncomingAttack] = useState<IncomingAttackPayload | null>(null);
  const [parryEvent, setParryEvent] = useState<AttackParriedPayload | null>(null);
  const [goldenWord, setGoldenWord] = useState<ScheduledWord | null>(null);
  const [goldenTaken, setGoldenTaken] = useState<GoldenTakenPayload | null>(null);
  const [lastStandPlayers, setLastStandPlayers] = useState<Set<string>>(new Set());
  const [suddenDeath, setSuddenDeath] = useState<boolean>(false);
  const [latestReaction, setLatestReaction] = useState<ReactionPayload | null>(null);

  // Phase 3 Skill States
  const [shieldAbsorbed, setShieldAbsorbed] = useState<ShieldAbsorbedPayload | null>(null);
  const [echoChainEvent, setEchoChainEvent] = useState<EchoChainPayload | null>(null);
  const [fogActiveUntilMs, setFogActiveUntilMs] = useState<number | null>(null);
  const [fogOpponentUntilMs, setFogOpponentUntilMs] = useState<number | null>(null);
  const [shieldActiveUntilMs, setShieldActiveUntilMs] = useState<number | null>(null);

  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [isJoiningRoom, setIsJoiningRoom] = useState(false);
  const isCreatingRoomRef = useRef(false);
  const isJoiningRoomRef = useRef(false);
  const createRoomTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const joinRoomTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleUserMessageRef = useRef<(msg: any) => void>(() => {});
  const handleRoomMessageRef = useRef<(msg: any) => void>(() => {});

  const clientRef = useRef<Client | null>(null);
  const connectPromiseRef = useRef<Promise<Client | null> | null>(null);
  const transportReadyRef = useRef(false);
  const transportReadyCallbackRef = useRef<(() => void) | null>(null);
  const clockSyncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const createSentRef = useRef(false);
  const createCancelledRef = useRef(false);
  const createTraceRef = useRef(0);
  const timingEventsRef = useRef<{ trace: number; step: string; atMs: number; epochMs: number; detail?: unknown }[]>([]);
  const markCreate = (step: string, detail?: unknown) => {
    if (typeof performance !== "undefined") {
      performance.mark(`card-blast:${createTraceRef.current}:${step}`, { detail });
      // Opt-in, bounded DOM diagnostics allow browser timing inspection without
      // exposing credentials or relying on access to browser internals.
      if (typeof document !== "undefined" && new URLSearchParams(window.location.search).has("gameTiming")) {
        timingEventsRef.current = [...timingEventsRef.current.slice(-31), {
          trace: createTraceRef.current, step, atMs: performance.now(), epochMs: Date.now(), detail,
        }];
        document.documentElement.setAttribute("data-card-blast-timing", JSON.stringify(timingEventsRef.current));
      }
    }
  };
  const createdRoomCodeRef = useRef<string | null>(null);
  const roomCodeRef = useRef<string | null>(null);
  const currentUserIdRef = useRef<string>(currentUserId);
  const myStateRef = useRef<PlayerState | null>(null);
  const pingSamplesRef = useRef<number[]>([]);
  const roomSubRef = useRef<any>(null);
  const onRoomDissolvedRef = useRef(options?.onRoomDissolved);
  const resultRef = useRef<MatchResultData | null>(null);
  const hasVoluntarilyLeftRef = useRef<boolean>(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      transportReadyRef.current = false;
      transportReadyCallbackRef.current = null;
      if (clockSyncTimerRef.current) clearInterval(clockSyncTimerRef.current);
      if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
      isCreatingRoomRef.current = false;
      isJoiningRoomRef.current = false;
      if (createRoomTimeoutRef.current) clearTimeout(createRoomTimeoutRef.current);
      if (joinRoomTimeoutRef.current) clearTimeout(joinRoomTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    onRoomDissolvedRef.current = options?.onRoomDissolved;
  }, [options?.onRoomDissolved]);

  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);

  useEffect(() => {
    roomCodeRef.current = room?.roomCode || null;
  }, [room?.roomCode]);

  // Connect STOMP client
  const connect = useCallback(async (): Promise<Client | null> => {
    if (clientRef.current?.connected && transportReadyRef.current) {
      return clientRef.current;
    }
    if (connectPromiseRef.current) {
      return connectPromiseRef.current;
    }

    const promise = (async () => {
      try {
        let userId = "";

        try {
          const session = await getSession();
          if (session?.user) {
            userId = String((session.user as any)?.id || session.user.email || "");
            setCurrentUserId(userId);
          }
        } catch {
          // Fallback
        }

        // The handshake carries the HttpOnly session cookie: it must be fresh, and no token goes into the frame.
        if (!(await ensureApiSession())) {
          setError("Vui lòng đăng nhập để tham gia đấu PvP");
          return null;
        }

        if (!mountedRef.current) return null;
        const wsUrl = getWsUrl();

        return await new Promise<Client | null>((resolve) => {
          const client = new Client({
            brokerURL: wsUrl,
            beforeConnect: async () => { await ensureApiSession(); },
            heartbeatIncoming: 10000,
            heartbeatOutgoing: 10000,
            heartbeatStrategy: TickerStrategy.Worker,
            connectionTimeout: 8000,
            reconnectDelay: 4000,
            debug: (msg: string) => {
              if (process.env.NODE_ENV === "development") {
                console.debug("[STOMP]", msg);
              }
            },
            onConnect: () => {
              if (!mountedRef.current) { void client.deactivate(); resolve(null); return; }
              transportReadyRef.current = false;
              markCreate("connection-ready");
              setError(null);

              // 1. Subscribe to private user queue
              client.subscribe("/user/queue/pvp", (msg: IMessage) => {
                try {
                  const data = JSON.parse(msg.body);
                  if (data.type === "ROOM_CREATED") markCreate("frame-received", data.payload?.createTiming);
                  handleUserMessageRef.current(data);
                } catch (e) {
                  console.error("[STOMP] Failed to parse user message:", e);
                }
              });

              // The simple broker has no SUBSCRIBE receipts. A PONG delivered to
              // this private subscription proves end-to-end readiness. Repeated
              // probes tolerate concurrent inbound SUBSCRIBE/SEND processing.
              transportReadyCallbackRef.current = () => {
                if (!mountedRef.current) return;
                transportReadyRef.current = true;
                setConnected(true);
                markCreate("subscription-ready");
                if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
                resolve(client);
                const activeRoomCode = roomCodeRef.current || createdRoomCodeRef.current;
                if (activeRoomCode) {
                  subscribeToRoom(activeRoomCode);
                  client.publish({ destination: "/app/pvp/rejoin", body: JSON.stringify({ roomCode: activeRoomCode }) });
                } else if (createSentRef.current && !createCancelledRef.current) {
                  // Recover a sent intent whose ACK was lost during disconnect.
                  // The server finds this principal's room; never resend CREATE.
                  client.publish({ destination: "/app/pvp/rejoin", body: "{}" });
                }
              };
              // 2. Probe immediately and synchronize the game clock in background.
              pingSamplesRef.current = [];
              performClockSync(client);
            },
            onDisconnect: () => {
              transportReadyRef.current = false;
              setConnected(false);
            },
            onStompError: (frame: any) => {
              console.warn("[STOMP ERROR]", frame.headers["message"], frame.body);
              setError(frame.headers["message"] || "Lỗi kết nối máy chủ PvP");
              resolve(null);
            },
            onWebSocketClose: () => {
              transportReadyRef.current = false;
              transportReadyCallbackRef.current = null;
              setConnected(false);
            },
          });

          if (clientRef.current) void clientRef.current.deactivate();
          clientRef.current = client;
          client.activate();

          connectionTimerRef.current = setTimeout(() => {
            if (!transportReadyRef.current) {
              void client.deactivate();
              resolve(null);
            }
          }, 8000);
        });
      } finally {
        connectPromiseRef.current = null;
      }
    })();

    connectPromiseRef.current = promise;
    return promise;
  }, []);

  // Clock synchronization routine
  const performClockSync = (client: Client) => {
    let sent = 0;
    if (clockSyncTimerRef.current) clearInterval(clockSyncTimerRef.current);
    const probe = () => {
      if (!mountedRef.current || !client.connected || (sent >= 5 && transportReadyRef.current)) {
        if (clockSyncTimerRef.current) clearInterval(clockSyncTimerRef.current);
        return;
      }
      sent++;
      client.publish({
        destination: "/app/pvp/ping",
        body: JSON.stringify({ clientTimeMs: Date.now() }),
      });
    };
    clockSyncTimerRef.current = setInterval(probe, 200);
    probe();
  };

  // Subscribe to room topic
  const subscribeToRoom = useCallback((code: string) => {
    if (!clientRef.current?.connected) return;
    if (roomSubRef.current) {
      roomSubRef.current.unsubscribe();
      roomSubRef.current = null;
    }

    const sub = clientRef.current.subscribe(`/topic/pvp/${code}`, (msg: IMessage) => {
      try {
        const data = JSON.parse(msg.body);
        handleRoomMessageRef.current(data);
      } catch (e) {
        console.error("[STOMP] Failed to parse room message:", e);
      }
    });
    roomSubRef.current = sub;
  }, []);

  // Handle messages on /user/queue/pvp
  const handleUserMessage = useCallback(
    (msg: any) => {
      const type = msg.type;
      const payload = msg.payload;

      if (type === "MATCH_END") {
        handleRoomMessageRef.current(msg);
      } else if (type === "PONG") {
        const ready = transportReadyCallbackRef.current;
        transportReadyCallbackRef.current = null;
        ready?.();
        const clientSent = payload.clientTimeMs;
        const serverTime = payload.serverTimeMs;
        const now = Date.now();
        const rtt = now - clientSent;
        const offset = serverTime - (clientSent + rtt / 2);

        pingSamplesRef.current.push(offset);
        if (pingSamplesRef.current.length >= 3) {
          const sorted = [...pingSamplesRef.current].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];
          setClockOffset(median);
        }
      } else if (type === "ROOM_CREATED" || type === "ROOM_JOINED") {
        if (!payload?.roomCode || !mountedRef.current) return;
        if (type === "ROOM_CREATED" && createCancelledRef.current) {
          clientRef.current?.publish({ destination: "/app/pvp/leave", body: JSON.stringify({ roomCode: payload.roomCode }) });
          createSentRef.current = false;
          return;
        }
        markCreate("handler");
        createSentRef.current = false;
        setError(null);
        if (createRoomTimeoutRef.current) {
          clearTimeout(createRoomTimeoutRef.current);
          createRoomTimeoutRef.current = null;
        }
        if (joinRoomTimeoutRef.current) {
          clearTimeout(joinRoomTimeoutRef.current);
          joinRoomTimeoutRef.current = null;
        }
        isCreatingRoomRef.current = false;
        setIsCreatingRoom(false);
        isJoiningRoomRef.current = false;
        setIsJoiningRoom(false);

        const code = payload.roomCode;
        hasVoluntarilyLeftRef.current = false;
        roomCodeRef.current = code;
        if (type === "ROOM_CREATED") {
          createdRoomCodeRef.current = code;
          if (payload.host?.userId) {
            const uid = String(payload.host.userId);
            currentUserIdRef.current = uid;
            setCurrentUserId(uid);
          }
        } else if (type === "ROOM_JOINED") {
          if (payload.guest?.userId) {
            const uid = String(payload.guest.userId);
            currentUserIdRef.current = uid;
            setCurrentUserId(uid);
          }
        }
        subscribeToRoom(code);
        setRoom(payload);
        setSuddenDeath(false);
        setLastStandPlayers(new Set());
        setResult(null);
        if (payload.status === "COUNTDOWN" || payload.status === "IN_GAME") {
          setSchedule(payload.schedule || []);
          setMatchStartServerMs(payload.matchStartServerMs);
          setPhase(payload.status === "IN_GAME" ? "PLAYING" : "COUNTDOWN");
        } else {
          setPhase("LOBBY");
        }
      } else if (type === "ROOM_DISSOLVED") {
        const notice = payload?.message || "Chủ phòng đã rời phòng. Phòng đấu đã được giải tán.";
        if (roomSubRef.current) {
          try {
            roomSubRef.current.unsubscribe();
          } catch (e) {}
          roomSubRef.current = null;
        }
        roomCodeRef.current = null;
        createdRoomCodeRef.current = null;
        setRoom(null);
        setPhase("IDLE");
        setDissolutionNotice(notice);
        onRoomDissolvedRef.current?.(notice);
      } else if (type === "ROOM_LEFT") {
        if (roomSubRef.current) {
          try {
            roomSubRef.current.unsubscribe();
          } catch (e) {}
          roomSubRef.current = null;
        }
        roomCodeRef.current = null;
        createdRoomCodeRef.current = null;
        setRoom(null);
        setPhase("IDLE");
      } else if (type === "ROOM_REJOINED") {
        if (createCancelledRef.current && hasVoluntarilyLeftRef.current) {
          clientRef.current?.publish({ destination: "/app/pvp/leave", body: JSON.stringify({ roomCode: payload.roomCode }) });
          return;
        }
        setError(null);
        if (createRoomTimeoutRef.current) clearTimeout(createRoomTimeoutRef.current);
        createRoomTimeoutRef.current = null;
        isCreatingRoomRef.current = false;
        createSentRef.current = false;
        setIsCreatingRoom(false);
        const code = payload.roomCode;
        roomCodeRef.current = code;
        subscribeToRoom(code);
        setRoom(payload);
        setSchedule(payload.schedule || []);
        setMatchStartServerMs(payload.matchStartServerMs);
        if (payload.status === "IN_GAME") {
          setPhase("PLAYING");
        } else if (payload.status === "COUNTDOWN") {
          setPhase("COUNTDOWN");
        } else if (payload.status === "FINISHED") {
          setPhase("RESULT");
        } else {
          setPhase("LOBBY");
        }
      } else if (type === "ERROR") {
        createSentRef.current = false;
        if (createRoomTimeoutRef.current) {
          clearTimeout(createRoomTimeoutRef.current);
          createRoomTimeoutRef.current = null;
        }
        if (joinRoomTimeoutRef.current) {
          clearTimeout(joinRoomTimeoutRef.current);
          joinRoomTimeoutRef.current = null;
        }
        isCreatingRoomRef.current = false;
        setIsCreatingRoom(false);
        isJoiningRoomRef.current = false;
        setIsJoiningRoom(false);

        const msg = payload?.message || "Đã xảy ra lỗi";
        setError(msg);
        if (
          msg.toLowerCase().includes("room not found") ||
          msg.toLowerCase().includes("phòng không tồn tại") ||
          msg.toLowerCase().includes("access denied") ||
          msg.toLowerCase().includes("giải tán")
        ) {
          if (roomSubRef.current) {
            try {
              roomSubRef.current.unsubscribe();
            } catch (e) {}
            roomSubRef.current = null;
          }
          roomCodeRef.current = null;
          createdRoomCodeRef.current = null;
          setRoom(null);
          setPhase("IDLE");
          const notice = "Chủ phòng đã rời phòng. Phòng đấu đã được giải tán.";
          setDissolutionNotice(notice);
          onRoomDissolvedRef.current?.(notice);
        }
      }
    },
    [subscribeToRoom]
  );

  // Handle messages on /topic/pvp/{roomCode}
  const handleRoomMessage = useCallback((msg: any) => {
    const type = msg.type;
    const payload = msg.payload;

    if (type === "ROOM_DISSOLVED") {
      const notice = payload?.message || "Chủ phòng đã rời phòng. Phòng đấu đã được giải tán.";
      if (roomSubRef.current) {
        try {
          roomSubRef.current.unsubscribe();
        } catch (e) {}
        roomSubRef.current = null;
      }
      roomCodeRef.current = null;
      createdRoomCodeRef.current = null;
      setRoom(null);
      setPhase("IDLE");
      setDissolutionNotice(notice);
      onRoomDissolvedRef.current?.(notice);
    } else if (type === "ROOM_STATE") {
      if (payload?.roomCode && isCreatingRoomRef.current) {
        if (createRoomTimeoutRef.current) clearTimeout(createRoomTimeoutRef.current);
        createRoomTimeoutRef.current = null;
        isCreatingRoomRef.current = false;
        createSentRef.current = false;
        setIsCreatingRoom(false);
        setError(null);
      }
      setRoom(payload);
      if (payload.status === "WAITING") {
        setPhase("LOBBY");
        setLastStandPlayers(new Set());
        setSuddenDeath(false);
        setResult(null);
      } else if (payload.status === "COUNTDOWN") {
        setPhase("COUNTDOWN");
        setLastStandPlayers(new Set());
        setSuddenDeath(false);
        setResult(null);
      } else if (payload.status === "IN_GAME") {
        setPhase("PLAYING");
        if (payload.suddenDeath !== undefined) {
          setSuddenDeath(!!payload.suddenDeath);
        }
      } else if (payload.status === "FINISHED") {
        setPhase("RESULT");
      }
    } else if (type === "START_COUNTDOWN") {
      setRoom((prev) => (prev ? {
        ...prev,
        status: "COUNTDOWN",
        matchStartServerMs: payload.matchStartServerMs,
        host: payload.host ? { ...payload.host, hp: 100 } : prev.host ? { ...prev.host, hp: 100 } : prev.host,
        guest: payload.guest ? { ...payload.guest, hp: 100 } : prev.guest ? { ...prev.guest, hp: 100 } : prev.guest,
      } : prev));
      setSchedule(payload.schedule || []);
      setMatchStartServerMs(payload.matchStartServerMs);
      setPhase("COUNTDOWN");
      setLastStandPlayers(new Set());
      setSuddenDeath(false);
      setResult(null);
      setIncomingAttack(null);
      setParryEvent(null);
      setGoldenTaken(null);
      setGoldenWord(null);
      setShieldAbsorbed(null);
      setEchoChainEvent(null);
      setFogActiveUntilMs(null);
      setFogOpponentUntilMs(null);
      setShieldActiveUntilMs(null);
    } else if (type === "STATE") {
      setRoom((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          status: "IN_GAME",
          host: payload.host ? { ...prev.host, ...payload.host } : prev.host,
          guest: payload.guest && prev.guest ? { ...prev.guest, ...payload.guest } : prev.guest,
        };
      });
      // Clear last stand for players whose HP is > 30 (e.g. rematch or full health)
      setLastStandPlayers((prev) => {
        let changed = false;
        const next = new Set(prev);
        if (payload.host?.userId && (payload.host.hp > 30 || payload.host.hp === undefined)) {
          if (next.delete(String(payload.host.userId))) changed = true;
        }
        if (payload.guest?.userId && (payload.guest.hp > 30 || payload.guest.hp === undefined)) {
          if (next.delete(String(payload.guest.userId))) changed = true;
        }
        return changed ? next : prev;
      });
      if (payload.suddenDeath !== undefined) {
        setSuddenDeath(!!payload.suddenDeath);
      }
      setPhase("PLAYING");
    } else if (type === "MATCH_END") {
      if (hasVoluntarilyLeftRef.current) {
        // Quitting player voluntarily left, do not display result modal
        return;
      }
      setResult((prev) => {
        // Prevent normal match-end (KO, SURVIVAL, WORDS_EXHAUSTED) from being overwritten by a late FORFEIT
        if (prev && prev.reason !== "FORFEIT" && payload.reason === "FORFEIT") {
          return prev;
        }
        return payload;
      });
      setRoom((prev) => {
        if (!prev) return prev;
        const finalReason = prev.endReason && prev.endReason !== "FORFEIT" && payload.reason === "FORFEIT"
          ? prev.endReason
          : payload.reason;
        const finalWinner = prev.endReason && prev.endReason !== "FORFEIT" && payload.reason === "FORFEIT"
          ? prev.winnerId
          : payload.winnerId;
        return { ...prev, status: "FINISHED", winnerId: finalWinner, endReason: finalReason };
      });
      setPhase("RESULT");
    } else if (type === "INCOMING_ATTACK") {
      const myId = myStateRef.current?.userId || currentUserIdRef.current;
      const targetId = payload?.targetUserId || payload?.targetPlayerId;
      const isTargetMe = targetId && myId ? String(targetId) === String(myId) : false;
      if (isTargetMe) {
        setIncomingAttack(payload);
        setTimeout(() => {
          setIncomingAttack((curr) => (curr?.attackId === payload.attackId ? null : curr));
        }, payload.telegraphMs || 2000);
      }
    } else if (type === "ATTACK_PARRIED") {
      setParryEvent(payload);
      setIncomingAttack((curr) => (curr?.attackId === payload.attackId ? null : curr));
      setTimeout(() => {
        setParryEvent((curr) => (curr?.attackId === payload.attackId ? null : curr));
      }, 2500);
    } else if (type === "SPAWN_GARBAGE") {
      const myId = myStateRef.current?.userId || currentUserIdRef.current;
      const targetId = payload?.targetPlayerId || payload?.targetUserId;
      const isTargetMe = targetId && myId ? String(targetId) === String(myId) : false;
      if (isTargetMe) {
        const gw: ScheduledWord = payload.scheduledWord;
        if (gw) {
          gw.isGarbage = true;
          setSchedule((prev) => {
            if (prev.some((w) => w.seq === gw.seq)) return prev;
            return [...prev, gw];
          });
        }
      }
      setIncomingAttack((curr) => (curr?.attackId === payload.attackId ? null : curr));
    } else if (type === "SPAWN_GOLDEN_WORD") {
      const gWord: ScheduledWord = payload.scheduledWord;
      if (gWord) {
        gWord.isGolden = true;
        setGoldenWord(gWord);
        setSchedule((prev) => {
          if (prev.some((w) => w.seq === gWord.seq)) return prev;
          return [...prev, gWord];
        });
      }
    } else if (type === "GOLDEN_TAKEN") {
      setGoldenTaken(payload);
      setGoldenWord(null);
      if (payload?.seq != null) {
        setSchedule((prev) => prev.filter((w) => w.seq !== payload.seq));
      }
      setTimeout(() => {
        setGoldenTaken((curr) => (curr?.seq === payload.seq ? null : curr));
      }, 3000);
    } else if (type === "LAST_STAND") {
      if (payload.playerId) {
        setLastStandPlayers((prev) => new Set([...prev, String(payload.playerId)]));
      }
    } else if (type === "SUDDEN_DEATH") {
      setSuddenDeath(true);
    } else if (type === "REACTION") {
      setLatestReaction(payload);
      setTimeout(() => {
        setLatestReaction((curr) => (curr?.playerId === payload.playerId && curr?.reactionId === payload.reactionId ? null : curr));
      }, 2500);
    } else if (type === "DEADLINE_UPDATE") {
      // Slow-Mo visual speed reduction is handled dynamically in CardBlastEngine animation loop.
      // Base logical schedule remains intact to prevent word jumping or disappearing.
    } else if (type === "EMP_BLAST_CAST") {
      const cleared: number[] = payload?.clearedSeqs || [];
      if (cleared.length > 0) {
        setSchedule((prev) => prev.filter((w) => !cleared.includes(w.seq)));
      }
    } else if (type === "FOG_APPLIED") {
      const myId = myStateRef.current?.userId || currentUserIdRef.current;
      const targetUserId = payload?.userId != null ? String(payload.userId) : "";
      const isTargetMe = targetUserId && String(myId) ? targetUserId === String(myId) : true;
      if (isTargetMe) {
        setFogActiveUntilMs(Date.now() + (payload?.durationMs || 5000));
        setTimeout(() => {
          setFogActiveUntilMs((curr) => (curr && curr <= Date.now() ? null : curr));
        }, payload?.durationMs || 5000);
      } else {
        setFogOpponentUntilMs(Date.now() + (payload?.durationMs || 5000));
        setTimeout(() => {
          setFogOpponentUntilMs((curr) => (curr && curr <= Date.now() ? null : curr));
        }, payload?.durationMs || 5000);
      }
    } else if (type === "SHIELD_ACTIVATED") {
      const myId = myStateRef.current?.userId || currentUserIdRef.current;
      const targetUserId = payload?.userId != null ? String(payload.userId) : "";
      const isTargetMe = targetUserId && String(myId) ? targetUserId === String(myId) : true;
      if (isTargetMe) {
        setShieldActiveUntilMs(Date.now() + (payload?.durationMs || 8000));
        setTimeout(() => {
          setShieldActiveUntilMs((curr) => (curr && curr <= Date.now() ? null : curr));
        }, payload?.durationMs || 8000);
      }
    } else if (type === "ATTACK_ABSORBED") {
      setShieldAbsorbed(payload);
      setIncomingAttack(null);
      setShieldActiveUntilMs(null);
      setTimeout(() => setShieldAbsorbed(null), 3000);
    } else if (type === "ECHO_CHAIN_DETONATED") {
      setEchoChainEvent(payload);
      if (payload?.detonatedSeq != null) {
        setSchedule((prev) => prev.filter((w) => w.seq !== payload.detonatedSeq));
      }
      setTimeout(() => setEchoChainEvent(null), 2500);
    }
  }, []);

  // Publish handlers only after both callbacks are initialized. Subscription
  // callbacks read these refs so reconnects do not capture a previous render.
  useEffect(() => {
    handleUserMessageRef.current = handleUserMessage;
    handleRoomMessageRef.current = handleRoomMessage;
  }, [handleUserMessage, handleRoomMessage]);

  useEffect(() => {
    if (!room?.roomCode) return;
    markCreate("state-committed", { roomCode: room.roomCode });
    const frame = requestAnimationFrame(() => markCreate("lobby-rendered", { roomCode: room.roomCode }));
    return () => cancelAnimationFrame(frame);
  }, [room?.roomCode]);

  // Inbound STOMP actions
  const createRoom = useCallback(
    async (params: {
      deckId?: number | null;
      deckSlug?: string;
      deckTitle: string;
      direction: "VI_EN" | "EN_VI";
      mode: "HUMAN" | "BOT";
      botLevel?: "EASY" | "NORMAL" | "HARD";
      speedLevel?: number;
      hintLevel?: "EASY" | "NORMAL" | "HARD";
      avatar?: string;
    }) => {
      if (isCreatingRoomRef.current || createSentRef.current || roomCodeRef.current) {
        console.log("[PVP] createRoom dropped: already creating room");
        return;
      }
      isCreatingRoomRef.current = true;
      createCancelledRef.current = false;
      createTraceRef.current += 1;
      markCreate("click", { ready: transportReadyRef.current });
      setIsCreatingRoom(true);
      setError(null);

      if (createRoomTimeoutRef.current) clearTimeout(createRoomTimeoutRef.current);
      let client = clientRef.current;
      if (!client?.connected || !transportReadyRef.current) {
        client = await connect();
      }
      // A connection may complete after the visible action timeout or unmount.
      if (!isCreatingRoomRef.current) return;
      if (!client?.connected || !transportReadyRef.current) {
        if (createRoomTimeoutRef.current) clearTimeout(createRoomTimeoutRef.current);
        isCreatingRoomRef.current = false;
        setIsCreatingRoom(false);
        setError("Không thể kết nối đến máy chủ PvP. Vui lòng thử lại.");
        return;
      }
      setError(null);
      createSentRef.current = true;
      markCreate("create-sent");
      createRoomTimeoutRef.current = setTimeout(() => {
        if (isCreatingRoomRef.current && !roomCodeRef.current) {
          // Keep the logical intent locked until an authoritative response:
          // a delayed response must not allow a second in-flight create.
          setError("Không nhận được phản hồi tạo phòng từ máy chủ. Vui lòng thử lại.");
        }
      }, 8000);
      client.publish({
        destination: "/app/pvp/create",
        body: JSON.stringify(params),
      });
    },
    [connect]
  );

  const joinRoom = useCallback(
    async (roomCode: string, avatar?: string) => {
      if (isJoiningRoomRef.current) {
        console.log("[PVP] joinRoom dropped: already joining room");
        return;
      }
      isJoiningRoomRef.current = true;
      setIsJoiningRoom(true);
      setError(null);

      if (joinRoomTimeoutRef.current) clearTimeout(joinRoomTimeoutRef.current);
      joinRoomTimeoutRef.current = setTimeout(() => {
        if (isJoiningRoomRef.current) {
          isJoiningRoomRef.current = false;
          setIsJoiningRoom(false);
          setError("Không nhận được phản hồi vào phòng từ máy chủ. Vui lòng thử lại.");
        }
      }, 8000);

      let client = clientRef.current;
      if (!client?.connected || !transportReadyRef.current) {
        client = await connect();
      }
      if (!isJoiningRoomRef.current) return;
      if (!client?.connected || !transportReadyRef.current) {
        if (joinRoomTimeoutRef.current) clearTimeout(joinRoomTimeoutRef.current);
        isJoiningRoomRef.current = false;
        setIsJoiningRoom(false);
        setError("Không thể kết nối đến máy chủ PvP. Vui lòng thử lại.");
        return;
      }
      setError(null);
      client.publish({
        destination: "/app/pvp/join",
        body: JSON.stringify({ roomCode, avatar }),
      });
    },
    [connect]
  );

  const leaveRoom = useCallback(() => {
    createCancelledRef.current = true;
    isCreatingRoomRef.current = false;
    setIsCreatingRoom(false);
    if (createRoomTimeoutRef.current) clearTimeout(createRoomTimeoutRef.current);
    hasVoluntarilyLeftRef.current = true;
    const code = roomCodeRef.current || room?.roomCode || createdRoomCodeRef.current;
    if (clientRef.current?.connected && code) {
      try {
        clientRef.current.publish({
          destination: "/app/pvp/leave",
          body: JSON.stringify({ roomCode: code }),
        });
      } catch (e) {
        // ignore publish errors
      }
    }
    if (roomSubRef.current) {
      try {
        roomSubRef.current.unsubscribe();
      } catch (e) {}
      roomSubRef.current = null;
    }
    roomCodeRef.current = null;
    createdRoomCodeRef.current = null;
    setRoom(null);
    setPhase("IDLE");
    setSuddenDeath(false);
    setLastStandPlayers(new Set());
    setResult(null);
  }, [room?.roomCode]);

  const toggleReady = useCallback(
    (ready: boolean, skills?: string[], sentinel?: string) => {
      if (!clientRef.current?.connected || !roomCodeRef.current) return;
      clientRef.current.publish({
        destination: "/app/pvp/ready",
        // Echo Sentinel handle of an acknowledged match against a person (page memory only).
        body: JSON.stringify({ roomCode: roomCodeRef.current, ready, skills, sentinel }),
      });
    },
    []
  );

  const sendSkill = useCallback(
    (skillId: string) => {
      if (!clientRef.current?.connected || !roomCodeRef.current) return;
      clientRef.current.publish({
        destination: "/app/pvp/skill",
        body: JSON.stringify({ roomCode: roomCodeRef.current, skillId }),
      });
    },
    []
  );

  const sendHit = useCallback((seq: number, tMs: number) => {
    if (!clientRef.current?.connected || !roomCodeRef.current) return;
    clientRef.current.publish({
      destination: "/app/pvp/hit",
      body: JSON.stringify({ roomCode: roomCodeRef.current, seq, tMs, tms: tMs }),
    });
  }, []);

  const requestRematch = useCallback(() => {
    if (resultRef.current?.reason === "FORFEIT") {
      const notice = "Đối thủ đã rời đi. Vui lòng tạo hoặc tham gia phòng mới.";
      setError(notice);
      onRoomDissolvedRef.current?.(notice);
      return;
    }
    const code = roomCodeRef.current || room?.roomCode || createdRoomCodeRef.current;
    if (!clientRef.current?.connected || !code) return;
    hasVoluntarilyLeftRef.current = false;
    setLastStandPlayers(new Set());
    setSuddenDeath(false);
    setResult(null);
    setIncomingAttack(null);
    setParryEvent(null);
    setGoldenTaken(null);
    setShieldAbsorbed(null);
    setEchoChainEvent(null);
    setFogActiveUntilMs(null);
    setFogOpponentUntilMs(null);
    setShieldActiveUntilMs(null);
    clientRef.current.publish({
      destination: "/app/pvp/rematch",
      body: JSON.stringify({ roomCode: code }),
    });
  }, [room?.roomCode]);

  const rejoinRoom = useCallback((code: string) => {
    if (!clientRef.current?.connected) return;
    clientRef.current.publish({
      destination: "/app/pvp/rejoin",
      body: JSON.stringify({ roomCode: code }),
    });
  }, []);

  const isHost =
    room?.mode === "BOT" ||
    (room?.host?.userId != null && String(room.host.userId) === String(currentUserId)) ||
    (room?.roomCode != null && room.roomCode === createdRoomCodeRef.current);
  const opponent = isHost ? room?.guest || null : room?.host || null;
  const myState = isHost ? room?.host || null : room?.guest || null;

  useEffect(() => {
    myStateRef.current = myState;
  }, [myState]);

  const isLocalPlayerInLastStand = Boolean(
    myState && typeof myState.hp === "number" && myState.hp <= 30 && myState.hp > 0
  );

  const sendGameOver = useCallback(
    (reason = "KO") => {
      const code = roomCodeRef.current || room?.roomCode || createdRoomCodeRef.current;
      if (clientRef.current?.connected && code) {
        clientRef.current.publish({
          destination: "/app/pvp/gameover",
          body: JSON.stringify({ roomCode: code, reason }),
        });
      }
    },
    [room?.roomCode]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (roomSubRef.current) {
        roomSubRef.current.unsubscribe();
      }
      if (clientRef.current) {
        clientRef.current.deactivate();
      }
    };
  }, []);

  const sendReaction = useCallback((reactionId: string) => {
    if (!clientRef.current?.connected || !roomCodeRef.current) return;
    clientRef.current.publish({
      destination: "/app/pvp/react",
      body: JSON.stringify({ roomCode: roomCodeRef.current, reactionId }),
    });
  }, []);

  return {
    phase,
    connected,
    room,
    schedule,
    matchStartServerMs,
    clockOffset,
    currentUserId,
    isHost,
    opponent,
    myState,
    result,
    error,
    incomingAttack,
    parryEvent,
    goldenWord,
    goldenTaken,
    lastStandPlayers,
    isLocalPlayerInLastStand,
    suddenDeath,
    latestReaction,
    shieldAbsorbed,
    echoChainEvent,
    fogActiveUntilMs,
    fogOpponentUntilMs,
    shieldActiveUntilMs,
    isCreatingRoom,
    isJoiningRoom,
    connect,
    createRoom,
    joinRoom,
    leaveRoom,
    toggleReady,
    sendSkill,
    sendHit,
    sendGameOver,
    requestRematch,
    rejoinRoom,
    sendReaction,
    setError,
    dissolutionNotice,
    clearDissolutionNotice: () => setDissolutionNotice(null),
  };
}
