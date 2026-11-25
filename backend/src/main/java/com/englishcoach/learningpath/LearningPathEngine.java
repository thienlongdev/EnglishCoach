package com.englishcoach.learningpath;

import java.util.*;

/**
 * Echo Learning Path calculations. Pure (no I/O, no clock): every input comes from the caller so the rules are
 * deterministic and testable. Nothing here produces a CEFR level, an IELTS band or a TOEIC score: practice estimates are
 * bounded evidence summaries of the learner's own recent practice, kept separate from the Proficiency Engine's ability
 * ratings, from task completion and from activity consistency.
 */
public final class LearningPathEngine {

    private LearningPathEngine() {}

    public enum Goal { GENERAL, COMMUNICATION, IELTS, TOEIC }

    public enum Skill { VOCABULARY, LISTENING, READING, SPEAKING, WRITING }

    public enum Kind { PLACEMENT, VOCAB_REVIEW, DICTATION, READING, TOPIC_SPEAKING, WRITING, EXAM_PRACTICE }

    /**
     * Kinds the planner may assign: each has a server-side, AI-free completion contract (LearningEvidenceReader#branch)
     * that every learner can reach and that was verified end to end. WRITING completes from the free practice submission
     * of a Writing Coach draft (no AI, no Premium); EXAM_PRACTICE from a submitted, server-scored practice attempt of the
     * exact form part the Exams catalog declared ready. A stored task that cannot lead to its activity any more is
     * replaced explicitly (never completed).
     */
    public static final Set<String> ASSIGNABLE = Set.of("PLACEMENT", "VOCAB_REVIEW", "DICTATION", "READING", "TOPIC_SPEAKING",
            "WRITING", "EXAM_PRACTICE");

    public static final List<String> CEFR = List.of("A1", "A2", "B1", "B2", "C1", "C2");

    // ── Practice estimate (Beta-smoothed success rate) ─────────────────────────────────────────────
    /** Prior Beta(2, 2): mean 0.5 with the weight of four observations, so one bad result moves it only a little. */
    public static final double PRIOR_ALPHA = 2.0;
    public static final double PRIOR_BETA = 2.0;
    /** Effective sample size at which confidence reaches 0.5. */
    public static final double CONFIDENCE_K = 8.0;
    /** Observation weight halves every 21 days (applied in SQL: reliability × 0.5^(age/21)). */
    public static final double HALF_LIFE_DAYS = 21.0;
    /** Below this confidence a skill is shown as "not enough data" and is never called weak. */
    public static final double MEASURED_CONFIDENCE = 0.35;

    /**
     * Weighted sums of one skill's recent observations (success in [0, 1], weight = reliability × recency) plus the
     * number of days since the skill was last practised (null = never).
     */
    public record SkillSums(Skill skill, double weightedSuccess, double weight, int observations, Integer daysSinceLast) {
        public static SkillSums none(Skill skill) { return new SkillSums(skill, 0, 0, 0, null); }
    }

    public record SkillEstimate(Skill skill, double mastery, double confidence, int observations, Integer daysSinceLast) {
        public boolean measured() { return confidence >= MEASURED_CONFIDENCE; }

        /** Learner-facing band; never a percentage. */
        public String band() {
            if (!measured()) return "UNKNOWN";
            if (mastery < 0.5) return "NEEDS_WORK";
            if (mastery < 0.75) return "DEVELOPING";
            return "STRONG";
        }
    }

    public static SkillEstimate estimate(SkillSums s) {
        double w = Math.max(0, s.weight());
        double ws = Math.max(0, Math.min(s.weightedSuccess(), w));
        double mastery = (PRIOR_ALPHA + ws) / (PRIOR_ALPHA + PRIOR_BETA + w);
        double confidence = w / (w + CONFIDENCE_K);
        return new SkillEstimate(s.skill(), mastery, confidence, Math.max(0, s.observations()), s.daysSinceLast());
    }

