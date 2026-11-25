'use client';

import { mutate } from 'swr';
import { FLASHCARD_PROGRESS_PATH, READING_PROGRESS_PATH } from '../services/moduleEntryResources';

const SYNC_CHANNEL_NAME = 'englishcoach_tab_sync';
const SYNC_STORAGE_KEY = 'englishcoach_tab_sync';

export interface TabSyncMessage {
  type: 'STREAK_UPDATED' | 'SESSION_COMPLETED';
  timestamp: number;
  sourceTabId?: string;
}

// Unique tab instance identifier to prevent echoing to self
const tabId = typeof window !== 'undefined'
  ? `tab_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
  : 'ssr';

let channel: BroadcastChannel | null = null;
let isInitialized = false;
const listeners = new Set<() => void>();

/**
 * Triggers SWR global mutate across all streak, dashboard, and user profile cache keys.
 */
export function invalidateStreakAndDashboardCaches() {
  mutate(
    (key) => {
      if (typeof key === 'string') {
        return (
          key.startsWith('/progress/streak') ||
          key.startsWith('/progress/heatmap') ||
          key.startsWith('/users/me/profile') ||
          key.startsWith('/flashcards') ||
          key.startsWith('/reading/materials') ||
          key.startsWith('/listening/materials') ||
          key.startsWith('/writing/sessions')
        );
      }
      if (Array.isArray(key) && key.length > 0) {
        if (key[0] === 'module-entry' && (key[1] === FLASHCARD_PROGRESS_PATH || key[1] === READING_PROGRESS_PATH)) return true;
        const first = key[0];
        if (typeof first === 'string') {
          return (
            first.startsWith('/progress/streak') ||
            first.startsWith('/progress/heatmap') ||
            first.startsWith('/users/me/profile') ||
            first.startsWith('/flashcards') ||
            first.startsWith('/reading/materials') ||
            first.startsWith('/listening/materials') ||
            first.startsWith('/writing/sessions')
          );
        }
      }
      return false;
    },
    undefined,
    { revalidate: true }
  );
}

/**
 * Broadcasts a streak or learning session completion event to all other open tabs.
 * Also immediately invalidates caches in the current tab (<10ms).
 */
export function broadcastStreakUpdate() {
  if (typeof window === 'undefined') return;

  // 1. Immediately invalidate in current tab
  invalidateStreakAndDashboardCaches();

  const message: TabSyncMessage = {
    type: 'STREAK_UPDATED',
    timestamp: Date.now(),
    sourceTabId: tabId,
  };

  // 2. Broadcast via BroadcastChannel API if supported
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      if (!channel) {
        channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
      }
      channel.postMessage(message);
    }
  } catch (err) {
    console.debug('[TabSync] BroadcastChannel post failed, falling back to localStorage:', err);
  }

  // 3. Storage event fallback for older/restricted browser environments
  try {
    localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(message));
  } catch {
    // ignore storage quota or private mode issues
  }
}

/**
 * Initializes cross-tab synchronization listener.
 * Safe to call multiple times.
 */
export function initCrossTabSync(onUpdate?: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  if (onUpdate) {
    listeners.add(onUpdate);
  }

  const notifyAll = () => {
    invalidateStreakAndDashboardCaches();
    listeners.forEach((listener) => {
      try {
        listener();
      } catch (e) {
        console.error('[TabSync] Listener callback error:', e);
      }
    });
  };

  if (!isInitialized) {
    isInitialized = true;

    // 1. Setup BroadcastChannel listener
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
        channel.onmessage = (event: MessageEvent<TabSyncMessage>) => {
          if (event.data?.type === 'STREAK_UPDATED' || event.data?.type === 'SESSION_COMPLETED') {
            if (event.data.sourceTabId !== tabId) {
              notifyAll();
            }
          }
        };
      }
    } catch (e) {
      console.debug('[TabSync] BroadcastChannel init error:', e);
    }

    // 2. Setup Storage event listener fallback
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key === SYNC_STORAGE_KEY && event.newValue) {
        try {
          const parsed = JSON.parse(event.newValue) as TabSyncMessage;
          if (parsed.sourceTabId !== tabId) {
            notifyAll();
          }
        } catch {
          // ignore malformed json
        }
      }
    });
  }

  return () => {
    if (onUpdate) {
      listeners.delete(onUpdate);
    }
  };
}
