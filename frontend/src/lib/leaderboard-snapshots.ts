/** In-memory MIXED snapshots only. Five-second live polling remains authoritative. */
export const BOARD_FRESH_MS = 5000;
export const BOARD_MAX_AGE_MS = 30000;
export function createBoardSnapshots() {
  const snapshots = new Map<string, { data: any; receivedAt: number }>();
  return {
    read(key: readonly unknown[], now = Date.now()) {
      const entry = snapshots.get(JSON.stringify(key));
      return entry && now - entry.receivedAt >= 0 && now - entry.receivedAt <= BOARD_MAX_AGE_MS ? entry.data : undefined;
    },
    accept<T extends { updatedAt?: string | null }>(key: readonly unknown[], data: T, now = Date.now()): T {
      const id = JSON.stringify(key), previous = snapshots.get(id);
      // Server refresh timestamp prevents an older REST response from regressing live state.
      if (previous && Date.parse(previous.data.updatedAt || '') > Date.parse(data.updatedAt || '')) return previous.data;
      snapshots.set(id, { data, receivedAt: now });
      return data;
    },
    clear() { snapshots.clear(); },
  };
}