    // ── Skill priority ────────────────────────────────────────────────────────────────────────────
    public static final double W_NEED = 0.40, W_RELEVANCE = 0.25, W_REVIEW = 0.20, W_GAP = 0.15;
    public static final double FOCUS_LIMIT = 0.20;
    /** Due cards at which vocabulary review need saturates. */
    public static final int DUE_SATURATION = 20;
    /** Days without practice at which a practised skill's review need saturates. */
    public static final int REVIEW_SATURATION_DAYS = 7;

    private static final Map<Goal, Map<Skill, Double>> RELEVANCE = Map.of(
            Goal.GENERAL, Map.of(Skill.VOCABULARY, 0.8, Skill.LISTENING, 0.8, Skill.READING, 0.8, Skill.SPEAKING, 0.6, Skill.WRITING, 0.6),
            Goal.COMMUNICATION, Map.of(Skill.VOCABULARY, 0.7, Skill.LISTENING, 0.9, Skill.READING, 0.4, Skill.SPEAKING, 1.0, Skill.WRITING, 0.4),
            Goal.IELTS, Map.of(Skill.VOCABULARY, 0.6, Skill.LISTENING, 0.9, Skill.READING, 0.9, Skill.SPEAKING, 0.9, Skill.WRITING, 0.9),
            Goal.TOEIC, Map.of(Skill.VOCABULARY, 0.8, Skill.LISTENING, 1.0, Skill.READING, 1.0, Skill.SPEAKING, 0.2, Skill.WRITING, 0.2));

    public static double relevance(Goal goal, Skill skill) {
        return RELEVANCE.get(goal).get(skill);
    }

    /** Goal-core skills (relevance ≥ 0.8). */
    public static List<Skill> coreSkills(Goal goal) {
        return Arrays.stream(Skill.values()).filter(s -> relevance(goal, s) >= 0.8).toList();
    }

    /**
     * Long-term balance: a goal-core skill that got no task in the last {@link #COVERAGE_DAYS} plan days earns this much
     * extra priority, so convenient kinds cannot crowd out the goal's other skills. Applied only once the learner has a
     * few plan days (a new learner has no history to balance).
     */
    public static final double COVERAGE_BONUS = 0.08;
    public static final int COVERAGE_DAYS = 7;
    public static final int COVERAGE_MIN_DAYS = 3;

    public record Priority(Skill skill, double value, double need, double relevance, double review, double gap, double focus,
                           double coverage) {
        public Priority(Skill skill, double value, double need, double relevance, double review, double gap, double focus) {
            this(skill, value, need, relevance, review, gap, focus, 0);
        }

        /** The term that contributes most decides the learner-facing reason. */
        public String reason() {
            double needPart = W_NEED * need, reviewPart = W_REVIEW * review, gapPart = W_GAP * gap;
            if (skill == Skill.VOCABULARY && review > 0) return "REVIEW_DUE";
            if (focus > 0.0001) return "DNA_FOCUS";
            if (coverage > 0.0001) return "SKILL_BALANCE";
            if (gap >= 1 - MEASURED_CONFIDENCE) return "LITTLE_DATA";
            if (need >= 0.5 && needPart >= reviewPart) return "LOW_RESULTS";
            if (reviewPart >= gapPart && review >= 0.5) return "KEEP_FRESH";
            return "GOAL_CORE";
        }
    }

    /**
     * {@code priority = 0.40·need + 0.25·relevance + 0.20·review + 0.15·gap + focus}, clamped to [0, 1].
     * need = 1 − posterior mean (an unknown skill sits at the prior, 0.5 — never treated as failed);
     * review = due cards / 20 (vocabulary) or days since last practice / 7 (others; 0 when never practised);
     * gap = 1 − confidence; focus = applied Learner DNA adjustment in [−0.2, 0.2].
     */
    public static Priority priority(Goal goal, SkillEstimate e, int dueCards, double focus) {
        return priority(goal, e, dueCards, focus, false);
    }

