package com.englishcoach.garden;

import com.englishcoach.garden.api.GardenDtos;
import com.englishcoach.garden.api.GardenDtos.PestView;
import com.englishcoach.garden.api.GardenDtos.PlantRequest;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.application.LedgerService;
import com.englishcoach.progress.service.LearningEventService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 4 on real PostgreSQL 17 + the real migrations through V89: the Forgotten Pest cure end to end. One genuine
 * review cures exactly the pest of that word, at once and for good; the next overdue word can no longer take its place
 * on the same crop or in the same read; an insufficient attempt changes nothing and says why; retries and races reward
 * once; and a review of a card whose counter was reset still leaves the evidence the garden reads. Each test uses its
 * own user ids.
 */
class GardenPhase4PersistenceTest {

    static GardenTestEnv env;
    static JdbcTemplate jdbc;
    static LedgerService ledger;
    static LearningEventService reviewLog;
    static final AtomicLong USERS = new AtomicLong(140_000);
    static final AtomicLong WORDS = new AtomicLong();

    @BeforeAll
    static void start() {
        env = new GardenTestEnv(Instant.parse("2026-10-09T03:00:00Z"), "89"); // 10:00 Vietnam
        jdbc = env.jdbc;
        ledger = new LedgerService(env.ctx);
        // the Flashcard module's own event writer on the same database
        reviewLog = new LearningEventService(new NamedParameterJdbcTemplate(env.ds));
    }

    @AfterAll
    static void stop() {
        if (env != null) env.close();
    }

    // ------------------------------------------------------------------ helpers

    static UUID key() {
        return UUID.randomUUID();
    }

    static String code(Runnable r) {
        return assertThrows(GardenException.class, r::run).code;
    }

