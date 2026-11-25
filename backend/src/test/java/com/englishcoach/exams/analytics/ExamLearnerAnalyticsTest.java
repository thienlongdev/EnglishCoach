package com.englishcoach.exams.analytics;

import com.englishcoach.exams.analytics.ExamAnalyticsRecords.*;
import com.englishcoach.exams.analytics.ExamLearnerAnalytics.*;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Exams Phase 8 — pure analytics / mistake / recommendation policy (no database, no Spring). Synthetic facts only (ids,
 * outcomes — no exam text). Numbers in the display names refer to the Phase 8 required test matrix.
 */
class ExamLearnerAnalyticsTest {

    static final Instant NOW = Instant.parse("2026-10-04T10:00:00Z");
    static final UUID FORM_A = UUID.fromString("00000000-0000-0000-0000-00000000000a");
    static final UUID FORM_B = UUID.fromString("00000000-0000-0000-0000-00000000000b");
    static final ObjectMapper MAPPER = new ObjectMapper().findAndRegisterModules();
    static int seq = 0;

    static UUID id() {
        return UUID.nameUUIDFromBytes(("a" + (seq++)).getBytes());
    }

    /** n items of one scope; outcome per index from the pattern string: C correct, I incorrect, U unanswered, N unkeyed. */
    static PracticeAttemptFacts toeic(int part, UUID form, Instant at, String pattern) {
        List<ItemOutcome> items = new ArrayList<>();
        for (int i = 0; i < pattern.length(); i++) {
            Outcome o = switch (pattern.charAt(i)) {
                case 'C' -> Outcome.CORRECT;
                case 'I' -> Outcome.INCORRECT;
                case 'U' -> Outcome.UNANSWERED;
                default -> Outcome.NOT_SCORED;
            };
            items.add(new ItemOutcome(UUID.nameUUIDFromBytes((key(form, part, i)).getBytes()), key(form, part, i), 1,
                    part * 100 + i, "SINGLE_CHOICE", o));
        }
        SkillType skill = part <= 4 ? SkillType.LISTENING : SkillType.READING;
        return new PracticeAttemptFacts(id(), ExamFamily.TOEIC, "TOEIC_PART_" + part, "TOEIC_PART", skill, part, form,
                "Test " + form.toString().substring(35), true, at.minusSeconds(600), at, items, null, null);
    }

    static PracticeAttemptFacts writing(int task, Instant at, int words, Integer min) {
        return new PracticeAttemptFacts(id(), ExamFamily.IELTS, "IELTS_WRITING_TASK_" + task, "IELTS_WRITING_TASK",
                SkillType.WRITING, task, FORM_A, "IELTS A", false, at.minusSeconds(1200), at, List.of(), words, min);
    }

    /** Logical item key of the synthetic item i of a part on a form (different forms ⇒ different items). */
    static String key(UUID form, int part, int i) {
        return "F" + form.toString().substring(35) + "_P" + part + "_Q" + i;
    }

    static AvailableScope avail(int part, UUID form) {
        return new AvailableScope("TOEIC_PART_" + part, "TOEIC_PART", part <= 4 ? SkillType.LISTENING : SkillType.READING,
                part, form, "Test " + form.toString().substring(35), true);
    }

    static Instant daysAgo(int d) {
        return NOW.minus(d, ChronoUnit.DAYS);
    }

    static String repeat(String s, int n) {
        return s.repeat(n);
    }

    static ScopeStatsDto scope(FamilyAnalyticsDto f, String code) {
        return f.scopes().stream().filter(s -> s.scopeCode().equals(code)).findFirst().orElseThrow();
    }

    static FamilyAnalyticsDto compute(List<PracticeAttemptFacts> p, List<AvailableScope> a) {
        return ExamLearnerAnalytics.compute(ExamFamily.TOEIC, p, List.of(), a, NOW);
    }