    /** As above, plus {@link #COVERAGE_BONUS} for a goal-core skill that went without a task for a week. */
    public static Priority priority(Goal goal, SkillEstimate e, int dueCards, double focus, boolean uncovered) {
        double need = clamp01(1 - e.mastery());
        double rel = relevance(goal, e.skill());
        double review;
        if (e.skill() == Skill.VOCABULARY) review = clamp01(dueCards / (double) DUE_SATURATION);
        else review = e.daysSinceLast() == null ? 0 : clamp01(e.daysSinceLast() / (double) REVIEW_SATURATION_DAYS);
        double gap = clamp01(1 - e.confidence());
        double f = Math.max(-FOCUS_LIMIT, Math.min(FOCUS_LIMIT, focus));
        double cov = uncovered && rel >= 0.8 ? COVERAGE_BONUS : 0;
        double value = clamp01(W_NEED * need + W_RELEVANCE * rel + W_REVIEW * review + W_GAP * gap + f + cov);
        return new Priority(e.skill(), value, need, rel, review, gap, f, cov);
    }

    // ── Task selection ────────────────────────────────────────────────────────────────────────────
    public record Candidate(Kind kind, String skill, Long targetId, String targetKey, String title, int minutes, int goalCount,
                            String targetRef) {
        public Candidate(Kind kind, String skill, Long targetId, String targetKey, String title, int minutes, int goalCount) {
            this(kind, skill, targetId, targetKey, title, minutes, goalCount, null);
        }
    }

    /** Weekly exam practice is a goal check: it wins a tie with the same skill's ordinary practice. */
    public static final double EXAM_BONUS = 0.05;

    public record Selected(Candidate candidate, String reason, double score) {}

    /** Score multiplier for a skill that already had a task on the previous plan day (rotation, not exclusion). */
    public static final double ROTATION_PENALTY = 0.85;
    public static final double BUDGET_TOLERANCE = 1.15;
    public static final int MAX_TASKS = 4;

    /**
     * Greedy, constraint-aware fill: highest score first, one task per skill per day, total minutes within
     * budget × 1.15, at most four tasks (minus the slots already taken by carried-over tasks). A placement candidate
     * always goes first. Fewer good candidates ⇒ a smaller plan, never an invented task.
     */
    public static List<Selected> select(List<Candidate> candidates, Map<String, Priority> priorities,
                                        Set<String> yesterdaySkills, Set<String> takenSkills, int usedMinutes,
                                        int usedSlots, int budgetMinutes) {
        List<Selected> scored = new ArrayList<>();
        for (Candidate c : candidates) {
            if (c.kind() == Kind.PLACEMENT) { scored.add(new Selected(c, "PLACEMENT_FIRST", 2.0)); continue; }
            Priority p = priorities.get(c.skill());
            if (p == null) continue;
            if (c.kind() == Kind.EXAM_PRACTICE) { scored.add(new Selected(c, "GOAL_CHECK", p.value() + EXAM_BONUS)); continue; }
            double score = p.value() * (yesterdaySkills.contains(c.skill()) ? ROTATION_PENALTY : 1.0);
            scored.add(new Selected(c, p.reason(), score));
        }
        scored.sort(Comparator.comparingDouble(Selected::score).reversed()
                .thenComparing(s -> s.candidate().kind().ordinal()));
        List<Selected> chosen = new ArrayList<>();
        Set<String> skills = new HashSet<>(takenSkills);
        int minutes = usedMinutes;
        int limit = (int) Math.floor(Math.max(0, budgetMinutes) * BUDGET_TOLERANCE);
        for (Selected s : scored) {
            if (usedSlots + chosen.size() >= MAX_TASKS) break;
            if (skills.contains(s.candidate().skill())) continue;
            boolean first = usedSlots + chosen.size() == 0;
            if (!first && minutes + s.candidate().minutes() > limit) continue;
            chosen.add(s);
            skills.add(s.candidate().skill());
            minutes += s.candidate().minutes();
        }
        return chosen;
    }

