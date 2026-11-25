package com.englishcoach.exams.analytics;

import com.englishcoach.exams.analytics.ExamAnalyticsRecords.*;
import com.englishcoach.exams.analytics.ExamLearnerAnalytics.*;
import com.englishcoach.exams.analytics.ExamLearnerAnalyticsRepository.*;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.practice.ExamPracticeScope;
import com.englishcoach.exams.practice.ExamPracticeService;
import com.englishcoach.exams.scoring.ExamAttemptSnapshotContent;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.scoring.ExamObjectiveScorer.ItemScoreResult;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

/**
 * Exams Phase 8 — learner analytics, mistake intelligence and recommended practice for ONE authenticated learner.
 *
 * <p>Truth: the learner's own SUBMITTED attempts. Practice items are re-scored with the SAME set-aware
 * {@link ExamObjectiveScorer} the worker and the Phase 6 result use, over the snapshot each attempt pinned — never the
 * current form content. Simulation scores are the scorer's persisted components only. The service is read-only: it never
 * writes attempts, evidence, Proficiency, score events or recommendations, and it never calls AI.
 *
 * <p>Isolation (P0): the user id always comes from the authenticated principal (controller); every query filters by it.
 */
@Slf4j
@Service
public class ExamLearnerAnalyticsService {

    static final int MAX_PRACTICE_ATTEMPTS = 150;
    static final int MAX_SIMULATION_ATTEMPTS = 30;

    /** Currently AVAILABLE practice scopes of a family (server readiness). */
    public interface AvailabilitySource {
        List<AvailableScope> availableScopes(ExamFamily family);
    }

    private final ExamLearnerAnalyticsRepository repository;
    private final ExamObjectiveScorer scorer;
    private final AvailabilitySource availability;
    private final Clock clock;

    @Autowired
    public ExamLearnerAnalyticsService(ExamLearnerAnalyticsRepository repository, ExamObjectiveScorer scorer,
                                       AvailabilitySource availability) {
        this(repository, scorer, availability, Clock.systemUTC());
    }

    public ExamLearnerAnalyticsService(ExamLearnerAnalyticsRepository repository, ExamObjectiveScorer scorer,
                                       AvailabilitySource availability, Clock clock) {
        this.repository = repository;
        this.scorer = scorer;
        this.availability = availability;
        this.clock = clock;
    }

    public ExamAnalyticsDto getAnalytics(Long userId, ExamFamily family) {
        if (userId == null) throw new IllegalArgumentException("USER_REQUIRED");
        Instant now = clock.instant();
        Instant since = now.minus(ExamLearnerAnalytics.WINDOW_DAYS, ChronoUnit.DAYS);
        List<PracticeAttemptFacts> practice = practiceFacts(userId, family, since);
        List<FamilySimulation> simulations = simulations(userId, family, since);
        List<FamilyAnalyticsDto> families = new ArrayList<>();
        for (ExamFamily f : family != null ? List.of(family) : List.of(ExamFamily.values())) {
            List<AvailableScope> available;
            try {
                available = availability == null ? List.of() : availability.availableScopes(f);
            } catch (RuntimeException e) {
                log.warn("[ExamsAnalytics] availability for {} failed: {}", f, e.getMessage());
                available = List.of();   // fail closed: nothing recommended rather than a guessed scope
            }
            families.add(ExamLearnerAnalytics.compute(f, practice,
                    simulations.stream().filter(s -> s.family() == f).map(FamilySimulation::attempt).toList(), available, now));
        }
        Map<String, String> versions = new LinkedHashMap<>();
        versions.put("signal", ExamLearnerAnalytics.SIGNAL_POLICY_VERSION);
        versions.put("mistakes", ExamLearnerAnalytics.MISTAKE_POLICY_VERSION);
        versions.put("recommendations", ExamLearnerAnalytics.RECOMMENDATION_POLICY_VERSION);
        return new ExamAnalyticsDto(now, ExamLearnerAnalytics.WINDOW_DAYS, ExamLearnerAnalytics.RECENT_DAYS, versions, families);
    }

