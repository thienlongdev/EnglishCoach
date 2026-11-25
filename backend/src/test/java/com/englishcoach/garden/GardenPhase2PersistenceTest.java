package com.englishcoach.garden;

import com.englishcoach.garden.api.GardenDtos;
import com.englishcoach.garden.api.GardenException;
import com.englishcoach.garden.application.LedgerService;
import com.englishcoach.garden.domain.LevelCurve;
import com.englishcoach.garden.domain.WeatherCalendar;
import com.fasterxml.jackson.databind.JsonNode;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Phase 2 on real PostgreSQL 17 + V77 + V78: Knowledge Trees (ownership, evidence, peak, essence, graduation, forest),
 * Forgotten Pests (eligibility, bounds, idempotent spawning, review-gated spray, harvest quality), skill-lesson sources,
 * Epic seeds with essence, weather in the state, isolation, concurrency and ledger reconciliation (incl. ESSENCE).
 */
class GardenPhase2PersistenceTest {

    static GardenTestEnv env;
    static LedgerService ledger;
    static final AtomicLong USERS = new AtomicLong(5000);
    static final AtomicLong WORDS = new AtomicLong();

    @BeforeAll
    static void start() {
        env = new GardenTestEnv(Instant.parse("2026-10-09T03:00:00Z")); // Thursday 10:00 Vietnam, Lữ Hành week
        ledger = new LedgerService(env.ctx);
    }

    @AfterAll
    static void stop() {
        if (env != null) env.close();
    }

    // ------------------------------------------------------------------ helpers

    static long newUser() {
        long id = USERS.incrementAndGet();
        env.jdbc.update("INSERT INTO public.users(id) VALUES (?)", id);
        env.props.getAllowlistUserIds().add(id);
        return id;
    }

    /** A garden past the tutorial at {@code level} (XP granted through the ledger so balances reconcile). */
    static long gardener(int level) {
        long u = newUser();
        env.state.state(u);
        env.jdbc.update("UPDATE public.garden_profile SET onboarding_step = 8 WHERE user_id = ?", u);
        long xp = new LevelCurve(GardenTestRules.seeded()).totalXpForLevel(level);
        if (xp > 0) ledger.addXp(u, xp, "TEST", "TEST", "setup", null, env.clock.now);
        return u;
    }

    /** One of the player's cards: {@code dueHoursAgo} null = never studied (no due date), negative = due in the future. */
    static long card(long user, String status, Double dueHoursAgo) {
        String word = "word" + WORDS.incrementAndGet();
        long de = env.jdbc.queryForObject("INSERT INTO public.dictionary_entries(word, cefr, general_translation_vi) VALUES (?, 'A2', ?) RETURNING id",
                Long.class, word, "Nghĩa của " + word);
        Timestamp due = dueHoursAgo == null ? null
                : Timestamp.valueOf(java.time.LocalDateTime.now().minusMinutes(Math.round(dueHoursAgo * 60)));
        return env.jdbc.queryForObject("""
                INSERT INTO public.flashcards(user_id, dictionary_entry_id, status, next_review_date, review_count)
                VALUES (?, ?, ?, ?, ?) RETURNING id""", Long.class, user, de, status, due, dueHoursAgo == null ? 0 : 1);
    }

    static List<Long> cards(long user, int n, String status) {
        List<Long> out = new ArrayList<>();
        for (int i = 0; i < n; i++) out.add(card(user, status, -48.0));
        return out;
    }

    /** What FlashcardService#reviewFlashcard records (the real review endpoint writes this row synchronously). */
    static void review(long user, long cardId, Instant at) {
        int n = env.jdbc.queryForObject("SELECT count(*) FROM public.learning_activity_events WHERE user_id = ? AND source_ref LIKE ?",
                Integer.class, user, cardId + ":%") + 1;
        env.jdbc.update("INSERT INTO public.learning_activity_events(user_id, activity_type, source_ref, occurred_at) VALUES (?, 'FLASHCARD_REVIEWED', ?, ?)",
                user, cardId + ":" + n, Timestamp.from(at));
    }

    static UUID key() {
        return UUID.randomUUID();
    }

    static GardenException rejected(Runnable r) {
        return assertThrows(GardenException.class, r::run);
    }

    static GardenDtos.TreeView tree(GardenDtos.State s, int slot) {
        return s.knowledge().slots().get(slot - 1).tree();
    }

    static List<Integer> answers(UUID challengeId, int wrong) throws Exception {
        JsonNode qs = env.json.readTree(env.jdbc.queryForObject("SELECT questions::text FROM public.garden_challenge WHERE id = ?", String.class, challengeId));
        List<Integer> out = new ArrayList<>();
        int i = 0;
        for (JsonNode q : qs) {
            int a = q.get("answer").asInt();
            out.add(i++ < wrong ? (a + 1) % 4 : a);
        }
        return out;
    }