    // ── Task sizing (real content, bounded by the daily budget) ───────────────────────────────────
    /** Assumed ≈ 24 s per flashcard review. */
    public static int vocabGoal(int due, int budget) {
        int cap = switch (budget) { case 15 -> 10; case 30 -> 20; case 45 -> 25; default -> 30; };
        return Math.min(Math.max(due, 0), cap);
    }

    public static int vocabMinutes(int cards) { return Math.max(3, (int) Math.ceil(cards * 0.4)); }

    /** Assumed ≈ 75 s per dictation segment (listen, replay, type, read feedback). */
    public static int dictationGoal(int segments, int budget) {
        int cap = switch (budget) { case 15 -> 5; case 30 -> 8; case 45 -> 10; default -> 12; };
        return Math.min(Math.max(segments, 0), cap);
    }

    public static int dictationMinutes(int segments) { return Math.max(4, (int) Math.ceil(segments * 1.25)); }

    /** Assumed ≈ 110 words per minute for a learner reading carefully with look-ups. */
    public static int readingMinutes(int words) { return Math.max(3, Math.min(25, (int) Math.ceil(words / 110.0))); }

    public static int speakingRounds(int budget) { return budget <= 15 ? 1 : budget >= 60 ? 3 : 2; }

    public static int speakingMinutes(int rounds, String style) { return rounds * ("IELTS2".equals(style) ? 4 : 3); }

    // ── Writing tasks (real Writing Coach prompts, free practice submission) ─────────────────────
    /**
     * Writing Coach tasks the path may give, by a short enumerated key (stored in target_key; the client maps the same
     * key to the same task id): {@code minWords} is the task's own minimum, which the free submission enforces.
     */
    public record WritingTask(String key, String taskId, int minWords) {}

    public static final Map<String, WritingTask> WRITING_TASKS = Map.of(
            "GENPARA", new WritingTask("GENPARA", "gen-paragraph-01", 80),
            "GENEMAIL", new WritingTask("GENEMAIL", "gen-email-01", 120),
            "GENFREE", new WritingTask("GENFREE", "gen-free-01", 150),
            "GENESSAY", new WritingTask("GENESSAY", "gen-essay-01", 200),
            "TOEICEMAIL", new WritingTask("TOEICEMAIL", "toeic-email-01", 80),
            "TOEICOPINION", new WritingTask("TOEICOPINION", "toeic-opinion-01", 150),
            "IELTSOPINION", new WritingTask("IELTSOPINION", "ielts-t2-opinion-01", 250),
            "IELTSDISCUSS", new WritingTask("IELTSDISCUSS", "ielts-t2-discussion-01", 250),
            "IELTSPROBLEM", new WritingTask("IELTSPROBLEM", "ielts-t2-prob-sol-01", 250));

    /** Minutes for a task with this word minimum: ≈ 8 words a minute plus planning, 10–40 min. */
    public static int writingMinutes(int minWords) { return Math.max(10, Math.min(40, (int) Math.ceil(minWords / 8.0) + 5)); }

    /**
     * Writing tasks suited to the learner's writing level (never the goal's level): short paragraph / e-mail tasks up to
     * B1, longer goal-format tasks (IELTS Task 2, TOEIC opinion) only from B2, and only those that fit the daily budget.
     */
    public static List<WritingTask> writingOptions(Goal goal, int step, int budget) {
        List<String> keys;
        if (step <= 1) keys = goal == Goal.TOEIC ? List.of("TOEICEMAIL", "GENPARA") : List.of("GENPARA");
        else if (step == 2) keys = switch (goal) {
            case TOEIC -> List.of("TOEICEMAIL", "GENEMAIL");
            default -> List.of("GENEMAIL", "GENPARA");
        };
        else keys = switch (goal) {
            case IELTS -> List.of("IELTSOPINION", "IELTSDISCUSS", "IELTSPROBLEM", "GENESSAY");
            case TOEIC -> List.of("TOEICOPINION", "TOEICEMAIL");
            default -> List.of("GENFREE", "GENESSAY", "GENEMAIL");
        };
        return keys.stream().map(WRITING_TASKS::get).filter(t -> writingMinutes(t.minWords()) <= Math.max(budget, 15)).toList();
    }