    // ─── 8A ──────────────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("01/03/13/14/15: practice counts are raw; unanswered counted; attempt + sample counts exact")
    void practiceRawCounts() {
        FamilyAnalyticsDto f = compute(List.of(toeic(5, FORM_A, daysAgo(3), "CCCIIU"), toeic(5, FORM_A, daysAgo(2), "CCCCUN")),
                List.of());
        ScopeStatsDto s = scope(f, "TOEIC_PART_5");
        assertEquals(2, s.attempts());
        assertEquals(11, s.questions(), "unkeyed item excluded");
        assertEquals(7, s.correct());
        assertEquals(2, s.incorrect());
        assertEquals(2, s.unanswered());
        assertEquals(9, s.answered());
        assertEquals(63.6, s.rawAccuracyPercent());
        assertEquals(2, f.practice().attempts());
        assertEquals(11, f.practice().questions());
        assertEquals(1200L, s.timeSpentSeconds(), "server timestamps only");
        assertNotNull(s.trend(), "≥ 2 attempts ⇒ trend");
        assertEquals(2, s.trend().size());
    }

    @Test
    @DisplayName("04/05: practice analytics JSON never carries a TOEIC scale, an IELTS band or a standardized score")
    void noStandardizedPracticeScore() throws Exception {
        FamilyAnalyticsDto f = compute(List.of(toeic(5, FORM_A, daysAgo(1), repeat("C", 30))), List.of(avail(5, FORM_A)));
        String json = MAPPER.writeValueAsString(f.practice()) + MAPPER.writeValueAsString(f.scopes());
        for (String forbidden : List.of("scaled", "band", "Band", "TOEIC_SCALE", "IELTS_BAND", "estimated", "mastery", "cefr")) {
            assertFalse(json.contains(forbidden), "practice analytics must not contain " + forbidden);
        }
    }

    @Test
    @DisplayName("02/06/07: simulations are a separate block; components only when the scorer persisted them")
    void simulationSeparate() {
        SimulationAttemptDto scored = new SimulationAttemptDto(id(), FORM_A, "Full A", "LR", "FULL", daysAgo(1), 7200L,
                "COMPLETED", List.of(new ComponentDto("LR_TOTAL", 750, "TOEIC_SCALE", 150.0)), List.of());
        SimulationAttemptDto partial = new SimulationAttemptDto(id(), FORM_B, "Full B", "LR", "FULL", daysAgo(2), 3600L,
                "PARTIAL", List.of(), List.of(new RawSectionDto("READING", 40, 54, 74.1, "UNSCALED_PARTIAL")));
        FamilyAnalyticsDto f = ExamLearnerAnalytics.compute(ExamFamily.TOEIC, List.of(toeic(5, FORM_A, daysAgo(1), "CCCC")),
                List.of(scored, partial), List.of(), NOW);
        assertEquals(2, f.simulation().submitted());
        assertEquals(1, f.simulation().withStandardizedScore(), "incomplete simulation fabricates no score");
        assertTrue(f.simulation().attempts().get(1).components().isEmpty());
        assertEquals(1, f.practice().attempts(), "simulation never counted as practice");
        assertEquals(4, f.practice().questions());
    }

    @Test
    @DisplayName("08: TOEIC Part grouping is by the pinned scope code, canonical order Part 1 → 7")
    void toeicGrouping() {
        FamilyAnalyticsDto f = compute(List.of(toeic(7, FORM_A, daysAgo(1), "CC"), toeic(2, FORM_A, daysAgo(1), "CI"),
                toeic(5, FORM_A, daysAgo(1), "C"), toeic(2, FORM_B, daysAgo(2), "II")), List.of());
        assertEquals(List.of("TOEIC_PART_2", "TOEIC_PART_5", "TOEIC_PART_7"),
                f.scopes().stream().map(ScopeStatsDto::scopeCode).toList(), "only practised scopes, canonical order");
        assertEquals(2, scope(f, "TOEIC_PART_2").attempts(), "two forms, one canonical scope");
    }

