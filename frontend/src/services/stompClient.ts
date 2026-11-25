'use client';

import { Client, IMessage, StompSubscription } from '@stomp/stompjs';
import { authEpoch, authEnding } from '../lib/auth-lifecycle';
import { ensureApiSession } from '../lib/api-session';

export function getWsUrl(): string {
  if (typeof window === 'undefined') return 'wss://englishcoach.io.vn/ws-card-blast';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  if (host.includes(':3000')) {
    return `${protocol}//${window.location.hostname}:8080/ws-card-blast`;
  }
  return `${protocol}//${host}/ws-card-blast`;
}

type TopicCallback = (data: any) => void;
type ConnectionListener = (connected: boolean) => void;

class RealtimeSocketService {
  private client: Client | null = null;
  private subscribers: Map<string, Set<TopicCallback>> = new Map();
  private stompSubscriptions: Map<string, StompSubscription> = new Map();
  private connectionListeners: Set<ConnectionListener> = new Set();
  private connected: boolean = false;
  private isConnecting: boolean = false;
  private reconnectAttempt: number = 0;

  private calculateBackoff(attempt: number): number {
    const baseDelay = 1000;
    const maxDelay = 30000;
    const exponential = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
    const jitter = Math.random() * 1000;
    return Math.min(maxDelay, Math.round(exponential + jitter));
  }

  private notifyConnection(next: boolean): void {
    if (this.connected === next) return;
    this.connected = next;
    this.connectionListeners.forEach((listener) => {
      try {
        listener(next);
      } catch (err) {
        console.error('[Realtime STOMP] Error in connection listener:', err);
      }
    });
  }

  public isConnected(): boolean {
    return this.connected && Boolean(this.client?.connected);
  }