    static long plotId(GardenDtos.State s, int slot) {
        return s.plots().stream().filter(p -> p.slot() == slot).findFirst().orElseThrow().id();
    }

    static void assertLedgerReconciles(long user) {
        var j = env.jdbc;
        assertEquals(j.queryForObject("SELECT coins FROM public.garden_profile WHERE user_id = ?", Long.class, user), sum(user, "COIN"));
        assertEquals(j.queryForObject("SELECT total_xp FROM public.garden_profile WHERE user_id = ?", Long.class, user), sum(user, "XP"));
        assertEquals(j.queryForObject("SELECT essence::bigint FROM public.garden_profile WHERE user_id = ?", Long.class, user), sum(user, "ESSENCE"));
        Integer orphan = j.queryForObject("""
                SELECT count(*) FROM (SELECT asset, tier, sum(delta) s FROM public.garden_ledger WHERE user_id = ? AND asset NOT IN ('COIN','XP','ESSENCE')
                GROUP BY asset, tier) l LEFT JOIN public.garden_inventory i ON i.user_id = ? AND i.item_code = l.asset AND i.tier = l.tier
                WHERE COALESCE(i.qty, 0) <> l.s""", Integer.class, user, user);
        assertEquals(0, orphan, "inventory reconciles with the ledger");
    }

    static long sum(long user, String asset) {
        return env.jdbc.queryForObject("SELECT COALESCE(sum(delta), 0) FROM public.garden_ledger WHERE user_id = ? AND asset = ?", Long.class, user, asset);
    }

    // ================================================================================ migration

    @Test
    void v78IsAdditiveAndV77IsTheAppliedFile() {
        var info = Flyway.configure().dataSource(env.ds).schemas("exams").locations("classpath:db/migration/exams").load().info();
        var v77 = java.util.Arrays.stream(info.applied()).filter(m -> "77".equals(m.getVersion().toString())).findFirst().orElseThrow();
        assertEquals(-995984783, v77.getChecksum(), "V77 is byte-identical to the migration applied in production");
        var j = env.jdbc;
        assertEquals(0, j.queryForObject("""
                SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                WHERE t.relname LIKE 'garden_%' AND c.contype = 'f' AND c.confdeltype <> 'r'""", Integer.class), "all garden FKs restrict");
        assertEquals(0, j.queryForObject("""
                SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_class r ON r.oid = c.confrelid
                WHERE t.relname LIKE 'garden_%' AND c.contype = 'f' AND r.relname = 'flashcards'""", Integer.class),
                "no Garden foreign key into the Flashcard module");
        assertEquals(5, j.queryForObject("SELECT seed_essence FROM public.garden_crop_def WHERE code = 'MOONFLOWER'", Integer.class));
        assertEquals(1, j.queryForObject("SELECT unlock_level FROM public.garden_crop_def WHERE code = 'CRYSTAL_ORCHID'", Integer.class));
    }

    // ================================================================================ Knowledge Trees

