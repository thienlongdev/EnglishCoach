package com.englishcoach.learningpath;

import com.englishcoach.learningpath.LearningPathEngine.*;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

class LearningPathEngineTest {

    @Test
    void unknownSkillSitsAtThePriorAndIsNeverCalledWeak() {
        SkillEstimate e = LearningPathEngine.estimate(SkillSums.none(Skill.LISTENING));
        assertThat(e.mastery()).isEqualTo(0.5);
        assertThat(e.confidence()).isZero();
        assertThat(e.band()).isEqualTo("UNKNOWN");
        Priority p = LearningPathEngine.priority(Goal.GENERAL, e, 0, 0);
        assertThat(p.reason()).isEqualTo("LITTLE_DATA").isNotEqualTo("LOW_RESULTS");
    }

    @Test
    void oneBadResultMovesTheEstimateOnlyALittle() {
        SkillEstimate e = LearningPathEngine.estimate(new SkillSums(Skill.LISTENING, 0, 1, 1, 0));
        assertThat(e.mastery()).isCloseTo(0.4, within(1e-9));
        assertThat(e.measured()).isFalse();
    }

    @Test
    void manyGoodResultsRaiseConfidenceAndBand() {
        SkillEstimate e = LearningPathEngine.estimate(new SkillSums(Skill.VOCABULARY, 27, 30, 30, 1));
        assertThat(e.confidence()).isGreaterThan(0.75);
        assertThat(e.mastery()).isGreaterThan(0.8);
        assertThat(e.band()).isEqualTo("STRONG");
    }

    @Test
    void successCannotExceedWeightEvenWithBadInput() {
        SkillEstimate e = LearningPathEngine.estimate(new SkillSums(Skill.WRITING, 99, 2, 2, 0));
        assertThat(e.mastery()).isLessThanOrEqualTo(1.0).isCloseTo(4.0 / 6.0, within(1e-9));
    }

    @Test
    void priorityIsBoundedAndFocusIsClamped() {
        SkillEstimate e = LearningPathEngine.estimate(new SkillSums(Skill.SPEAKING, 0, 40, 40, 30));
        Priority p = LearningPathEngine.priority(Goal.COMMUNICATION, e, 0, 5.0);
        assertThat(p.value()).isBetween(0.0, 1.0);
        assertThat(p.focus()).isEqualTo(LearningPathEngine.FOCUS_LIMIT);
        Priority vocab = LearningPathEngine.priority(Goal.TOEIC, LearningPathEngine.estimate(SkillSums.none(Skill.VOCABULARY)), 40, 0);
        assertThat(vocab.review()).isEqualTo(1.0);
        assertThat(vocab.reason()).isEqualTo("REVIEW_DUE");
    }

    @Test
    void neverPractisedSkillHasNoReviewNeed() {
        Priority p = LearningPathEngine.priority(Goal.IELTS, LearningPathEngine.estimate(SkillSums.none(Skill.WRITING)), 0, 0);
        assertThat(p.review()).isZero();
    }

    @Test
    void selectionFitsBudgetOnePerSkillAndPlacementFirst() {
        Map<String, Priority> pr = new HashMap<>();
        for (Skill s : Skill.values())
            pr.put(s.name(), LearningPathEngine.priority(Goal.GENERAL, LearningPathEngine.estimate(SkillSums.none(s)), 10, 0));
        List<Candidate> c = List.of(
                new Candidate(Kind.WRITING, "WRITING", null, null, "", 8, 1),
                new Candidate(Kind.PLACEMENT, "ASSESSMENT", null, null, "", 4, 1),
                new Candidate(Kind.VOCAB_REVIEW, "VOCABULARY", null, null, "", 4, 10),
                new Candidate(Kind.DICTATION, "LISTENING", 7L, "B1", "x", 7, 5),
                new Candidate(Kind.READING, "READING", 9L, "B1", "y", 5, 1),
                new Candidate(Kind.TOPIC_SPEAKING, "SPEAKING", null, "QUICK", "", 3, 1));
        List<Selected> s = LearningPathEngine.select(c, pr, Set.of(), Set.of(), 0, 0, 15);
        assertThat(s.get(0).candidate().kind()).isEqualTo(Kind.PLACEMENT);
        assertThat(s).hasSizeLessThanOrEqualTo(LearningPathEngine.MAX_TASKS);
        assertThat(s.stream().mapToInt(x -> x.candidate().minutes()).sum()).isLessThanOrEqualTo((int) (15 * 1.15));
        assertThat(s.stream().map(x -> x.candidate().skill()).distinct().count()).isEqualTo(s.size());
    }