  public subscribeConnection(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  public publish(destination: string, body: string): boolean {
    if (!this.client?.connected) return false;
    try {
      this.client.publish({ destination, body });
      return true;
    } catch (err) {
      console.warn(`[Realtime STOMP] Failed to publish to ${destination}:`, err);
      return false;
    }
  }

  public async connect(): Promise<Client | null> {
    if (typeof window === 'undefined') return null;
    if (authEnding()) return null;
    if (this.client?.active) {
      return this.client;
    }
    if (this.isConnecting) {
      return null;
    }

    const started = authEpoch();
    this.isConnecting = true;

    try {
      // The handshake carries the HttpOnly session cookie; nothing to connect with when nobody is signed in.
      const signedIn = await ensureApiSession();
      if (!signedIn || authEnding() || started !== authEpoch()) {
        this.isConnecting = false;
        return null;
      }

      if (this.client?.active) {
        this.isConnecting = false;
        return this.client;
      }

      if (this.client) {
        try {
          void this.client.deactivate();
        } catch {
          // ignore
        }
        this.client = null;
      }

      const client = new Client({
        brokerURL: getWsUrl(),
        // Every (re)connect first makes sure the session cookie is fresh; no token goes into the frame.
        beforeConnect: async () => {
          if (authEnding()) {
            this.isConnecting = false;
            if (this.client === client) this.client = null;
            void client.deactivate();
            return;
          }
          const ok = await ensureApiSession();
          client.connectHeaders = {};
          if (!ok) {
            this.isConnecting = false;
            if (this.client === client) this.client = null;
            void client.deactivate();
          }
        },
        heartbeatIncoming: 10000,
        heartbeatOutgoing: 10000,
        reconnectDelay: 2000,
        debug: (msg: string) => {
          if (process.env.NODE_ENV === 'development') {
            console.debug('[Realtime STOMP]', msg);
          }
        },
        onConnect: () => {
          if (this.client !== client) return;
          this.isConnecting = false;
          this.reconnectAttempt = 0;
          client.reconnectDelay = 2000;
          // Re-subscribe all active topics before notifying connection listeners
          this.resubscribeAll();
          this.notifyConnection(true);
        },
        onDisconnect: () => {
          if (this.client !== client) return;
          this.isConnecting = false;
          this.stompSubscriptions.clear();
          this.notifyConnection(false);
        },
        onStompError: (frame) => {
          if (this.client !== client) return;
          console.warn('[Realtime STOMP ERROR]', frame.headers['message'], frame.body);
          this.isConnecting = false;
          const msg = (frame.headers['message'] || '').toLowerCase();
          if (msg.includes('unauthenticated') || msg.includes('auth') || msg.includes('token')) {
            try {
              void client.deactivate();
            } catch {
              // ignore
            }
            if (this.client === client) {
              this.client = null;
              this.stompSubscriptions.clear();
            }
            this.notifyConnection(false);
          }
        },
        onWebSocketClose: () => {
          if (this.client !== client) return;
          this.isConnecting = false;
          this.stompSubscriptions.clear();
          this.reconnectAttempt += 1;
          client.reconnectDelay = this.calculateBackoff(this.reconnectAttempt);
          this.notifyConnection(false);
        },
      });

      this.client = client;
      client.activate();
      return client;
    } catch (err) {
      console.warn('[Realtime STOMP] Connection failed', err);
      this.isConnecting = false;
      return null;
    }
  }

  private resubscribeAll() {
    if (!this.client?.connected) return;

    this.stompSubscriptions.forEach((sub) => {
      try {
        sub.unsubscribe();
      } catch {
        // ignore
      }
    });
    this.stompSubscriptions.clear();

    for (const [topic, callbacks] of this.subscribers.entries()) {
      if (callbacks.size > 0) {
        this.doStompSubscribe(topic);
      }
    }
  }

  private doStompSubscribe(topic: string) {
    if (!this.client?.connected) return;
    if (this.stompSubscriptions.has(topic)) return;

    try {
      const sub = this.client.subscribe(topic, (msg: IMessage) => {
        let data: any = null;
        if (msg.body) {
          try {
            data = JSON.parse(msg.body);
          } catch (e) {
            console.error(`[Realtime] Failed to parse message body for ${topic}:`, e);
            return;
          }
        }
        const cbs = this.subscribers.get(topic);
        if (cbs) {
          cbs.forEach((cb) => {
            try {
              cb(data);
            } catch (cbErr) {
              console.error(`[Realtime] Error in topic callback for ${topic}:`, cbErr);
            }
          });
        }
      });
      this.stompSubscriptions.set(topic, sub);
    } catch (err) {
      console.warn(`[Realtime] Failed to subscribe to ${topic}:`, err);
    }
  }

  public subscribe<T = any>(topic: string, callback: (data: T) => void): () => void {
    if (!this.subscribers.has(topic)) {
      this.subscribers.set(topic, new Set());
    }
    const cbs = this.subscribers.get(topic)!;
    cbs.add(callback);

    if (this.client?.connected) {
      this.doStompSubscribe(topic);
    } else {
      void this.connect();
    }

    return () => {
      const currentCbs = this.subscribers.get(topic);
      if (currentCbs) {
        currentCbs.delete(callback);
        if (currentCbs.size === 0) {
          this.subscribers.delete(topic);
          const sub = this.stompSubscriptions.get(topic);
          if (sub) {
            try {
              sub.unsubscribe();
            } catch {
              // ignore
            }
            this.stompSubscriptions.delete(topic);
          }
        }
      }
    };
  }

  /** Tear down the active STOMP socket without dropping current subscriber registrations (e.g. account switch). */
  public resetConnection() {
    this.stompSubscriptions.forEach((sub) => {
      try {
        sub.unsubscribe();
      } catch {
        // ignore
      }
    });
    this.stompSubscriptions.clear();

    if (this.client) {
      const oldClient = this.client;
      this.client = null;
      try {
        void oldClient.deactivate();
      } catch {
        // ignore
      }
    }
    this.isConnecting = false;
    this.reconnectAttempt = 0;
    this.notifyConnection(false);
  }

  public disconnect() {
    this.subscribers.clear();
    this.resetConnection();
  }
}

export const realtimeSocket = new RealtimeSocketService();

export function subscribeRealtimeTopic<T = any>(
  topic: string,
  callback: (data: T) => void
): () => void {
  return realtimeSocket.subscribe<T>(topic, callback);
}

export function subscribeRealtimeConnection(
  listener: (connected: boolean) => void
): () => void {
  return realtimeSocket.subscribeConnection(listener);
}

export function isRealtimeConnected(): boolean {
  return realtimeSocket.isConnected();
}

export function publish(destination: string, body: string): boolean {
  return realtimeSocket.publish(destination, body);
}

export function disconnectRealtimeClient(): void {
  realtimeSocket.disconnect();
}