    @Test
    void plantingATreeValidatesFiveOwnedDistinctUnboundCardsAndTheSlotLevel() {
        long u = gardener(3);
        long other = gardener(3);
        List<Long> mine = cards(u, 6, "LEARNED");
        List<Long> theirs = cards(other, 1, "LEARNED");
        var five = mine.subList(0, 5);
        assertEquals("TREE_NEEDS_FIVE_CARDS", rejected(() -> env.knowledge.plant(u, key(), new GardenDtos.KnowledgePlantRequest(1, mine.subList(0, 4)))).code);
        assertEquals("TREE_NEEDS_FIVE_CARDS", rejected(() -> env.knowledge.plant(u, key(),
                new GardenDtos.KnowledgePlantRequest(1, List.of(mine.get(0), mine.get(0), mine.get(1), mine.get(2), mine.get(3))))).code);
        var foreign = new ArrayList<>(mine.subList(0, 4));
        foreign.add(theirs.getFirst());
        var e = rejected(() -> env.knowledge.plant(u, key(), new GardenDtos.KnowledgePlantRequest(1, foreign)));
        assertEquals(404, e.status, "another learner's card is indistinguishable from a missing one");
        assertEquals("SLOT_LOCKED", rejected(() -> env.knowledge.plant(u, key(), new GardenDtos.KnowledgePlantRequest(2, five))).code,
                "slot 2 opens at level 5");
        UUID k = key();
        var planted = env.knowledge.plant(u, k, new GardenDtos.KnowledgePlantRequest(1, five));
        var replay = env.knowledge.plant(u, k, new GardenDtos.KnowledgePlantRequest(1, five));
        assertEquals(planted.treeId(), replay.treeId(), "a retried request plants once");
        assertEquals(1, env.jdbc.queryForObject("SELECT count(*) FROM public.garden_knowledge_tree WHERE user_id = ?", Integer.class, u));
        var t = tree(env.state.state(u), 1);
        assertEquals(com.englishcoach.garden.application.KnowledgeService.species(
                new com.englishcoach.garden.domain.GardenCalendar(GardenTestRules.seeded()).theme(env.clock.now)), t.species(),
                "the species is the season (theme week) it was planted in");
        assertEquals(5, t.cards().size());
        assertEquals(1, t.stage());
        assertEquals("SLOT_OCCUPIED", rejected(() -> env.knowledge.plant(u, key(), new GardenDtos.KnowledgePlantRequest(1, mine.subList(1, 6)))).code);
        // a bound card cannot join a second growing tree (application check + partial unique index)
        ledger.addXp(u, new LevelCurve(GardenTestRules.seeded()).totalXpForLevel(5), "TEST", "TEST", "lvl5", null, env.clock.now);
        assertEquals("CARD_BOUND", rejected(() -> env.knowledge.plant(u, key(), new GardenDtos.KnowledgePlantRequest(2, mine.subList(1, 6)))).code);
        long rogue = env.jdbc.queryForObject("""
                INSERT INTO public.garden_knowledge_tree(user_id, slot, species, planted_at, essence_since)
                VALUES (?, 3, 'SPRING', now(), now()) RETURNING id""", Long.class, u);
        assertThrows(Exception.class, () -> env.jdbc.update("""
                INSERT INTO public.garden_knowledge_card(tree_id, user_id, position, flashcard_id, word, meaning_vi)
                VALUES (?, ?, 1, ?, 'x', 'y')""", rogue, u, mine.get(1)), "the partial unique index refuses a second binding");
        assertEquals(404, rejected(() -> env.knowledge.claimEssence(other, key(), planted.treeId())).status, "other learners never see my tree");
        assertEquals(404, rejected(() -> env.knowledge.release(other, key(), planted.treeId())).status);
        assertLedgerReconciles(u);
    }

    @Test
    void stageFollowsDistinctReviewDaysAfterPlantingAndThePeakNeverDrops() {
        long u = gardener(3);
        List<Long> five = cards(u, 5, "LEARNED");
        long beforePlant = five.getFirst();
        review(u, beforePlant, env.clock.now.minus(Duration.ofHours(1))); // before planting: no evidence
        long treeId = env.knowledge.plant(u, key(), new GardenDtos.KnowledgePlantRequest(1, five)).treeId();
        assertEquals(0, tree(env.state.state(u), 1).evidence());
        for (int day = 0; day < 3; day++) {
            for (long c : five) {
                review(u, c, env.clock.now.plusSeconds(60));
                review(u, c, env.clock.now.plusSeconds(120)); // a second review the same day adds no evidence
            }
            env.clock.advance(Duration.ofDays(day == 2 ? 6 : 1));
        }
        var t = tree(env.state.state(u), 1);
        assertEquals(15, t.evidence(), "5 cards × 3 distinct days");
        assertEquals(3, t.stage(), "the final stage also needs 9 days of age (8 so far)");
        assertEquals(4, t.next().stage());
        env.clock.advance(Duration.ofDays(1));
        assertEquals(4, tree(env.state.state(u), 1).stage());
        // a word falls overdue: health drops, the highest stage reached stays
        env.jdbc.update("UPDATE public.flashcards SET next_review_date = LOCALTIMESTAMP - interval '30 hours' WHERE id = ?", five.get(1));
        var sick = tree(env.state.state(u), 1);
        assertEquals(4, sick.stage());
        assertEquals("THIRSTY", sick.health());
        assertTrue(sick.cards().get(1).needsAttention());
        assertEquals(4, env.jdbc.queryForObject("SELECT peak_stage FROM public.garden_knowledge_tree WHERE id = ?", Integer.class, treeId));
    }