    /** A garden at level 10, past the tutorial, with coins for seeds. */
    static long farmer() {
        long id = USERS.incrementAndGet();
        jdbc.update("INSERT INTO public.users(id, name, email) VALUES (?, ?, ?)", id, "Learner " + id, "private-" + id + "@example.com");
        env.props.getAllowlistUserIds().add(id);
        env.state.state(id);
        jdbc.update("UPDATE public.garden_profile SET onboarding_step = 8 WHERE user_id = ?", id);
        ledger.addXp(id, env.ctx.engine().levels().totalXpForLevel(10), "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        ledger.addCoins(id, 5_000, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
        return id;
    }

    /** Plants {@code n} corn beds (slots 1..n) and returns the planting ids in slot order. */
    static List<Long> corn(long user, int n) {
        var s = env.state.state(user);
        List<Long> out = new ArrayList<>();
        for (int slot = 1; slot <= n; slot++) {
            int at = slot;
            long plot = s.plots().stream().filter(p -> p.slot() == at).findFirst().orElseThrow().id();
            out.add(env.planting.plant(user, key(), plot, new PlantRequest("CORN")).plot().planting().id());
        }
        return out;
    }

    /** One of the player's cards, overdue by {@code hours} on the Flashcard module's own due date. */
    static long overdueCard(long user, double hours) {
        String word = "phase4word" + WORDS.incrementAndGet();
        long de = jdbc.queryForObject("INSERT INTO public.dictionary_entries(word, cefr, general_translation_vi) VALUES (?, 'A2', ?) RETURNING id",
                Long.class, word, "Nghĩa của " + word);
        return jdbc.queryForObject("""
                INSERT INTO public.flashcards(user_id, dictionary_entry_id, status, next_review_date, review_count)
                VALUES (?, ?, 'LEARNED', ?, 1) RETURNING id""", Long.class, user, de,
                Timestamp.valueOf(LocalDateTime.now().minusMinutes(Math.round(hours * 60))));
    }

    /**
     * What {@code FlashcardService#reviewFlashcard} does for a grade: the counter rises, the review-log row is written
     * through the module's own writer, and the due date moves ("hard" keeps the card due now, "good" +3 days, "easy" +7).
     */
    static void review(long user, long cardId, String grade, Instant at) {
        int n = jdbc.queryForObject("UPDATE public.flashcards SET review_count = review_count + 1 WHERE id = ? RETURNING review_count", Integer.class, cardId);
        assertTrue(reviewLog.recordOccurrenceSafely(user, "FLASHCARD_REVIEWED", cardId + ":" + n, at));
        String due = switch (grade) {
            case "hard" -> "LOCALTIMESTAMP - interval '1 second'";
            case "easy" -> "LOCALTIMESTAMP + interval '7 days'";
            default -> "LOCALTIMESTAMP + interval '3 days'";
        };
        jdbc.update("UPDATE public.flashcards SET next_review_date = " + due + " WHERE id = ?", cardId);
    }

    static long xp(long user) {
        return jdbc.queryForObject("SELECT total_xp FROM public.garden_profile WHERE user_id = ?", Long.class, user);
    }

    /** XP granted for pest cures only (a review also earns its ordinary learning XP through the Flashcard ingest). */
    static long cureXp(long user) {
        return jdbc.queryForObject("SELECT COALESCE(sum(delta), 0) FROM public.garden_ledger WHERE user_id = ? AND reason = 'PEST_CURE'",
                Long.class, user);
    }

    static PestView pestOn(GardenDtos.State s, long plantingId) {
        return s.pests().stream().filter(p -> p.plantingId() != null && p.plantingId() == plantingId).findFirst().orElse(null);
    }

    static String clearReason(long pestId) {
        return jdbc.queryForObject("SELECT clear_reason FROM public.garden_pest WHERE id = ?", String.class, pestId);
    }

    static void assertXpReconciles(long user) {
        assertEquals(xp(user), jdbc.queryForObject("SELECT COALESCE(sum(delta), 0) FROM public.garden_ledger WHERE user_id = ? AND asset = 'XP'",
                Long.class, user), "XP reconciles with the ledger");
    }

    static <T> List<Object> race(int n, Callable<T> call) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(n);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<T>> futures = new ArrayList<>();
        for (int i = 0; i < n; i++) futures.add(pool.submit(() -> {
            go.await();
            return call.call();
        }));
        go.countDown();
        List<Object> out = new ArrayList<>();
        for (var f : futures) {
            try {
                out.add(f.get());
            } catch (java.util.concurrent.ExecutionException ex) {
                out.add(ex.getCause());
            }
        }
        pool.shutdown();
        return out;
    }

    // ================================================================================ the cure

    @Test
    void oneGenuineReviewCuresTheRightPestAtOnceAndNoOtherWordTakesItsPlace() {
        long u = farmer();
        List<Long> beds = corn(u, 3);
        env.clock.advance(Duration.ofMinutes(40));
        // a real backlog: five overdue words, most overdue first
        List<Long> cards = new ArrayList<>();
        for (int i = 0; i < 5; i++) cards.add(overdueCard(u, 90 - i));
        var before = env.state.state(u);
        assertEquals(2, before.pests().size(), "at most two crop pests");
        PestView first = pestOn(before, beds.get(0));
        PestView second = pestOn(before, beds.get(1));
        assertNotNull(first);
        assertNotNull(second);
        assertEquals(cards.get(0), first.flashcardId());
        long xpBefore = cureXp(u);

        // the learner grades the word (Khó): one genuine review, the card stays due today
        env.clock.advance(Duration.ofSeconds(20));
        review(u, first.flashcardId(), "hard", env.clock.now);
        env.clock.advance(Duration.ofSeconds(2));
        var cure = env.pests.spray(u, key(), first.id());
        assertTrue(cure.rewarded());
        assertEquals(5, cure.xp());
        assertEquals(xpBefore + 5, cureXp(u));
        assertEquals("SPRAYED", clearReason(first.id()));

        // the read the client makes right after the cure: THE defect was a new pest on the same bed here
        var after = env.state.state(u);
        assertNull(pestOn(after, beds.get(0)), "the cured crop is clean although three more words are overdue");
        assertEquals(1, after.pests().size(), "no other word takes the cured pest's place");
        assertEquals(second.id(), after.pests().getFirst().id(), "the other crop's pest is untouched");
        assertNull(after.plots().stream().filter(p -> p.planting() != null && p.planting().id() == beds.get(0)).findFirst().orElseThrow()
                .planting().pestId(), "the bed itself reports no pest");
        // a reload changes nothing
        var reload = env.state.state(u);
        assertEquals(List.of(second.id()), reload.pests().stream().map(PestView::id).toList());
        assertEquals(xpBefore + 5, cureXp(u), "the reward is granted once");

        // after the protection period a new pest may come, but never on the crop that was cured
        env.clock.advance(Duration.ofMinutes(31));
        var later = env.state.state(u);
        assertNull(pestOn(later, beds.get(0)), "a cured crop stays clean until harvest");
        PestView arrived = pestOn(later, beds.get(2));
        assertNotNull(arrived, "the next overdue word settles on another crop");
        assertNotEquals(first.id(), arrived.id(), "a new pest is a new object");
        assertNotEquals(first.flashcardId(), arrived.flashcardId(), "of another word");
        assertXpReconciles(u);
    }