    // ── Exam practice (practice-ready parts from the Exams catalog) ─────────────────────────────
    /** Objective, server-scored practice parts the path may give, in order of preference per level band, with skill and minutes. */
    public record ExamPart(String scopeCode, Skill skill, int minutes) {}

    private static final Map<String, ExamPart> EXAM_PARTS = Map.ofEntries(
            Map.entry("TOEIC_PART_2", new ExamPart("TOEIC_PART_2", Skill.LISTENING, 10)),
            Map.entry("TOEIC_PART_3", new ExamPart("TOEIC_PART_3", Skill.LISTENING, 15)),
            Map.entry("TOEIC_PART_4", new ExamPart("TOEIC_PART_4", Skill.LISTENING, 12)),
            Map.entry("TOEIC_PART_5", new ExamPart("TOEIC_PART_5", Skill.READING, 12)),
            Map.entry("TOEIC_PART_6", new ExamPart("TOEIC_PART_6", Skill.READING, 10)),
            Map.entry("TOEIC_PART_7", new ExamPart("TOEIC_PART_7", Skill.READING, 25)),
            Map.entry("IELTS_LISTENING_SECTION_1", new ExamPart("IELTS_LISTENING_SECTION_1", Skill.LISTENING, 10)),
            Map.entry("IELTS_LISTENING_SECTION_2", new ExamPart("IELTS_LISTENING_SECTION_2", Skill.LISTENING, 10)),
            Map.entry("IELTS_LISTENING_SECTION_3", new ExamPart("IELTS_LISTENING_SECTION_3", Skill.LISTENING, 10)),
            Map.entry("IELTS_LISTENING_SECTION_4", new ExamPart("IELTS_LISTENING_SECTION_4", Skill.LISTENING, 10)),
            Map.entry("IELTS_READING_PASSAGE_1", new ExamPart("IELTS_READING_PASSAGE_1", Skill.READING, 20)),
            Map.entry("IELTS_READING_PASSAGE_2", new ExamPart("IELTS_READING_PASSAGE_2", Skill.READING, 20)),
            Map.entry("IELTS_READING_PASSAGE_3", new ExamPart("IELTS_READING_PASSAGE_3", Skill.READING, 20)));

    public static ExamPart examPart(String scopeCode) { return scopeCode == null ? null : EXAM_PARTS.get(scopeCode); }

    /**
     * Exam parts in order of preference for a level step: the easier parts of the format first for A1–B1 (TOEIC Part 2 /
     * Part 5, IELTS Listening Sections 1–2), the harder ones from B2. Writing / speaking parts are never given (their only
     * grading is AI).
     */
    public static List<String> examPreference(Goal goal, int step) {
        if (goal == Goal.TOEIC) return step <= 1 ? List.of("TOEIC_PART_5", "TOEIC_PART_2")
                : step == 2 ? List.of("TOEIC_PART_5", "TOEIC_PART_2", "TOEIC_PART_6", "TOEIC_PART_4", "TOEIC_PART_3")
                : List.of("TOEIC_PART_3", "TOEIC_PART_4", "TOEIC_PART_6", "TOEIC_PART_7", "TOEIC_PART_5");
        if (goal == Goal.IELTS) return step <= 2 ? List.of("IELTS_LISTENING_SECTION_1", "IELTS_LISTENING_SECTION_2", "IELTS_READING_PASSAGE_1")
                : List.of("IELTS_LISTENING_SECTION_3", "IELTS_READING_PASSAGE_2", "IELTS_LISTENING_SECTION_4", "IELTS_READING_PASSAGE_3",
                        "IELTS_READING_PASSAGE_1", "IELTS_LISTENING_SECTION_2");
        return List.of();
    }

    /** Topic-speaking style suited to the goal and level (the learner may still pick any style). */
    public static String speakingStyle(Goal goal, String cefr) {
        if (goal == Goal.IELTS) return stepOf(cefr) >= 3 ? "IELTS2" : "IELTS1";
        return stepOf(cefr) >= 3 ? "DEEP" : "QUICK";
    }