    /** A simulation DTO with its family (the learner-facing DTO itself needs no family field). */
    record FamilySimulation(ExamFamily family, SimulationAttemptDto attempt) {}

    // ─── practice facts (snapshot re-scoring) ─────────────────────────────────────────────────

    List<PracticeAttemptFacts> practiceFacts(Long userId, ExamFamily family, Instant since) {
        List<PracticeAttemptRow> rows = repository.findSubmittedPracticeAttempts(userId, family, since, MAX_PRACTICE_ATTEMPTS);
        Map<UUID, Map<UUID, ResponseRow>> responses = new HashMap<>();
        for (ResponseRow r : repository.findResponses(userId, rows.stream().map(PracticeAttemptRow::attemptId).toList())) {
            if (r.itemId() != null) responses.computeIfAbsent(r.attemptId(), k -> new HashMap<>()).put(r.itemId(), r);
        }
        List<PracticeAttemptFacts> out = new ArrayList<>();
        for (PracticeAttemptRow row : rows) {
            PracticeAttemptFacts f = facts(row, responses.getOrDefault(row.attemptId(), Map.of()));
            if (f != null) out.add(f);
            else log.warn("[ExamsAnalytics] practice attempt {} skipped: pinned scope / snapshot not in a known canonical shape",
                    row.attemptId());
        }
        return out;
    }

    /** One attempt's facts, or null when its pinned scope / snapshot is not a known canonical shape (never guessed). */
    PracticeAttemptFacts facts(PracticeAttemptRow row, Map<UUID, ResponseRow> responses) {
        Map<String, Object> scope = row.practiceScope();
        if (scope == null || !ExamPracticeScope.VERSION.equals(scope.get("scopeVersion"))) return null;
        Optional<ExamAttemptSnapshotContent> content = ExamAttemptSnapshotContent.parse(row.itemSnapshot());
        if (content.isEmpty()) return null;
        SkillType skill;
        UUID sourceFormId;
        try {
            skill = SkillType.valueOf(String.valueOf(scope.get("skill")));
            sourceFormId = UUID.fromString(String.valueOf(scope.get("sourceFormId")));
        } catch (RuntimeException e) {
            return null;
        }
        String scopeCode = String.valueOf(scope.get("scopeCode"));
        String scopeType = String.valueOf(scope.get("scopeType"));
        int number = scope.get("number") instanceof Number n ? n.intValue() : 0;
        boolean objective = ExamPracticeScope.SCORING_OBJECTIVE_RAW.equals(scope.get("scoringMode"));
        List<ExamAttemptSnapshotContent.SnapshotItem> items = content.get().allItems();

        if (!objective) {
            ExamAttemptSnapshotContent.SnapshotItem task = items.isEmpty() ? null : items.get(0);
            Integer words = task == null ? null : ExamPracticeService.countEssayWords(text(responses.get(task.itemId())));
            Integer min = task == null ? null : ExamPracticeService.minimumWords(task);
            return new PracticeAttemptFacts(row.attemptId(), row.family(), scopeCode, scopeType, skill, number, sourceFormId,
                    row.formTitle(), false, row.startedAt(), row.submittedAt(), List.of(), words, min);
        }

        List<ExamObjectiveScorer.ObjectiveItemInput> inputs = new ArrayList<>();
        for (ExamAttemptSnapshotContent.SnapshotItem it : items) {
            if (it.answerSpec() == null) continue;
            inputs.add(new ExamObjectiveScorer.ObjectiveItemInput(it.itemId(), it.questionNumber(),
                    learnerAnswer(responses.get(it.itemId())), it.answerSpec(), it.numbersExempt()));
        }
        Map<UUID, ItemScoreResult> results = new HashMap<>();
        for (ItemScoreResult r : scorer.scoreItems(inputs)) results.put(r.itemId(), r);
        List<ItemOutcome> outcomes = new ArrayList<>();
        for (ExamAttemptSnapshotContent.SnapshotItem it : items) {
            outcomes.add(new ItemOutcome(it.itemId(), it.logicalItemKey(), it.version(), it.questionNumber(),
                    it.interactionType(), outcome(results.get(it.itemId()))));
        }
        return new PracticeAttemptFacts(row.attemptId(), row.family(), scopeCode, scopeType, skill, number, sourceFormId,
                row.formTitle(), true, row.startedAt(), row.submittedAt(), outcomes, null, null);
    }

