package com.englishcoach.garden;

import com.englishcoach.garden.infra.GardenJdbc;
import com.englishcoach.garden.infra.GardenScope;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Phase 5: the rules that keep {@link GardenJdbc} exact, on real PostgreSQL 17 and counted on the wire. A remembered or
 * prefetched result may only ever stand in for the statement that would have returned the same rows at that point of
 * the same transaction; these tests pin each way that could go wrong.
 */
class GardenJdbcTest {

    static GardenTestEnv env;
    static GardenJdbc jdbc;
    static TransactionTemplate tx;

    @BeforeAll
    static void start() {
        GardenTestEnv.throughWire = true;
        try {
            env = new GardenTestEnv(Instant.parse("2026-10-09T03:00:00Z"), "90");
        } finally {
            GardenTestEnv.throughWire = false;
        }
        jdbc = GardenJdbc.of(env.jdbc);
        tx = new TransactionTemplate(new DataSourceTransactionManager(env.ds));
        env.jdbc.execute("""
                CREATE TABLE public.garden_zz_a(id BIGINT PRIMARY KEY, v TEXT, at TIMESTAMPTZ, ref UUID, tags TEXT[]);
                CREATE TABLE public.garden_zz_b(id BIGINT PRIMARY KEY, a_id BIGINT REFERENCES public.garden_zz_a(id), v TEXT);
                CREATE TABLE public.zz_foreign(id BIGINT PRIMARY KEY, v TEXT);
                """);
    }

    @AfterAll
    static void stop() {
        if (env != null) env.close();
    }

    @BeforeEach
    void clean() {
        env.jdbc.execute("TRUNCATE public.garden_zz_b, public.garden_zz_a, public.zz_foreign");
        env.jdbc.update("INSERT INTO public.garden_zz_a(id, v) VALUES (1, 'one'), (2, 'two'), (3, 'three')");
        env.jdbc.update("INSERT INTO public.zz_foreign(id, v) VALUES (1, 'f')");
        GardenJdbc.setEnabled(true);
    }

    @AfterEach
    void on() {
        GardenJdbc.setEnabled(true);
    }

    static <T> T scoped(Supplier<T> work) {
        return GardenScope.within(() -> tx.execute(status -> work.get()));
    }