    @Test
    void reviewsDoneWhileAwayFromTheGardenStillGrowTheTreeAndWeakenItsPest() {
        long u = gardener(3);
        List<Long> five = cards(u, 5, "LEARNED");
        env.knowledge.plant(u, key(), new GardenDtos.KnowledgePlantRequest(1, five));
        env.jdbc.update("UPDATE public.flashcards SET next_review_date = LOCALTIMESTAMP - interval '30 hours' WHERE id = ?", five.get(4));
        var pest = env.state.state(u).pests().stream().filter(p -> "TREE".equals(p.host())).findFirst().orElseThrow();
        assertFalse(pest.reviewed());
        // the learner studies in the Flashcard screen on three days and opens the garden only a week later,
        // beyond the garden's few-days reward lookback: the review log is still the tree's evidence
        for (int day = 0; day < 3; day++) {
            env.clock.advance(Duration.ofDays(1));
            for (long c : five) review(u, c, env.clock.now);
        }
        env.jdbc.update("UPDATE public.flashcards SET next_review_date = LOCALTIMESTAMP + interval '3 days' WHERE id = ?", five.get(4));
        env.clock.advance(Duration.ofDays(5));
        var s = env.state.state(u);
        assertEquals(15, tree(s, 1).evidence(), "5 cards × 3 distinct days, read from the Flashcard review log");
        assertTrue(s.pests().stream().filter(p -> p.id() == pest.id()).allMatch(GardenDtos.PestView::reviewed),
                "a review done while away weakens the pest");
    }

    @Test
    void essenceAccruesFromServerTimeIsClaimedOnceAndOnlyWhileTheTreeIsHealthy() throws Exception {
        long u = gardener(3);
        List<Long> five = cards(u, 5, "LEARNED");
        long treeId = env.knowledge.plant(u, key(), new GardenDtos.KnowledgePlantRequest(1, five)).treeId();
        for (long c : five) review(u, c, env.clock.now.plusSeconds(30));
        env.clock.advance(Duration.ofDays(1).plusMinutes(5));
        var t = tree(env.state.state(u), 1);
        assertEquals(2, t.stage(), "5 evidence, 1 day");
        assertEquals("ESSENCE_NOT_READY", rejected(() -> env.knowledge.claimEssence(u, key(), treeId)).code, "stage 2 just began");
        env.clock.advance(Duration.ofDays(2));
        assertEquals(1, tree(env.state.state(u), 1).essence().available(), "0.5 / day × 2 days");
        // a card becomes overdue: the tree needs care, essence waits (nothing is lost)
        env.jdbc.update("UPDATE public.flashcards SET next_review_date = LOCALTIMESTAMP - interval '30 hours' WHERE id = ?", five.getFirst());
        var sick = tree(env.state.state(u), 1);
        assertEquals("THIRSTY", sick.health());
        assertFalse(sick.essence().claimable());
        assertEquals("TREE_NEEDS_CARE", rejected(() -> env.knowledge.claimEssence(u, key(), treeId)).code);
        env.jdbc.update("UPDATE public.flashcards SET next_review_date = LOCALTIMESTAMP + interval '3 days' WHERE id = ?", five.getFirst());
        review(u, five.getFirst(), env.clock.now);
        env.clock.advance(Duration.ofMinutes(1));
        // tree pest of that card is weakened by the review; spray it so the tree is fully healthy
        var pests = env.state.state(u).pests();
        for (var p : pests) env.pests.spray(u, key(), p.id());
        UUID k = key();
        var claimed = env.knowledge.claimEssence(u, k, treeId);
        assertEquals(1, claimed.claimed());
        assertEquals(1, claimed.essence());
        assertEquals(claimed.essence(), env.knowledge.claimEssence(u, k, treeId).essence(), "replay never pays twice");
        assertEquals("ESSENCE_NOT_READY", rejected(() -> env.knowledge.claimEssence(u, key(), treeId)).code);
        // concurrent claims after more time: exactly one succeeds
        env.clock.advance(Duration.ofDays(2));
        ExecutorService pool = Executors.newFixedThreadPool(6);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<String>> fs = new ArrayList<>();
        for (int i = 0; i < 6; i++) fs.add(pool.submit(() -> {
            go.await();
            try {
                return "OK:" + env.knowledge.claimEssence(u, key(), treeId).claimed();
            } catch (GardenException ex) {
                return ex.code;
            }
        }));
        go.countDown();
        List<String> codes = new ArrayList<>();
        for (var f : fs) codes.add(f.get());
        pool.shutdown();
        assertEquals(1, codes.stream().filter(c -> c.startsWith("OK")).count(), codes.toString());
        assertLedgerReconciles(u);
    }