    @Test
    void carriedSlotsAndSkillsAreRespected() {
        Map<String, Priority> pr = new HashMap<>();
        for (Skill s : Skill.values())
            pr.put(s.name(), LearningPathEngine.priority(Goal.GENERAL, LearningPathEngine.estimate(SkillSums.none(s)), 0, 0));
        List<Candidate> c = List.of(new Candidate(Kind.WRITING, "WRITING", null, null, "", 8, 1),
                new Candidate(Kind.TOPIC_SPEAKING, "SPEAKING", null, "QUICK", "", 3, 1));
        List<Selected> s = LearningPathEngine.select(c, pr, Set.of(), Set.of("WRITING"), 10, 3, 15);
        assertThat(s).extracting(x -> x.candidate().skill()).containsExactly("SPEAKING");
    }

    @Test
    void stagesNeedEvidenceAndNeverGoDown() {
        Map<Skill, SkillEstimate> none = new EnumMap<>(Skill.class);
        for (Skill s : Skill.values()) none.put(s, LearningPathEngine.estimate(SkillSums.none(s)));
        // lots of activity but no level evidence ⇒ still stage 1
        StageStatus s1 = LearningPathEngine.stage(1, new StageInput(30, 5, false, none, Goal.GENERAL, false));
        assertThat(s1.stage()).isEqualTo(1);
        assertThat(s1.next()).anyMatch(r -> r.code().equals("LEVEL") && !r.met());
        // activity + level evidence ⇒ stage 2, but unmeasured core skills block stage 3
        StageStatus s2 = LearningPathEngine.stage(1, new StageInput(30, 5, true, none, Goal.GENERAL, false));
        assertThat(s2.stage()).isEqualTo(2);
        // a stored stage is kept even when the evidence later looks thinner
        assertThat(LearningPathEngine.stage(3, new StageInput(0, 0, false, none, Goal.GENERAL, false)).stage()).isEqualTo(3);
        // stage 4 without a goal assessment says an assessment is needed (never "achieved")
        Map<Skill, SkillEstimate> strong = new EnumMap<>(Skill.class);
        for (Skill s : Skill.values()) strong.put(s, LearningPathEngine.estimate(new SkillSums(s, 45, 50, 50, 0)));
        StageStatus s4 = LearningPathEngine.stage(1, new StageInput(60, 5, true, strong, Goal.TOEIC, false));
        assertThat(s4.stage()).isEqualTo(4);
        assertThat(s4.assessmentNeeded()).isTrue();
    }

    @Test
    void dnaFocusIsBoundedAndExplained() {
        DnaSignals d = new DnaSignals(2, false, 1, 4, 3, 20);
        Map<String, Double> f = LearningPathEngine.focusFromDna(d);
        assertThat(f).containsEntry("VOCABULARY", 0.10).containsEntry("LISTENING", 0.10)
                .containsEntry("SPEAKING", 0.10).containsEntry("WRITING", 0.05).doesNotContainKey("READING");
        List<FocusChange> changes = LearningPathEngine.diff(Map.of("READING", 0.1, "VOCABULARY", 0.10), f, d);
        assertThat(changes).extracting(FocusChange::skill).containsExactlyInAnyOrder("LISTENING", "READING", "SPEAKING", "WRITING");
        assertThat(changes).filteredOn(c -> c.skill().equals("READING")).first()
                .satisfies(c -> assertThat(c.reason()).isEqualTo("NO_RECENT_SIGNAL"));
        assertThat(LearningPathEngine.focusFromDna(new DnaSignals(0, false, 0, 0, 0, 0))).isEmpty();
    }