    // ── Content difficulty ────────────────────────────────────────────────────────────────────────
    /** Level used when there is no ability evidence at all: accessible content, labelled provisional (never the goal). */
    public static final String PROVISIONAL_LEVEL = "A2";
    /** A Proficiency skill rating is used for that skill's content only from this confidence on. */
    public static final double SKILL_LEVEL_CONFIDENCE = 0.35;

    /** Three CEFR steps of content (absolute, 0 = A1) in order of preference; a step outside 0–5 matches nothing. */
    public record Band(int first, int second, int third) {}

    /**
     * Content band of one skill, never more than one step from the learner's level. Default: at the level, then one
     * step up (a small stretch), then one down. Conservative — at the level, then one down, then one up — when the level
     * is provisional or the learner's own results on the skill are low. The one-step stretch comes first only when the
     * level is evidence-based AND the learner's own practice on the skill is STRONG.
     */
    public static Band band(int step, boolean evidenceLevel, SkillEstimate estimate) {
        String b = estimate == null ? "UNKNOWN" : estimate.band();
        if (evidenceLevel && "STRONG".equals(b)) return new Band(step + 1, step, step - 1);
        if (!evidenceLevel || "NEEDS_WORK".equals(b)) return new Band(step, step - 1, step + 1);
        return new Band(step, step + 1, step - 1);
    }

    /** CEFR of a Proficiency rating (0–1000, Proficiency Spec §1). */
    public static String cefrOfRating(int rating) {
        int[] hi = {166, 333, 499, 666, 833};
        for (int i = 0; i < hi.length; i++) if (rating <= hi[i]) return CEFR.get(i);
        return "C2";
    }

    public static int stepOf(String cefr) {
        int i = cefr == null ? -1 : CEFR.indexOf(cefr.toUpperCase(Locale.ROOT));
        return Math.max(i, 0);
    }

    // ── Stages ────────────────────────────────────────────────────────────────────────────────────
    /**
     * Activity and evidence the stage rule reads. {@code skillTasksDone} = DONE path tasks per skill since the plan began
     * (participation, never a measure of quality).
     */
    public record StageInput(int doneTasks, int distinctSkillsDone, boolean levelEvidence,
                             Map<Skill, SkillEstimate> estimates, Goal goal, boolean goalAssessment,
                             Map<Skill, Integer> skillTasksDone) {
        public StageInput(int doneTasks, int distinctSkillsDone, boolean levelEvidence, Map<Skill, SkillEstimate> estimates,
                          Goal goal, boolean goalAssessment) {
            this(doneTasks, distinctSkillsDone, levelEvidence, estimates, goal, goalAssessment, Map.of());
        }

        int tasksDone(Skill skill) {
            return skillTasksDone == null ? 0 : skillTasksDone.getOrDefault(skill, 0);
        }
    }

    public record Requirement(String code, int current, int needed, boolean met) {}

    public record StageStatus(int stage, List<Requirement> next, boolean assessmentNeeded) {}

    /** Skills whose practice can be measured for every goal (plain Reading has no server-scored outcome). */
    public static final Set<Skill> MEASURABLE = EnumSet.of(Skill.VOCABULARY, Skill.LISTENING, Skill.SPEAKING, Skill.WRITING);

    /**
     * Measurable skills of a goal: IELTS / TOEIC paths also give server-scored exam reading parts, so Reading is
     * measured there; for the other goals it stays "Chưa đo được".
     */
    public static Set<Skill> measurable(Goal goal) {
        if (goal == Goal.IELTS || goal == Goal.TOEIC) {
            EnumSet<Skill> s = EnumSet.copyOf(MEASURABLE);
            s.add(Skill.READING);
            return s;
        }
        return MEASURABLE;
    }