    @Test
    @DisplayName("09/10: IELTS scopes grouped; writing counted (attempts, words, minimum met) but never scored")
    void ieltsWritingNotScored() throws Exception {
        PracticeAttemptFacts l1 = new PracticeAttemptFacts(id(), ExamFamily.IELTS, "IELTS_LISTENING_SECTION_1",
                "IELTS_LISTENING_SECTION", SkillType.LISTENING, 1, FORM_A, "IELTS A", true, daysAgo(1).minusSeconds(60),
                daysAgo(1), List.of(new ItemOutcome(id(), "L1", 1, 1, "TEXT_GAP", Outcome.CORRECT)), null, null);
        FamilyAnalyticsDto f = ExamLearnerAnalytics.compute(ExamFamily.IELTS,
                List.of(l1, writing(2, daysAgo(3), 230, 250), writing(2, daysAgo(1), 270, 250), writing(1, daysAgo(1), 160, 150)),
                List.of(), List.of(), NOW);
        assertEquals(List.of("IELTS_LISTENING_SECTION_1", "IELTS_WRITING_TASK_1", "IELTS_WRITING_TASK_2"),
                f.scopes().stream().map(ScopeStatsDto::scopeCode).toList());
        ScopeStatsDto w2 = scope(f, "IELTS_WRITING_TASK_2");
        assertFalse(w2.objective());
        assertEquals("NOT_APPLICABLE", w2.signal());
        assertNull(w2.rawAccuracyPercent(), "no writing quality / accuracy");
        assertEquals(2, w2.writing().submitted());
        assertEquals(270, w2.writing().lastWordCount());
        assertEquals(250, w2.writing().averageWordCount());
        assertEquals(1, w2.writing().metMinimumCount());
        assertEquals("NOT_SCORED", w2.writing().assessment());
        assertEquals(3, f.practice().writingAttempts());
        String json = MAPPER.writeValueAsString(w2);
        assertFalse(json.contains("band") || json.contains("strong") || json.contains("weak"));
        assertTrue(f.recommendations().items().stream().allMatch(r -> !"FOCUS".equals(r.kind())));
    }

    @Test
    @DisplayName("sample sufficiency: < 10 ⇒ INSUFFICIENT, ≥ 10 ⇒ EMERGING, ≥ 30 + 2 attempts ⇒ ESTABLISHED; stale data ⇒ insufficient")
    void sampleSufficiency() {
        assertEquals("INSUFFICIENT_DATA", scope(compute(List.of(toeic(5, FORM_A, daysAgo(1), "IIIIIIIII")), List.of()),
                "TOEIC_PART_5").signal(), "9 questions is not a signal, even all wrong");
        assertEquals("EMERGING_SIGNAL", scope(compute(List.of(toeic(5, FORM_A, daysAgo(1), repeat("C", 30))), List.of()),
                "TOEIC_PART_5").signal(), "one attempt is never established");
        assertEquals("ESTABLISHED_SIGNAL", scope(compute(List.of(toeic(5, FORM_A, daysAgo(2), repeat("C", 15)),
                toeic(5, FORM_A, daysAgo(1), repeat("C", 15))), List.of()), "TOEIC_PART_5").signal());
        ScopeStatsDto stale = scope(compute(List.of(toeic(5, FORM_A, daysAgo(100), repeat("I", 30)),
                toeic(5, FORM_A, daysAgo(90), repeat("I", 30))), List.of()), "TOEIC_PART_5");
        assertEquals("INSUFFICIENT_DATA", stale.signal(), "older than the recency window ⇒ no current signal");
        assertEquals(60, stale.questions(), "history stays visible");
    }