    @Test
    void taskSizesFollowTheDailyBudget() {
        assertThat(LearningPathEngine.vocabGoal(200, 15)).isEqualTo(10);
        assertThat(LearningPathEngine.vocabGoal(3, 60)).isEqualTo(3);
        assertThat(LearningPathEngine.dictationGoal(230, 30)).isEqualTo(8);
        assertThat(LearningPathEngine.readingMinutes(420)).isEqualTo(4);
        assertThat(LearningPathEngine.readingMinutes(50_000)).isEqualTo(25);
        assertThat(LearningPathEngine.speakingStyle(Goal.IELTS, "B2")).isEqualTo("IELTS2");
        assertThat(LearningPathEngine.speakingStyle(Goal.GENERAL, "A2")).isEqualTo("QUICK");
    }

    @Test
    void contentBandStaysWithinOneStepAndStretchesOnlyOnEvidence() {
        SkillEstimate strong = LearningPathEngine.estimate(new SkillSums(Skill.LISTENING, 18, 20, 20, 1));
        SkillEstimate low = LearningPathEngine.estimate(new SkillSums(Skill.LISTENING, 3, 20, 20, 1));
        SkillEstimate none = LearningPathEngine.estimate(SkillSums.none(Skill.LISTENING));
        assertThat(strong.band()).isEqualTo("STRONG");
        assertThat(low.band()).isEqualTo("NEEDS_WORK");
        assertThat(LearningPathEngine.band(2, true, strong)).isEqualTo(new Band(3, 2, 1));   // evidence + strong: stretch first
        assertThat(LearningPathEngine.band(2, false, strong)).isEqualTo(new Band(2, 1, 3));  // provisional: never stretch first
        assertThat(LearningPathEngine.band(2, true, low)).isEqualTo(new Band(2, 1, 3));      // low results: consolidate
        assertThat(LearningPathEngine.band(2, true, none)).isEqualTo(new Band(2, 3, 1));     // default: at level, then +1
        assertThat(LearningPathEngine.cefrOfRating(166)).isEqualTo("A1");
        assertThat(LearningPathEngine.cefrOfRating(560)).isEqualTo("B2");
        assertThat(LearningPathEngine.cefrOfRating(1000)).isEqualTo("C2");
    }

    @Test
    void everyKindIsAssignableWithItsOwnCompletionContract() {
        assertThat(LearningPathEngine.ASSIGNABLE).containsExactlyInAnyOrder("PLACEMENT", "VOCAB_REVIEW", "DICTATION", "READING",
                "TOPIC_SPEAKING", "WRITING", "EXAM_PRACTICE");
    }

    @Test
    void writingPromptsFollowTheWritingLevelNotTheGoalAndFitTheBudget() {
        // A2 learner with an IELTS 7.5 goal: a short paragraph, never IELTS Task 2
        assertThat(LearningPathEngine.writingOptions(Goal.IELTS, 1, 30)).extracting(WritingTask::key).containsExactly("GENPARA");
        assertThat(LearningPathEngine.writingOptions(Goal.TOEIC, 1, 15)).extracting(WritingTask::key).containsExactly("TOEICEMAIL", "GENPARA");
        // B2: the goal's own format, but a 250-word task only when the day has room for it
        assertThat(LearningPathEngine.writingOptions(Goal.IELTS, 3, 60)).extracting(WritingTask::key).startsWith("IELTSOPINION");
        assertThat(LearningPathEngine.writingOptions(Goal.IELTS, 3, 30)).extracting(WritingTask::key).containsExactly("GENESSAY");
        for (WritingTask t : LearningPathEngine.WRITING_TASKS.values()) {
            assertThat(t.key()).matches("[A-Z0-9]{2,16}"); // fits learning_path_task.target_key
            assertThat(LearningPathEngine.writingMinutes(t.minWords())).isBetween(10, 40);
        }
    }

    @Test
    void examPracticeUsesOnlyObjectiveScoredPartsEasierOnesFirst() {
        assertThat(LearningPathEngine.examPreference(Goal.TOEIC, 1)).containsExactly("TOEIC_PART_5", "TOEIC_PART_2");
        assertThat(LearningPathEngine.examPreference(Goal.IELTS, 2)).first().isEqualTo("IELTS_LISTENING_SECTION_1");
        assertThat(LearningPathEngine.examPreference(Goal.GENERAL, 3)).isEmpty();
        for (Goal g : List.of(Goal.TOEIC, Goal.IELTS))
            for (int step = 0; step <= 5; step++)
                for (String code : LearningPathEngine.examPreference(g, step)) {
                    assertThat(code).doesNotContain("WRITING", "SPEAKING");
                    assertThat(LearningPathEngine.examPart(code)).isNotNull();
                    assertThat(LearningPathEngine.examPart(code).skill()).isIn(Skill.LISTENING, Skill.READING);
                }
    }

