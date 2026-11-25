package com.englishcoach.common.cache;

import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletionException;
import java.util.concurrent.atomic.LongAdder;
import java.util.function.Function;
import java.util.function.LongSupplier;
import java.util.function.Predicate;

/**
 * A small in-process cache with a hard entry bound, real expiry, opportunistic pruning, optional negative caching,
 * lightweight hit/miss/eviction counters, and single-flight loading (performance release 2026-11-16, PERF-05).
 * The JVM heap is 416 MiB on a 2 GB host: a cache whose entries only become "stale" but are never removed grows with
 * every distinct account or parameter. Here expired entries are dropped on read and opportunistically pruned on writes,
 * the least recently used entry is evicted beyond {@code maxEntries}, and concurrent misses of one key share one load.
 * <p>
 * Private (per-account) values must use a key that contains the owner; this class never shares across keys.
 * A load that throws is not cached and its exception reaches every waiting caller.
 */
public final class BoundedTtlCache<K, V> {

    private static final Object NULL_SENTINEL = new Object();
    private static final long MAX_PRUNE_WINDOW_MS = 30_000L;
    private static final int OPPORTUNISTIC_SCAN_BUDGET = 64;

    private record Entry(Object value, long expiresAt) {}

    /**
     * Explicit lookup outcome distinguishing a cache miss from a cached {@code null} (negative sentinel) entry.
     */
    public record Lookup<V>(boolean hit, V value) {
        private static final Lookup<?> MISS = new Lookup<>(false, null);

        @SuppressWarnings("unchecked")
        public static <V> Lookup<V> miss() {
            return (Lookup<V>) MISS;
        }
    }

    private final int maxEntries;
    private final long ttlMillis;
    private final long negativeTtlMillis;
    private final LongSupplier clock;
    private final LinkedHashMap<K, Entry> map;
    private final ConcurrentHashMap<K, CompletableFuture<V>> loading = new ConcurrentHashMap<>();
    private final LongAdder hits = new LongAdder();
    private final LongAdder misses = new LongAdder();
    private final LongAdder evictions = new LongAdder();
    private long lastPruneAt;
    private long putOps;

    public BoundedTtlCache(int maxEntries, long ttlMillis) {
        this(maxEntries, ttlMillis, 0L, System::currentTimeMillis);
    }

    public BoundedTtlCache(int maxEntries, long ttlMillis, long negativeTtlMillis) {
        this(maxEntries, ttlMillis, negativeTtlMillis, System::currentTimeMillis);
    }

    BoundedTtlCache(int maxEntries, long ttlMillis, LongSupplier clock) {
        this(maxEntries, ttlMillis, 0L, clock);
    }

    public BoundedTtlCache(int maxEntries, long ttlMillis, long negativeTtlMillis, LongSupplier clock) {
        if (maxEntries < 1) throw new IllegalArgumentException("maxEntries");
        if (ttlMillis < 1) throw new IllegalArgumentException("ttlMillis");
        if (negativeTtlMillis < 0) throw new IllegalArgumentException("negativeTtlMillis");
        this.maxEntries = maxEntries;
        this.ttlMillis = ttlMillis;
        this.negativeTtlMillis = negativeTtlMillis;
        this.clock = Objects.requireNonNull(clock, "clock");
        this.map = new LinkedHashMap<>(16, 0.75f, true);
        this.lastPruneAt = this.clock.getAsLong();
    }

    /** Explicit lookup distinguishing a miss from a negatively cached null sentinel. */
    public Lookup<V> lookupIfPresent(K key) {
        return lookupInternal(key, true);
    }

    /** The cached value, or null when absent, expired (removed), or negatively cached. */
    public V getIfPresent(K key) {
        return lookupInternal(key, true).value();
    }

    public void put(K key, V value) {
        if (value == null) return;
        long now = clock.getAsLong();
        synchronized (map) {
            map.put(key, new Entry(value, now + ttlMillis));
            pruneAndEvictLocked(now);
        }
    }

    /**
     * Caches a negative (null) sentinel for {@code key} using this cache's configured {@code negativeTtlMillis}.
     * No-op if {@code negativeTtlMillis == 0}.
     */
    public void putNegative(K key) {
        if (negativeTtlMillis <= 0L) return;
        putNegative(key, negativeTtlMillis);
    }

    /**
     * Caches a negative (null) sentinel for {@code key} with an explicit short TTL in milliseconds.
     */
    public void putNegative(K key, long customNegativeTtlMillis) {
        if (customNegativeTtlMillis <= 0L) return;
        long now = clock.getAsLong();
        synchronized (map) {
            map.put(key, new Entry(NULL_SENTINEL, now + customNegativeTtlMillis));
            pruneAndEvictLocked(now);
        }
    }

    /**
     * Stores {@code value} if non-null, or stores a negative sentinel when {@code value == null} and
     * {@code cacheNull == true} (using {@code negativeTtlMillis} if positive, otherwise {@code ttlMillis}).
     */
    public void putNullable(K key, V value, boolean cacheNull) {
        if (value != null) {
            put(key, value);
            return;
        }
        if (!cacheNull) return;
        long ttl = negativeTtlMillis > 0L ? negativeTtlMillis : ttlMillis;
        putNegative(key, ttl);
    }