    static String a(long id) {
        List<String> rows = jdbc.queryForList("SELECT v FROM public.garden_zz_a WHERE id = ?", String.class, id);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    static long countA() {
        return jdbc.queryForObject("SELECT count(*) FROM public.garden_zz_a", Long.class);
    }

    static String b(long id) {
        List<String> rows = jdbc.queryForList("SELECT v FROM public.garden_zz_b WHERE id = ?", String.class, id);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** Round trips of {@code work} as the wire shows them (BEGIN travels with the first statement; COMMIT is one). */
    static long wire(Runnable work) {
        long before = env.wire.roundTrips();
        work.run();
        return env.wire.roundTrips() - before;
    }

    // ---------------------------------------------------------------------------------------------- one exchange

    @Test
    void manyReadsTravelInOneExchangeAndEachCallerMapsItsOwnRows() {
        scoped(() -> a(1)); // warm the connection
        long trips = wire(() -> scoped(() -> {
            GardenScope.prefetch(() -> a(1), () -> a(2), () -> a(3), GardenJdbcTest::countA, () -> b(9));
            assertEquals("one", a(1));
            assertEquals("two", a(2));
            assertEquals("three", a(3));
            assertEquals(3, countA());
            assertNull(b(9));
            // the same question again is answered from the same rows, through a fresh mapper
            List<String> seen = new ArrayList<>();
            jdbc.query("SELECT v FROM public.garden_zz_a WHERE id = ?", (RowCallbackHandler) rs -> seen.add(rs.getString(1)), 2L);
            assertEquals(List.of("two"), seen);
            return null;
        }));
        assertEquals(2, trips, "five reads + one repeated read = one exchange, plus the COMMIT");
    }

    @Test
    void theSameSqlWithOtherParametersIsAnotherQuestion() {
        scoped(() -> {
            GardenScope.prefetch(() -> a(1));
            assertEquals("one", a(1));
            assertEquals("two", a(2));
            assertNull(a(99));
            return null;
        });
    }

    @Test
    void nullArrayTimestampAndUuidParametersAreReplayedExactly() {
        UUID ref = UUID.randomUUID();
        Instant at = Instant.parse("2026-10-01T10:15:30.123456Z");
        env.jdbc.update("UPDATE public.garden_zz_a SET at = ?, ref = ?, tags = ARRAY['x','y'] WHERE id = 2", Timestamp.from(at), ref);
        scoped(() -> {
            Runnable byArray = () -> jdbc.query("SELECT id FROM public.garden_zz_a WHERE id = ANY(?) ORDER BY id",
                    ps -> ps.setArray(1, ps.getConnection().createArrayOf("bigint", new Object[]{2L, 3L})), (rs, n) -> rs.getLong(1));
            Supplier<List<Long>> byNull = () -> jdbc.queryForList(
                    "SELECT id FROM public.garden_zz_a WHERE (?::text IS NULL OR v = ?::text) AND at = ? AND ref = ?", Long.class,
                    null, null, Timestamp.from(at), ref);
            long before = GardenJdbc.exchanges();
            GardenScope.prefetch(byArray, byNull::get);
            assertEquals(1, GardenJdbc.exchanges() - before, "both parameter shapes were recordable and travelled together");
            assertEquals(List.of(2L), byNull.get());
            assertEquals(List.of(2L, 3L), jdbc.query("SELECT id FROM public.garden_zz_a WHERE id = ANY(?) ORDER BY id",
                    ps -> ps.setArray(1, ps.getConnection().createArrayOf("bigint", new Object[]{2L, 3L})), (rs, n) -> rs.getLong(1)));
            assertEquals(1, GardenJdbc.exchanges() - before, "and were answered without another exchange");
            return null;
        });
    }

    // ---------------------------------------------------------------------------------------------- writes

    @Test
    void aReadAfterAWriteOfItsTableGoesToTheDatabase() {
        scoped(() -> {
            GardenScope.prefetch(() -> a(1), GardenJdbcTest::countA, () -> b(1));
            assertEquals("one", a(1));
            jdbc.update("UPDATE public.garden_zz_a SET v = 'uno' WHERE id = ?", 1L);
            assertEquals("uno", a(1));
            jdbc.update("INSERT INTO public.garden_zz_a(id, v) VALUES (?, ?)", 4L, "four");
            assertEquals(4, countA());
            jdbc.queryForObject("INSERT INTO public.garden_zz_b(id, a_id, v) VALUES (1, 4, 'b') RETURNING id", Long.class);
            assertEquals("b", b(1), "a write issued through a query method (RETURNING) is still a write");
            jdbc.update("DELETE FROM public.garden_zz_b WHERE id = ?", 1L);
            assertNull(b(1));
            return null;
        });
    }

    @Test
    void aWriteInsideAProbeIsNeverExecuted() {
        scoped(() -> {
            GardenScope.prefetch(() -> jdbc.update("DELETE FROM public.garden_zz_a"),
                    () -> { a(1); jdbc.update("UPDATE public.garden_zz_a SET v = 'gone'"); },
                    () -> jdbc.updateLater("UPDATE public.garden_zz_a SET v = 'late'"),
                    () -> jdbc.queryForObject("INSERT INTO public.garden_zz_a(id, v) VALUES (50, 'x') RETURNING id", Long.class));
            // second round: the probe that read first now reaches its write, and stops there again
            GardenScope.prefetch(() -> { a(1); jdbc.update("UPDATE public.garden_zz_a SET v = 'gone'"); });
            return null;
        });
        assertEquals(3L, env.jdbc.queryForObject("SELECT count(*) FROM public.garden_zz_a", Long.class));
        assertEquals("one", env.jdbc.queryForObject("SELECT v FROM public.garden_zz_a WHERE id = 1", String.class));
    }

    @Test
    void lateWritesLeaveTogetherInOrderAndNoStatementSeesThemLate() {
        scoped(() -> a(1));
        long trips = wire(() -> scoped(() -> {
            assertEquals("one", a(1));
            jdbc.updateLater("UPDATE public.garden_zz_a SET v = ? WHERE id = ?", "uno", 1L);
            jdbc.updateLater("INSERT INTO public.garden_zz_a(id, v) VALUES (?, ?)", 7L, "seven");
            // a read of the table they write sends them first
            assertEquals("uno", a(1));
            assertEquals(4, countA());
            // a later immediate write keeps its place after the held-back ones (the foreign key needs row 8 to exist)
            jdbc.updateLater("INSERT INTO public.garden_zz_a(id, v) VALUES (?, ?)", 8L, "eight");
            assertEquals(1, jdbc.update("INSERT INTO public.garden_zz_b(id, a_id, v) VALUES (?, ?, ?)", 1L, 8L, "child"));
            jdbc.updateLater("UPDATE public.garden_zz_b SET v = ? WHERE id = ?", "last", 1L);
            jdbc.updateLater("UPDATE public.garden_zz_a SET v = ? WHERE id = ?", "dos", 2L);
            GardenScope.flush();
            return null;
        }));
        assertEquals("last", env.jdbc.queryForObject("SELECT v FROM public.garden_zz_b WHERE id = 1", String.class));
        assertEquals("dos", env.jdbc.queryForObject("SELECT v FROM public.garden_zz_a WHERE id = 2", String.class));
        // read a(1) | late x2 | a(1) + count (two reads) | late 8 together with the insert of b | late x2 | COMMIT
        assertEquals(7, trips);
    }

    @Test
    void aTransactionThatFailsTakesItsLateWritesWithIt() {
        assertThrows(IllegalStateException.class, () -> scoped(() -> {
            jdbc.updateLater("UPDATE public.garden_zz_a SET v = ? WHERE id = ?", "lost", 1L);
            jdbc.update("UPDATE public.garden_zz_a SET v = 'also lost' WHERE id = 2");
            throw new IllegalStateException("the command fails");
        }));
        assertEquals("one", env.jdbc.queryForObject("SELECT v FROM public.garden_zz_a WHERE id = 1", String.class));
        assertEquals("two", env.jdbc.queryForObject("SELECT v FROM public.garden_zz_a WHERE id = 2", String.class));
    }

    @Test
    void aFailingLateWriteFailsTheTransaction() {
        assertThrows(DataAccessException.class, () -> scoped(() -> {
            jdbc.update("UPDATE public.garden_zz_a SET v = 'rolled back' WHERE id = 2");
            jdbc.updateLater("INSERT INTO public.garden_zz_a(id, v) VALUES (?, ?)", 1L, "duplicate key");
            GardenScope.flush();
            return null;
        }));
        assertEquals("two", env.jdbc.queryForObject("SELECT v FROM public.garden_zz_a WHERE id = 2", String.class));
    }

    // ---------------------------------------------------------------------------------------------- what is not remembered

    @Test
    void aTableOfAnotherModuleIsAlwaysReadFromTheDatabase() {
        scoped(() -> {
            Supplier<String> foreign = () -> jdbc.queryForObject("SELECT v FROM public.zz_foreign WHERE id = ?", String.class, 1L);
            GardenScope.prefetch(foreign::get);
            assertEquals("f", foreign.get());
            // written through another template in the same transaction, as another module's service would
            env.jdbc.update("UPDATE public.zz_foreign SET v = 'changed' WHERE id = 1");
            assertEquals("changed", foreign.get());
            return null;
        });
    }

    @Test
    void aLockForgetsEverything() {
        scoped(() -> {
            assertEquals("one", a(1));
            long before = GardenJdbc.exchanges();
            jdbc.query("SELECT pg_advisory_xact_lock(hashtext(?))", (RowCallbackHandler) rs -> { }, "garden:test");
            assertEquals("one", a(1));
            assertEquals(2, GardenJdbc.exchanges() - before, "the lock and a fresh read");
            return null;
        });
    }

    @Test
    void outsideAScopeAndSwitchedOffItIsAPlainTemplate() {
        long before = GardenJdbc.exchanges();
        assertEquals("one", a(1));
        GardenScope.prefetch(() -> a(2));
        jdbc.updateLater("UPDATE public.garden_zz_a SET v = ? WHERE id = ?", "now", 3L);
        assertEquals("now", env.jdbc.queryForObject("SELECT v FROM public.garden_zz_a WHERE id = 3", String.class));
        assertEquals(0, GardenJdbc.exchanges() - before, "nothing is counted, remembered or held back outside a scope");

        GardenJdbc.setEnabled(false);
        long trips = wire(() -> scoped(() -> {
            GardenScope.prefetch(() -> a(1), () -> a(2));
            a(1);
            a(1);
            jdbc.updateLater("UPDATE public.garden_zz_a SET v = ? WHERE id = ?", "plain", 1L);
            return null;
        }));
        assertEquals(4, trips, "switched off: every statement is its own exchange, plus the COMMIT");
        assertEquals("plain", env.jdbc.queryForObject("SELECT v FROM public.garden_zz_a WHERE id = 1", String.class));
    }

    // ---------------------------------------------------------------------------------------------- failures

    @Test
    void aSpeculativeFailureOutsideATransactionOnlyCostsTheBatching() {
        GardenJdbc.forgetFailures();
        Supplier<String> broken = () -> jdbc.queryForObject("SELECT v FROM public.garden_zz_missing WHERE id = ?", String.class, 1L);
        for (int round = 0; round < 2; round++) {
            int r = round;
            GardenScope.within(() -> {
                long before = GardenJdbc.exchanges();
                GardenScope.prefetch(() -> a(1), broken::get, () -> a(2));
                assertEquals("one", a(1));
                assertEquals("two", a(2));
                long used = GardenJdbc.exchanges() - before;
                // first time: the exchange fails and each statement is tried alone; afterwards the broken one stays out
                assertEquals(r == 0 ? 4 : 1, used);
                assertThrows(DataAccessException.class, broken::get, "the real call fails where it always failed");
                return null;
            });
        }
    }

    @Test
    void insideATransactionAFailedReadIsTheCallersFailure() {
        assertThrows(DataAccessException.class, () -> scoped(() -> {
            GardenScope.prefetch(() -> a(1), () -> jdbc.queryForObject("SELECT v FROM public.garden_zz_gone WHERE id = 1", String.class));
            return null;
        }));
    }

    // ---------------------------------------------------------------------------------------------- the lock travels first

    @Test
    void readsSentWithTheLockRunOnlyAfterTheLockIsHeld() throws Exception {
        var repo = env.ctx.repo;
        long user = 424_242L;
        CountDownLatch locked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        var first = CompletableFuture.runAsync(() -> scoped(() -> {
            repo.lock(user);
            jdbc.update("UPDATE public.garden_zz_a SET v = 'written under the lock' WHERE id = 1");
            locked.countDown();
            try {
                release.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return null;
        }));
        assertTrue(locked.await(10, TimeUnit.SECONDS));
        var second = CompletableFuture.supplyAsync(() -> scoped(() -> {
            repo.lock(user, () -> a(1));
            return a(1);
        }));
        Thread.sleep(400);
        assertFalse(second.isDone(), "the second transaction waits for the lock");
        release.countDown();
        first.get(10, TimeUnit.SECONDS);
        assertEquals("written under the lock", second.get(10, TimeUnit.SECONDS),
                "its read was sent together with the lock and still saw what the lock holder committed");
    }
}
