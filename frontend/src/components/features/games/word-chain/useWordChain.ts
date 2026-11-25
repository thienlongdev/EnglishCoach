'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Client } from '@stomp/stompjs';
import { useSession } from 'next-auth/react';
import { ensureApiSession } from '@/lib/api-session';
import { getWsUrl } from '@/services/stompClient';
import { rememberMetadata } from './metadataCache';
import type { ChainState } from './types';

type Event = { type: 'STATE' | 'ACK' | 'ERROR'; state?: ChainState; code?: string; messageId?: string };
export function useWordChain() {
  const { data: session } = useSession();
  const userScope = (session?.user as { id?: string } | undefined)?.id || session?.user?.email || null;
  const [state, setState] = useState<ChainState | null>(null);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setErrorCode] = useState<string | null>(null);
  const [errorId, setErrorId] = useState(0);
  // Every refusal is a new event, even when the code repeats (two unknown words in a row).
  const setError = useCallback((code: string | null) => { setErrorCode(code); if (code) setErrorId(n => n + 1); }, []);
  const [serverOffset, setServerOffset] = useState(0);
  const client = useRef<Client | null>(null);
  const current = useRef<ChainState | null>(null);
  const pendingId = useRef<string | null>(null);
  const pendingAction = useRef<string | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const room = useRef<string | null>(null);
  const accept = useCallback((next: ChainState) => {
    if (current.current?.roomCode === next.roomCode && current.current.revision > next.revision) return;
    current.current = next; room.current = next.roomCode;
    rememberMetadata([...next.moves.map(m => m.word), ...(next.currentWord ? [next.currentWord] : [])]);
    setServerOffset(next.serverTimestamp - Date.now());
    setState(next);
    const url = new URL(window.location.href);
    url.searchParams.set('room', next.roomCode);
    window.history.replaceState(window.history.state, '', url);
  }, []);
  useEffect(() => {
    if (!userScope) return;
    current.current = null; setState(null); room.current = new URLSearchParams(window.location.search).get('room');
    const socket = new Client({
      brokerURL: getWsUrl(), reconnectDelay: 3000, connectionTimeout: 10000,
      heartbeatIncoming: 10000, heartbeatOutgoing: 10000,
      beforeConnect: async () => {
        // The handshake carries the HttpOnly session cookie; make sure it is fresh, send no token in the frame.
        await ensureApiSession();
        socket.connectHeaders = {};
      },
      onConnect: () => {
        setConnected(true); setError(null);
        socket.subscribe('/user/queue/word-chain', message => {
          let event: Event;
          try { event = JSON.parse(message.body) as Event; } catch { return; }
          if (event.type === 'ERROR') {
            setError(event.code || 'SERVER_UNAVAILABLE');
            if (event.code === 'ROOM_NOT_FOUND') { room.current = null; current.current = null; setState(null); }
          } else if (event.state) accept(event.state);
          if ((event.type === 'ACK' || event.type === 'ERROR') && event.messageId === pendingId.current) {
            if (timeout.current) clearTimeout(timeout.current);
            if (event.type === 'ACK' && pendingAction.current === 'leave') {
              current.current = null; room.current = null; setState(null);
              const url = new URL(window.location.href); url.searchParams.delete('room'); window.history.replaceState(window.history.state, '', url);
            }
            pendingId.current = null; setPending(false);
          }
        });
        if (room.current) socket.publish({ destination: '/app/word-chain/rejoin', body: JSON.stringify({ roomCode: room.current }) });
      },
      onWebSocketClose: () => { setConnected(false); setError('CONNECTION_LOST'); },
      onStompError: () => { setConnected(false); setError('AUTH_REQUIRED'); },
    });
    client.current = socket; socket.activate();
    const heartbeat = setInterval(() => {
      if (socket.connected && room.current) socket.publish({ destination: '/app/word-chain/ping', body: JSON.stringify({ roomCode: room.current }) });
    }, 10000);
    return () => {
      clearInterval(heartbeat); if (timeout.current) clearTimeout(timeout.current);
      void socket.deactivate(); client.current = null; current.current = null; room.current = null;
      pendingId.current = null; setPending(false); setConnected(false);
    };
  }, [userScope, accept, setError]);
  const send = useCallback((action: string, payload: Record<string, unknown> = {}) => {
    if (!client.current?.connected || pendingId.current) return false;
    const messageId = crypto.randomUUID(); pendingId.current = messageId; pendingAction.current = action;
    setPending(true); setError(null);
    client.current.publish({ destination: `/app/word-chain/${action}`, body: JSON.stringify({ roomCode: room.current,
      revision: current.current?.revision, ...payload, messageId }) });
    timeout.current = setTimeout(() => { pendingId.current = null; setPending(false); setError('REQUEST_TIMEOUT');
      if (client.current?.connected && room.current) client.current.publish({ destination: '/app/word-chain/rejoin', body: JSON.stringify({ roomCode: room.current }) });
    }, 12000);
    return true;
  }, [setError]);
  return { state, connected, pending, error, errorId, serverOffset, send };
}