    /** Scorer outcome → analytics outcome (same classification as the Phase 6 practice result). */
    static Outcome outcome(ItemScoreResult r) {
        if (r == null || ExamObjectiveScorer.OUTCOME_UNKEYED.equals(r.outcome())) return Outcome.NOT_SCORED;
        if (r.isCorrect()) return Outcome.CORRECT;
        if (ExamObjectiveScorer.OUTCOME_BLANK.equals(r.outcome())) return Outcome.UNANSWERED;
        return Outcome.INCORRECT;
    }

    static Object learnerAnswer(ResponseRow r) {
        if (r == null) return null;
        return r.answerPayload() != null ? r.answerPayload() : r.textResponse();
    }

    static String text(ResponseRow r) {
        if (r == null) return null;
        if (r.textResponse() != null && !r.textResponse().isBlank()) return r.textResponse();
        Map<String, Object> p = r.answerPayload();
        if (p != null) {
            for (String k : List.of("value", "text", "answer")) if (p.get(k) instanceof String s) return s;
        }
        return null;
    }

    // ─── simulations (scorer-persisted components only) ───────────────────────────────────────

    @SuppressWarnings("unchecked")
    List<FamilySimulation> simulations(Long userId, ExamFamily family, Instant since) {
        List<SimulationAttemptRow> rows = repository.findSubmittedSimulations(userId, family, since, MAX_SIMULATION_ATTEMPTS);
        Map<UUID, List<ComponentDto>> components = new HashMap<>();
        for (ComponentRow c : repository.findComponents(rows.stream().map(SimulationAttemptRow::artifactId)
                .filter(Objects::nonNull).toList())) {
            components.computeIfAbsent(c.artifactId(), k -> new ArrayList<>())
                    .add(new ComponentDto(c.metric(), c.scaledScore(), c.scaleName(), c.rawScore()));
        }
        List<FamilySimulation> out = new ArrayList<>();
        for (SimulationAttemptRow r : rows) {
            List<RawSectionDto> raw = new ArrayList<>();
            if (r.practiceRawScores() != null) {
                for (Map.Entry<String, Object> e : new TreeMap<>(r.practiceRawScores()).entrySet()) {
                    if (!(e.getValue() instanceof Map<?, ?> m)) continue;
                    Map<String, Object> v = (Map<String, Object>) m;
                    raw.add(new RawSectionDto(e.getKey(), intOrNull(v.get("correct")), intOrNull(v.get("maxRaw")),
                            v.get("percent") instanceof Number n ? n.doubleValue() : null, String.valueOf(v.get("scale"))));
                }
            }
            Long spent = r.startedAt() != null && r.submittedAt() != null
                    ? Math.max(0, Duration.between(r.startedAt(), r.submittedAt()).getSeconds()) : null;
            out.add(new FamilySimulation(r.family(), new SimulationAttemptDto(r.attemptId(), r.formId(), r.formTitle(),
                    r.variant(), r.scope(), r.submittedAt(), spent, r.artifactId() == null ? "PENDING" : r.resultStatus(),
                    r.artifactId() == null ? List.of() : components.getOrDefault(r.artifactId(), List.of()), raw)));
        }
        return out;
    }

    private static Integer intOrNull(Object o) {
        return o instanceof Number n ? n.intValue() : null;
    }
}