    // ─── 8B ──────────────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("17/18/19/20: wrong once / repeated / corrected later; identity = logical key + version")
    void mistakes() {
        // item 0: I, I (repeated) · item 1: I, C (improved) · item 2: C, U (single) · item 3: C, C (none)
        FamilyAnalyticsDto f = compute(List.of(toeic(5, FORM_A, daysAgo(3), "IICC"), toeic(5, FORM_A, daysAgo(1), "ICUC")),
                List.of());
        MistakeSummaryDto m = f.mistakes();
        assertEquals(1, m.repeated());
        assertEquals(1, m.single());
        assertEquals(1, m.improved());
        assertEquals(3, m.totalTracked());
        assertEquals(List.of("REPEATED", "SINGLE", "IMPROVED"), m.items().stream().map(MistakeItemDto::state).toList());
        MistakeItemDto rep = m.items().get(0);
        assertEquals(key(FORM_A, 5, 0), rep.logicalItemKey());
        assertEquals(1, rep.itemVersion());
        assertEquals(List.of("INCORRECT", "INCORRECT"), rep.outcomes());
        MistakeItemDto imp = m.items().get(2);
        assertEquals("CORRECT", imp.lastOutcome(), "later correction represented");
        assertEquals(1, scope(f, "TOEIC_PART_5").currentRepeatedMistakes());

        // a new version of the same logical item is a different item (version identity preserved)
        PracticeAttemptFacts v2 = new PracticeAttemptFacts(id(), ExamFamily.TOEIC, "TOEIC_PART_5", "TOEIC_PART",
                SkillType.READING, 5, FORM_B, "B", true, daysAgo(1).minusSeconds(5), daysAgo(1),
                List.of(new ItemOutcome(id(), key(FORM_A, 5, 0), 2, 500, "SINGLE_CHOICE", Outcome.INCORRECT)), null, null);
        MistakeSummaryDto m2 = compute(List.of(toeic(5, FORM_A, daysAgo(3), "I"), v2), List.of()).mistakes();
        assertEquals(2, m2.totalTracked());
        assertEquals(0, m2.repeated(), "v1 + v2 misses are not merged into a repeat");
    }

    @Test
    @DisplayName("21: the review link is the attempt of the latest miss")
    void reviewLink() {
        PracticeAttemptFacts first = toeic(5, FORM_A, daysAgo(3), "I");
        PracticeAttemptFacts second = toeic(5, FORM_A, daysAgo(2), "I");
        PracticeAttemptFacts third = toeic(5, FORM_A, daysAgo(1), "C");
        MistakeItemDto item = compute(List.of(third, first, second), List.of()).mistakes().items().get(0);
        assertEquals("IMPROVED", item.state());
        assertEquals(second.attemptId(), item.reviewAttemptId());
    }

    @Test
    @DisplayName("22/23: analytics carry no answers, keys, prompts, and no linguistic topic — only canonical interaction types")
    void noKeysNoTopics() throws Exception {
        FamilyAnalyticsDto f = compute(List.of(toeic(5, FORM_A, daysAgo(1), "IICCU")), List.of(avail(5, FORM_A)));
        String json = MAPPER.writeValueAsString(f);
        for (String forbidden : List.of("acceptedAnswers", "correctAnswers", "answerSpec", "learnerAnswer", "prompt",
                "explanation", "keySource", "topic", "grammar", "vocabulary", "preposition", "conditional")) {
            assertFalse(json.contains(forbidden), "analytics leaks " + forbidden);
        }
        assertEquals(List.of("SINGLE_CHOICE"), f.questionTypes().stream().map(InteractionStatsDto::interactionType).toList());
    }

    // ─── 8C ──────────────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("24: insufficient data ⇒ no weakness claimed, neutral START suggestions of available scopes only")
    void insufficientData() {
        FamilyAnalyticsDto f = compute(List.of(toeic(5, FORM_A, daysAgo(1), "IIII")),
                List.of(avail(2, FORM_A), avail(5, FORM_A), avail(6, FORM_A), avail(7, FORM_A)));
        RecommendationBlockDto r = f.recommendations();
        assertEquals("INSUFFICIENT_DATA", r.status());
        assertTrue(r.items().stream().allMatch(i -> "START".equals(i.kind())));
        assertTrue(r.items().stream().allMatch(i -> i.reasons().get(0).code().equals("AVAILABLE_TO_START")));
        assertEquals(List.of("TOEIC_PART_2", "TOEIC_PART_6", "TOEIC_PART_7"),
                r.items().stream().map(RecommendationDto::scopeCode).toList(), "never-practised first, canonical order");
    }

