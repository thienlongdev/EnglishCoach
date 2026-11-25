/** One in-flight request per account/resource. Logout cancels pending preparation. */
export function createEntryRequestStore() {
  const pending = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();
  let generation = 0;
  return {
    run<T>(key: string, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const existing = pending.get(key);
      if (existing) return existing.promise as Promise<T>;
      const controller = new AbortController();
      const startedGeneration = generation;
      const promise = Promise.resolve().then(() => load(controller.signal)).then(value => {
        if (controller.signal.aborted || generation !== startedGeneration) throw new Error('Module request cancelled');
        return value;
      }).finally(() => {
        if (pending.get(key)?.promise === promise) pending.delete(key);
      });
      pending.set(key, { controller, promise });
      return promise;
    },
    clear() {
      generation++;
      for (const entry of pending.values()) entry.controller.abort();
      pending.clear();
    },
  };
}

export function moduleEntryKey(path: string, scope: string) {
  return ['module-entry', path, scope] as const;
}

/** Sequential low-priority preparation: at most one preparation request in flight. */
export async function prepareEntryResources(
  paths: readonly string[], load: (path: string) => Promise<unknown>, cancelled: () => boolean,
) {
  for (const path of paths) {
    if (cancelled()) break;
    try { await load(path); } catch { /* A failed preparation must not block the dashboard. */ }
  }
}