    @Test
    void graduationNeedsFourteenDaysEvidenceAndFourOfFiveAndPaysExactlyOnce() throws Exception {
        long u = gardener(3);
        List<Long> five = cards(u, 5, "LEARNED");
        long treeId = env.knowledge.plant(u, key(), new GardenDtos.KnowledgePlantRequest(1, five)).treeId();
        assertEquals("GRADUATION_NOT_READY", rejected(() -> env.knowledge.graduationStart(u, key(), treeId)).code);
        for (int day = 0; day < 3; day++) {
            for (long c : five) review(u, c, env.clock.now.plusSeconds(30));
            env.clock.advance(Duration.ofDays(5));
        }
        var ready = tree(env.state.state(u), 1);
        assertTrue(ready.graduation().eligible(), ready.graduation().blockers().toString());
        var ch = env.knowledge.graduationStart(u, key(), treeId);
        assertEquals(5, ch.questions().size());
        assertFalse(env.json.writeValueAsString(ch).contains("\"answer\""), "answers stay on the server");
        // three right: not enough, the tree stays and rests
        var fail = env.knowledge.graduationComplete(u, key(), new GardenDtos.GraduationCompleteRequest(ch.challengeId(), answers(ch.challengeId(), 2)));
        assertFalse(fail.passed());
        assertEquals(3, fail.recall().correct());
        assertNotNull(fail.retryAt());
        assertEquals(0, fail.xpGained());
        assertEquals("ACTIVE", env.jdbc.queryForObject("SELECT status FROM public.garden_knowledge_tree WHERE id = ?", String.class, treeId));
        var blocked = rejected(() -> env.knowledge.graduationStart(u, key(), treeId));
        assertEquals("GRADUATION_NOT_READY", blocked.code);
        assertTrue(blocked.details.get("blockers").toString().contains("RETRY_WAIT"));
        env.clock.advance(Duration.ofMinutes(31));
        var ch2 = env.knowledge.graduationStart(u, key(), treeId);
        long xpBefore = env.state.state(u).profile().totalXp();
        UUID done = key();
        var pass = env.knowledge.graduationComplete(u, done, new GardenDtos.GraduationCompleteRequest(ch2.challengeId(), answers(ch2.challengeId(), 1)));
        assertTrue(pass.passed());
        assertEquals(4, pass.recall().correct());
        assertEquals(120, pass.xpGained());
        assertEquals(5, pass.essenceGained());
        assertEquals(env.json.writeValueAsString(pass), env.json.writeValueAsString(env.knowledge.graduationComplete(u, done,
                new GardenDtos.GraduationCompleteRequest(ch2.challengeId(), answers(ch2.challengeId(), 1)))), "replay");
        var allRight = answers(ch2.challengeId(), 0);
        assertEquals("CHALLENGE_DONE", rejected(() -> env.knowledge.graduationComplete(u, key(),
                new GardenDtos.GraduationCompleteRequest(ch2.challengeId(), allRight))).code);
        var after = env.state.state(u);
        assertEquals(xpBefore + 120, after.profile().totalXp(), "graduation XP once");
        assertNull(tree(after, 1), "the sacred spot is free again");
        assertEquals(1, after.knowledge().forestCount());
        String species = after.knowledge().forestRecent().getFirst().species();
        assertEquals(1, after.knowledge().forestSpecies().get(species), "the forest keeps the season the tree was planted in");
        assertEquals(5, after.knowledge().forestRecent().getFirst().words().size());
        assertEquals(1, after.inventory().seeds().stream().filter(s -> s.cropCode().equals("CRYSTAL_ORCHID")).findFirst().orElseThrow().qty());
        assertEquals(0, env.jdbc.queryForObject("SELECT count(*) FROM public.garden_knowledge_card WHERE tree_id = ? AND released_at IS NULL", Integer.class, treeId));
        var page = env.knowledge.forest(u, null);
        assertEquals(1, page.total());
        assertNull(page.nextBefore());
        // the five words can grow a new tree now
        env.knowledge.plant(u, key(), new GardenDtos.KnowledgePlantRequest(1, five));
        assertEquals(1, tree(env.state.state(u), 1).stage());
        assertLedgerReconciles(u);
    }

    // ================================================================================ Forgotten Pests

    @Test
    void pestsAppearOnlyForGenuinelyOverdueCardsAreBoundedAndNeverDuplicated() {
        long u = gardener(2);
        var s = env.state.state(u);
        for (int slot = 1; slot <= 3; slot++) env.planting.plant(u, key(), plotId(s, slot), new GardenDtos.PlantRequest("CORN"));
        env.clock.advance(Duration.ofMinutes(40)); // past the 30-minute protection
        card(u, "MASTERED", 72.0);            // MASTERED never comes due in the Flashcard scheduler
        card(u, "LEARNED", 23.0);             // due, but inside the grace day
        card(u, "NEW", null);                 // never studied
        assertTrue(env.state.state(u).pests().isEmpty());
        long a = card(u, "LEARNED", 30.0);
        long b = card(u, "LEARNED", 40.0);
        long c = card(u, "LEARNED", 50.0);
        var first = env.state.state(u);
        assertEquals(2, first.pests().size(), "at most two crop pests");
        assertEquals(List.of(c, b), first.pests().stream().map(GardenDtos.PestView::flashcardId).toList(), "most overdue first");
        assertTrue(first.pests().stream().allMatch(p -> "CROP".equals(p.host()) && p.plotSlot() != null));
        for (int i = 0; i < 3; i++) env.state.state(u);
        assertEquals(2, env.jdbc.queryForObject("SELECT count(*) FROM public.garden_pest WHERE user_id = ?", Integer.class, u),
                "repeated reads never spawn duplicates");
        assertThrows(Exception.class, () -> env.jdbc.update("""
                INSERT INTO public.garden_pest(user_id, flashcard_id, word, host, planting_id, spawned_at)
                SELECT user_id, flashcard_id, 'x', 'CROP', planting_id, now() FROM public.garden_pest WHERE user_id = ? LIMIT 1""", u),
                "one active pest per card");
        assertTrue(a > 0);
    }