    @Test
    @DisplayName("25/26/33: a weaker sufficiently-sampled scope ranks first; the stronger one lower; reason = actual counts")
    void weakerFirst() {
        List<PracticeAttemptFacts> p = List.of(
                toeic(5, FORM_A, daysAgo(4), repeat("C", 8) + repeat("I", 12)),   // 40 %
                toeic(5, FORM_B, daysAgo(2), repeat("C", 12) + repeat("I", 8)),   // 60 %
                toeic(6, FORM_A, daysAgo(3), repeat("C", 14) + repeat("I", 6)),   // 70 %
                toeic(6, FORM_B, daysAgo(1), repeat("C", 14) + repeat("I", 6)));  // 70 %
        FamilyAnalyticsDto f = compute(p, List.of(avail(5, FORM_A), avail(5, FORM_B), avail(6, FORM_A), avail(6, FORM_B)));
        List<RecommendationDto> items = f.recommendations().items();
        assertEquals("PERSONALIZED", f.recommendations().status());
        assertEquals("TOEIC_PART_5", items.get(0).scopeCode());
        assertEquals("FOCUS", items.get(0).kind());
        assertEquals("TOEIC_PART_6", items.get(1).scopeCode(), "stronger scope ranks lower");
        ReasonDto reason = items.get(0).reasons().get(0);
        assertEquals("RECENT_MISSES", reason.code());
        assertEquals(20, reason.facts().get("incorrect"), "8 + 12 wrong in the recent block");
        assertEquals(40, reason.facts().get("total"));
        ScopeStatsDto part5 = scope(f, "TOEIC_PART_5");
        assertEquals(part5.recentIncorrect(), reason.facts().get("incorrect"));
        assertEquals(part5.recentQuestions(), reason.facts().get("total"));
        assertEquals(40, items.get(0).sampleQuestions());
        assertEquals(2, items.get(0).sampleAttempts());
        assertTrue(items.get(0).reasons().stream().anyMatch(x -> x.code().equals("LOWER_THAN_OTHER_SCOPES")));
    }

    @Test
    @DisplayName("27: recurring mistakes raise pressure at equal accuracy")
    void recurringMistakes() {
        // both 50 % recent; Part 5 misses the SAME items twice, Part 6 misses different ones
        List<PracticeAttemptFacts> p = List.of(
                toeic(5, FORM_A, daysAgo(3), repeat("I", 6) + repeat("C", 6)),
                toeic(5, FORM_A, daysAgo(2), repeat("I", 6) + repeat("C", 6)),
                toeic(6, FORM_A, daysAgo(3), repeat("I", 6) + repeat("C", 6)),
                toeic(6, FORM_A, daysAgo(2), repeat("C", 6) + repeat("I", 6)));
        FamilyAnalyticsDto f = compute(p, List.of(avail(5, FORM_A), avail(6, FORM_A)));
        assertEquals("TOEIC_PART_5", f.recommendations().items().get(0).scopeCode());
        assertEquals("REPEATED_MISTAKES", f.recommendations().items().get(0).reasons().get(0).code());
        assertEquals(6, f.recommendations().items().get(0).reasons().get(0).facts().get("count"));
    }

    @Test
    @DisplayName("28: recent improvement reduces recommendation pressure")
    void improvementReducesPressure() {
        // Part 5: earlier 0 %, recent three attempts 60 % ⇒ improving; Part 6: steady 55 %
        List<PracticeAttemptFacts> p = new ArrayList<>(List.of(
                toeic(5, FORM_A, daysAgo(20), repeat("I", 20)),
                toeic(5, FORM_A, daysAgo(3), repeat("C", 12) + repeat("I", 8)),
                toeic(5, FORM_A, daysAgo(2), repeat("C", 12) + repeat("I", 8)),
                toeic(5, FORM_B, daysAgo(1), repeat("C", 12) + repeat("I", 8)),
                toeic(6, FORM_A, daysAgo(2), repeat("C", 11) + repeat("I", 9)),
                toeic(6, FORM_B, daysAgo(1), repeat("C", 11) + repeat("I", 9))));
        FamilyAnalyticsDto f = compute(p, List.of(avail(5, FORM_A), avail(6, FORM_A)));
        ScopeStatsDto s5 = scope(f, "TOEIC_PART_5");
        assertEquals(0.0, s5.earlierAccuracyPercent());
        assertEquals(60.0, s5.recentAccuracyPercent());
        List<RecommendationDto> items = f.recommendations().items();
        assertEquals("TOEIC_PART_6", items.get(0).scopeCode(), "the improving scope is no longer first");
        RecommendationDto r5 = items.stream().filter(i -> i.scopeCode().equals("TOEIC_PART_5")).findFirst().orElseThrow();
        assertTrue(r5.reasons().stream().anyMatch(x -> x.code().equals("IMPROVING")));
    }

