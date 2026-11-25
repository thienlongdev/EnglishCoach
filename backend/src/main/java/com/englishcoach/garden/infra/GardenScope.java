package com.englishcoach.garden.infra;

import java.util.HashMap;
import java.util.Map;
import java.util.function.Supplier;

/**
 * A memo that lives for ONE garden transaction (Phase 4). One {@code GET /state} read the same few rows of the acting
 * player again and again from different services — the profile 14 times, the monument row 7 times, the inventory, the
 * plots and the building levels 5 times each — and against the external production database every one of those is a
 * network round trip made while a pooled connection and the player's advisory lock are held.
 *
 * <p>Rules that keep it exact:</p>
 * <ul>
 *   <li>the scope is opened and closed by {@code GardenContext.read / command}, around the transaction itself: nothing
 *   outlives a transaction, a rollback included, and nothing is shared between threads or players;</li>
 *   <li>only rows that are written exclusively by the garden's own repositories are memoized, and every one of those
 *   write methods evicts its key before returning — a read after a write always goes to the database;</li>
 *   <li>the memoized values are immutable (records, unmodifiable collections);</li>
 *   <li>outside a scope (tests calling a repository directly, the read-only collection that precedes the transaction)
 *   every call simply loads.</li>
 * </ul>
 */
public final class GardenScope {

    /** One scope: the keyed memo (Phase 4) and what {@link GardenJdbc} remembers of the database (Phase 5). */
    private static final class State {
        final Map<String, Object> memo = new HashMap<>();
        final GardenJdbc.Session reads = new GardenJdbc.Session();
    }

    private static final ThreadLocal<State> CURRENT = new ThreadLocal<>();

    private GardenScope() {}

    /** Runs {@code work} inside a scope (joins the caller's scope when one is already open). */
    public static <T> T within(Supplier<T> work) {
        if (CURRENT.get() != null) return work.get();
        State state = new State();
        CURRENT.set(state);
        try {
            return work.get();
        } finally {
            CURRENT.remove();
            state.reads.close();
        }
    }

    /** What {@link GardenJdbc} remembers in this scope; null outside a scope or when batching is switched off. */
    static GardenJdbc.Session session() {
        State state = CURRENT.get();
        return state == null || !GardenJdbc.enabled() ? null : state.reads;
    }

    /**
     * Phase 5: ONE database exchange for the first read each probe has no result for yet. A probe is an ordinary
     * read-only repository or view call; it executes nothing while probing (see {@link GardenJdbc}). Call it where the
     * arguments of several independent reads are known, just before the code that makes them. Outside a scope it does
     * nothing, so a caller never depends on it.
     */
    public static void prefetch(Runnable... probes) {
        GardenJdbc.Session session = session();
        if (session != null) session.prefetch(probes);
    }

    /**
     * {@link #prefetch} repeated until no probe has anything left to read (or {@code rounds} exchanges were sent): a
     * probe that needs the result of its first read to know its second one gets there in the next round.
     */
    public static void prefetch(int rounds, Runnable... probes) {
        GardenJdbc.Session session = session();
        if (session == null) return;
        for (int i = 0; i < rounds && session.prefetch(probes); i++) {
            // one exchange per round
        }
    }

    /**
     * Sends the writes {@link GardenJdbc#updateLater} held back. Called by the garden transaction when its work is done,
     * still inside the transaction.
     */
    public static void flush() {
        GardenJdbc.Session session = session();
        if (session != null) session.flush();
    }

    private static Map<String, Object> memo() {
        State state = CURRENT.get();
        return state == null ? null : state.memo;
    }

    /** The value memoized under {@code key} in this transaction, loading it once; a plain load outside a scope. */
    @SuppressWarnings("unchecked")
    public static <T> T get(String key, Supplier<T> load) {
        Map<String, Object> memo = memo();
        if (memo == null) return load.get();
        if (memo.containsKey(key)) return (T) memo.get(key);
        T value = load.get();
        memo.put(key, value);
        return value;
    }

    /** Called by every write of a memoized row: the next read goes to the database. */
    public static void evict(String key) {
        Map<String, Object> memo = memo();
        if (memo != null) memo.remove(key);
    }

    /** Evicts every key that starts with {@code prefix} (a row memoized per day, e.g.). */
    public static void evictPrefix(String prefix) {
        Map<String, Object> memo = memo();
        if (memo != null) memo.keySet().removeIf(k -> k.startsWith(prefix));
    }
}