    /**
     * Core skills that no free, always-available server score measures: Writing (its only score is the optional,
     * paid AI feedback) and Reading (scored only by exam reading parts, which only IELTS / TOEIC paths with enough daily
     * time and a practice-ready part receive). For these a stage needs a practice milestone of completed tasks
     * of that skill while no confident measurement exists; the skill's quality then stays "not measured" (never low,
     * never verified). A confident measurement, when one exists (e.g. AI feedback), decides instead — for every learner
     * alike. The other core skills (Vocabulary, Listening, Speaking) always have a free server-scored source.
     */
    public static final Set<Skill> PRACTICE_MILESTONE_SKILLS = EnumSet.of(Skill.WRITING, Skill.READING);

    /** Stage 2 → 3 and 3 → 4: practice estimate bar and practice milestone (completed tasks of the skill). */
    private static final double[] STAGE_CONFIDENCE = {0.45, 0.60}, STAGE_MASTERY = {0.60, 0.70};
    private static final int[] STAGE_TASKS = {24, 48}, STAGE_PRACTICE = {3, 6};

    /**
     * Four stages (1 Nền tảng, 2 Phát triển, 3 Củng cố, 4 Sẵn sàng mục tiêu). A stage is reached only when BOTH the
     * activity milestone and the skill condition hold; the stored stage never goes down. A stage is a learning-path
     * position, never a certified level: Stage 4 never claims the goal is achieved (without a recent goal assessment it
     * reports that one is needed). Paid AI feedback can add evidence; it is never required to move on.
     */
    public static StageStatus stage(int storedStage, StageInput in) {
        List<Skill> core = coreSkills(in.goal());
        int stage = Math.max(1, Math.min(4, storedStage));
        while (stage < 4) {
            List<Requirement> req = requirements(stage, in, core);
            if (req.stream().allMatch(Requirement::met)) stage++;
            else break;
        }
        List<Requirement> next = stage < 4 ? requirements(stage, in, core) : List.of();
        return new StageStatus(stage, next, stage == 4 && !in.goalAssessment());
    }

    private static List<Requirement> requirements(int stage, StageInput in, List<Skill> core) {
        List<Requirement> r = new ArrayList<>();
        if (stage == 1) {
            r.add(new Requirement("TASKS", in.doneTasks(), 6, in.doneTasks() >= 6));
            r.add(new Requirement("SKILLS", in.distinctSkillsDone(), 3, in.distinctSkillsDone() >= 3));
            r.add(new Requirement("LEVEL", in.levelEvidence() ? 1 : 0, 1, in.levelEvidence()));
            return r;
        }
        int i = stage == 2 ? 0 : 1;
        r.add(new Requirement("TASKS", in.doneTasks(), STAGE_TASKS[i], in.doneTasks() >= STAGE_TASKS[i]));
        int ok = 0;
        List<Requirement> practice = new ArrayList<>();
        for (Skill s : core) {
            SkillEstimate e = in.estimates().get(s);
            boolean confident = e != null && e.confidence() >= STAGE_CONFIDENCE[i];
            boolean ready;
            if (confident) {
                ready = e.mastery() >= STAGE_MASTERY[i];
            } else if (PRACTICE_MILESTONE_SKILLS.contains(s)) {
                int done = in.tasksDone(s);
                ready = done >= STAGE_PRACTICE[i];
                practice.add(new Requirement("PRACTICE_" + s.name(), Math.min(done, STAGE_PRACTICE[i]), STAGE_PRACTICE[i], ready));
            } else {
                ready = false;
            }
            if (ready) ok++;
        }
        r.add(new Requirement("CORE_SKILLS", ok, core.size(), ok == core.size()));
        r.addAll(practice);
        return r;
    }

    // ── Exam practice evidence of one assigned part ────────────────────────────────────────────────
    /** One server-scored, submitted practice attempt of the assigned part. */
    public record ExamAttemptOutcome(String ref, int answered, int total, Integer accuracyPct) {}

    /** A newer qualifying attempt is used instead of the most complete one only if it answered at least this share of it. */
    public static final double EXAM_COMPARABLE_SHARE = 0.8;

