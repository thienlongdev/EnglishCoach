package com.englishcoach.garden.application;

import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.domain.AnimalEngine;
import com.englishcoach.garden.domain.CosmeticRules;
import com.englishcoach.garden.domain.EstateEngine;
import com.englishcoach.garden.domain.FarmingEngine;
import com.englishcoach.garden.domain.GardenEngine;
import com.englishcoach.garden.domain.LivingEngine;
import com.englishcoach.garden.domain.SocialEngine;
import com.englishcoach.garden.infra.CosmeticRepository;
import com.englishcoach.garden.infra.GardenRepository;
import com.englishcoach.garden.infra.GardenRulesLoader;
import com.englishcoach.garden.infra.GardenScope;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.function.BiFunction;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * Shared runtime of the Garden services: repository, rules, clock and the two transaction shapes.
 * <ul>
 *   <li>{@link #read}: one READ COMMITTED transaction under the per-user advisory lock.</li>
 *   <li>{@link #command}: the same, plus idempotency (GDD 03 §10). The operation row is written in the SAME
 *   transaction as the mutation: a failed command rolls it back (the key may be retried), a committed command stores
 *   its response, and a retry with the same key + same payload returns that response without executing again. The
 *   same key with a different payload is rejected (422). Concurrent duplicates wait on the advisory lock and then
 *   find the stored response.</li>
 * </ul>
 */
@Component
public class GardenContext {

    public final GardenRepository repo;
    public final ObjectMapper json;
    private final TransactionTemplate tx;
    private final Clock clock;
    private final GardenRulesLoader loader;
    private final Semaphore slots;
    private final long busyWaitMillis;
    private volatile GardenEngine engine;
    private volatile LivingEngine living;
    private volatile EstateEngine estate;
    private volatile FarmingEngine farming;
    private volatile boolean farmingLoaded;
    private volatile CosmeticRules cosmetics;
    private volatile boolean cosmeticsLoaded;
    private volatile SocialEngine social;
    private volatile boolean socialLoaded;
    private volatile AnimalEngine animals;
    private volatile String socialDefaultVisibility;
    private volatile boolean animalsLoaded;

    @Autowired
    public GardenContext(GardenRepository repo, PlatformTransactionManager transactions, ObjectMapper json,
                         com.englishcoach.garden.config.GardenProperties properties) {
        this(repo, transactions, json, Clock.systemUTC(), properties.getMaxConcurrentTransactions(), properties.getBusyWaitMillis());
        com.englishcoach.garden.infra.GardenJdbc.setEnabled(properties.isBatchReads());
    }

    /** No bound on concurrent transactions (tests, tools). */
    public GardenContext(GardenRepository repo, PlatformTransactionManager transactions, ObjectMapper json, Clock clock) {
        this(repo, transactions, json, clock, 0, 0);
    }

    /**
     * {@code maxConcurrent}: the bulkhead (Phase 4) — at most this many garden transactions hold a pooled connection at
     * once (0 = unbounded); {@code busyWaitMillis}: how long a request waits for a slot before 503 GARDEN_BUSY.
     */
    public GardenContext(GardenRepository repo, PlatformTransactionManager transactions, ObjectMapper json, Clock clock,
                         int maxConcurrent, long busyWaitMillis) {
        this.repo = repo;
        this.json = json;
        this.tx = new TransactionTemplate(transactions);
        this.clock = clock;
        this.loader = new GardenRulesLoader(repo.jdbc(), json);
        this.slots = maxConcurrent > 0 ? new Semaphore(maxConcurrent, true) : null;
        this.busyWaitMillis = Math.max(0, busyWaitMillis);
    }

    /**
     * Runs one garden transaction inside the bulkhead and inside its own {@link GardenScope}. The slot is taken BEFORE a
     * connection is borrowed, so a queue of garden requests waits here — on nothing but a counter — instead of holding
     * (or starving) the connection pool that sign-in, learning and payments share.
     */
    private <T> T guarded(Supplier<T> transaction) {
        return slot(() -> GardenScope.within(transaction));
    }

    /**
     * Runs {@code work} holding one bulkhead slot. Everything of a garden request that borrows a pooled connection
     * belongs inside: the transaction, and (Phase 5) the read-only collection that precedes the state transaction and
     * keeps one connection for its two exchanges. A garden request can therefore never hold more connections than
     * there are slots, whatever the number of requests waiting. Re-entrant: work that already holds a slot (a garden
     * transaction opened inside another one, or the state transaction after its collection) does not wait for a
     * second one while it holds the first.
     */
    public <T> T slot(Supplier<T> work) {
        if (slots == null || HOLDING.get() != null) return work.get();
        boolean acquired;
        try {
            acquired = slots.tryAcquire(busyWaitMillis, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            acquired = false;
        }
        if (!acquired) throw new GardenException(503, "GARDEN_BUSY");
        HOLDING.set(Boolean.TRUE);
        try {
            return work.get();
        } finally {
            HOLDING.remove();
            slots.release();
        }
    }

    /** Set while this thread holds a bulkhead slot. */
    private static final ThreadLocal<Boolean> HOLDING = new ThreadLocal<>();

    /** Configuration is seeded by Flyway and changes only with a migration (= a restart): loaded once. */
    public GardenEngine engine() {
        GardenEngine e = engine;
        if (e == null) {
            synchronized (this) {
                if (engine == null) {
                    var rules = loader.load();
                    engine = GardenEngine.of(rules, loader.loadEconomy(rules));
                }
                e = engine;
            }
        }
        return e;
    }

    /** Phase 3B rules (monument, mastery, skins): seeded by Flyway like the rest, loaded once. */
    public LivingEngine living() {
        LivingEngine l = living;
        if (l == null) {
            synchronized (this) {
                if (living == null) living = LivingEngine.of(loader.loadLiving(engine().rules()));
                l = living;
            }
        }
        return l;
    }

    /** Phase 3C rules (buildings, land, staged pest damage, contribution): seeded by Flyway like the rest, loaded once. */
    public EstateEngine estate() {
        EstateEngine x = estate;
        if (x == null) {
            synchronized (this) {
                if (estate == null) estate = new EstateEngine(loader.loadEstate(engine().rules()));
                x = estate;
            }
        }
        return x;
    }

    /**
     * Phase 3D rules (soil moisture, farming supplies, harvest bonus): seeded by V85 like the rest, loaded once.
     * {@code null} while the configuration is absent — the garden then behaves exactly like Phase 3C.
     */
    public FarmingEngine farming() {
        if (!farmingLoaded) {
            synchronized (this) {
                if (!farmingLoaded) {
                    var rules = loader.loadFarming(engine().rules());
                    farming = rules == null ? null : new FarmingEngine(engine().rules(), rules);
                    farmingLoaded = true;
                }
            }
        }
        return farming;
    }

    /**
     * Phase 3E rules (cosmetic catalogue, decoration regions): seeded by V86 like the rest, loaded once. {@code null}
     * while the catalogue is absent — the garden then has no cosmetic shop and behaves exactly like Phase 3D.
     */
    public CosmeticRules cosmetics() {
        if (!cosmeticsLoaded) {
            synchronized (this) {
                if (!cosmeticsLoaded) {
                    cosmetics = CosmeticRepository.load(repo.jdbc(), json);
                    cosmeticsLoaded = true;
                }
            }
        }
        return cosmetics;
    }

    /**
     * Phase 3G rules (social islands): seeded by V88 like the rest, loaded once. {@code null} while the configuration
     * is absent — the garden then has no social islands and behaves exactly like Phase 3F.
     */
    public SocialEngine social() {
        if (!socialLoaded) {
            synchronized (this) {
                if (!socialLoaded) {
                    var rules = loader.loadSocial();
                    social = rules == null ? null : new SocialEngine(rules);
                    socialLoaded = true;
                }
            }
        }
        return social;
    }

    /**
     * Phase 3H rules (livestock, guardian pets): seeded by V89 like the rest, loaded once. {@code null} while the
     * configuration is absent — the garden then has no animals and behaves exactly like Phase 3G.
     */
    public AnimalEngine animals() {
        if (!animalsLoaded) {
            synchronized (this) {
                if (!animalsLoaded) {
                    var rules = loader.loadAnimals();
                    animals = rules == null ? null : new AnimalEngine(rules);
                    socialDefaultVisibility = loader.loadSocialDefaultVisibility();
                    animalsLoaded = true;
                }
            }
        }
        return animals;
    }

    /**
     * Phase 3H: the visibility a new garden's social profile starts with until its owner chooses ({@code PRIVATE} from
     * V89 on). {@code null} on a database from before V89: a profile then starts open, as Phase 3G created it.
     */
    public String socialDefaultVisibility() {
        animals();
        return socialDefaultVisibility;
    }

    /**
     * Loads every rule set that is not loaded yet (the first request after a start). The state read calls it before it
     * opens a scope, so the configuration is never read from inside a probe.
     */
    public void warm() {
        engine();
        living();
        estate();
        farming();
        cosmetics();
        social();
        animals();
    }

    /** What this garden's buildings change (cottage, storehouse, market stall); nothing while it owns none. */
    public EstateEngine.Perks perks(long userId) {
        return estate().perks(repo.buildingLevels(userId));
    }

    /** Server time, truncated to the database precision so stored and in-memory instants compare exactly. */
    public Instant now() {
        return clock.instant().truncatedTo(ChronoUnit.MICROS);
    }

    public <T> T read(long userId, Function<Instant, T> work) {
        // every read begins by making sure the garden exists: its profile travels with the lock
        return read(userId, new Runnable[]{() -> repo.profile(userId)}, work);
    }

    /**
     * Phase 5: {@code entry} are reads the work is known to start with and that need nothing but the user (see
     * {@link com.englishcoach.garden.infra.GardenJdbc}); they travel in the same exchange as the lock, after it. The
     * server time is still taken only once the lock is held, so time never runs backwards between two transactions of
     * one garden. Writes the work held back are sent when it is done, inside the transaction.
     */
    public <T> T read(long userId, Runnable[] entry, Function<Instant, T> work) {
        return guarded(() -> tx.execute(status -> {
            repo.lock(userId, entry);
            T result = work.apply(now());
            GardenScope.flush();
            return result;
        }));
    }


    public <T> T command(long userId, UUID key, String opType, Object request, Class<T> type,
                         Function<Instant, Void> ensureGarden, BiFunction<Instant, UUID, T> work) {
        return command(userId, null, key, opType, request, type, ensureGarden, work);
    }

    /**
     * Phase 3G: a command of {@code userId} that also changes the garden of {@code otherUserId} (a visitor taking from a
     * ripe crop). Both per-user locks are taken, always in ascending lock-key order, so it is serialised against every command
     * of either garden (the owner's harvest included) and two players acting on each other can never deadlock. The
     * operation row and its idempotent replay belong to {@code userId}, exactly as in {@link #command}.
     */
    public <T> T pairCommand(long userId, long otherUserId, UUID key, String opType, Object request, Class<T> type,
                             Function<Instant, Void> ensureGarden, BiFunction<Instant, UUID, T> work) {
        if (userId == otherUserId) throw new IllegalArgumentException("a pair command needs two gardens");
        return command(userId, otherUserId, key, opType, request, type, ensureGarden, work);
    }

    private <T> T command(long userId, Long otherUserId, UUID key, String opType, Object request, Class<T> type,
                          Function<Instant, Void> ensureGarden, BiFunction<Instant, UUID, T> work) {
        if (key == null) throw new GardenException(400, "IDEMPOTENCY_KEY_REQUIRED");
        String hash = sha256(opType + "|" + write(request));
        return guarded(() -> tx.execute(status -> {
            if (otherUserId == null) {
                // Phase 5: the lock, the garden's profile and the idempotency lookup in one exchange (they were three)
                repo.lock(userId, () -> repo.profile(userId), () -> repo.operation(userId, key));
            } else {
                repo.lockPair(userId, otherUserId);
            }
            Instant now = now();
            ensureGarden.apply(now);
            var stored = repo.operation(userId, key);
            if (stored != null) {
                if (!stored.opType().equals(opType) || !stored.requestHash().equals(hash)) {
                    throw new GardenException(422, "IDEMPOTENCY_KEY_REUSED");
                }
                try {
                    GardenScope.flush();
                    return json.readValue(stored.response(), type);
                } catch (Exception e) {
                    throw new IllegalStateException("stored garden response unreadable", e);
                }
            }
            T result = work.apply(now, key);
            repo.saveOperation(userId, key, opType, hash, write(result), now);
            GardenScope.flush();
            return result;
        }));
    }

    public String write(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException("garden JSON serialisation failed", e);
        }
    }

    static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
