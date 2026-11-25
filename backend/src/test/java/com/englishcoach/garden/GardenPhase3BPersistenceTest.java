package com.englishcoach.garden;

import com.englishcoach.garden.api.GardenDtos;
import com.englishcoach.garden.api.GardenDtos.BranchView;
import com.englishcoach.garden.api.GardenDtos.CodexCropView;
import com.englishcoach.garden.api.GardenDtos.SkinView;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.application.LedgerService;
import com.englishcoach.garden.infra.GardenRulesLoader;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
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
 * Phase 3B on real PostgreSQL 17 + the real migrations through V82 ({@link GardenTestEnv}): verified learning days and
 * the monument (owner scope, real timestamps, duplicate safety, long absences, never decreasing), graduation credit,
 * crop mastery (exactly once per closed harvest, seeded history), crop skins (authority, idempotency, concurrency,
 * isolation, planting snapshot, no gameplay effect) and Echo's grounded hint. Each test uses its own user ids.
 */
class GardenPhase3BPersistenceTest {

    static GardenTestEnv env;
    static JdbcTemplate jdbc;
    static LedgerService ledger;
    static final AtomicLong USERS = new AtomicLong(40_000);
    static final AtomicLong WORDS = new AtomicLong(40_000);
    /** 2026-10-09 10:00 Vietnam (Lữ Hành week). */
    static final Instant T0 = Instant.parse("2026-10-09T03:00:00Z");

    @BeforeAll
    static void start() {
        env = new GardenTestEnv(T0);
        jdbc = env.jdbc;
        ledger = new LedgerService(env.ctx);
    }

    @AfterAll
    static void stop() {
        if (env != null) env.close();
    }

    // ------------------------------------------------------------------ helpers

    static long newUser() {
        long id = USERS.incrementAndGet();
        jdbc.update("INSERT INTO public.users(id) VALUES (?)", id);
        env.props.getAllowlistUserIds().add(id);
        return id;
    }

    static UUID key() {
        return UUID.randomUUID();
    }

    static GardenException rejected(Runnable r) {
        return assertThrows(GardenException.class, r::run);
    }

    static long card(long user, String status, boolean due) {
        String word = "living" + WORDS.incrementAndGet();
        long de = jdbc.queryForObject("INSERT INTO public.dictionary_entries(word, cefr, general_translation_vi) VALUES (?, 'A2', ?) RETURNING id",
                Long.class, word, "Nghĩa của " + word);
        Timestamp at = Timestamp.valueOf(due ? LocalDateTime.now().minusHours(2) : LocalDateTime.now().plusDays(30));
        return jdbc.queryForObject("""
                INSERT INTO public.flashcards(user_id, dictionary_entry_id, status, next_review_date, review_count)
                VALUES (?, ?, ?, ?, 1) RETURNING id""", Long.class, user, de, status, at);
    }

    static List<Long> cards(long user, int n) {
        List<Long> out = new ArrayList<>();
        for (int i = 0; i < n; i++) out.add(card(user, "LEARNED", false));
        return out;
    }

    /** What FlashcardService#reviewFlashcard records (one row per real review, source_ref = cardId:reviewCount). */
    static void review(long user, long cardId, Instant at) {
        int n = jdbc.queryForObject("SELECT count(*) FROM public.learning_activity_events WHERE user_id = ? AND source_ref LIKE ?",
                Integer.class, user, cardId + ":%") + 1;
        jdbc.update("INSERT INTO public.learning_activity_events(user_id, activity_type, source_ref, occurred_at) VALUES (?, 'FLASHCARD_REVIEWED', ?, ?)",
                user, cardId + ":" + n, Timestamp.from(at));
    }

    /** A finished dictation session with enough attempts (the Listening module's own completion record). */
    static void dictation(long user, Instant endedAt) {
        LocalDateTime local = LocalDateTime.ofInstant(endedAt, ZoneId.systemDefault());
        long session = jdbc.queryForObject("INSERT INTO public.listening_sessions(user_id, started_at, ended_at) VALUES (?, ?, ?) RETURNING id",
                Long.class, user, Timestamp.valueOf(local.minusMinutes(10)), Timestamp.valueOf(local));
        for (int i = 0; i < 3; i++) jdbc.update("INSERT INTO public.exercise_attempts(listening_session_id, accuracy_percentage) VALUES (?, 90)", session);
    }

    static GardenDtos.MonumentView monument(long user) {
        return env.state.state(user).living().monument();
    }