    @Test
    void aReviewDoneOnTheFlashcardsScreenCuresOnTheNextReadWithoutAnyGardenAction() {
        long u = farmer();
        List<Long> beds = corn(u, 1);
        env.clock.advance(Duration.ofMinutes(40));
        long card = overdueCard(u, 48);
        PestView pest = pestOn(env.state.state(u), beds.getFirst());
        assertNotNull(pest);
        long xpBefore = cureXp(u);
        env.clock.advance(Duration.ofMinutes(5));
        review(u, card, "easy", env.clock.now);
        env.clock.advance(Duration.ofSeconds(30));

        var s = env.state.state(u);
        assertTrue(s.pests().isEmpty(), "the review alone is the cure");
        assertEquals("SPRAYED", clearReason(pest.id()));
        assertEquals(xpBefore + 5, cureXp(u));
        assertEquals(1, s.learning().pestCuresToday());
        env.state.state(u);
        env.state.state(u);
        assertEquals(xpBefore + 5, cureXp(u), "repeated reads reward nothing more");
        // an old tab that still shows the pest: it is told the pest has left, and nothing is granted again
        assertEquals("PEST_GONE", code(() -> env.pests.spray(u, key(), pest.id())));
        assertEquals(xpBefore + 5, cureXp(u));
        assertXpReconciles(u);
    }

    @Test
    void withoutAGenuineReviewOfThatWordNothingIsCuredAndTheReasonIsExplicit() {
        long u = farmer();
        List<Long> beds = corn(u, 2);
        long early = overdueCard(u, 80);
        // a review from BEFORE the pest appeared is not a cure (the word became overdue again)
        review(u, early, "good", env.clock.now);
        jdbc.update("UPDATE public.flashcards SET next_review_date = LOCALTIMESTAMP - interval '80 hours' WHERE id = ?", early);
        env.clock.advance(Duration.ofMinutes(40));
        long other = overdueCard(u, 70);
        var s = env.state.state(u);
        PestView pest = pestOn(s, beds.get(0));
        PestView twin = pestOn(s, beds.get(1));
        assertEquals(early, pest.flashcardId());
        assertEquals(other, twin.flashcardId());
        long xpBefore = cureXp(u);

        var refused = assertThrows(GardenException.class, () -> env.pests.spray(u, key(), pest.id()));
        assertEquals("PEST_NEEDS_REVIEW", refused.code);
        assertEquals(409, refused.status);
        // reviewing ANOTHER word cures that word's pest only
        env.clock.advance(Duration.ofSeconds(10));
        review(u, other, "good", env.clock.now);
        env.clock.advance(Duration.ofSeconds(1));
        assertEquals("PEST_NEEDS_REVIEW", code(() -> env.pests.spray(u, key(), pest.id())));
        var after = env.state.state(u);
        assertEquals(List.of(pest.id()), after.pests().stream().map(PestView::id).toList(), "only the reviewed word's pest left");
        assertFalse(after.pests().getFirst().reviewed());
        assertEquals("SPRAYED", clearReason(twin.id()));
        assertNull(jdbc.queryForObject("SELECT cleared_at FROM public.garden_pest WHERE id = ?", Timestamp.class, pest.id()));
        assertEquals(xpBefore + 5, cureXp(u), "one cure, one reward");
        // a pest of another garden is never reachable
        long stranger = farmer();
        assertEquals("PEST_NOT_FOUND", code(() -> env.pests.spray(stranger, key(), pest.id())));
        assertXpReconciles(u);
    }