    @Test
    @DisplayName("29/30/31: unavailable / in-progress / source-blocked scopes (absent from the availability index) are never recommended")
    void onlyAvailable() {
        List<PracticeAttemptFacts> p = List.of(toeic(1, FORM_A, daysAgo(2), repeat("I", 20)), toeic(1, FORM_A, daysAgo(1), repeat("I", 20)),
                toeic(5, FORM_A, daysAgo(2), repeat("C", 15) + repeat("I", 10)), toeic(5, FORM_A, daysAgo(1), repeat("C", 15) + repeat("I", 10)));
        // Part 1 is CONTENT_IN_PROGRESS (photos pending) ⇒ not in the index; Part 3 is UNAVAILABLE ⇒ not in the index
        FamilyAnalyticsDto f = compute(p, List.of(avail(5, FORM_A), avail(2, FORM_A)));
        assertTrue(f.recommendations().items().stream().noneMatch(i -> i.scopeCode().equals("TOEIC_PART_1")));
        assertTrue(f.recommendations().items().stream().noneMatch(i -> i.scopeCode().equals("TOEIC_PART_3")));
        assertEquals("TOEIC_PART_5", f.recommendations().items().get(0).scopeCode());
        assertEquals("TOEIC_PART_2", f.recommendations().items().get(1).scopeCode());
        assertEquals("COVERAGE", f.recommendations().items().get(1).kind());
        assertEquals("NO_AVAILABLE_SCOPE", compute(p, List.of()).recommendations().status());
    }

    @Test
    @DisplayName("32: deterministic — same facts (any input order) ⇒ identical recommendations")
    void deterministic() throws Exception {
        List<PracticeAttemptFacts> p = new ArrayList<>(List.of(
                toeic(5, FORM_A, daysAgo(3), "IIICCCCCCCII"), toeic(6, FORM_A, daysAgo(2), "IICCCCCCIICC"),
                toeic(7, FORM_B, daysAgo(1), "IIIIICCCCCCC"), toeic(5, FORM_B, daysAgo(1), "CCCIIICCCIII")));
        List<AvailableScope> a = new ArrayList<>(List.of(avail(5, FORM_A), avail(5, FORM_B), avail(6, FORM_A), avail(7, FORM_B),
                avail(2, FORM_A)));
        String first = MAPPER.writeValueAsString(compute(p, a));
        for (int i = 0; i < 5; i++) {
            Collections.shuffle(p, new Random(i));
            Collections.shuffle(a, new Random(i + 100));
            assertEquals(first, MAPPER.writeValueAsString(compute(p, a)));
        }
    }

    @Test
    @DisplayName("target form: prefer a form where the scope was not practised yet")
    void targetFreshForm() {
        List<PracticeAttemptFacts> p = List.of(toeic(5, FORM_A, daysAgo(2), repeat("I", 15)), toeic(5, FORM_A, daysAgo(1), repeat("I", 15)));
        RecommendationDto r = compute(p, List.of(avail(5, FORM_A), avail(5, FORM_B))).recommendations().items().get(0);
        assertEquals(FORM_B, r.formId());
    }

    @Test
    @DisplayName("activity: 8 Monday-start weeks (Asia/Ho_Chi_Minh), practice + simulation counted separately")
    void activityWeeks() {
        FamilyAnalyticsDto f = compute(List.of(toeic(5, FORM_A, daysAgo(1), "CC"), toeic(5, FORM_A, daysAgo(70), "C")), List.of());
        assertEquals(8, f.activity().size());
        assertEquals(1, f.activity().stream().mapToInt(ActivityWeekDto::practiceAttempts).sum(), "70 days ago is outside 8 weeks");
        assertTrue(f.activity().stream().allMatch(w -> w.weekStart().getDayOfWeek() == java.time.DayOfWeek.MONDAY));
    }
}