    @Test
    void aGoalSkillLeftOutForAWeekGetsABoundedBalanceBonus() {
        SkillEstimate e = LearningPathEngine.estimate(SkillSums.none(Skill.WRITING));
        Priority plain = LearningPathEngine.priority(Goal.IELTS, e, 0, 0, false);
        Priority balanced = LearningPathEngine.priority(Goal.IELTS, e, 0, 0, true);
        assertThat(balanced.value() - plain.value()).isCloseTo(LearningPathEngine.COVERAGE_BONUS, within(1e-9));
        assertThat(balanced.reason()).isEqualTo("SKILL_BALANCE");
        // not a goal-core skill (TOEIC writing relevance 0.2): no bonus
        assertThat(LearningPathEngine.priority(Goal.TOEIC, e, 0, 0, true).coverage()).isZero();
    }

    @Test
    void readingIsMeasuredOnlyWhereScoredExamReadingExists() {
        assertThat(LearningPathEngine.measurable(Goal.IELTS)).contains(Skill.READING);
        assertThat(LearningPathEngine.measurable(Goal.TOEIC)).contains(Skill.READING);
        assertThat(LearningPathEngine.measurable(Goal.GENERAL)).doesNotContain(Skill.READING);
        assertThat(LearningPathEngine.measurable(Goal.COMMUNICATION)).doesNotContain(Skill.READING);
    }

    // ── Free progression (owner closure 2026-10-18) ────────────────────────────────────────────

    private static Map<Skill, SkillEstimate> estimates(Map<Skill, SkillSums> sums) {
        Map<Skill, SkillEstimate> out = new EnumMap<>(Skill.class);
        for (Skill s : Skill.values()) out.put(s, LearningPathEngine.estimate(sums.getOrDefault(s, SkillSums.none(s))));
        return out;
    }

    /** Strong, confident free practice for the skills that have a free scored source (dictation, cards, topic rounds). */
    private static Map<Skill, SkillSums> strongFreeSkills() {
        Map<Skill, SkillSums> m = new EnumMap<>(Skill.class);
        for (Skill s : List.of(Skill.VOCABULARY, Skill.LISTENING, Skill.SPEAKING)) m.put(s, new SkillSums(s, 40, 45, 45, 0));
        return m;
    }

    @Test
    void scenarioF_aFreeIeltsLearnerAdvancesWithoutAnyAiWritingScoreAndWritingStaysUnmeasured() {
        Map<Skill, SkillEstimate> free = estimates(strongFreeSkills()); // Writing / Reading: no score at all
        // before the practice milestone: stage 2, the next requirements name the free Writing / Reading practice
        StageStatus waiting = LearningPathEngine.stage(2, new StageInput(30, 5, true, free, Goal.IELTS, false,
                Map.of(Skill.WRITING, 1, Skill.READING, 2)));
        assertThat(waiting.stage()).isEqualTo(2);
        assertThat(waiting.next()).anyMatch(r -> r.code().equals("PRACTICE_WRITING") && r.current() == 1 && r.needed() == 3 && !r.met());
        assertThat(waiting.next()).anyMatch(r -> r.code().equals("PRACTICE_READING") && !r.met());
        // free Writing practice submissions (no AI, no Premium) + reading completions reach stage 3 …
        StageStatus moved = LearningPathEngine.stage(2, new StageInput(30, 5, true, free, Goal.IELTS, false,
                Map.of(Skill.WRITING, 3, Skill.READING, 3)));
        assertThat(moved.stage()).isEqualTo(3);
        // … and stage 4 with more of the same; stage 4 still asks for a real goal assessment
        StageStatus top = LearningPathEngine.stage(2, new StageInput(60, 5, true,
                estimates(Map.of(Skill.VOCABULARY, new SkillSums(Skill.VOCABULARY, 60, 64, 64, 0),
                        Skill.LISTENING, new SkillSums(Skill.LISTENING, 60, 64, 64, 0),
                        Skill.SPEAKING, new SkillSums(Skill.SPEAKING, 60, 64, 64, 0))), Goal.IELTS, false,
                Map.of(Skill.WRITING, 6, Skill.READING, 6)));
        assertThat(top.stage()).isEqualTo(4);
        assertThat(top.assessmentNeeded()).isTrue();
        // the Writing estimate itself is untouched by participation: no score, not measured
        assertThat(free.get(Skill.WRITING).measured()).isFalse();
        assertThat(free.get(Skill.WRITING).band()).isEqualTo("UNKNOWN");
    }