    /**
     * Which submitted attempt of an assigned exam part is the task's evidence. An attempt qualifies only when at least
     * half of its scored items were answered (a submit after a few guesses is not a practised part). Among qualifying
     * attempts the NEWEST one that is about as complete as the most complete one (≥ 80 % of its answered count) wins:
     * a later low-information submit can never displace an earlier complete one, while a later complete attempt —
     * better or worse — is the current evidence. Empty = the part is not practised yet.
     *
     * @param newestFirst scored attempts, newest first
     */
    public static Optional<ExamAttemptOutcome> examEvidence(List<ExamAttemptOutcome> newestFirst) {
        List<ExamAttemptOutcome> qualifying = newestFirst.stream()
                .filter(o -> o != null && o.total() > 0 && o.answered() * 2 >= o.total()).toList();
        if (qualifying.isEmpty()) return Optional.empty();
        int most = qualifying.stream().mapToInt(ExamAttemptOutcome::answered).max().orElse(0);
        return qualifying.stream().filter(o -> o.answered() >= EXAM_COMPARABLE_SHARE * most).findFirst();
    }

    // ── Learner DNA → focus proposal (deterministic) ─────────────────────────────────────────────
    public record DnaSignals(int missingPhonemes, boolean pausingIssues, int grammarPatterns,
                             int listeningDistractorMistakes, int listeningSpellingMistakes, long vocabularyCritical) {}

    public record FocusChange(String skill, double from, double to, String reason) {}

    /**
     * Maps the seven-day Learner DNA to bounded per-skill adjustments: +0.10 for a skill with a clear recent problem
     * signal, +0.05 for a weaker one, nothing otherwise; Reading never changes (no detailed Reading DNA exists).
     * Adjustments not supported by the new DNA decay to 0 (a stale focus is not kept forever).
     */
    public static Map<String, Double> focusFromDna(DnaSignals d) {
        Map<String, Double> f = new TreeMap<>();
        if (d.vocabularyCritical() >= 15) f.put(Skill.VOCABULARY.name(), 0.10);
        else if (d.vocabularyCritical() >= 5) f.put(Skill.VOCABULARY.name(), 0.05);
        int lis = d.listeningDistractorMistakes() + d.listeningSpellingMistakes();
        if (lis >= 6) f.put(Skill.LISTENING.name(), 0.10);
        else if (lis >= 3) f.put(Skill.LISTENING.name(), 0.05);
        if (d.missingPhonemes() >= 2 || d.pausingIssues()) f.put(Skill.SPEAKING.name(), 0.10);
        else if (d.missingPhonemes() == 1) f.put(Skill.SPEAKING.name(), 0.05);
        if (d.grammarPatterns() >= 2) f.put(Skill.WRITING.name(), 0.10);
        else if (d.grammarPatterns() == 1) f.put(Skill.WRITING.name(), 0.05);
        return f;
    }

    public static List<FocusChange> diff(Map<String, Double> current, Map<String, Double> proposed, DnaSignals d) {
        List<FocusChange> changes = new ArrayList<>();
        for (Skill s : Skill.values()) {
            double from = current.getOrDefault(s.name(), 0.0), to = proposed.getOrDefault(s.name(), 0.0);
            if (Math.abs(from - to) < 0.0001) continue;
            changes.add(new FocusChange(s.name(), from, to, to > from ? dnaReason(s, d) : "NO_RECENT_SIGNAL"));
        }
        return changes;
    }

    private static String dnaReason(Skill s, DnaSignals d) {
        return switch (s) {
            case VOCABULARY -> "CARDS_FORGETTING";
            case LISTENING -> d.listeningSpellingMistakes() >= d.listeningDistractorMistakes() ? "DICTATION_SPELLING" : "LISTENING_TRAPS";
            case SPEAKING -> d.missingPhonemes() > 0 ? "PRONUNCIATION_SOUNDS" : "SPEAKING_PAUSES";
            case WRITING -> "GRAMMAR_PATTERNS";
            case READING -> "NO_RECENT_SIGNAL";
        };
    }

    static double clamp01(double v) { return Double.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }
}