    @Test
    void retriesAndConcurrentRequestsCureAndRewardExactlyOnce() throws Exception {
        long u = farmer();
        List<Long> beds = corn(u, 1);
        env.clock.advance(Duration.ofMinutes(40));
        long card = overdueCard(u, 60);
        PestView pest = pestOn(env.state.state(u), beds.getFirst());
        long xpBefore = cureXp(u);
        env.clock.advance(Duration.ofSeconds(15));
        review(u, card, "good", env.clock.now);
        env.clock.advance(Duration.ofSeconds(1));

        // the same action retried with its key (network failure) while other tabs refresh and press too
        UUID retried = key();
        List<Object> results = race(8, () -> {
            long turn = Thread.currentThread().threadId() % 3;
            if (turn == 0) return env.pests.spray(u, retried, pest.id());
            if (turn == 1) return env.state.state(u);
            return env.pests.spray(u, key(), pest.id());
        });
        for (Object r : results) {
            if (r instanceof Throwable t) assertEquals("PEST_GONE", ((GardenException) t).code, "a late request only learns that the pest left");
        }
        assertEquals(xpBefore + 5, cureXp(u), "one reward whatever the interleaving");
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason = 'PEST_CURE'", Integer.class, u));
        assertEquals(1, env.state.state(u).learning().pestCuresToday());
        assertTrue(env.state.state(u).pests().isEmpty());
        assertXpReconciles(u);
    }