    @Test
    void participationAloneNeverReplacesTheFreeScoredSkills() {
        // 100 tasks of writing / reading do not stand in for unmeasured listening / speaking (free scored sources exist)
        StageStatus s = LearningPathEngine.stage(2, new StageInput(100, 5, true, estimates(Map.of()), Goal.IELTS, false,
                Map.of(Skill.WRITING, 50, Skill.READING, 50)));
        assertThat(s.stage()).isEqualTo(2);
        assertThat(s.next()).anyMatch(r -> r.code().equals("CORE_SKILLS") && !r.met());
        // and the activity milestone still applies
        assertThat(LearningPathEngine.stage(2, new StageInput(10, 5, true, estimates(strongFreeSkills()), Goal.IELTS, false,
                Map.of(Skill.WRITING, 9, Skill.READING, 9))).stage()).isEqualTo(2);
    }

    @Test
    void scenarioG_aConfidentWritingAssessmentDecidesForEveryLearnerAndNeverRewritesCompletion() {
        Map<Skill, SkillSums> sums = new EnumMap<>(strongFreeSkills());
        sums.put(Skill.READING, new SkillSums(Skill.READING, 9, 10, 10, 0));
        // strong AI-rubric evidence (confidence ≥ 0.45): Writing ready with only one writing task
        sums.put(Skill.WRITING, new SkillSums(Skill.WRITING, 6, 7, 14, 0));
        StageInput strongAi = new StageInput(30, 5, true, estimates(sums), Goal.IELTS, false, Map.of(Skill.WRITING, 1));
        assertThat(LearningPathEngine.stage(2, strongAi).stage()).isEqualTo(3);
        // a confident WEAK assessment is real evidence: practice count alone does not override it
        sums.put(Skill.WRITING, new SkillSums(Skill.WRITING, 2, 7, 14, 0));
        StageStatus weak = LearningPathEngine.stage(2, new StageInput(30, 5, true, estimates(sums), Goal.IELTS, false,
                Map.of(Skill.WRITING, 9)));
        assertThat(weak.stage()).isEqualTo(2);
        // the stored stage never goes down (completion history is never rewritten by new evidence)
        assertThat(LearningPathEngine.stage(3, new StageInput(30, 5, true, estimates(sums), Goal.IELTS, false,
                Map.of(Skill.WRITING, 9))).stage()).isEqualTo(3);
    }

    @Test
    void scenarioA_aLowInformationPartialSubmitNeverDisplacesAnEarlierCompleteAttempt() {
        var full = new ExamAttemptOutcome("ex:full", 30, 30, 80);
        var partial = new ExamAttemptOutcome("ex:partial", 4, 30, 25);      // newest, 4 of 30 answered
        assertThat(LearningPathEngine.examEvidence(List.of(partial, full))).contains(full);
        var halfDone = new ExamAttemptOutcome("ex:half", 16, 30, 40);       // qualifies, but far less complete
        assertThat(LearningPathEngine.examEvidence(List.of(halfDone, full))).contains(full);
        // a lone partial attempt is not a practised part
        assertThat(LearningPathEngine.examEvidence(List.of(partial))).isEmpty();
    }

    @Test
    void scenarioB_aLaterCompleteAttemptIsTheEvidenceEvenWhenItIsWorse() {
        var earlyGood = new ExamAttemptOutcome("ex:early", 30, 30, 90);
        var laterPoor = new ExamAttemptOutcome("ex:later", 29, 30, 35);      // newest, comparable completeness
        assertThat(LearningPathEngine.examEvidence(List.of(laterPoor, earlyGood))).contains(laterPoor);
        var laterBetter = new ExamAttemptOutcome("ex:better", 30, 30, 95);
        assertThat(LearningPathEngine.examEvidence(List.of(laterBetter, laterPoor, earlyGood))).contains(laterBetter);
        assertThat(LearningPathEngine.examEvidence(List.of())).isEmpty();
    }
}