    static BranchView branch(GardenDtos.MonumentView m, String family) {
        return m.branches().stream().filter(b -> b.family().equals(family)).findFirst().orElseThrow();
    }

    static CodexCropView codex(GardenDtos.State s, String crop) {
        return s.living().collection().crops().stream().filter(c -> c.cropCode().equals(crop)).findFirst().orElseThrow();
    }

    static SkinView skin(GardenDtos.State s, String code) {
        return s.living().collection().crops().stream().flatMap(c -> c.skins().stream()).filter(k -> k.code().equals(code)).findFirst().orElseThrow();
    }

    static long plotId(GardenDtos.State s, int slot) {
        return s.plots().stream().filter(p -> p.slot() == slot).findFirst().orElseThrow().id();
    }

    static long coins(long user) {
        return jdbc.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, user);
    }

    static void grantCoins(long user, long coins) {
        ledger.addCoins(user, coins, "TEST_FIXTURE", "TEST", "fixture", null, env.clock.now);
    }

    /** Test fixture: a crop's mastery row at a tier (real play reaches it through closed harvests). */
    static void masteryFixture(long user, String crop, int harvests, int tier) {
        jdbc.update("""
                INSERT INTO public.garden_crop_mastery(user_id, crop_code, harvests, best_tier, seasons, tier, first_at, last_at)
                VALUES (?, ?, ?, 2, 1, ?, now(), now())
                ON CONFLICT (user_id, crop_code) DO UPDATE SET harvests = EXCLUDED.harvests, tier = EXCLUDED.tier, best_tier = 2
                """, user, crop, harvests, tier);
    }

    /** Test fixture: a graduated tree with five words (real play graduates through the 14-day cycle and the challenge). */
    static long graduatedTree(long user, Instant at, long... flashcards) {
        long tree = jdbc.queryForObject("""
                INSERT INTO public.garden_knowledge_tree(user_id, slot, species, planted_at, status, peak_stage, essence_since, graduated_at)
                VALUES (?, 1, 'SPRING', ?, 'GRADUATED', 4, ?, ?) RETURNING id
                """, Long.class, user, Timestamp.from(at.minus(Duration.ofDays(15))), Timestamp.from(at), Timestamp.from(at));
        for (int i = 0; i < flashcards.length; i++) {
            jdbc.update("""
                    INSERT INTO public.garden_knowledge_card(tree_id, user_id, position, flashcard_id, word, meaning_vi, released_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)""", tree, user, i + 1, flashcards[i], "w" + flashcards[i], "nghĩa", Timestamp.from(at));
        }
        return tree;
    }

    static void assertLedgerReconciles(long user) {
        assertEquals(coins(user), jdbc.queryForObject("SELECT COALESCE(sum(delta), 0) FROM public.garden_ledger WHERE user_id = ? AND asset = 'COIN'",
                Long.class, user), "coins reconcile");
        Integer orphan = jdbc.queryForObject("""
                SELECT count(*) FROM (SELECT asset, tier, sum(delta) s FROM public.garden_ledger WHERE user_id = ? AND asset NOT IN ('COIN','XP','ESSENCE')
                GROUP BY asset, tier) l LEFT JOIN public.garden_inventory i ON i.user_id = ? AND i.item_code = l.asset AND i.tier = l.tier
                WHERE COALESCE(i.qty, 0) <> l.s""", Integer.class, user, user);
        assertEquals(0, orphan, "inventory reconciles with the ledger");
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

    /** Plants on a slot, lets the crop ripen and harvests it (recall skipped); returns the harvest result. */
    static GardenDtos.HarvestResult grow(long user, int slot, String crop, int seconds) {
        long plot = plotId(env.state.state(user), slot);
        var planted = env.planting.plant(user, key(), plot, new GardenDtos.PlantRequest(crop));
        env.clock.advance(Duration.ofSeconds(seconds));
        var ch = env.harvest.start(user, key(), new GardenDtos.HarvestStartRequest(List.of(planted.plot().planting().id())));
        return env.harvest.complete(user, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true));
    }

    // ================================================================================ configuration

    @Test
    void v82SeedsExactlyTheDocumentedLivingRules() {
        var loader = new GardenRulesLoader(jdbc, env.json);
        var rules = loader.load();
        assertTrue(GardenTestRules.equivalent(GardenTestRules.seeded(), rules), "V82 changes no Phase 1-3A rule");
        assertEquals(GardenTestRules.economy(), loader.loadEconomy(rules), "V82 changes no Phase 3A economy rule");
        assertEquals(GardenTestRules.living(), loader.loadLiving(rules), "V82 seed == GardenTestRules.living()");
        assertEquals(0, jdbc.queryForObject("""
                SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                WHERE t.relname IN ('garden_monument','garden_monument_day','garden_monument_credit','garden_monument_word',
                    'garden_milestone','garden_crop_mastery','garden_skin_owned','garden_skin_equipped','garden_skin_def')
                  AND c.contype = 'f' AND c.confdeltype <> 'r'""", Integer.class), "every new foreign key restricts deletion");
    }

    // ================================================================================ verified learning days

    @Test
    void aVerifiedDayNeedsEnoughDifferentCardsAfterTheGardenExistsAndCountsOnce() {
        long u = newUser(), other = newUser();
        List<Long> c = cards(u, 6);
        // before the garden existed (same Vietnam day): never counts
        for (int i = 0; i < 5; i++) review(u, c.get(i), T0.minus(Duration.ofHours(2)));
        env.state.state(u);
        env.state.state(other);
        Instant created = env.clock.now;
        // creation day, after creation: four different cards, one of them ten times
        for (int i = 0; i < 4; i++) review(u, c.get(i), created.plus(Duration.ofMinutes(5 + i)));
        for (int i = 0; i < 10; i++) review(u, c.getFirst(), created.plus(Duration.ofMinutes(20 + i)));
        // day 2: five different cards → the only verified day
        for (int i = 0; i < 5; i++) review(u, c.get(i), created.plus(Duration.ofDays(1)).plus(Duration.ofMinutes(i)));
        // day 3: one card five times
        for (int i = 0; i < 5; i++) review(u, c.get(2), created.plus(Duration.ofDays(2)).plus(Duration.ofMinutes(i)));
        // days 4 / 5: five different cards split around Vietnam midnight (23:50 and 00:10): neither day has five
        var cal = env.ctx.engine().calendar();
        Instant midnight = cal.startOfDay(cal.dayKey(created).plusDays(4));
        for (int i = 0; i < 3; i++) review(u, c.get(i), midnight.minus(Duration.ofMinutes(10 - i)));
        for (int i = 3; i < 5; i++) review(u, c.get(i), midnight.plus(Duration.ofMinutes(10 + i)));
        env.clock.advance(Duration.ofDays(6));

        var m = monument(u);
        assertEquals(1, m.learningDays());
        assertEquals(1, branch(m, "VOCABULARY").days());
        assertEquals(0, branch(m, "VOCABULARY").tier(), "one day is not a tier");
        assertEquals(5, m.minCardReviews());
        assertFalse(m.learnedToday());
        assertEquals(0, m.era());
        // reading the state again changes nothing
        assertEquals(1, monument(u).learningDays());
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_monument_day WHERE user_id = ?", Integer.class, u));
        // another learner's garden sees none of it
        var mo = monument(other);
        assertEquals(0, mo.learningDays());
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_monument_day WHERE user_id = ?", Integer.class, other));
        // today: three different cards so far → progress shown honestly, the day is not verified yet
        for (int i = 0; i < 3; i++) review(u, c.get(i), env.clock.now.minus(Duration.ofMinutes(3 - i)));
        var today = monument(u);
        assertEquals(3, today.cardsToday());
        assertFalse(today.learnedToday());
        for (int i = 3; i < 5; i++) review(u, c.get(i), env.clock.now.minus(Duration.ofSeconds(30 - i)));
        var done = monument(u);
        assertTrue(done.learnedToday());
        assertTrue(branch(done, "VOCABULARY").today());
        assertEquals(2, done.learningDays());
    }

    @Test
    void skillLessonsFeedTheirOwnBranchEvenAfterALongAbsenceAndGamesOnlyVerifyTheDay() {
        long u = newUser();
        env.state.state(u);
        Instant created = env.clock.now;
        // the learner studies elsewhere and stays away from the garden for weeks
        dictation(u, created.plus(Duration.ofDays(10)));
        dictation(u, created.plus(Duration.ofDays(11)));
        dictation(u, created.plus(Duration.ofDays(11)).plus(Duration.ofHours(1))); // same day: still one day
        dictation(u, created.plus(Duration.ofDays(12)));
        jdbc.update("INSERT INTO public.card_blast_runs(user_id, score, accuracy, created_at) VALUES (?, 150, 0.9, ?)", u,
                Timestamp.from(created.plus(Duration.ofDays(20))));
        jdbc.update("INSERT INTO public.card_blast_runs(user_id, score, accuracy, created_at) VALUES (?, 40, 0.9, ?)", u,
                Timestamp.from(created.plus(Duration.ofDays(21)))); // below the qualifying score
        env.clock.advance(Duration.ofDays(45));

        var s = env.state.state(u);
        var m = s.living().monument();
        assertEquals(4, m.learningDays(), "three dictation days + one qualifying game day");
        assertEquals(3, branch(m, "LISTENING").days());
        assertEquals(1, branch(m, "LISTENING").tier());
        assertEquals(20, branch(m, "LISTENING").nextAt());
        assertEquals(0, branch(m, "VOCABULARY").days(), "a game verifies the day but grows no branch");
        assertEquals(1, m.branchTiers());
        assertTrue(branch(m, "LISTENING").enabled());
        // the first ornament is a permanent milestone, celebrated once
        assertEquals(List.of("BRANCH:LISTENING:1"), m.unseen().stream().map(x -> x.kind() + ":" + x.code() + ":" + x.tier()).toList());
        assertEquals("MILESTONE", s.living().echo().code());
        assertEquals(0, m.era(), "four days are not an era");
        // the monument is a record, never a faucet: nothing was paid for these weeks
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason NOT IN ('STARTER')",
                Integer.class, u));
        assertEquals(4, monument(u).learningDays(), "idempotent");
    }

    @Test
    void anEraIsReachedOnceNeverLoweredAndInactivityTakesNothingAway() {
        long u = newUser();
        env.state.state(u);
        Instant created = env.clock.now;
        List<Long> c = cards(u, 5);
        for (int d = 1; d <= 21; d++) {
            for (int i = 0; i < 5; i++) review(u, c.get(i), created.plus(Duration.ofDays(d)).plus(Duration.ofMinutes(i)));
        }
        env.clock.advance(Duration.ofDays(22));
        var m = monument(u);
        assertEquals(21, m.learningDays());
        assertEquals(2, branch(m, "VOCABULARY").tier());
        assertEquals(1, m.era());
        assertEquals(2, m.next().tier());
        assertEquals(List.of("DAYS:21/75", "GRADUATIONS:0/3", "BRANCHES:2/3"),
                m.next().requirements().stream().map(r -> r.code() + ":" + r.have() + "/" + r.need()).toList());
        List<Long> unseen = m.unseen().stream().map(GardenDtos.MilestoneView::id).toList();
        assertEquals(3, unseen.size(), "era 1 + vocabulary tiers 1 and 2");

        // the database itself refuses to take progress back
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_monument SET era = 0 WHERE user_id = ?", u));
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_monument SET learning_days = 3 WHERE user_id = ?", u));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.garden_monument_day WHERE user_id = ?", u));
        assertThrows(Exception.class, () -> jdbc.update("UPDATE public.garden_monument_day SET vocabulary = FALSE WHERE user_id = ?", u));
        assertThrows(Exception.class, () -> jdbc.update("DELETE FROM public.garden_milestone WHERE user_id = ?", u));

        // a celebration is shown once: marking is idempotent and only touches the caller's own milestones
        long stranger = newUser();
        env.state.state(stranger);
        assertEquals(0, env.monument.seen(stranger, key(), new GardenDtos.MilestonesSeenRequest(unseen)).marked());
        UUID k = key();
        assertEquals(3, env.monument.seen(u, k, new GardenDtos.MilestonesSeenRequest(unseen)).marked());
        assertEquals(3, env.monument.seen(u, k, new GardenDtos.MilestonesSeenRequest(unseen)).marked(), "same key = same receipt");
        assertEquals(0, env.monument.seen(u, key(), new GardenDtos.MilestonesSeenRequest(unseen)).marked());
        assertTrue(monument(u).unseen().isEmpty());
        assertEquals(3, env.monument.milestones(u, null).milestones().size());
        assertTrue(env.monument.milestones(stranger, null).milestones().isEmpty());

        // four months without studying: the tree keeps everything
        env.clock.advance(Duration.ofDays(120));
        var later = monument(u);
        assertEquals(1, later.era());
        assertEquals(21, later.learningDays());
        assertEquals(2, branch(later, "VOCABULARY").tier());
        assertTrue(later.unseen().isEmpty(), "no celebration is replayed");
    }

    // ================================================================================ graduation credit

    @Test
    void aGraduatedTreeIsExaminedExactlyOnceAndTheSameWordsAreNeverCreditedTwice() {
        long u = newUser(), other = newUser();
        env.state.state(u);
        env.state.state(other);
        Instant t = env.clock.now;
        graduatedTree(u, t.plus(Duration.ofDays(1)), 1001, 1002, 1003, 1004, 1005);   // five new words → credited
        graduatedTree(u, t.plus(Duration.ofDays(2)), 1001, 1002, 1003, 1004, 1005);   // the same five again → not credited
        graduatedTree(u, t.plus(Duration.ofDays(3)), 1004, 1005, 1006, 1007, 1008);   // three new words → credited
        graduatedTree(u, t.plus(Duration.ofDays(4)), 1001, 1002, 1003, 1009, 1010);   // two new words → not credited
        env.clock.advance(Duration.ofDays(5));

        var m = monument(u);
        assertEquals(2, m.graduations());
        assertEquals(4, m.forestCount(), "the forest keeps every graduated tree");
        assertEquals(1, m.memoryTier());
        assertEquals(5, m.nextMemoryAt());
        assertEquals(3, m.minNewWords());
        assertEquals(4, jdbc.queryForObject("SELECT count(*) FROM public.garden_monument_credit WHERE user_id = ?", Integer.class, u));
        assertEquals(8, jdbc.queryForObject("SELECT count(*) FROM public.garden_monument_word WHERE user_id = ?", Integer.class, u));
        // repeated reads never mint more
        assertEquals(2, monument(u).graduations());
        assertEquals(2, monument(u).graduations());
        assertEquals(0, monument(other).graduations(), "another learner's forest is not mine");
        // words 1009 / 1010 were not credited by the refused tree: a later tree with enough new words still counts
        graduatedTree(u, env.clock.now, 1009, 1010, 1011, 1001, 1002);
        assertEquals(3, monument(u).graduations());
    }

    // ================================================================================ crop mastery

    @Test
    void masteryCountsEachClosedHarvestExactlyOnceAndNeverQaCrops() throws Exception {
        long u = newUser();
        env.props.getQaUserIds().add(u);
        var s0 = env.state.state(u);
        assertFalse(codex(s0, "WHEAT").discovered());
        assertEquals(0, codex(s0, "WHEAT").mastery().tier());
        assertFalse(s0.living().collection().crops().stream().anyMatch(c -> c.cropCode().equals("QA_SPROUT")), "the QA crop has no codex page");

        long plot = plotId(s0, 1);
        var planted = env.planting.plant(u, key(), plot, new GardenDtos.PlantRequest("WHEAT"));
        env.clock.advance(Duration.ofSeconds(61));
        var ch = env.harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(planted.plot().planting().id())));
        UUID done = key();
        var request = new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true);
        var result = env.harvest.complete(u, done, request);
        // a lost response retried with the same key replays the receipt: the harvest is not counted again
        assertEquals(env.json.writeValueAsString(result), env.json.writeValueAsString(env.harvest.complete(u, done, request)));
        assertEquals("CHALLENGE_DONE", rejected(() -> env.harvest.complete(u, key(), request)).code);

        var s1 = env.state.state(u);
        var wheat = codex(s1, "WHEAT");
        assertTrue(wheat.discovered());
        assertEquals(1, wheat.mastery().harvests());
        assertEquals(1, wheat.mastery().tier());
        assertEquals(2, wheat.mastery().next().tier());
        assertEquals("HARVESTS:1/10", wheat.mastery().next().requirements().getFirst().code() + ":"
                + wheat.mastery().next().requirements().getFirst().have() + "/" + wheat.mastery().next().requirements().getFirst().need());
        assertEquals(1, wheat.mastery().seasons().size());
        assertFalse(wheat.forms().isEmpty(), "the codex shows the forms the harvest discovered");
        assertTrue(wheat.possibleForms().containsAll(List.of("NORMAL", "GOOD", "PERFECT", "MOONLIT", "RAINBOW", "MUTATED")));
        assertFalse(wheat.possibleForms().contains("GOLDEN"), "a Common crop cannot reach Golden: the codex never asks for it");
        assertTrue(codex(s1, "STRAWBERRY").possibleForms().contains("GOLDEN"));
        assertEquals(1, s1.living().monument().unseen().stream().filter(x -> x.kind().equals("MASTERY") && x.code().equals("WHEAT")).count());

        // the 60-second QA crop never counts
        grow(u, 2, "QA_SPROUT", 61);
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_crop_mastery WHERE user_id = ? AND crop_code = 'QA_SPROUT'",
                Integer.class, u));
        assertEquals(1, jdbc.queryForObject("SELECT harvests FROM public.garden_crop_mastery WHERE user_id = ? AND crop_code = 'WHEAT'",
                Integer.class, u));
    }

    @Test
    void aGardenOlderThanV82IsSeededOnceFromItsOwnHarvestHistory() {
        long u = newUser();
        var s = env.state.state(u);
        long plot = plotId(s, 3);
        // an "old" garden: closed harvests exist, mastery was never computed
        for (int i = 0; i < 12; i++) {
            jdbc.update("""
                    INSERT INTO public.garden_planting(user_id, plot_id, crop_code, planted_at, base_seconds, harvested_at, harvest_tier, harvest_score)
                    VALUES (?, ?, 'WHEAT', ?, 1200, ?, ?, 80)""", u, plot, Timestamp.from(T0.minus(Duration.ofDays(30 - i))),
                    Timestamp.from(T0.minus(Duration.ofDays(30 - i)).plus(Duration.ofHours(1))), i == 4 ? "PERFECT" : "GOOD");
        }
        jdbc.update("DELETE FROM public.garden_crop_mastery WHERE user_id = ?", u);
        jdbc.update("UPDATE public.garden_monument SET mastery_seeded_at = NULL WHERE user_id = ?", u);

        var wheat = codex(env.state.state(u), "WHEAT").mastery();
        assertEquals(12, wheat.harvests());
        assertEquals("PERFECT", wheat.bestTier());
        assertEquals(2, wheat.tier(), "12 harvests = tier 2");
        // seeded history is recorded, not celebrated
        assertEquals(2, jdbc.queryForObject("SELECT count(*) FROM public.garden_milestone WHERE user_id = ? AND kind = 'MASTERY' AND seen_at IS NOT NULL",
                Integer.class, u));
        assertEquals(12, codex(env.state.state(u), "WHEAT").mastery().harvests(), "the seed runs once");
        // the next real harvest adds exactly one
        grow(u, 1, "WHEAT", 1500);
        assertEquals(13, codex(env.state.state(u), "WHEAT").mastery().harvests());
    }

    // ================================================================================ crop skins

    @Test
    void aSkinPurchaseIsAuthoritativeIdempotentAndReconciled() {
        long u = newUser();
        var s0 = env.state.state(u);
        assertEquals("LOCKED", skin(s0, "TOMATO_AMBER").status(), "never grown: not for sale yet");
        assertEquals("SKIN_LOCKED", rejected(() -> env.collection.acquire(u, key(), new GardenDtos.SkinAcquireRequest("TOMATO_AMBER"))).code);
        assertEquals(404, rejected(() -> env.collection.acquire(u, key(), new GardenDtos.SkinAcquireRequest("NO_SUCH_SKIN"))).status);

        masteryFixture(u, "TOMATO", 1, 1);
        var s1 = env.state.state(u);
        assertEquals("AVAILABLE", skin(s1, "TOMATO_AMBER").status());
        assertFalse(skin(s1, "TOMATO_AMBER").coinsOk());
        var funds = rejected(() -> env.collection.acquire(u, key(), new GardenDtos.SkinAcquireRequest("TOMATO_AMBER")));
        assertEquals("INSUFFICIENT_FUNDS", funds.code);
        assertEquals(23_800L, ((Number) funds.details.get("missing")).longValue());
        assertEquals(0, jdbc.queryForObject("SELECT count(*) FROM public.garden_skin_owned WHERE user_id = ?", Integer.class, u));
        assertEquals(200, coins(u), "a refused purchase takes nothing");

        grantCoins(u, 30_000);
        UUID k = key();
        var receipt = env.collection.acquire(u, k, new GardenDtos.SkinAcquireRequest("TOMATO_AMBER"));
        assertEquals(24_000, receipt.coinsPaid());
        assertEquals(6_200, receipt.coins());
        assertEquals("COIN", receipt.source());
        var replay = env.collection.acquire(u, k, new GardenDtos.SkinAcquireRequest("TOMATO_AMBER"));
        assertEquals(receipt.coins(), replay.coins(), "same key = same receipt");
        assertEquals(6_200, coins(u), "never charged twice");
        assertEquals(422, rejected(() -> env.collection.acquire(u, k, new GardenDtos.SkinAcquireRequest("STRAWBERRY_SNOW"))).status,
                "same key with another skin is refused");
        assertEquals("SKIN_OWNED", rejected(() -> env.collection.acquire(u, key(), new GardenDtos.SkinAcquireRequest("TOMATO_AMBER"))).code);
        assertEquals(1, jdbc.queryForObject("SELECT count(*) FROM public.garden_skin_owned WHERE user_id = ?", Integer.class, u));
        assertEquals(-24_000L, jdbc.queryForObject("SELECT sum(delta) FROM public.garden_ledger WHERE user_id = ? AND reason = 'SKIN_BUY'", Long.class, u));
        var s2 = env.state.state(u);
        assertEquals("OWNED", skin(s2, "TOMATO_AMBER").status());
        assertEquals(1, s2.living().collection().skinsOwned());
        assertLedgerReconciles(u);
    }

    @Test
    void earnedSkinsNeedTheirMilestoneAndCostNothing() {
        long u = newUser();
        env.state.state(u);
        grantCoins(u, 999_999);
        // mastery skin: coins never buy it
        masteryFixture(u, "WHEAT", 30, 3);
        var locked = rejected(() -> env.collection.acquire(u, key(), new GardenDtos.SkinAcquireRequest("WHEAT_DUSK")));
        assertEquals("SKIN_LOCKED", locked.code);
        assertEquals("MASTERY", locked.details.get("reason"));
        masteryFixture(u, "WHEAT", 75, 4);
        long before = coins(u);
        var got = env.collection.acquire(u, key(), new GardenDtos.SkinAcquireRequest("WHEAT_DUSK"));
        assertEquals(0, got.coinsPaid());
        assertEquals(before, coins(u));
        assertEquals("MASTERY", got.source());
        // learning skin: verified learning days, never coins
        masteryFixture(u, "CORN", 1, 1);
        var learn = rejected(() -> env.collection.acquire(u, key(), new GardenDtos.SkinAcquireRequest("CORN_GEM")));
        assertEquals("LEARNING", learn.details.get("reason"));
        assertEquals(21, learn.details.get("days"));
        assertEquals("LOCKED", skin(env.state.state(u), "CORN_GEM").status());
        // once earned, Echo points at the skin waiting to be collected (nothing higher is pending for this garden)
        masteryFixture(u, "ROSE", 45, 4);
        var s = env.state.state(u);
        assertEquals("AVAILABLE", skin(s, "ROSE_MOON").status());
        assertEquals("CLAIM_SKIN", s.living().echo().code());
        assertEquals("ROSE_MOON", s.living().echo().params().get("skinCode"));
    }

    @Test
    void concurrentPurchasesOfOneSkinChargeOnce() throws Exception {
        long u = newUser();
        env.state.state(u);
        masteryFixture(u, "STRAWBERRY", 1, 1);
        grantCoins(u, 100_000);
        long before = coins(u);
        var results = race(4, () -> env.collection.acquire(u, key(), new GardenDtos.SkinAcquireRequest("STRAWBERRY_SNOW")));
        assertEquals(1, results.stream().filter(r -> r instanceof GardenDtos.SkinReceipt).count());
        assertEquals(3, results.stream().filter(r -> r instanceof GardenException ge && ge.code.equals("SKIN_OWNED")).count());
        assertEquals(before - 60_000, coins(u));
        assertLedgerReconciles(u);
    }

    @Test
    void anEquippedSkinIsSnapshottedAtPlantingOwnedOnlyAndChangesNoGameplay() {
        long a = newUser(), b = newUser();
        var sa = env.state.state(a);
        env.state.state(b);
        masteryFixture(a, "TOMATO", 1, 1);
        grantCoins(a, 30_000);
        env.collection.acquire(a, key(), new GardenDtos.SkinAcquireRequest("TOMATO_AMBER"));

        // only the owner can equip it, only on its own crop
        assertEquals(404, rejected(() -> env.collection.equip(b, key(), new GardenDtos.SkinEquipRequest("TOMATO", "TOMATO_AMBER"))).status,
                "a skin someone else owns does not exist for me");
        assertEquals(404, rejected(() -> env.collection.equip(a, key(), new GardenDtos.SkinEquipRequest("TOMATO", "PUMPKIN_JADE"))).status,
                "not owned");
        assertEquals("SKIN_CROP_MISMATCH", rejected(() -> env.collection.equip(a, key(), new GardenDtos.SkinEquipRequest("WHEAT", "TOMATO_AMBER"))).code);
        var eq = env.collection.equip(a, key(), new GardenDtos.SkinEquipRequest("TOMATO", "TOMATO_AMBER"));
        assertEquals("TOMATO_AMBER", eq.collection().crops().stream().filter(c -> c.cropCode().equals("TOMATO")).findFirst().orElseThrow().equippedSkin());

        long p1 = plotId(sa, 1), p2 = plotId(sa, 2);
        var skinned = env.planting.plant(a, key(), p1, new GardenDtos.PlantRequest("TOMATO")).plot().planting();
        assertEquals("TOMATO_AMBER", skinned.skinCode());
        assertEquals("tomato_amber", skinned.skinArt());
        // changing the choice never touches a growing planting; the next planting takes the new choice
        env.collection.equip(a, key(), new GardenDtos.SkinEquipRequest("TOMATO", null));
        var plain = env.planting.plant(a, key(), p2, new GardenDtos.PlantRequest("TOMATO")).plot().planting();
        assertNull(plain.skinCode());
        var now = env.state.state(a);
        var again = now.plots().stream().filter(p -> p.id() == p1).findFirst().orElseThrow().planting();
        assertEquals("TOMATO_AMBER", again.skinCode(), "the planting keeps the skin it was planted with");
        // art only: identical growth facts with and without the skin
        assertEquals(plain.requiredSeconds(), skinned.requiredSeconds());
        assertEquals(plain.speed(), skinned.speed());
        assertEquals(plain.maxBoost(), skinned.maxBoost());
        assertEquals(plain.seasonFit(), skinned.seasonFit());
        assertEquals(1, jdbc.queryForObject("SELECT count(DISTINCT base_seconds) FROM public.garden_planting WHERE user_id = ? AND crop_code = 'TOMATO'",
                Integer.class, a));

        // the database refuses a planting with a skin its owner does not hold, or a skin of another crop
        long pb = plotId(env.state.state(b), 1);
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.garden_planting(user_id, plot_id, crop_code, planted_at, base_seconds, skin_code)
                VALUES (?, ?, 'TOMATO', now(), 2700, 'TOMATO_AMBER')""", b, pb));
        long p3 = plotId(sa, 3);
        assertThrows(Exception.class, () -> jdbc.update("""
                INSERT INTO public.garden_planting(user_id, plot_id, crop_code, planted_at, base_seconds, skin_code)
                VALUES (?, ?, 'WHEAT', now(), 1200, 'TOMATO_AMBER')""", a, p3));
        assertThrows(Exception.class, () -> jdbc.update(
                "INSERT INTO public.garden_skin_equipped(user_id, crop_code, skin_code, equipped_at) VALUES (?, 'TOMATO', 'TOMATO_AMBER', now())", b));
        assertEquals(0, env.state.state(b).living().collection().skinsOwned(), "nothing leaks between gardens");
    }

    // ================================================================================ Echo

    @Test
    void echoGivesOneHintGroundedInWhatIsTrueRightNow() {
        long u = newUser();
        var fresh = env.state.state(u);
        // no cards, nothing ripe, nothing new: the nearest honest goal is the first vocabulary tier
        assertEquals("BRANCH", fresh.living().echo().code());
        assertEquals("VOCABULARY", fresh.living().echo().params().get("family"));
        assertEquals(3, fresh.living().echo().params().get("daysLeft"));

        List<Long> due = new ArrayList<>();
        for (int i = 0; i < 6; i++) due.add(card(u, "LEARNED", true));
        var withDue = env.state.state(u);
        assertEquals("REVIEW_DUE", withDue.living().echo().code());
        assertEquals(6L, ((Number) withDue.living().echo().params().get("due")).longValue(), "the real due count, never an invented one");

        long plot = plotId(withDue, 1);
        var planted = env.planting.plant(u, key(), plot, new GardenDtos.PlantRequest("WHEAT"));
        assertEquals("REVIEW_DUE", env.state.state(u).living().echo().code(), "a growing crop is not a task");
        env.clock.advance(Duration.ofSeconds(61));
        var ripe = env.state.state(u);
        assertEquals("HARVEST", ripe.living().echo().code());
        assertEquals(1, ripe.living().echo().params().get("count"));

        var ch = env.harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(planted.plot().planting().id())));
        env.harvest.complete(u, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true));
        var after = env.state.state(u);
        assertEquals("MILESTONE", after.living().echo().code(), "the first wheat harvest is a milestone to see");
        env.monument.seen(u, key(), new GardenDtos.MilestonesSeenRequest(after.living().monument().unseen().stream()
                .map(GardenDtos.MilestoneView::id).toList()));
        assertEquals("REVIEW_DUE", env.state.state(u).living().echo().code());

        // five different real reviews today: the day is verified and Echo stops asking for more study
        for (int i = 0; i < 5; i++) review(u, due.get(i), env.clock.now.minus(Duration.ofSeconds(50 - i)));
        var studied = env.state.state(u);
        assertTrue(studied.living().monument().learnedToday());
        assertEquals("IDLE", studied.living().echo().code());
    }
}