    @Test
    void aReviewAfterTheCardWasResetStillLeavesTheEvidenceTheGardenReads() {
        long u = farmer();
        List<Long> beds = corn(u, 1);
        long card = overdueCard(u, 50);
        // history before the reset: the card's first review wrote "<card>:1" long ago
        assertTrue(reviewLog.recordEventSafely(u, "FLASHCARD_REVIEWED", card + ":1", env.clock.now.minus(Duration.ofDays(9))));
        // "reset" restarted the counter (FlashcardService#resetFlashcard); the word became overdue again
        jdbc.update("UPDATE public.flashcards SET review_count = 0 WHERE id = ?", card);
        env.clock.advance(Duration.ofMinutes(40));
        PestView pest = pestOn(env.state.state(u), beds.getFirst());
        assertNotNull(pest);
        long xpBefore = cureXp(u);

        // the next review is "<card>:1" again: it collides with the old row and used to leave no trace at all
        env.clock.advance(Duration.ofSeconds(30));
        review(u, card, "good", env.clock.now);
        assertEquals(2, jdbc.queryForObject("""
                SELECT count(*) FROM public.learning_activity_events WHERE user_id = ? AND activity_type = 'FLASHCARD_REVIEWED'
                  AND split_part(source_ref, ':', 1) = ?""", Integer.class, u, String.valueOf(card)), "the review after the reset has its own row");
        env.clock.advance(Duration.ofSeconds(1));
        assertTrue(env.pests.spray(u, key(), pest.id()).rewarded());
        assertTrue(env.state.state(u).pests().isEmpty());
        assertEquals(xpBefore + 5, cureXp(u));

        // the ordinary idempotent writer is unchanged: a repeated reference stays one row
        assertTrue(reviewLog.recordEventSafely(u, "DICTATION_COMPLETED", "session:7", env.clock.now));
        assertTrue(reviewLog.recordEventSafely(u, "DICTATION_COMPLETED", "session:7", env.clock.now));
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.learning_activity_events WHERE user_id = ? AND activity_type = 'DICTATION_COMPLETED'",
                Integer.class, u));
    }

    // ================================================================================ the bulkhead

    @Test
    void gardenTransactionsBeyondTheBoundAreToldBusyWithoutEverTouchingTheConnectionPool() throws Exception {
        long u = farmer();
        long other = farmer();
        // the production wiring with a bound of ONE transaction and a short wait
        var bounded = new com.englishcoach.garden.application.GardenContext(new com.englishcoach.garden.infra.GardenRepository(jdbc),
                new org.springframework.jdbc.datasource.DataSourceTransactionManager(env.ds), env.json, env.clock, 1, 150);
        CountDownLatch inside = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        Future<Long> holder = pool.submit(() -> bounded.read(u, now -> {
            inside.countDown();
            try {
                release.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return bounded.repo.profile(u).coins();
        }));
        inside.await();
        int idleBefore = env.ds.getHikariPoolMXBean().getIdleConnections();
        // another player's request finds no slot: refused after the wait, as a retryable 503, with no connection borrowed
        GardenException busy = assertThrows(GardenException.class, () -> bounded.read(other, now -> 1));
        assertEquals(503, busy.status);
        assertEquals("GARDEN_BUSY", busy.code);
        assertEquals("GARDEN_BUSY", code(() -> bounded.command(other, key(), "NOOP", java.util.Map.of(), Integer.class, now -> null, (now, op) -> 1)));
        assertEquals(idleBefore, env.ds.getHikariPoolMXBean().getIdleConnections(), "a waiting garden request holds no connection");
        release.countDown();
        assertEquals(coins(u), holder.get());
        pool.shutdown();
        // the slot is free again (also after the refusals above)
        assertEquals(Integer.valueOf(7), bounded.<Integer>read(other, now -> 7));
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_operation WHERE user_id = ? AND op_type = 'NOOP'", Integer.class, other),
                "a refused command stored nothing");
    }

    static long coins(long user) {
        return jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, user);
    }

    @Test
    void theHarvestOfACropWhosePestWasReviewedIsCleanAndTheLearningRecordIsUntouched() {
        long u = farmer();
        List<Long> beds = corn(u, 1);
        env.clock.advance(Duration.ofMinutes(40));
        long card = overdueCard(u, 40);
        assertNotNull(pestOn(env.state.state(u), beds.getFirst()));
        env.clock.advance(Duration.ofHours(4)); // corn is ripe; the pest is still there
        review(u, card, "good", env.clock.now);
        int reviewsBefore = jdbc.queryForObject("SELECT review_count FROM public.flashcards WHERE id = ?", Integer.class, card);
        Timestamp dueBefore = jdbc.queryForObject("SELECT next_review_date FROM public.flashcards WHERE id = ?", Timestamp.class, card);
        int logBefore = jdbc.queryForObject("SELECT count(*) FROM public.learning_activity_events WHERE user_id = ?", Integer.class, u);
        env.clock.advance(Duration.ofMinutes(1));

        // harvesting straight away (no state read in between): the command itself sees the review
        var ch = env.harvest.start(u, key(), new GardenDtos.HarvestStartRequest(beds));
        var res = env.harvest.complete(u, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true));
        assertEquals(env.ctx.engine().rules().quality().pestClean(), res.harvests().getFirst().components().pest());
        assertTrue(env.state.state(u).pests().isEmpty());
        // the garden never writes to the Flashcard module: counter, schedule and review log are exactly as the review left them
        assertEquals(reviewsBefore, jdbc.queryForObject("SELECT review_count FROM public.flashcards WHERE id = ?", Integer.class, card));
        assertEquals(dueBefore, jdbc.queryForObject("SELECT next_review_date FROM public.flashcards WHERE id = ?", Timestamp.class, card));
        assertEquals(logBefore, jdbc.queryForObject("SELECT count(*) FROM public.learning_activity_events WHERE user_id = ?", Integer.class, u));
        assertXpReconciles(u);
    }
}