    @Test
    void sprayNeedsAGenuineReviewPaysOnceAndAReviewedPestHarvestsClean() throws Exception {
        long u = gardener(2);
        var s = env.state.state(u);
        env.planting.plant(u, key(), plotId(s, 6), new GardenDtos.PlantRequest("WHEAT")); // the tutorial crop never hosts pests
        long infested = env.planting.plant(u, key(), plotId(s, 1), new GardenDtos.PlantRequest("WHEAT")).plot().planting().id();
        long control = env.planting.plant(u, key(), plotId(s, 2), new GardenDtos.PlantRequest("WHEAT")).plot().planting().id();
        env.clock.advance(Duration.ofMinutes(35));
        long word = card(u, "LEARNED", 30.0);
        var warning = env.state.state(u).pests().getFirst();
        assertEquals(infested, warning.plantingId());
        // Phase 3C (V83): a pest first only warns; leaf damage (and the slowdown) starts six hours later
        assertEquals(1, warning.stage());
        assertFalse(warning.slowing(), "a warning costs nothing");
        env.clock.advance(Duration.ofHours(7));
        var pest = env.state.state(u).pests().getFirst();
        assertEquals(2, pest.stage());
        assertTrue(pest.slowing(), "an unreviewed crop pest slows growth once the leaves are damaged");
        assertEquals("PEST_NEEDS_REVIEW", rejected(() -> env.pests.spray(u, key(), pest.id())).code, "no cure without learning");
        long other = gardener(2);
        assertEquals(404, rejected(() -> env.pests.spray(other, key(), pest.id())).status);
        // the learner reviews the word through the real Flashcard endpoint (it writes the review log row)
        review(u, word, env.clock.now);
        env.jdbc.update("UPDATE public.flashcards SET next_review_date = LOCALTIMESTAMP + interval '3 days' WHERE id = ?", word);
        env.clock.advance(Duration.ofSeconds(30));
        // Phase 4: the genuine review is the whole cure; the command the garden sends after it confirms and pays once
        UUID k = key();
        var sprayed = env.pests.spray(u, k, pest.id());
        assertTrue(sprayed.rewarded());
        assertEquals(5, sprayed.xp());
        assertEquals(sprayed.totalXp(), env.pests.spray(u, k, pest.id()).totalXp(), "replay");
        assertEquals("PEST_GONE", rejected(() -> env.pests.spray(u, key(), pest.id())).code);
        assertTrue(env.state.state(u).pests().isEmpty(), "the pest left with the review");
        assertEquals(5L, env.jdbc.queryForObject("SELECT COALESCE(sum(delta), 0) FROM public.garden_ledger WHERE user_id = ? AND reason = 'PEST_CURE'",
                Long.class, u), "cure XP exactly once");
        assertThrows(Exception.class, () -> env.jdbc.update("UPDATE public.garden_pest SET cleared_at = now(), clear_reason = 'SPRAYED', reviewed_at = NULL WHERE id = ?", pest.id()),
                "the database refuses a spray without review evidence");
        // both wheat crops ripen; the reviewed one harvests clean
        env.clock.advance(Duration.ofHours(1));
        var ch = env.harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(infested, control)));
        var res = env.harvest.complete(u, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true));
        assertTrue(res.harvests().stream().allMatch(h -> h.components().pest() == 25), res.harvests().toString());
        assertLedgerReconciles(u);
    }

    @Test
    void anUnreviewedPestLowersTheHarvestAndLeavesWithTheCrop() {
        long u = gardener(2);
        var s = env.state.state(u);
        long pid = env.planting.plant(u, key(), plotId(s, 1), new GardenDtos.PlantRequest("TOMATO")).plot().planting().id();
        env.clock.advance(Duration.ofMinutes(31));
        card(u, "LEARNED", 30.0);
        assertEquals(1, env.state.state(u).pests().size());
        env.clock.advance(Duration.ofHours(7)); // past the six-hour warning (Phase 3C): the leaves are damaged
        var ch = env.harvest.start(u, key(), new GardenDtos.HarvestStartRequest(List.of(pid)));
        var res = env.harvest.complete(u, key(), new GardenDtos.HarvestCompleteRequest(ch.challengeId(), List.of(), true));
        assertEquals(10, res.harvests().getFirst().components().pest(), "leaf damage = pestLate");
        assertEquals("HOST_GONE", env.jdbc.queryForObject("SELECT clear_reason FROM public.garden_pest WHERE planting_id = ?", String.class, pid));
        assertTrue(env.state.state(u).pests().isEmpty() || env.state.state(u).pests().stream().noneMatch(p -> p.plantingId() == pid));
    }

    @Test
    void anOverdueTreeWordBecomesATreePestAndBlocksGraduationUntilReviewed() {
        long u = gardener(3);
        List<Long> five = cards(u, 5, "LEARNED");
        long treeId = env.knowledge.plant(u, key(), new GardenDtos.KnowledgePlantRequest(1, five)).treeId();
        env.jdbc.update("UPDATE public.flashcards SET next_review_date = LOCALTIMESTAMP - interval '26 hours' WHERE id = ?", five.get(2));
        var s = env.state.state(u);
        var pest = s.pests().stream().filter(p -> "TREE".equals(p.host())).findFirst().orElseThrow();
        assertEquals(treeId, pest.treeId());
        assertEquals(five.get(2), pest.flashcardId());
        var t = tree(s, 1);
        assertTrue(t.graduation().blockers().contains("PEST"));
        assertTrue(t.cards().get(2).needsAttention());
        // releasing the tree clears its pest (nothing lingers on an empty spot)
        env.knowledge.release(u, key(), treeId);
        assertTrue(env.state.state(u).pests().stream().noneMatch(p -> "TREE".equals(p.host())));
    }

    // ================================================================================ learning sources

    @Test
    void endedDictationSessionsAndCardBlastRunsAreCreditedOnceWithinDailyCaps() {
        long u = gardener(1);
        var before = env.state.state(u);
        int fert0 = before.inventory().fertilizer();
        long xp0 = before.profile().totalXp();
        java.time.LocalDateTime local = java.time.LocalDateTime.ofInstant(env.clock.now, java.time.ZoneId.systemDefault());
        // a session that ended BEFORE the garden existed earns nothing
        long old = env.jdbc.queryForObject("INSERT INTO public.listening_sessions(user_id, started_at, ended_at) VALUES (?, ?, ?) RETURNING id",
                Long.class, u, Timestamp.valueOf(local.minusDays(1)), Timestamp.valueOf(local.minusDays(1)));
        for (int i = 0; i < 3; i++) env.jdbc.update("INSERT INTO public.exercise_attempts(listening_session_id, accuracy_percentage) VALUES (?, 90)", old);
        // four ended sessions with 3 attempts + one with only 2 attempts (not a lesson)
        for (int sIdx = 0; sIdx < 5; sIdx++) {
            long sid = env.jdbc.queryForObject("INSERT INTO public.listening_sessions(user_id, started_at, ended_at) VALUES (?, ?, ?) RETURNING id",
                    Long.class, u, Timestamp.valueOf(local.plusMinutes(sIdx)), Timestamp.valueOf(local.plusMinutes(sIdx + 1)));
            for (int i = 0; i < (sIdx == 4 ? 2 : 3); i++) env.jdbc.update("INSERT INTO public.exercise_attempts(listening_session_id, accuracy_percentage) VALUES (?, 80)", sid);
        }
        env.jdbc.update("INSERT INTO public.card_blast_runs(user_id, score, created_at) VALUES (?, 240, ?), (?, 60, ?)",
                u, Timestamp.from(env.clock.now.plusSeconds(400)), u, Timestamp.from(env.clock.now.plusSeconds(500)));
        env.clock.advance(Duration.ofMinutes(10));
        var s = env.state.state(u);
        assertEquals(3, s.learning().skillsToday(), "4 lessons, daily cap 3");
        assertEquals(1, s.learning().gamesToday(), "the 60-point run is below the threshold");
        assertEquals(fert0 + 2, s.inventory().fertilizer(), "the first two lessons of the day bring fertilizer");
        assertEquals(xp0 + 3 * 30 + 5, s.profile().totalXp());
        var again = env.state.state(u);
        assertEquals(s.profile().totalXp(), again.profile().totalXp(), "never credited twice");
        assertEquals(1, env.jdbc.queryForObject("SELECT count(*) FROM public.garden_learning_event WHERE user_id = ? AND source = 'DICTATION' AND units = 0", Integer.class, u),
                "the fourth lesson is recorded without reward");
        assertTrue(s.rewards().lessons() >= 4);
        assertLedgerReconciles(u);
    }

    @Test
    void tenCardsPlusOneSkillLessonReachTheMixedGoal() {
        long u = gardener(1);
        card(u, "LEARNED", 1.0); // a due card keeps the due-queue variant out of this test
        env.state.state(u);
        env.clock.advance(Duration.ofMinutes(1));
        for (int i = 0; i < 10; i++) review(u, 90_000 + i, env.clock.now.plusSeconds(i));
        var s1 = env.state.state(u);
        assertFalse(s1.today().goal().done());
        java.time.LocalDateTime local = java.time.LocalDateTime.ofInstant(env.clock.now, java.time.ZoneId.systemDefault());
        long sid = env.jdbc.queryForObject("INSERT INTO public.listening_sessions(user_id, started_at, ended_at) VALUES (?, ?, ?) RETURNING id",
                Long.class, u, Timestamp.valueOf(local), Timestamp.valueOf(local.plusSeconds(20)));
        for (int i = 0; i < 3; i++) env.jdbc.update("INSERT INTO public.exercise_attempts(listening_session_id, accuracy_percentage) VALUES (?, 80)", sid);
        env.clock.advance(Duration.ofMinutes(1));
        var s2 = env.state.state(u);
        assertTrue(s2.today().goal().done());
        assertTrue(s2.today().blessing());
        assertEquals(1, env.jdbc.queryForObject("SELECT count(*) FROM public.garden_event_log WHERE user_id = ? AND type = 'BLESSING'", Integer.class, u));
        env.state.state(u);
        assertEquals(1, env.jdbc.queryForObject("SELECT count(*) FROM public.garden_ledger WHERE user_id = ? AND reason = 'GOAL'", Integer.class, u),
                "goal XP once");
        assertLedgerReconciles(u);
    }

    @Test
    void aMissingLearningModuleNeverBreaksTheGarden() {
        // WRITING / SHADOWING / EXAM / WORD_CHAIN tables do not exist in this fixture: those sources are skipped
        long u = gardener(1);
        assertNotNull(env.state.state(u).learning());
        assertEquals(4, env.state.state(u).learning().sources().stream().filter(x -> !x.enabled()).count(),
                "Reading, Role-play, Listening watch and Card Blast PvP stay disabled");
    }

    // ================================================================================ economy, weather

    @Test
    void epicSeedsCostEssenceAndCoinsTogetherOrNothing() {
        long u = gardener(10);
        var s = env.state.state(u);
        long coins = s.profile().coins();
        var e = rejected(() -> env.planting.plant(u, key(), plotId(s, 1), new GardenDtos.PlantRequest("MOONFLOWER")));
        assertEquals("INSUFFICIENT_ESSENCE", e.code);
        assertEquals(coins, env.state.state(u).profile().coins(), "no coins taken");
        ledger.addEssence(u, 6, "TEST", "TEST", "setup", null, env.clock.now);
        var planted = env.planting.plant(u, key(), plotId(s, 1), new GardenDtos.PlantRequest("MOONFLOWER"));
        assertEquals(180, planted.coinsPaid());
        assertEquals(1, env.state.state(u).profile().essence());
        assertEquals("NO_SEED", rejected(() -> env.planting.plant(u, key(), plotId(s, 2), new GardenDtos.PlantRequest("CRYSTAL_ORCHID"))).code,
                "the legendary seed is never sold");
        assertLedgerReconciles(u);
    }

    @Test
    void theStateCarriesTheGlobalSeasonAndTheDeterministicForecast() {
        long u = gardener(1);
        long v = gardener(1);
        var a = env.state.state(u).world();
        var b = env.state.state(v).world();
        assertEquals(a, b, "every player sees the same season and weather at the same moment");
        var calendar = new com.englishcoach.garden.domain.GardenCalendar(GardenTestRules.seeded());
        assertEquals(calendar.theme(env.clock.now).name(), a.theme());
        assertEquals(calendar.theme(calendar.themeEndsAt(env.clock.now)).name(), a.nextTheme());
        assertEquals(calendar.themeEndsAt(env.clock.now), a.themeEndsAt());
        var weather = new WeatherCalendar(GardenTestRules.seeded());
        assertEquals(weather.at(env.clock.now).name(), a.weather().kind());
        assertEquals(4, a.forecast().size());
        assertTrue(a.forecast().stream().skip(1).noneMatch(w -> "RAINBOW".equals(w.kind())), "a coming rainbow is never forecast");
    }
}