    /**
     * Atomically puts a value if no live entry exists for {@code key}. Returns the existing live entry if present,
     * or {@link Lookup#miss()} if the new entry was stored.
     */
    public Lookup<V> putIfAbsent(K key, V value, boolean cacheNull) {
        long now = clock.getAsLong();
        synchronized (map) {
            Entry existing = map.get(key);
            if (existing != null) {
                if (existing.expiresAt() > now) {
                    return new Lookup<>(true, decode(existing.value()));
                }
                map.remove(key);
                evictions.increment();
            }
            if (value != null) {
                map.put(key, new Entry(value, now + ttlMillis));
                pruneAndEvictLocked(now);
            } else if (cacheNull) {
                long ttl = negativeTtlMillis > 0L ? negativeTtlMillis : ttlMillis;
                map.put(key, new Entry(NULL_SENTINEL, now + ttl));
                pruneAndEvictLocked(now);
            }
            return Lookup.miss();
        }
    }

    /**
     * The cached value, or the loader's value computed once for all concurrent callers of the same key. A null result is
     * returned but not cached.
     */
    public V get(K key, Function<? super K, ? extends V> loader) {
        Lookup<V> first = lookupInternal(key, true);
        if (first.hit() && first.value() != null) return first.value();
        return loadSingleFlight(key, loader, false);
    }

    /**
     * Single-flight loader that also caches {@code null} results as a short-lived negative sentinel when
     * {@code negativeTtlMillis > 0}.
     */
    public V getOrNull(K key, Function<? super K, ? extends V> loader) {
        Lookup<V> first = lookupInternal(key, true);
        if (first.hit()) return first.value();
        return loadSingleFlight(key, loader, true);
    }

    public void invalidate(K key) {
        synchronized (map) {
            map.remove(key);
        }
    }

    public boolean evictIfPresent(K key) {
        synchronized (map) {
            return map.remove(key) != null;
        }
    }

    public void invalidateIf(Predicate<? super K> keyTest) {
        synchronized (map) {
            map.keySet().removeIf(keyTest);
        }
    }

    public void clear() {
        synchronized (map) {
            map.clear();
        }
    }

    public boolean clearIfNotEmpty() {
        synchronized (map) {
            if (map.isEmpty()) return false;
            map.clear();
            return true;
        }
    }

    public int size() {
        synchronized (map) {
            return map.size();
        }
    }

    public int maxEntries() {
        return maxEntries;
    }

    public long ttlMillis() {
        return ttlMillis;
    }

    public long negativeTtlMillis() {
        return negativeTtlMillis;
    }

    public long hits() {
        return hits.sum();
    }

    public long misses() {
        return misses.sum();
    }

    public long evictions() {
        return evictions.sum();
    }

    private Lookup<V> lookupInternal(K key, boolean recordStats) {
        long now = clock.getAsLong();
        synchronized (map) {
            Entry e = map.get(key);
            if (e == null) {
                if (recordStats) misses.increment();
                return Lookup.miss();
            }
            if (e.expiresAt() <= now) {
                map.remove(key);
                evictions.increment();
                if (recordStats) misses.increment();
                return Lookup.miss();
            }
            if (recordStats) hits.increment();
            return new Lookup<>(true, decode(e.value()));
        }
    }

    private V loadSingleFlight(K key, Function<? super K, ? extends V> loader, boolean cacheNull) {
        CompletableFuture<V> mine = new CompletableFuture<>();
        CompletableFuture<V> running = loading.putIfAbsent(key, mine);
        if (running != null) {
            try {
                return running.join();
            } catch (CompletionException e) {
                throw unwrap(e);
            }
        }
        try {
            Lookup<V> again = lookupInternal(key, false);
            if (again.hit() && (cacheNull || again.value() != null)) {
                V val = again.value();
                mine.complete(val);
                return val;
            }
            V value = loader.apply(key);
            if (value != null) {
                put(key, value);
            } else if (cacheNull && negativeTtlMillis > 0L) {
                putNegative(key, negativeTtlMillis);
            }
            mine.complete(value);
            return value;
        } catch (RuntimeException | Error e) {
            mine.completeExceptionally(e);
            throw e;
        } finally {
            loading.remove(key, mine);
        }
    }

    @SuppressWarnings("unchecked")
    private V decode(Object raw) {
        return raw == NULL_SENTINEL ? null : (V) raw;
    }

    private void pruneAndEvictLocked(long now) {
        putOps++;
        if (map.size() > maxEntries) {
            // Expired entries first, then the least recently used ones
            Iterator<Map.Entry<K, Entry>> it = map.entrySet().iterator();
            while (it.hasNext()) {
                if (it.next().getValue().expiresAt() <= now) {
                    it.remove();
                    evictions.increment();
                }
            }
            lastPruneAt = now;
            it = map.entrySet().iterator();
            while (it.hasNext() && map.size() > maxEntries) {
                it.next();
                it.remove();
                evictions.increment();
            }
            return;
        }

        long pruneWindow = Math.min(ttlMillis, MAX_PRUNE_WINDOW_MS);
        boolean windowElapsed = (now - lastPruneAt) >= pruneWindow;
        boolean capacityPressure = (putOps & 31L) == 0L && map.size() >= ((maxEntries * 3) >>> 2);
        if (windowElapsed || capacityPressure) {
            int scanLimit = (now - lastPruneAt) >= ttlMillis ? Integer.MAX_VALUE : OPPORTUNISTIC_SCAN_BUDGET;
            int scanned = 0;
            Iterator<Map.Entry<K, Entry>> it = map.entrySet().iterator();
            while (it.hasNext() && scanned < scanLimit) {
                scanned++;
                if (it.next().getValue().expiresAt() <= now) {
                    it.remove();
                    evictions.increment();
                }
            }
            if (windowElapsed) {
                lastPruneAt = now;
            }
        }
    }

    private static RuntimeException unwrap(CompletionException e) {
        Throwable cause = e.getCause();
        if (cause instanceof RuntimeException re) return re;
        if (cause instanceof Error err) throw err;
        return e;
    }
}
