package com.englishcoach.leaderboard.activity;

import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import com.englishcoach.common.event.DictationAttemptSubmittedEvent;
import com.englishcoach.common.event.ExamScoredEvent;
import com.englishcoach.common.event.RoleplayTurnRecordedEvent;
import com.englishcoach.leaderboard.activity.event.CardBlastRunFinishedEvent;
import com.englishcoach.leaderboard.activity.event.FlashcardReviewedEvent;
import com.englishcoach.leaderboard.activity.event.PvpMatchFinishedEvent;
import com.englishcoach.leaderboard.activity.event.ShadowingAttemptRecordedEvent;
import com.englishcoach.leaderboard.activity.event.WritingAssessmentCompletedEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

/**
 * Turns source domain events into immutable {@code score_events} rows (Activity Spec §1–§5).
 * Each handler runs in its own transaction, takes a per-user advisory lock, applies the daily
 * cap ONCE at insert time and inserts with ON CONFLICT DO NOTHING (idempotent).
 * Returns the rows newly written by the call.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ActivityScoringService {

    private static final Set<ActivitySource> FLASHCARD_CAP_GROUP = EnumSet.of(
            ActivitySource.FLASHCARD_REVIEW, ActivitySource.FLASHCARD_NEW, ActivitySource.FLASHCARD_MASTERED);

    private static final List<ScoreMetric> SKILL_METRICS = List.of(
            ScoreMetric.LISTENING, ScoreMetric.READING, ScoreMetric.WRITING, ScoreMetric.SPEAKING);

    private final ActivityScoringProperties props;
    private final ActivityPointsCalculator calc;
    private final ScoreEventRepository ledger;
    private final ActivitySourceReadRepository sourceReader;
    private final UserLevelProvider userLevelProvider;

    // ---- Flashcards: NEW (first study) or REVIEW, plus MASTERED; one shared daily cap (D5) -----

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public List<ScoreEventRow> onFlashcardReviewed(FlashcardReviewedEvent e) {
        Instant at = occurredAt(e.occurredAt());
        if (!accepts(e.userId(), at) || e.flashcardId() == null) {
            return List.of();
        }
        long userId = e.userId();
        ledger.lockUserForScoring(userId);

        Cefr cefr = resolveCefr(ActivitySource.FLASHCARD_REVIEW, e.contentCefr(), str(e.dictionaryEntryId()));
        double relative = calc.relativeMult(cefr, userLevelProvider.currentLevel(userId));
        int cap = props.getFlashcard().getDailyCap();

        List<ScoreEventRow> written = new ArrayList<>();
        // Phase 1.1: the first study of a card scores FLASHCARD_NEW only; later reviews score FLASHCARD_REVIEW.
        if (calc.isFirstStudy(e.reviewCount())) {
            record(written, withPointCap(userId, candidate(ActivitySource.FLASHCARD_NEW,
                    "new:" + e.flashcardId(),
                    props.getFlashcard().getNewCard(), cefr, 1.0, relative), at, FLASHCARD_CAP_GROUP, cap));
        } else {
            record(written, withPointCap(userId, candidate(ActivitySource.FLASHCARD_REVIEW,
                    "review:" + e.flashcardId() + ":" + e.reviewCount(),
                    calc.flashcardReviewBase(e.quality()), cefr, 1.0, relative), at, FLASHCARD_CAP_GROUP, cap));
        }
        if (calc.earnsMasteredBonus(e.previousStatus(), e.newStatus(), e.reviewCount())) {
            record(written, withPointCap(userId, candidate(ActivitySource.FLASHCARD_MASTERED,
                    "mastered:" + e.flashcardId(),
                    props.getFlashcard().getMastered(), cefr, 1.0, relative), at, FLASHCARD_CAP_GROUP, cap));
        }
        return written;
    }

    // ---- Card Blast solo: eligible = raw; top-3/day + cap 100 belong to the Phase 3 rollup ----

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public List<ScoreEventRow> onCardBlastRunFinished(CardBlastRunFinishedEvent e) {
        Instant at = occurredAt(e.occurredAt());
        if (!accepts(e.userId(), at) || e.runId() == null) {
            return List.of();
        }
        long userId = e.userId();
        ledger.lockUserForScoring(userId);

        Cefr cefr = resolveCefr(ActivitySource.CARD_BLAST_SOLO, null, str(e.deckId()));
        Candidate c = candidate(ActivitySource.CARD_BLAST_SOLO, "cardblast:" + e.runId(),
                calc.cardBlastSoloBase(e.score(), e.hits()), cefr, calc.cardBlastSoloQuality(e.accuracyPct()),
                calc.relativeMult(cefr, userLevelProvider.currentLevel(userId)));
        List<ScoreEventRow> written = new ArrayList<>();
        record(written, insert(userId, c, c.rawPoints(), false, at));
        return written;
    }

    // ---- Card Blast PvP (D7): 10 matches/day (HUMAN + BOT), 3/day vs the same human --------------

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public List<ScoreEventRow> onPvpMatchFinished(PvpMatchFinishedEvent e) {
        Instant at = occurredAt(e.occurredAt());
        if (e.matchId() == null) {
            return List.of();
        }
        boolean botMatch = "BOT".equalsIgnoreCase(e.mode()) || e.guestUserId() == null;

        // Lock participants in ascending id order to avoid deadlocks between concurrent matches.
        TreeSet<Long> participants = new TreeSet<>();
        if (accepts(e.hostUserId(), at)) participants.add(e.hostUserId());
        if (accepts(e.guestUserId(), at)) participants.add(e.guestUserId());
        participants.forEach(ledger::lockUserForScoring);

        List<ScoreEventRow> written = new ArrayList<>();
        Cefr cefr = resolveCefr(ActivitySource.CARD_BLAST_PVP, null, str(e.deckId()));
        boolean instantForfeit = calc.isInstantForfeit(botMatch, e.endReason(), e.durationMs());
        for (Long userId : participants) {
            Long opponentId = botMatch ? null
                    : (userId.equals(e.hostUserId()) ? e.guestUserId() : e.hostUserId());
            ActivityPointsCalculator.PvpOutcome outcome = calc.pvpOutcome(userId, e.winnerId(), e.endReason());
            double quality = calc.pvpQuality(botMatch,
                    sourceReader.pvpRating(userId).orElse(null),
                    botMatch ? null : sourceReader.pvpRating(opponentId).orElse(null));
            String opponentKey = botMatch ? "bot" : String.valueOf(opponentId);
            Candidate c = candidate(ActivitySource.CARD_BLAST_PVP,
                    "pvp:" + e.matchId() + ":vs:" + opponentKey,
                    instantForfeit ? 0 : calc.pvpBase(botMatch, outcome), cefr, quality,
                    calc.relativeMult(cefr, userLevelProvider.currentLevel(userId)));

            DayWindow day = day(at);
            ActivityScoringProperties.Pvp p = props.getPvp();
            boolean overLimit = ledger.countUncapped(userId, ActivitySource.CARD_BLAST_PVP, null, day.from(), day.to())
                    >= p.getMaxMatchesPerDay();
            if (!botMatch && !overLimit) {
                overLimit = ledger.countUncapped(userId, ActivitySource.CARD_BLAST_PVP,
                        "pvp:%:vs:" + opponentKey, day.from(), day.to()) >= p.getMaxMatchesPerOpponentPerDay();
            }
            record(written, overLimit ? insert(userId, c, 0, true, at) : insert(userId, c, c.rawPoints(), false, at));
        }
        return written;
    }

    // ---- Dictation: retries 100 % / 30 % / 0, cap 120 ---------------------------------------------

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public List<ScoreEventRow> onDictationAttemptSubmitted(DictationAttemptSubmittedEvent e) {
        Instant at = occurredAt(e.occurredAt());
        if (!accepts(e.userId(), at) || e.attemptId() == null || e.exerciseId() == null) {
            return List.of();
        }
        long userId = e.userId();
        ledger.lockUserForScoring(userId);

        long attemptNo = sourceReader.dictationAttemptNumber(userId, e.exerciseId(), e.attemptId());
        double base = props.getDictation().getBase() * calc.dictationRetryFactor(attemptNo);
        Cefr cefr = resolveCefr(ActivitySource.DICTATION, e.contentCefr(), str(e.materialId()));
        Candidate c = candidate(ActivitySource.DICTATION, "dictation:" + e.exerciseId() + ":" + e.attemptId(),
                base, cefr, calc.dictationQuality(e.accuracyPct()),
                calc.relativeMult(cefr, userLevelProvider.currentLevel(userId)));
        List<ScoreEventRow> written = new ArrayList<>();
        record(written, withPointCap(userId, c, at, EnumSet.of(ActivitySource.DICTATION),
                props.getDictation().getDailyCap()));
        return written;
    }

    // ---- Shadowing: abstention/mocked = no event; first scored attempt per sentence per day ------

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public List<ScoreEventRow> onShadowingAttemptRecorded(ShadowingAttemptRecordedEvent e) {
        Instant at = occurredAt(e.occurredAt());
        if (!accepts(e.userId(), at) || e.unitId() == null
                || e.pronunciationScore() == null || Boolean.TRUE.equals(e.mocked())) {
            return List.of();
        }
        long userId = e.userId();
        ledger.lockUserForScoring(userId);

        LocalDate localDay = at.atZone(zone()).toLocalDate();
        Cefr cefr = resolveCefr(ActivitySource.SHADOWING, e.contentCefr(), str(e.materialId()));
        Candidate c = candidate(ActivitySource.SHADOWING, "shadowing:" + e.unitId() + ":" + localDay,
                props.getShadowing().getBase(), cefr, calc.shadowingQuality(e.pronunciationScore()),
                calc.relativeMult(cefr, userLevelProvider.currentLevel(userId)));
        List<ScoreEventRow> written = new ArrayList<>();
        record(written, withPointCap(userId, c, at, EnumSet.of(ActivitySource.SHADOWING),
                props.getShadowing().getDailyCap()));
        return written;
    }

    // ---- Roleplay: once per session at >= 6 learner turns, max 3 sessions/day ---------------------

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public List<ScoreEventRow> onRoleplayTurnRecorded(RoleplayTurnRecordedEvent e) {
        Instant at = occurredAt(e.occurredAt());
        if (!accepts(e.userId(), at) || e.sessionId() == null) {
            return List.of();
        }
        long userId = e.userId();
        String ref = "roleplay:" + e.sessionId();
        ledger.lockUserForScoring(userId);
        if (ledger.exists(userId, ActivitySource.ROLEPLAY, ref)) {
            return List.of();
        }
        ActivitySourceReadRepository.RoleplayTurnStats stats = sourceReader.roleplayTurnStats(e.sessionId());
        if (stats.learnerTurns() < props.getRoleplay().getMinLearnerTurns()) {
            return List.of();
        }
        Cefr cefr = resolveCefr(ActivitySource.ROLEPLAY, e.contentCefr(), str(e.scenarioId()));
        Candidate c = candidate(ActivitySource.ROLEPLAY, ref, props.getRoleplay().getBase(), cefr,
                calc.roleplayQuality(stats.averageFluency()),
                calc.relativeMult(cefr, userLevelProvider.currentLevel(userId)));
        List<ScoreEventRow> written = new ArrayList<>();
        record(written, withCountLimit(userId, c, at, props.getRoleplay().getMaxSessionsPerDay()));
        return written;
    }

    // ---- Writing: first READY assessment per session, max 2 counted/day (D3, D4) ----------------

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public List<ScoreEventRow> onWritingAssessmentCompleted(WritingAssessmentCompletedEvent e) {
        Instant at = occurredAt(e.occurredAt());
        if (!accepts(e.userId(), at) || e.sessionId() == null || e.overallScore() == null) {
            return List.of();
        }
        long userId = e.userId();
        ledger.lockUserForScoring(userId);

        Cefr cefr = resolveCefr(ActivitySource.WRITING, null, e.taskId());
        Candidate c = candidate(ActivitySource.WRITING, "writing:" + e.sessionId(),
                calc.writingBase(e.taskId()), cefr, calc.writingQuality(e.overallScore()),
                calc.relativeMult(cefr, userLevelProvider.currentLevel(userId)));
        List<ScoreEventRow> written = new ArrayList<>();
        record(written, withCountLimit(userId, c, at, props.getWriting().getMaxSubmissionsPerDay()));
        return written;
    }

    // ---- Exams (D8): cefrMult = relativeMult = 1.0 ------------------------------------------------

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public List<ScoreEventRow> onExamScored(ExamScoredEvent e) {
        Instant at = occurredAt(e.occurredAt());
        if (!accepts(e.userId(), at) || e.formId() == null || e.metricScores() == null
                || !"COMPLETED".equals(e.resultStatus())) {
            return List.of();
        }
        long userId = e.userId();
        ledger.lockUserForScoring(userId);

        List<ScoreEventRow> written = new ArrayList<>();
        boolean simulation = "EXAM_SIMULATION".equals(e.attemptMode()) && calc.isFullExamScope(e.scope(), e.variant());
        if (simulation) {
            ScoreMetric metric = e.metricScores().get(ScoreMetric.FULL_OVERALL) != null
                    ? ScoreMetric.FULL_OVERALL : ScoreMetric.LR_TOTAL;
            Double score = e.metricScores().get(metric);
            Optional<Double> scaleMax = calc.examScaleMax(e.family(), metric);
            if (score == null || score < 0 || scaleMax.isEmpty()) {
                log.info("[Leaderboard] Exam attempt {} has no overall score on a known scale; no simulation points.", e.attemptId());
                return written;
            }
            Candidate c = candidate(ActivitySource.EXAM_SIMULATION, "examsim:" + e.formId(),
                    props.getExam().getSimulationBase(), null, calc.examQuality(score, scaleMax.get()), 1.0);
            record(written, insert(userId, c, c.rawPoints(), false, at));
            return written;
        }
        for (ScoreMetric skill : SKILL_METRICS) {
            Double score = e.metricScores().get(skill);
            Optional<Double> scaleMax = calc.examScaleMax(e.family(), skill);
            if (score == null || score < 0 || scaleMax.isEmpty()) {
                continue;
            }
            Candidate c = candidate(ActivitySource.EXAM_PRACTICE, "exampractice:" + e.formId() + ":" + skill.name(),
                    props.getExam().getPracticeBase(), null, calc.examQuality(score, scaleMax.get()), 1.0);
            record(written, withPointCap(userId, c, at, EnumSet.of(ActivitySource.EXAM_PRACTICE),
                    props.getExam().getPracticeDailyCap()));
        }
        return written;
    }

    // ---- Shared helpers ---------------------------------------------------------------------------

    record Candidate(ActivitySource source, String sourceRef, double base, Cefr cefr,
                     double cefrMult, double qualityMult, double relativeMult, int rawPoints) {}

    record DayWindow(Instant from, Instant to) {}

    private Candidate candidate(ActivitySource source, String ref, double base, Cefr cefr,
                                double quality, double relative) {
        double cefrMult = cefr == null ? 1.0 : calc.cefrMult(cefr);
        return new Candidate(source, ref, base, cefr, cefrMult, quality, relative,
                calc.points(base, cefrMult, quality, relative));
    }

    /** Daily point cap shared by {@code capGroup} (SUM of today's eligible points). */
    private Optional<ScoreEventRow> withPointCap(long userId, Candidate c, Instant at,
                                                 Set<ActivitySource> capGroup, int dailyCap) {
        if (ledger.exists(userId, c.source(), c.sourceRef())) {
            return Optional.empty();
        }
        DayWindow day = day(at);
        long today = ledger.sumEligible(userId, capGroup, day.from(), day.to());
        int eligible = ActivityPointsCalculator.eligibleUnderPointCap(c.rawPoints(), today, dailyCap);
        return insert(userId, c, eligible, eligible < c.rawPoints(), at);
    }

    /** Daily count limit on uncapped rows of the candidate's module. */
    private Optional<ScoreEventRow> withCountLimit(long userId, Candidate c, Instant at, int maxPerDay) {
        if (ledger.exists(userId, c.source(), c.sourceRef())) {
            return Optional.empty();
        }
        DayWindow day = day(at);
        boolean overLimit = ledger.countUncapped(userId, c.source(), null, day.from(), day.to()) >= maxPerDay;
        return overLimit ? insert(userId, c, 0, true, at) : insert(userId, c, c.rawPoints(), false, at);
    }

    private Optional<ScoreEventRow> insert(long userId, Candidate c, int eligible, boolean capped, Instant at) {
        ScoreEventRow row = new ScoreEventRow(null, userId, c.source(), c.sourceRef(), c.source().skillGroup(),
                decimal(c.base(), 3), c.cefr(), decimal(c.cefrMult(), 3), decimal(c.qualityMult(), 4),
                decimal(c.relativeMult(), 3), c.rawPoints(), eligible, capped, at, null);
        return ledger.insertIfAbsent(row) ? Optional.of(row) : Optional.empty();
    }

    private static void record(List<ScoreEventRow> written, Optional<ScoreEventRow> row) {
        row.ifPresent(written::add);
    }

    /** Event CEFR → leaderboard_content_cefr → Activity default (RSS content would use B2). */
    private Cefr resolveCefr(ActivitySource source, String eventCefr, String refId) {
        return Cefr.parse(eventCefr)
                .or(() -> sourceReader.contentCefr(source, refId))
                .orElse(props.getCefrMult().getDefaultCefr());
    }

    /** Recording is enabled, start-at is configured and the event is not before it. */
    boolean accepts(Long userId, Instant occurredAt) {
        Instant startAt = props.startAtInstant();
        return props.isEnabled() && userId != null && startAt != null && !occurredAt.isBefore(startAt);
    }

    private DayWindow day(Instant at) {
        ZoneId zone = zone();
        LocalDate d = at.atZone(zone).toLocalDate();
        return new DayWindow(d.atStartOfDay(zone).toInstant(), d.plusDays(1).atStartOfDay(zone).toInstant());
    }

    private ZoneId zone() {
        return ZoneId.of(props.getTimeZone());
    }

    private static Instant occurredAt(Instant at) {
        return at != null ? at : Instant.now();
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }

    private static BigDecimal decimal(double v, int scale) {
        return BigDecimal.valueOf(v).setScale(scale, RoundingMode.HALF_UP);
    }
}
