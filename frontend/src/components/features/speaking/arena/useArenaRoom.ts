'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArenaMotion } from './arenaMotion';
import { Client } from '@stomp/stompjs';
import { ensureApiSession } from '@/lib/api-session';
import { authEpoch, authEnding, subscribeAuthLifecycle } from '@/lib/auth-lifecycle';
import { getWsUrl } from '@/services/stompClient';
import type { ArenaCommand, ArenaEvent, ArenaState } from '@/types/speakingArena';

/** One private socket per account-mounted Arena. No room names in public broker subscriptions. */
export function useArenaRoom() {
  const [state, setState] = useState<ArenaState | null>(null);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<ArenaState | null>(null), socket = useRef<Client | null>(null);
  const epoch = useRef(-1), seq = useRef(0), lastMove = useRef(0), boatSeq = useRef(0), lastRow = useRef(0);
  const motion = useRef<ArenaMotion | null>(null);
  if (!motion.current) motion.current = new ArenaMotion();
  const membershipReady = useRef(false);
  const inflight = useRef<{ id: string; action: string; roomId?: string; retries: number; retry?: ReturnType<typeof setTimeout>; timer: ReturnType<typeof setTimeout> } | null>(null);
  const clear = useCallback(() => {
    if (inflight.current) { clearTimeout(inflight.current.timer); clearTimeout(inflight.current.retry); }
    inflight.current = null; setPending(false);
  }, []);
  const send = useCallback((action: string, payload: ArenaCommand = {}) => {
    const client = socket.current;
    if (!client?.connected || authEnding() || authEpoch() !== epoch.current) { setError('CONNECTION_LOST'); return false; }
    const quiet = action === 'move' || action === 'row' || action === 'ping';
    if (!membershipReady.current) return false;
    if (!quiet && inflight.current) return false;
    if (!quiet) setError('');
    const requestId = crypto.randomUUID();
    if (!quiet) {
      inflight.current = { id: requestId, action, roomId: current.current?.roomId, retries: 0, timer: setTimeout(() => { clear(); setError('REQUEST_TIMEOUT'); }, 12000) };
      setPending(true);
    }
    client.publish({ destination: `/app/speaking-arena/${action}`, body: JSON.stringify({ ...payload, requestId, roomId: current.current?.roomId }) });
    return true;
  }, [clear]);
  useEffect(() => {
    let disposed = false, replaced = false;
    let rejoinId: string | null = null, retry: ReturnType<typeof setTimeout> | null = null, retries = 0;
    membershipReady.current = false;
    epoch.current = authEpoch();
    const client = new Client({
      brokerURL: getWsUrl(), reconnectDelay: 1800, heartbeatIncoming: 10000, heartbeatOutgoing: 10000,
      debug: () => {},
      beforeConnect: async () => {
        if (disposed || replaced || authEnding() || epoch.current !== authEpoch() || !(await ensureApiSession())) { void client.deactivate(); }
      },
      onConnect: () => {
        if (disposed) return;
        membershipReady.current = false; motion.current!.reset(''); setConnected(false);
        const rejoin = (roomId: string) => {
          rejoinId = crypto.randomUUID();
          client.publish({ destination: '/app/speaking-arena/rejoin', body: JSON.stringify({ roomId, requestId: rejoinId }) });
        };
        client.subscribe('/user/queue/speaking-arena', message => {
          if (disposed || epoch.current !== authEpoch()) return;
          let event: ArenaEvent;
          try { event = JSON.parse(message.body); } catch { return; }
          if (event.type === 'MOTION') {
            const delta = event.motion;
            if (delta && membershipReady.current && current.current?.roomId === delta.roomId)
              motion.current!.ingest(delta.roomId, delta.serverTime, delta.players, performance.now(), delta.boats);
            return;
          }
          const action = inflight.current && inflight.current.id === event.requestId ? inflight.current.action : undefined;
          const leave = inflight.current;
          if (action === 'leave' && leave && event.type === 'ERROR' && event.code === 'ROOM_BUSY' && leave.retries < 4) {
            leave.retry = setTimeout(() => {
              if (disposed || inflight.current !== leave || !client.connected || authEnding() || authEpoch() !== epoch.current || current.current?.roomId !== leave.roomId) return;
              client.publish({ destination: '/app/speaking-arena/leave', body: JSON.stringify({ roomId: leave.roomId, requestId: leave.id }) });
            }, 400 * ++leave.retries); return;
          }
          if (action) clear();
          if (event.type === 'REPLACED') {
            replaced = true; current.current = null; setState(null); clear(); setConnected(false);
            setError('SESSION_REPLACED'); void client.deactivate(); return;
          }
          if (['REMOVED', 'LEFT', 'ROOM_CLOSED', 'EXPIRED'].includes(event.type)) { current.current = null; setState(null); clear(); if (event.type !== 'LEFT') setError(event.type); return; }
          if (event.type === 'ERROR') {
            if (event.requestId === rejoinId && current.current && retries++ < 5 && ['ROOM_BUSY', 'ARENA_BUSY', 'VOICE_UNAVAILABLE'].includes(event.code ?? '')) {
              retry = setTimeout(() => { if (!disposed && client.connected && current.current) rejoin(current.current.roomId); }, 1500);
              return;
            }
            if (
              event.requestId === rejoinId ||
              ['SESSION_REPLACED', 'ROOM_NOT_FOUND', 'NOT_MEMBER', 'REMOVED', 'ROOM_CLOSED', 'EXPIRED'].includes(event.code ?? '')
            ) {
              current.current = null; setState(null);
            }
            if (event.code === 'SESSION_REPLACED') { replaced = true; setConnected(false); void client.deactivate(); }
            setError(event.code ?? 'ROOM_UNAVAILABLE'); return;
          }
          if (action === 'leave') { current.current = null; setState(null); return; }
          if (event.type === 'ACK' && event.requestId === rejoinId) {
            motion.current!.reset(event.state?.roomId ?? ''); rejoinId = null; retries = 0; membershipReady.current = true; setConnected(true); setError('');
          }
          if (event.state && (!current.current || event.state.roomId !== current.current.roomId || event.state.revision >= current.current.revision)) {
            if (event.type === 'SYNC') motion.current!.reset(event.state.roomId);
            motion.current!.ingest(event.state.roomId, event.state.serverTime, event.state.players, performance.now(), event.state.boats);
            for (const id of motion.current!.history.keys()) if (!event.state.players.some(p => p.id === id)) motion.current!.history.delete(id);
            current.current = event.state; setState(event.state);
            if (event.type === 'SYNC') {
              rejoin(event.state.roomId);
            }
          } else if (event.type === 'SYNC' && !event.state) { current.current = null; setState(null); membershipReady.current = true; setConnected(true); }
        });
        setError('');
        if (current.current) rejoin(current.current.roomId);
        else client.publish({ destination: '/app/speaking-arena/sync', body: JSON.stringify({ requestId: crypto.randomUUID() }) });
      },
      onWebSocketClose: () => { membershipReady.current = false; if (retry) clearTimeout(retry); if (!disposed) { setConnected(false); clear(); } },
      onStompError: () => { if (!disposed) setError('CONNECTION_LOST'); },
    });
    socket.current = client; client.activate();
    const heartbeat = setInterval(() => { if (current.current) send('ping'); }, 8000);
    const cancel = subscribeAuthLifecycle(() => { if (authEnding() || epoch.current !== authEpoch()) { current.current = null; setState(null); setConnected(false); void client.deactivate(); } });
    return () => { disposed = true; membershipReady.current = false; if (retry) clearTimeout(retry); cancel(); clearInterval(heartbeat); clear(); socket.current = null; void client.deactivate(); };
  }, [clear, send]);
  const move = useCallback((x: number, z: number, yaw: number, jump: boolean, diveDepth?: number) => {
    const now = performance.now();
    if (now - lastMove.current < 100 || !membershipReady.current) return false;
    const sequence = ++seq.current;
    if (!send('move', { x, z, yaw, sequence, value: jump, ...(diveDepth !== undefined ? { aux: diveDepth } : {}) })) return false;
    lastMove.current = now;
    const sent = motion.current!.sent;
    sent.set(sequence, { x, z, yaw });
    if (sent.size > 32) sent.delete(sent.keys().next().value!);
    return true;
  }, [send]);
  const row = useCallback((x: number, z: number, yaw: number, rowPhase: number, throttle?: number, steering?: number) => {
    const now = performance.now();
    if (now - lastRow.current < 100 || !membershipReady.current) return false;
    const sequence = ++boatSeq.current;
    if (!send('row', { x, z, yaw, sequence, aux: rowPhase, throttle, steering })) return false;
    lastRow.current = now;
    const sent = motion.current!.boatSent;
    sent.set(sequence, { x, z, yaw });
    if (sent.size > 32) sent.delete(sent.keys().next().value!);
    return true;
  }, [send]);
  return { state, connected, pending, error, send, move, row, motion: motion.current, dismissError: () => setError('') };
}
