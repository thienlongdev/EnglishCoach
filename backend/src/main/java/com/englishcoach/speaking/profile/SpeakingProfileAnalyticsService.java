package com.englishcoach.speaking.profile;

import com.englishcoach.speaking.dto.*;
import com.englishcoach.speaking.entity.*;
import com.englishcoach.speaking.profile.SpeakingProfileDtos.*;
import com.englishcoach.speaking.profile.SpeakingProfileQueryRepository.*;
import com.englishcoach.speaking.repository.SpeakingQuickCheckRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository;
import com.englishcoach.speaking.repository.SpeakingTurnFeedbackRepository;
import com.englishcoach.speaking.service.SpeakingProgressAggregationService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Reconciled longitudinal Speaking Profile analytics engine ({@code SPEAKING_PROFILE_ANALYTICS_v2}).
 *
 * <p>Enforces strict evidence thresholds, honest {@code INSUFFICIENT_DATA} states, zero fabricated scores,
 * zero N+1 queries, and complete separation of lightweight Hub Entry from lazy Profile subsections.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class SpeakingProfileAnalyticsService {

    public static final String ANALYTICS_POLICY_VERSION = "SPEAKING_PROFILE_ANALYTICS_v2";
    public static final int LOOKBACK_DAYS_30 = 30;
    public static final int LOOKBACK_DAYS_7 = 7;
    public static final int MIN_SCORED_ATTEMPTS_FOR_STRENGTH = 3;
    public static final double STRENGTH_SCORE_THRESHOLD = 75.0;
    public static final int MIN_DISTINCT_SESSIONS_FOR_RECURRING = 2;
    public static final int MIN_SCORED_POINTS_FOR_TREND = 2;
    public static final int MIN_PHONEME_OBS_FOR_STRONG_PATTERN = 5;
    public static final double STRONG_PATTERN_ACCEPTABLE_RATE = 0.85;
    public static final double STRONG_PATTERN_QUALITY_SCORE = 80.0;

    private static final Set<String> EXCLUDED_ISSUE_TYPES = Set.of(
            "VALID_VARIANT", "NO_SAFE_TARGET", "INCONCLUSIVE", "RUNTIME_BUSY", "TIMEOUT", "NO_SPEECH"
    );

    private static final Set<String> ALLOWED_MODES = Set.of("ALL", "SHADOWING", "ROLEPLAY", "QUICK_CHECK");
    private static final Set<String> ALLOWED_STATUSES = Set.of("ALL", "COMPLETED", "ACTIVE");

    private static final Map<String, PhoneMeta> PHONE_METADATA = buildPhoneMetadata();

    private final SpeakingProfileQueryRepository queryRepository;
    private final SpeakingShadowingAttemptRepository attemptRepository;
    private final SpeakingQuickCheckRepository quickCheckRepository;
    private final SpeakingTurnFeedbackRepository feedbackRepository;
    private final SpeakingProgressAggregationService legacyAggregationService;
    private final ObjectMapper objectMapper;

    /**
     * Ultra-lightweight Hub Entry summary for {@code /speaking} ("Luyện tập" header & Continue card).
     * Performs zero heavy JSON tree parsing and zero full history/unit hydration.
     */
    @Transactional(readOnly = true)
    public SpeakingHubEntryDto getHubEntry(Long userId) {
        requireUserId(userId);
        LocalDateTime now = LocalDateTime.now();
        LocalDate today = now.toLocalDate();
        LocalDateTime thirtyDaysAgo = now.minusDays(LOOKBACK_DAYS_30);

        Set<LocalDate> activeDates = queryRepository.findDistinctActiveDates(userId);
        int currentStreakDays = computeCurrentStreak(activeDates, today);

        long activeTargetsCount = countRecurringTargetsLightweight(userId, thirtyDaysAgo);

        long lifetimeCompletedSessions = queryRepository.getSessionStatusAndModeCounts(userId).stream()
                .filter(r -> "COMPLETED".equalsIgnoreCase(r.status()))
                .mapToLong(SessionStatusModeRow::count)
                .sum();

        SpeakingActiveContinueDto activeContinue = null;
        String activeTitle = null;
        String activeThumb = null;
        String activeYtId = null;

        Optional<ActiveShadowingHeader> activeOpt = queryRepository.findActiveShadowingHeader(userId);
        if (activeOpt.isPresent()) {
            ActiveShadowingHeader h = activeOpt.get();
            VisibleMaterialMeta mat = null;
            if (h.sourceId() != null) {
                mat = queryRepository.findVisibleMaterialsByIds(userId, List.of(h.sourceId())).get(h.sourceId());
            }
            activeTitle = mat != null ? mat.title() : null;
            activeThumb = mat != null ? mat.thumbnail() : null;
            activeYtId = mat != null ? mat.youtubeVideoId() : null;

            activeContinue = SpeakingActiveContinueDto.builder()
                    .sessionId(h.sessionId())
                    .status(h.status())
                    .mode(h.mode())
                    .sourceType(h.sourceType())
                    .sourceId(h.sourceId())
                    .currentUnitIndex(h.currentUnitIndex())
                    .completedUnitsCount(h.completedUnitsCount())
                    .totalUnitsCount(h.totalUnitsCount())
                    .materialTitle(activeTitle)
                    .thumbnail(activeThumb)
                    .youtubeVideoId(activeYtId)
                    .cefrLevel(mat != null ? mat.cefrLevel() : null)
                    .createdAt(h.createdAt())
                    .updatedAt(h.updatedAt())
                    .build();
        }

        return SpeakingHubEntryDto.builder()
                .currentStreakDays(currentStreakDays)
                .activeTargetsCount(activeTargetsCount)
                .lifetimeCompletedSessions(lifetimeCompletedSessions)
                .activeSession(activeContinue)
                .activeSessionTitle(activeTitle)
                .activeSessionThumbnail(activeThumb)
                .activeSessionYoutubeVideoId(activeYtId)
                .generatedAt(now)
                .build();
    }

    /**
     * Lazy Overview subsection ({@code GET /api/v1/speaking/profile/overview}).
     */
    @Transactional(readOnly = true)
    public SpeakingProfileOverviewDto getOverview(Long userId) {
        requireUserId(userId);
        LocalDateTime now = LocalDateTime.now();
        LocalDate today = now.toLocalDate();
        LocalDateTime sevenDaysAgo = now.minusDays(LOOKBACK_DAYS_7);
        LocalDateTime thirtyDaysAgo = now.minusDays(LOOKBACK_DAYS_30);

        // 1. Lifetime stats + session status counts
        List<SessionStatusModeRow> statusRows = queryRepository.getSessionStatusAndModeCounts(userId);
        long lifetimeCompleted = statusRows.stream()
                .filter(r -> "COMPLETED".equalsIgnoreCase(r.status()))
                .mapToLong(SessionStatusModeRow::count)
                .sum();
        long lifetimeInProgress = statusRows.stream()
                .filter(r -> "ACTIVE".equalsIgnoreCase(r.status()))
                .mapToLong(SessionStatusModeRow::count)
                .sum();
        LifetimeAggregateStats lifeAgg = queryRepository.getLifetimeAggregateStats(userId);
        long qualifiedSpeakingSeconds = lifeAgg.roleplayLearnerDurationSeconds()
                + Math.max(lifeAgg.completedShadowingSessionDurationSeconds(), lifeAgg.shadowingAttemptDurationSeconds());

        SpeakingLifetimeStatsDto lifetimeDto = SpeakingLifetimeStatsDto.builder()
                .completedSessions(lifetimeCompleted)
                .inProgressSessions(lifetimeInProgress)
                .totalSessions(lifetimeCompleted + lifetimeInProgress)
                .qualifiedSpeakingSeconds(qualifiedSpeakingSeconds)
                .roleplayLearnerTurns(lifeAgg.roleplayLearnerTurnsCount())
                .shadowingAttempts(lifeAgg.shadowingAttemptsCount())
                .quickCheckAttempts(lifeAgg.quickCheckAttemptsCount())
                .targetVocabularyUsed(lifeAgg.distinctTargetVocabCount())
                .averageContentMatchScore(lifeAgg.averageContentMatchScore())
                .build();

        // 2. 30-day window raw records (all non-mocked)
        Set<LocalDate> allActiveDates = queryRepository.findDistinctActiveDates(userId);
        int currentStreakDays = computeCurrentStreak(allActiveDates, today);

        List<SpeakingSession> sessions30d = queryRepository.findSessionsSince(userId, thirtyDaysAgo);
        List<SpeakingShadowingAttempt> attempts30d = filterGenuineShadowingAttempts(
                attemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(userId, thirtyDaysAgo));
        List<SpeakingQuickCheck> quickChecks30d = filterGenuineQuickChecks(
                quickCheckRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(userId, thirtyDaysAgo));
        List<SpeakingTurn> roleplayTurns30d = queryRepository.findLearnerTurnsSince(userId, thirtyDaysAgo);
        List<SpeakingTurnFeedback> feedbacks30d = feedbackRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(
                userId, thirtyDaysAgo);

        // Batch resolve all visible material metadata for 30d sessions & attempts (0 N+1)
        Set<Long> materialIds30d = new HashSet<>();
        for (SpeakingSession s : sessions30d) {
            if (s.getSourceId() != null && !"ROLEPLAY".equalsIgnoreCase(s.getMode()) && !"QUICK_CHECK".equalsIgnoreCase(s.getMode())) {
                materialIds30d.add(s.getSourceId());
            }
        }
        for (SpeakingShadowingAttempt a : attempts30d) {
            if (a.getSession() != null && a.getSession().getSourceId() != null) {
                materialIds30d.add(a.getSession().getSourceId());
            }
        }
        Map<Long, VisibleMaterialMeta> visibleMaterials = queryRepository.findVisibleMaterialsByIds(userId, materialIds30d);

        // 3. Reconciled 7d / 30d activity + daily rhythm (30 chronological days)
        Map<LocalDate, DailyAccumulator> dailyMap = new LinkedHashMap<>();
        LocalDate start30dDate = today.minusDays(LOOKBACK_DAYS_30 - 1);
        for (int i = 0; i < LOOKBACK_DAYS_30; i++) {
            LocalDate d = start30dDate.plusDays(i);
            dailyMap.put(d, new DailyAccumulator(d));
        }

        long sessionsCompleted7d = 0;
        long sessionsCompleted30d = 0;
        long sentences7d = 0;
        long sentences30d = 0;
        for (SpeakingSession s : sessions30d) {
            if ("ABANDONED".equalsIgnoreCase(s.getStatus())) continue;
            LocalDate d = s.getCreatedAt() != null ? s.getCreatedAt().toLocalDate() : today;
            DailyAccumulator acc = dailyMap.get(d);
            if (acc != null) {
                acc.active = true;
                if ("COMPLETED".equalsIgnoreCase(s.getStatus())) {
                    acc.completedSessions++;
                }
            }
            if ("COMPLETED".equalsIgnoreCase(s.getStatus())) {
                sessionsCompleted30d++;
                if (s.getCreatedAt() != null && !s.getCreatedAt().isBefore(sevenDaysAgo)) {
                    sessionsCompleted7d++;
                }
            }
            if ("SHADOWING".equalsIgnoreCase(s.getMode())) {
                int completedUnits = s.getCompletedUnitsCount() != null ? s.getCompletedUnitsCount() : 0;
                sentences30d += completedUnits;
                if (s.getCreatedAt() != null && !s.getCreatedAt().isBefore(sevenDaysAgo)) {
                    sentences7d += completedUnits;
                }
            }
        }

        long retries30d = 0;
        long resolvedTargets30d = 0;
        long speakingSeconds7d = 0;
        long speakingSeconds30d = 0;
        for (SpeakingShadowingAttempt a : attempts30d) {
            if (a.getRetryIndex() != null && a.getRetryIndex() > 0) retries30d++;
            if (Boolean.TRUE.equals(a.getResolvedThisSession())) resolvedTargets30d++;
            int sec = a.getDurationSeconds() != null ? Math.max(0, a.getDurationSeconds()) : 0;
            speakingSeconds30d += sec;
            if (a.getCreatedAt() != null && !a.getCreatedAt().isBefore(sevenDaysAgo)) {
                speakingSeconds7d += sec;
            }
            LocalDate d = a.getCreatedAt() != null ? a.getCreatedAt().toLocalDate() : today;
            DailyAccumulator acc = dailyMap.get(d);
            if (acc != null) {
                acc.active = true;
                acc.attemptsCount++;
                acc.speakingSeconds += sec;
                Double primaryScore = a.getPronunciationScore() != null ? a.getPronunciationScore() : a.getAccuracyScore();
                if (primaryScore != null) {
                    acc.scoreSum += primaryScore;
                    acc.scoreCount++;
                }
            }
        }

        long roleplayTurns7d = 0;
        for (SpeakingTurn t : roleplayTurns30d) {
            int sec = t.getDurationSeconds() != null ? Math.max(0, t.getDurationSeconds()) : 0;
            speakingSeconds30d += sec;
            if (t.getCreatedAt() != null && !t.getCreatedAt().isBefore(sevenDaysAgo)) {
                roleplayTurns7d++;
                speakingSeconds7d += sec;
            }
            LocalDate d = t.getCreatedAt() != null ? t.getCreatedAt().toLocalDate() : today;
            DailyAccumulator acc = dailyMap.get(d);
            if (acc != null) {
                acc.active = true;
                acc.attemptsCount++;
                acc.speakingSeconds += sec;
                if (t.getPronunciationScore() != null) {
                    acc.scoreSum += t.getPronunciationScore();
                    acc.scoreCount++;
                }
            }
        }

        long quickChecks7d = 0;
        for (SpeakingQuickCheck qc : quickChecks30d) {
            if (qc.getCreatedAt() != null && !qc.getCreatedAt().isBefore(sevenDaysAgo)) {
                quickChecks7d++;
            }
            int qcSec = extractAudioDurationSec(qc.getPronunciationDiagnosticsJson());
            speakingSeconds30d += qcSec;
            if (qc.getCreatedAt() != null && !qc.getCreatedAt().isBefore(sevenDaysAgo)) {
                speakingSeconds7d += qcSec;
            }
            LocalDate d = qc.getCreatedAt() != null ? qc.getCreatedAt().toLocalDate() : today;
            DailyAccumulator acc = dailyMap.get(d);
            if (acc != null) {
                acc.active = true;
                acc.attemptsCount++;
                acc.speakingSeconds += qcSec;
                if (qc.getOverallScore() != null) {
                    acc.scoreSum += qc.getOverallScore();
                    acc.scoreCount++;
                }
            }
        }

        int practiceDays7d = 0;
        int practiceDays30d = 0;
        int longestStreak30d = 0;
        int runningStreak = 0;
        LocalDate sevenDayCutoffDate = today.minusDays(LOOKBACK_DAYS_7 - 1);
        List<SpeakingDailyActivityPointDto> rhythm30d = new ArrayList<>(LOOKBACK_DAYS_30);
        for (DailyAccumulator acc : dailyMap.values()) {
            if (acc.active) {
                practiceDays30d++;
                if (!acc.date.isBefore(sevenDayCutoffDate)) {
                    practiceDays7d++;
                }
                runningStreak++;
                if (runningStreak > longestStreak30d) {
                    longestStreak30d = runningStreak;
                }
            } else {
                runningStreak = 0;
            }
            rhythm30d.add(SpeakingDailyActivityPointDto.builder()
                    .date(acc.date.toString())
                    .active(acc.active)
                    .completedSessions(acc.completedSessions)
                    .attemptsCount(acc.attemptsCount)
                    .speakingSeconds(acc.speakingSeconds)
                    .averageScore(acc.scoreCount > 0 ? round1(acc.scoreSum / acc.scoreCount) : null)
                    .build());
        }

        // 4. Unified 30d Pronunciation & Issue computation
        PronunciationEvaluation pronEval = evaluatePronunciation30d(
                attempts30d, quickChecks30d, roleplayTurns30d, visibleMaterials);
        SpeakingPronunciationMetricsDto pronMetrics = pronEval.metrics();

        List<SpeakingRecurringIssueDto> grammarVocabIssues = computeGrammarVocabIssues(feedbacks30d);
        List<SpeakingRecurringIssueDto> focusAreas = new ArrayList<>(pronEval.recurringIssues().size() + grammarVocabIssues.size());
        focusAreas.addAll(pronEval.recurringIssues());
        focusAreas.addAll(grammarVocabIssues);
        sortRecurringIssues(focusAreas);

        SpeakingWindowActivityDto recentWindow = SpeakingWindowActivityDto.builder()
                .currentStreakDays(currentStreakDays)
                .longestStreakDays30d(Math.max(longestStreak30d, Math.min(currentStreakDays, LOOKBACK_DAYS_30)))
                .practiceDays7d(practiceDays7d)
                .practiceDays30d(practiceDays30d)
                .sessionsCompleted7d(sessionsCompleted7d)
                .sessionsCompleted30d(sessionsCompleted30d)
                .sessionsStarted30d(sessions30d.size())
                .sentencesPracticed7d(sentences7d)
                .sentencesPracticed30d(sentences30d)
                .roleplayTurns7d(roleplayTurns7d)
                .roleplayTurns30d(roleplayTurns30d.size())
                .quickChecks7d(quickChecks7d)
                .quickChecks30d(quickChecks30d.size())
                .speakingSeconds7d(speakingSeconds7d)
                .speakingSeconds30d(speakingSeconds30d)
                .totalAttempts30d(pronMetrics.getTotalAttemptsCount())
                .v2ScoredAttempts30d(pronMetrics.getScoredAttemptsCount())
                .sttOnlyOrAbstainedAttempts30d(
                        Math.max(0L, pronMetrics.getTotalAttemptsCount() - pronMetrics.getScoredAttemptsCount()))
                .retries30d(retries30d)
                .resolvedTargets30d(resolvedTargets30d)
                .averagePronunciationScore30d(pronMetrics.getAveragePronunciationScore())
                .averageContentMatchScore30d(pronMetrics.getAverageContentMatchScore())
                .build();

        // 5. Recent sessions preview (top 5) & chronological score trend (up to 15 scored sessions)
        List<SpeakingSession> top5Raw = sessions30d.size() >= 5
                ? sessions30d.subList(0, 5)
                : queryRepository.findPaginatedSessions(userId, "ALL", "ALL", 0, 5);
        List<SpeakingSessionSummaryDto> recentSessions = buildSessionSummariesBatch(userId, top5Raw);

        List<SpeakingScoreTrendPointDto> scoreTrend = buildChronologicalScoreTrend(userId, sessions30d);

        // 6. Evidence-backed strengths (strict sample-size thresholds)
        List<SpeakingStrengthItemDto> strengths = buildEvidenceBackedStrengths(
                pronMetrics, recentWindow, lifetimeDto);

        // 7. Recent improvements
        List<SpeakingRecentImprovementDto> recentImprovements = buildRecentImprovements(attempts30d, visibleMaterials);

        // 8. Data sufficiency flags
        boolean hasAnyPractice = lifetimeDto.totalSessions() > 0
                || lifetimeDto.shadowingAttempts() > 0
                || lifetimeDto.roleplayLearnerTurns() > 0
                || lifetimeDto.quickCheckAttempts() > 0;

        String strengthsStatus = !strengths.isEmpty()
                ? "READY"
                : (hasAnyPractice ? "BUILDING_EVIDENCE" : "INSUFFICIENT_DATA");

        int distinct30dSessions = pronEval.distinctAssessedSessionsCount();
        String focusStatus;
        if (!focusAreas.isEmpty()) {
            focusStatus = "READY";
        } else if (distinct30dSessions >= MIN_DISTINCT_SESSIONS_FOR_RECURRING || sessionsCompleted30d >= MIN_DISTINCT_SESSIONS_FOR_RECURRING) {
            focusStatus = "NO_RECURRING_ISSUES";
        } else {
            focusStatus = "INSUFFICIENT_DATA";
        }

        String trendStatus = scoreTrend.size() >= MIN_SCORED_POINTS_FOR_TREND ? "READY" : "INSUFFICIENT_DATA";

        SpeakingDataSufficiencyDto sufficiency = SpeakingDataSufficiencyDto.builder()
                .hasAnyPractice(hasAnyPractice)
                .strengthsStatus(strengthsStatus)
                .focusStatus(focusStatus)
                .trendStatus(trendStatus)
                .minScoredAttemptsForStrength(MIN_SCORED_ATTEMPTS_FOR_STRENGTH)
                .minDistinctSessionsForFocus(MIN_DISTINCT_SESSIONS_FOR_RECURRING)
                .minScoredPointsForTrend(MIN_SCORED_POINTS_FOR_TREND)
                .build();

        return SpeakingProfileOverviewDto.builder()
                .policyVersion(ANALYTICS_POLICY_VERSION)
                .generatedAt(now)
                .dataSufficiency(sufficiency)
                .lifetime(lifetimeDto)
                .recentWindow(recentWindow)
                .activityRhythm30d(rhythm30d)
                .scoreTrend(scoreTrend)
                .strengths(strengths)
                .focusAreas(focusAreas)
                .recentImprovements(recentImprovements)
                .recentSessions(recentSessions)
                .build();
    }

    /**
     * Lazy Pronunciation subsection ({@code GET /api/v1/speaking/profile/pronunciation}).
     */
    @Transactional(readOnly = true)
    public SpeakingProfilePronunciationDto getPronunciation(Long userId) {
        requireUserId(userId);
        LocalDateTime now = LocalDateTime.now();
        LocalDateTime thirtyDaysAgo = now.minusDays(LOOKBACK_DAYS_30);

        List<SpeakingShadowingAttempt> attempts30d = filterGenuineShadowingAttempts(
                attemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(userId, thirtyDaysAgo));
        List<SpeakingQuickCheck> quickChecks30d = filterGenuineQuickChecks(
                quickCheckRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(userId, thirtyDaysAgo));
        List<SpeakingTurn> roleplayTurns30d = queryRepository.findLearnerTurnsSince(userId, thirtyDaysAgo);

        Set<Long> matIds = new HashSet<>();
        for (SpeakingShadowingAttempt a : attempts30d) {
            if (a.getSession() != null && a.getSession().getSourceId() != null) {
                matIds.add(a.getSession().getSourceId());
            }
        }
        Map<Long, VisibleMaterialMeta> visibleMaterials = queryRepository.findVisibleMaterialsByIds(userId, matIds);

        PronunciationEvaluation eval = evaluatePronunciation30d(
                attempts30d, quickChecks30d, roleplayTurns30d, visibleMaterials);

        long scored = eval.metrics().getScoredAttemptsCount();
        String sufficiencyStatus;
        if (scored >= MIN_SCORED_ATTEMPTS_FOR_STRENGTH && eval.distinctAssessedSessionsCount() >= MIN_DISTINCT_SESSIONS_FOR_RECURRING) {
            sufficiencyStatus = "READY";
        } else if (scored >= 1) {
            sufficiencyStatus = "LIMITED_EVIDENCE";
        } else {
            sufficiencyStatus = "INSUFFICIENT_DATA";
        }

        return SpeakingProfilePronunciationDto.builder()
                .policyVersion(ANALYTICS_POLICY_VERSION)
                .windowDays(LOOKBACK_DAYS_30)
                .windowLabelVi("30 ngày gần nhất")
                .windowLabelEn("Last 30 days")
                .generatedAt(now)
                .sufficiencyStatus(sufficiencyStatus)
                .minScoredAttemptsRequired(MIN_SCORED_ATTEMPTS_FOR_STRENGTH)
                .minDistinctSessionsForRecurring(MIN_DISTINCT_SESSIONS_FOR_RECURRING)
                .distinctAssessedSessionsCount(eval.distinctAssessedSessionsCount())
                .metrics(eval.metrics())
                .recurringIssues(eval.recurringIssues())
                .singleSessionObservations(eval.singleSessionObservations())
                .strongPatterns(eval.strongPatterns())
                .build();
    }

    /**
     * Lazy Paginated History subsection ({@code GET /api/v1/speaking/profile/history}).
     * Zero N+1 queries and zero heavy diagnostic JSON reads.
     */
    @Transactional(readOnly = true)
    public SpeakingSessionHistoryPageDto getHistory(
            Long userId,
            String mode,
            String status,
            int page,
            int size
    ) {
        requireUserId(userId);
        int safePage = Math.max(0, page);
        int safeSize = Math.max(1, Math.min(50, size));

        String normalizedMode = normalizeModeFilter(mode);
        String normalizedStatus = normalizeStatusFilter(status);

        List<SessionStatusModeRow> countRows = queryRepository.getSessionStatusAndModeCounts(userId);
        long allCount = 0;
        long completedCount = 0;
        long activeCount = 0;
        long shadowingCount = 0;
        long roleplayCount = 0;
        long quickCheckCount = 0;
        long filteredTotal = 0;

        for (SessionStatusModeRow r : countRows) {
            long c = r.count();
            allCount += c;
            if ("COMPLETED".equalsIgnoreCase(r.status())) completedCount += c;
            if ("ACTIVE".equalsIgnoreCase(r.status())) activeCount += c;
            if ("SHADOWING".equalsIgnoreCase(r.mode())) shadowingCount += c;
            else if ("ROLEPLAY".equalsIgnoreCase(r.mode())) roleplayCount += c;
            else if ("QUICK_CHECK".equalsIgnoreCase(r.mode())) quickCheckCount += c;

            boolean modeMatches = "ALL".equals(normalizedMode) || normalizedMode.equalsIgnoreCase(r.mode());
            boolean statusMatches = "ALL".equals(normalizedStatus) || normalizedStatus.equalsIgnoreCase(r.status());
            if (modeMatches && statusMatches) {
                filteredTotal += c;
            }
        }

        int totalPages = filteredTotal == 0 ? 0 : (int) Math.ceil((double) filteredTotal / safeSize);
        List<SpeakingSession> pageSessions = filteredTotal == 0
                ? List.of()
                : queryRepository.findPaginatedSessions(userId, normalizedMode, normalizedStatus, safePage, safeSize);

        List<SpeakingSessionSummaryDto> summaries = buildSessionSummariesBatch(userId, pageSessions);

        return SpeakingSessionHistoryPageDto.builder()
                .content(summaries)
                .page(safePage)
                .size(safeSize)
                .totalElements(filteredTotal)
                .totalPages(totalPages)
                .hasNext((long) (safePage + 1) * safeSize < filteredTotal)
                .modeFilter(normalizedMode)
                .statusFilter(normalizedStatus)
                .counts(new SpeakingSessionHistoryPageDto.FilterCounts(
                        allCount, completedCount, activeCount, shadowingCount, roleplayCount, quickCheckCount
                ))
                .build();
    }

    /**
     * Drill-down detail for a single speaking session (reuses owner-checked {@code SpeakingProgressAggregationService}).
     */
    @Transactional(readOnly = true)
    public SpeakingSessionDetailDto getSessionDetail(Long userId, Long sessionId) {
        requireUserId(userId);
        return legacyAggregationService.getSpeakingSessionDetail(userId, sessionId);
    }

    // =========================================================================
    // INTERNAL ANALYTICS HELPERS
    // =========================================================================

    private List<SpeakingSessionSummaryDto> buildSessionSummariesBatch(Long userId, List<SpeakingSession> sessions) {
        if (sessions == null || sessions.isEmpty()) {
            return List.of();
        }
        List<Long> sessionIds = sessions.stream().map(SpeakingSession::getId).toList();
        Set<Long> shadowingMatIds = sessions.stream()
                .filter(s -> !"ROLEPLAY".equalsIgnoreCase(s.getMode()) && !"QUICK_CHECK".equalsIgnoreCase(s.getMode()))
                .map(SpeakingSession::getSourceId)
                .filter(Objects::nonNull)
                .collect(Collectors.toSet());

        List<Long> qcSessionIds = sessions.stream()
                .filter(s -> "QUICK_CHECK".equalsIgnoreCase(s.getMode()))
                .map(SpeakingSession::getId)
                .toList();

        Map<Long, ShadowingSessionBatchStats> shStats = queryRepository.aggregateShadowingStatsBySessionIds(sessionIds);
        Map<Long, RoleplaySessionBatchStats> rpStats = queryRepository.aggregateRoleplayStatsBySessionIds(sessionIds);
        Map<Long, QuickCheckSessionBatchSummary> qcStats = queryRepository.findQuickCheckSummariesBySessionIds(qcSessionIds);
        Map<Long, VisibleMaterialMeta> materials = queryRepository.findVisibleMaterialsByIds(userId, shadowingMatIds);

        List<SpeakingSessionSummaryDto> out = new ArrayList<>(sessions.size());
        for (SpeakingSession s : sessions) {
            String mode = s.getMode() != null ? s.getMode().toUpperCase(Locale.ROOT) : "SHADOWING";
            if ("QUICK_CHECK".equals(mode)) {
                QuickCheckSessionBatchSummary qc = qcStats.get(s.getId());
                String title = (qc != null && qc.intendedTranscript() != null && !qc.intendedTranscript().isBlank())
                        ? qc.intendedTranscript()
                        : (qc != null && qc.whisperTranscript() != null && !qc.whisperTranscript().isBlank()
                            ? qc.whisperTranscript()
                            : "Kiểm tra nhanh phát âm");
                out.add(SpeakingSessionSummaryDto.builder()
                        .sessionId(s.getId())
                        .materialId(null)
                        .materialTitle(title)
                        .mode(mode)
                        .status(s.getStatus())
                        .sentencesPracticed(1)
                        .totalSentences(1)
                        .attemptCount(1)
                        .retryCount(0)
                        .resolvedTargetCount(0)
                        .durationSeconds(s.getDurationSeconds())
                        .averagePronunciationScore(qc != null ? qc.overallScore() : null)
                        .averageAccuracyScore(null)
                        .cefrLevel(null)
                        .createdAt(s.getCreatedAt())
                        .updatedAt(s.getUpdatedAt())
                        .build());
            } else if ("ROLEPLAY".equals(mode)) {
                RoleplaySessionBatchStats rp = rpStats.get(s.getId());
                SpeakingScenario sc = s.getScenario();
                int turns = rp != null ? rp.learnerTurnCount() : 0;
                Integer dur = s.getDurationSeconds() != null && s.getDurationSeconds() > 0
                        ? s.getDurationSeconds()
                        : (rp != null && rp.durationSeconds() > 0 ? rp.durationSeconds() : null);
                out.add(SpeakingSessionSummaryDto.builder()
                        .sessionId(s.getId())
                        .materialId(sc != null ? sc.getId() : null)
                        .materialTitle(sc != null ? sc.getTitle() : "Hội thoại AI Role-play")
                        .mode(mode)
                        .status(s.getStatus())
                        .sentencesPracticed(turns)
                        .totalSentences(turns)
                        .attemptCount(turns)
                        .retryCount(0)
                        .resolvedTargetCount(0)
                        .durationSeconds(dur)
                        .averagePronunciationScore(rp != null ? rp.avgPronunciationScore() : null)
                        .averageAccuracyScore(null)
                        .cefrLevel(sc != null && sc.getCefrLevel() != null ? sc.getCefrLevel().name() : null)
                        .createdAt(s.getCreatedAt())
                        .updatedAt(s.getUpdatedAt())
                        .build());
            } else {
                ShadowingSessionBatchStats sh = shStats.get(s.getId());
                VisibleMaterialMeta mat = s.getSourceId() != null ? materials.get(s.getSourceId()) : null;
                Integer dur = s.getDurationSeconds() != null && s.getDurationSeconds() > 0
                        ? s.getDurationSeconds()
                        : (sh != null && sh.durationSeconds() > 0 ? sh.durationSeconds() : null);
                out.add(SpeakingSessionSummaryDto.builder()
                        .sessionId(s.getId())
                        .materialId(s.getSourceId())
                        .materialTitle(mat != null ? mat.title() : "Bài luyện Shadowing")
                        .mode(mode)
                        .status(s.getStatus())
                        .sentencesPracticed(s.getCompletedUnitsCount() != null ? s.getCompletedUnitsCount() : 0)
                        .totalSentences(s.getTotalUnitsCount() != null ? s.getTotalUnitsCount() : 0)
                        .attemptCount(sh != null ? sh.attemptCount() : 0)
                        .retryCount(sh != null ? sh.retryCount() : 0)
                        .resolvedTargetCount(sh != null ? sh.resolvedCount() : 0)
                        .durationSeconds(dur)
                        .averagePronunciationScore(sh != null ? sh.avgPronunciationScore() : null)
                        .averageAccuracyScore(sh != null ? sh.avgAccuracyScore() : null)
                        .cefrLevel(mat != null ? mat.cefrLevel() : null)
                        .createdAt(s.getCreatedAt())
                        .updatedAt(s.getUpdatedAt())
                        .build());
            }
        }
        return out;
    }

    private List<SpeakingScoreTrendPointDto> buildChronologicalScoreTrend(
            Long userId,
            List<SpeakingSession> sessions30dDesc
    ) {
        if (sessions30dDesc == null || sessions30dDesc.isEmpty()) {
            return List.of();
        }
        List<SpeakingSessionSummaryDto> summariesDesc = buildSessionSummariesBatch(userId, sessions30dDesc);
        Map<Long, SpeakingSession> sessionById = sessions30dDesc.stream()
                .collect(Collectors.toMap(SpeakingSession::getId, s -> s, (a, b) -> a));

        List<Long> qcIds = sessions30dDesc.stream()
                .filter(s -> "QUICK_CHECK".equalsIgnoreCase(s.getMode()))
                .map(SpeakingSession::getId)
                .toList();
        Map<Long, QuickCheckSessionBatchSummary> qcStats = queryRepository.findQuickCheckSummariesBySessionIds(qcIds);

        List<SpeakingScoreTrendPointDto> scoredDesc = new ArrayList<>();
        for (SpeakingSessionSummaryDto sum : summariesDesc) {
            Double pron = sum.getAveragePronunciationScore();
            Double acc = sum.getAverageAccuracyScore();
            Double flu = null;
            if ("QUICK_CHECK".equalsIgnoreCase(sum.getMode())) {
                QuickCheckSessionBatchSummary qc = qcStats.get(sum.getSessionId());
                if (qc != null) flu = qc.fluencyScore();
            }
            if (pron == null && acc == null) {
                continue;
            }
            SpeakingSession raw = sessionById.get(sum.getSessionId());
            scoredDesc.add(SpeakingScoreTrendPointDto.builder()
                    .sessionId(sum.getSessionId())
                    .mode(sum.getMode())
                    .title(sum.getMaterialTitle())
                    .timestamp(sum.getCreatedAt() != null ? sum.getCreatedAt() : (raw != null ? raw.getCreatedAt() : LocalDateTime.now()))
                    .pronunciationScore(pron)
                    .contentMatchScore(acc)
                    .fluencyScore(flu)
                    .attemptCount(sum.getAttemptCount() != null ? sum.getAttemptCount() : 1)
                    .build());
            if (scoredDesc.size() >= 15) {
                break;
            }
        }
        Collections.reverse(scoredDesc);
        return scoredDesc;
    }

    private List<SpeakingStrengthItemDto> buildEvidenceBackedStrengths(
            SpeakingPronunciationMetricsDto metrics,
            SpeakingWindowActivityDto window,
            SpeakingLifetimeStatsDto lifetime
    ) {
        List<StrengthCandidate> candidates = new ArrayList<>();

        long scoredCount = metrics.getScoredAttemptsCount() != null ? metrics.getScoredAttemptsCount() : 0L;
        long contentCount = metrics.getContentMatchAttemptsCount() != null ? metrics.getContentMatchAttemptsCount() : 0L;
        long stressCount = metrics.getLexicalStressAssessmentsCount() != null ? metrics.getLexicalStressAssessmentsCount() : 0L;

        if (contentCount >= MIN_SCORED_ATTEMPTS_FOR_STRENGTH
                && metrics.getAverageContentMatchScore() != null
                && metrics.getAverageContentMatchScore() >= STRENGTH_SCORE_THRESHOLD) {
            double sc = metrics.getAverageContentMatchScore();
            candidates.add(new StrengthCandidate(sc, SpeakingStrengthItemDto.builder()
                    .id("content_match")
                    .evidenceType("ACOUSTIC")
                    .metricKey("averageContentMatchScore")
                    .titleVi("Khớp từ và nội dung chuẩn xác")
                    .titleEn("Accurate word and content fidelity")
                    .detailVi("Độ khớp nội dung Whisper STT đạt trung bình " + Math.round(sc) + "% qua " + contentCount + " lượt thu âm.")
                    .detailEn("Average Whisper STT content match of " + Math.round(sc) + "% across " + contentCount + " recorded attempts.")
                    .score(sc)
                    .unit("%")
                    .sampleSize(contentCount)
                    .windowLabelVi("30 ngày gần nhất")
                    .windowLabelEn("Last 30 days")
                    .build()));
        }

        if (scoredCount >= MIN_SCORED_ATTEMPTS_FOR_STRENGTH
                && metrics.getAveragePhonemeScore() != null
                && metrics.getAveragePhonemeScore() >= STRENGTH_SCORE_THRESHOLD) {
            double sc = metrics.getAveragePhonemeScore();
            candidates.add(new StrengthCandidate(sc, SpeakingStrengthItemDto.builder()
                    .id("phoneme_precision")
                    .evidenceType("ACOUSTIC")
                    .metricKey("averagePhonemeScore")
                    .titleVi("Độ chuẩn xác âm vị (Phonemes)")
                    .titleEn("Segmental phoneme accuracy")
                    .detailVi("Điểm âm vị V2.2 đạt trung bình " + Math.round(sc) + "/100 qua " + scoredCount + " lượt phân tích âm học.")
                    .detailEn("Average V2.2 phoneme score of " + Math.round(sc) + "/100 across " + scoredCount + " acoustic assessments.")
                    .score(sc)
                    .unit("/100")
                    .sampleSize(scoredCount)
                    .windowLabelVi("30 ngày gần nhất")
                    .windowLabelEn("Last 30 days")
                    .build()));
        }

        if (stressCount >= MIN_SCORED_ATTEMPTS_FOR_STRENGTH
                && metrics.getAverageStressScore() != null
                && metrics.getAverageStressScore() >= STRENGTH_SCORE_THRESHOLD) {
            double sc = metrics.getAverageStressScore();
            long matchedW = metrics.getLexicalStressMatchedWords() != null ? metrics.getLexicalStressMatchedWords() : 0L;
            long assessedW = metrics.getLexicalStressAssessedWords() != null ? metrics.getLexicalStressAssessedWords() : 0L;
            String wordRatioVi = assessedW > 0 ? " (" + matchedW + "/" + assessedW + " từ đa âm tiết khớp trọng âm)" : "";
            String wordRatioEn = assessedW > 0 ? " (" + matchedW + "/" + assessedW + " multisyllabic words matched)" : "";
            candidates.add(new StrengthCandidate(sc, SpeakingStrengthItemDto.builder()
                    .id("lexical_stress")
                    .evidenceType("ACOUSTIC")
                    .metricKey("averageStressScore")
                    .titleVi("Kiểm soát trọng âm từ (Lexical Stress)")
                    .titleEn("Lexical stress control")
                    .detailVi("Trọng âm từ đạt trung bình " + Math.round(sc) + "/100" + wordRatioVi + ".")
                    .detailEn("Average lexical stress score of " + Math.round(sc) + "/100" + wordRatioEn + ".")
                    .score(sc)
                    .unit("/100")
                    .sampleSize(stressCount)
                    .windowLabelVi("30 ngày gần nhất")
                    .windowLabelEn("Last 30 days")
                    .build()));
        }

        if (scoredCount >= MIN_SCORED_ATTEMPTS_FOR_STRENGTH
                && metrics.getAverageFluencyScore() != null
                && metrics.getAverageFluencyScore() >= STRENGTH_SCORE_THRESHOLD) {
            double sc = metrics.getAverageFluencyScore();
            candidates.add(new StrengthCandidate(sc, SpeakingStrengthItemDto.builder()
                    .id("fluency")
                    .evidenceType("ACOUSTIC")
                    .metricKey("averageFluencyScore")
                    .titleVi("Nhịp nói và độ lưu loát ổn định")
                    .titleEn("Steady speaking fluency")
                    .detailVi("Độ lưu loát V2.2 đạt trung bình " + Math.round(sc) + "/100 qua " + scoredCount + " lượt phân tích.")
                    .detailEn("Average V2.2 fluency score of " + Math.round(sc) + "/100 across " + scoredCount + " assessments.")
                    .score(sc)
                    .unit("/100")
                    .sampleSize(scoredCount)
                    .windowLabelVi("30 ngày gần nhất")
                    .windowLabelEn("Last 30 days")
                    .build()));
        }

        if (scoredCount >= MIN_SCORED_ATTEMPTS_FOR_STRENGTH
                && metrics.getAveragePronunciationScore() != null
                && metrics.getAveragePronunciationScore() >= STRENGTH_SCORE_THRESHOLD) {
            double sc = metrics.getAveragePronunciationScore();
            candidates.add(new StrengthCandidate(sc - 0.5, SpeakingStrengthItemDto.builder()
                    .id("overall_pronunciation")
                    .evidenceType("ACOUSTIC")
                    .metricKey("averagePronunciationScore")
                    .titleVi("Nền tảng phát âm tổng thể V2.2")
                    .titleEn("Overall V2.2 pronunciation")
                    .detailVi("Điểm phát âm tổng thể trung bình đạt " + Math.round(sc) + "/100 (" + scoredCount + " lượt chấm).")
                    .detailEn("Overall V2.2 pronunciation averaging " + Math.round(sc) + "/100 (" + scoredCount + " scored attempts).")
                    .score(sc)
                    .unit("/100")
                    .sampleSize(scoredCount)
                    .windowLabelVi("30 ngày gần nhất")
                    .windowLabelEn("Last 30 days")
                    .build()));
        }

        if (window.resolvedTargets30d() >= 2) {
            candidates.add(new StrengthCandidate(68.0, SpeakingStrengthItemDto.builder()
                    .id("retry_resolution")
                    .evidenceType("RETRY_RESOLUTION")
                    .metricKey("resolvedTargets30d")
                    .titleVi("Tự sửa lỗi hiệu quả ngay trong phiên")
                    .titleEn("Effective within-session self-correction")
                    .detailVi("Đã khắc phục thành công " + window.resolvedTargets30d() + " mục tiêu phát âm qua các lượt thử lại.")
                    .detailEn("Successfully resolved " + window.resolvedTargets30d() + " pronunciation targets during retries.")
                    .score((double) window.resolvedTargets30d())
                    .unit("targets")
                    .sampleSize(window.resolvedTargets30d())
                    .windowLabelVi("30 ngày gần nhất")
                    .windowLabelEn("Last 30 days")
                    .build()));
        }

        if (window.practiceDays30d() >= 3) {
            candidates.add(new StrengthCandidate(64.0, SpeakingStrengthItemDto.builder()
                    .id("consistency_30d")
                    .evidenceType("CONSISTENCY")
                    .metricKey("practiceDays30d")
                    .titleVi("Duy trì nhịp luyện nói đều đặn")
                    .titleEn("Consistent speaking rhythm")
                    .detailVi("Có hoạt động luyện nói thực tế trong " + window.practiceDays30d() + "/30 ngày gần nhất.")
                    .detailEn("Active speaking practice on " + window.practiceDays30d() + " of the last 30 days.")
                    .score((double) window.practiceDays30d())
                    .unit("days")
                    .sampleSize(window.practiceDays30d())
                    .windowLabelVi("30 ngày gần nhất")
                    .windowLabelEn("Last 30 days")
                    .build()));
        } else if (lifetime.completedSessions() >= 3) {
            candidates.add(new StrengthCandidate(60.0, SpeakingStrengthItemDto.builder()
                    .id("lifetime_completed")
                    .evidenceType("CONSISTENCY")
                    .metricKey("completedSessions")
                    .titleVi("Tích lũy phiên luyện nói hoàn chỉnh")
                    .titleEn("Completed speaking sessions")
                    .detailVi("Đã hoàn thành trọn vẹn " + lifetime.completedSessions() + " phiên luyện nói tích lũy.")
                    .detailEn("Completed " + lifetime.completedSessions() + " full speaking sessions overall.")
                    .score((double) lifetime.completedSessions())
                    .unit("sessions")
                    .sampleSize(lifetime.completedSessions())
                    .windowLabelVi("Toàn thời gian")
                    .windowLabelEn("All time")
                    .build()));
        }

        candidates.sort(Comparator.comparingDouble(StrengthCandidate::rank).reversed());
        return candidates.stream().limit(4).map(StrengthCandidate::item).toList();
    }

    private PronunciationEvaluation evaluatePronunciation30d(
            List<SpeakingShadowingAttempt> attempts,
            List<SpeakingQuickCheck> quickChecks,
            List<SpeakingTurn> roleplayTurns,
            Map<Long, VisibleMaterialMeta> visibleMaterials
    ) {
        double sumPron = 0.0;
        int countPron = 0;
        double sumAccuracy = 0.0;
        int countAccuracy = 0;
        double sumSegmental = 0.0;
        int countSegmental = 0;
        double sumStress = 0.0;
        int countStress = 0;
        double sumPitch = 0.0;
        int countPitch = 0;
        double sumRhythm = 0.0;
        int countRhythm = 0;
        double sumFluency = 0.0;
        int countFluency = 0;

        long abstainedCount = 0;
        long sttOnlyCount = 0;
        long stressMatchedWords = 0;
        long stressAssessedWords = 0;
        long shadowingScored = 0;
        long quickCheckScored = 0;
        long roleplayScored = 0;

        Set<Long> distinctAssessedSessionIds = new HashSet<>();
        Map<String, PhonemePatternTracker> phonemeTrackers = new HashMap<>();
        Map<String, IssueTracker> issueTrackers = new LinkedHashMap<>();
        Map<String, Map<Long, LocalDateTime>> cleanWordSessions = new HashMap<>();
        Map<String, Map<Long, LocalDateTime>> cleanPhoneSessions = new HashMap<>();

        // 1. Shadowing attempts
        for (SpeakingShadowingAttempt att : attempts) {
            Long sessionId = att.getSession() != null ? att.getSession().getId() : null;
            LocalDateTime ts = att.getCreatedAt() != null ? att.getCreatedAt() : LocalDateTime.now();

            if (att.getAccuracyScore() != null) {
                sumAccuracy += att.getAccuracyScore();
                countAccuracy++;
            }

            boolean scored = false;
            if (att.getPronunciationScore() != null) {
                sumPron += att.getPronunciationScore();
                countPron++;
                shadowingScored++;
                scored = true;
                if (sessionId != null) distinctAssessedSessionIds.add(sessionId);
            }
            if (att.getFluencyScore() != null) {
                sumFluency += att.getFluencyScore();
                countFluency++;
            }

            boolean explicitlyAbstained = "ABSTAINED".equalsIgnoreCase(att.getAnalysisStatus());
            ParsedV2Payload v2 = parseV2Json(att.getProductSafeResultJson());
            if (v2 != null) {
                if (v2.abstained) explicitlyAbstained = true;
                if (v2.segmentalScore != null) {
                    sumSegmental += v2.segmentalScore;
                    countSegmental++;
                }
                if (v2.stressScore != null) {
                    sumStress += v2.stressScore;
                    countStress++;
                    stressMatchedWords += v2.stressMatched;
                    stressAssessedWords += v2.stressAssessed;
                }
                if (v2.intonationScore != null) {
                    sumPitch += v2.intonationScore;
                    countPitch++;
                }
                if (v2.rhythmScore != null) {
                    sumRhythm += v2.rhythmScore;
                    countRhythm++;
                }
                if (att.getFluencyScore() == null && v2.fluencyScore != null) {
                    sumFluency += v2.fluencyScore;
                    countFluency++;
                }
                ingestPhonemeObservations(v2, sessionId, ts, phonemeTrackers, cleanWordSessions, cleanPhoneSessions);
            }

            if (!scored) {
                if (explicitlyAbstained) abstainedCount++;
                else sttOnlyCount++;
            }

            // Issue extraction for Shadowing
            String issueType = att.getPrimaryIssueType();
            String targetWord = att.getTargetWord();
            String targetPhone = v2 != null ? v2.priorityPhone : null;
            String observedPhone = v2 != null ? v2.priorityObserved : null;
            String instructionVi = v2 != null ? v2.priorityInstructionVi : null;
            if ((issueType == null || issueType.isBlank()) && v2 != null && v2.priorityIssueType != null) {
                issueType = v2.priorityIssueType;
                if (targetWord == null) targetWord = v2.priorityWord;
            }

            if (sessionId != null && isActionableIssueType(issueType)) {
                Long sourceId = att.getSession().getSourceId();
                VisibleMaterialMeta mat = sourceId != null ? visibleMaterials.get(sourceId) : null;
                String sourceTitle = mat != null ? mat.title() : "Bài luyện Shadowing";
                String snippet = att.getShadowingUnit() != null
                        ? att.getShadowingUnit().getDisplayText()
                        : (att.getLearnerTranscript() != null ? att.getLearnerTranscript() : targetWord);
                String route = sourceId != null ? "/speaking/shadowing/" + sourceId : "/speaking?mode=shadowing";

                recordIssueOccurrence(
                        issueTrackers,
                        issueType,
                        targetWord,
                        targetPhone,
                        observedPhone,
                        att.getPronunciationScore(),
                        instructionVi,
                        sessionId,
                        Boolean.TRUE.equals(att.getResolvedThisSession()),
                        ts,
                        snippet,
                        sourceTitle,
                        sourceId,
                        "SHADOWING",
                        route,
                        "Luyện lại bài này"
                );
            }
        }

        // 2. Quick Checks
        for (SpeakingQuickCheck qc : quickChecks) {
            Long sessionId = qc.getSession() != null ? qc.getSession().getId() : (-1_000_000L - (qc.getId() != null ? qc.getId() : 0L));
            LocalDateTime ts = qc.getCreatedAt() != null ? qc.getCreatedAt() : LocalDateTime.now();

            boolean scored = false;
            if (qc.getOverallScore() != null) {
                sumPron += qc.getOverallScore();
                countPron++;
                quickCheckScored++;
                scored = true;
                distinctAssessedSessionIds.add(sessionId);
            }
            if (qc.getPhonemeScore() != null) {
                sumSegmental += qc.getPhonemeScore();
                countSegmental++;
            }
            if (qc.getPitchScore() != null) {
                sumPitch += qc.getPitchScore();
                countPitch++;
            }
            if (qc.getRhythmScore() != null) {
                sumRhythm += qc.getRhythmScore();
                countRhythm++;
            }
            if (qc.getFluencyScore() != null) {
                sumFluency += qc.getFluencyScore();
                countFluency++;
            }

            ParsedV2Payload v2 = parseV2Json(qc.getPronunciationDiagnosticsJson());
            boolean qcAbstained = v2 != null && v2.abstained;
            if (v2 != null && v2.stressScore != null) {
                sumStress += v2.stressScore;
                countStress++;
                stressMatchedWords += v2.stressMatched;
                stressAssessedWords += v2.stressAssessed;
            } else {
                Integer measuredStress = PronunciationV2ResponseDto.historicalStressScore(qc.getPronunciationDiagnosticsJson());
                if (measuredStress != null) {
                    sumStress += measuredStress;
                    countStress++;
                }
            }
            if (v2 != null) {
                ingestPhonemeObservations(v2, sessionId, ts, phonemeTrackers, cleanWordSessions, cleanPhoneSessions);
                if (scored && isActionableIssueType(v2.priorityIssueType)) {
                    String snippet = qc.getIntendedTranscript() != null && !qc.getIntendedTranscript().isBlank()
                            ? qc.getIntendedTranscript()
                            : qc.getWhisperTranscript();
                    recordIssueOccurrence(
                            issueTrackers,
                            v2.priorityIssueType,
                            v2.priorityWord,
                            v2.priorityPhone,
                            v2.priorityObserved,
                            qc.getOverallScore(),
                            v2.priorityInstructionVi,
                            sessionId,
                            false,
                            ts,
                            snippet,
                            "Kiểm tra nhanh",
                            null,
                            "QUICK_CHECK",
                            "/speaking?mode=assessment",
                            "Kiểm tra nhanh lại"
                    );
                }
            }

            if (!scored) {
                if (qcAbstained) abstainedCount++;
                else sttOnlyCount++;
            }
        }

        // 3. Role-play Learner Turns
        for (SpeakingTurn turn : roleplayTurns) {
            Long sessionId = turn.getSession() != null ? turn.getSession().getId() : null;
            LocalDateTime ts = turn.getCreatedAt() != null ? turn.getCreatedAt() : LocalDateTime.now();

            boolean scored = false;
            if (turn.getPronunciationScore() != null) {
                sumPron += turn.getPronunciationScore();
                countPron++;
                roleplayScored++;
                scored = true;
                if (sessionId != null) distinctAssessedSessionIds.add(sessionId);
            }
            if (turn.getSegmentalScore() != null) {
                sumSegmental += turn.getSegmentalScore();
                countSegmental++;
            }
            if (turn.getIntonationScore() != null) {
                sumPitch += turn.getIntonationScore();
                countPitch++;
            }
            if (turn.getRhythmScore() != null) {
                sumRhythm += turn.getRhythmScore();
                countRhythm++;
            }
            if (turn.getFluencyScore() != null) {
                sumFluency += turn.getFluencyScore();
                countFluency++;
            }

            ParsedV2Payload v2 = parseV2Json(turn.getPronunciationResultJson());
            boolean turnAbstained = v2 != null && v2.abstained;
            if (v2 != null && v2.stressScore != null) {
                sumStress += v2.stressScore;
                countStress++;
                stressMatchedWords += v2.stressMatched;
                stressAssessedWords += v2.stressAssessed;
            }
            if (v2 != null && sessionId != null) {
                ingestPhonemeObservations(v2, sessionId, ts, phonemeTrackers, cleanWordSessions, cleanPhoneSessions);
                if (scored && isActionableIssueType(v2.priorityIssueType)) {
                    SpeakingScenario sc = turn.getSession().getScenario();
                    String scTitle = sc != null ? sc.getTitle() : "Hội thoại AI Role-play";
                    Long scId = sc != null ? sc.getId() : null;
                    String route = scId != null ? "/speaking/roleplay/" + scId : "/speaking?mode=roleplay";
                    recordIssueOccurrence(
                            issueTrackers,
                            v2.priorityIssueType,
                            v2.priorityWord,
                            v2.priorityPhone,
                            v2.priorityObserved,
                            turn.getPronunciationScore() != null ? turn.getPronunciationScore().doubleValue() : null,
                            v2.priorityInstructionVi,
                            sessionId,
                            false,
                            ts,
                            turn.getText(),
                            scTitle,
                            scId,
                            "ROLEPLAY",
                            route,
                            "Luyện lại tình huống này"
                    );
                }
            }

            if (!scored) {
                if (turnAbstained) abstainedCount++;
                else sttOnlyCount++;
            }
        }

        long totalAttempts = (long) attempts.size() + quickChecks.size() + roleplayTurns.size();
        SpeakingPronunciationMetricsDto metricsDto = SpeakingPronunciationMetricsDto.builder()
                .averagePronunciationScore(countPron > 0 ? round1(sumPron / countPron) : null)
                .averageContentMatchScore(countAccuracy > 0 ? round1(sumAccuracy / countAccuracy) : null)
                .averagePhonemeScore(countSegmental > 0 ? round1(sumSegmental / countSegmental) : null)
                .averageStressScore(countStress > 0 ? round1(sumStress / countStress) : null)
                .averagePitchScore(countPitch > 0 ? round1(sumPitch / countPitch) : null)
                .averageRhythmScore(countRhythm > 0 ? round1(sumRhythm / countRhythm) : null)
                .averageFluencyScore(countFluency > 0 ? round1(sumFluency / countFluency) : null)
                .scoredAttemptsCount((long) countPron)
                .totalAttemptsCount(totalAttempts)
                .abstainedAttemptsCount(abstainedCount)
                .sttOnlyAttemptsCount(sttOnlyCount)
                .lexicalStressMatchedWords(stressMatchedWords)
                .lexicalStressAssessedWords(stressAssessedWords)
                .lexicalStressAssessmentsCount((long) countStress)
                .contentMatchAttemptsCount((long) countAccuracy)
                .shadowingScoredCount(shadowingScored)
                .quickCheckScoredCount(quickCheckScored)
                .roleplayScoredCount(roleplayScored)
                .build();

        // Classify recurring (>= 2 distinct sessions) vs single-session (INSUFFICIENT_DATA)
        List<SpeakingRecurringIssueDto> recurringIssues = new ArrayList<>();
        List<SpeakingRecurringIssueDto> singleSessionIssues = new ArrayList<>();

        for (IssueTracker tr : issueTrackers.values()) {
            int distinctCount = tr.sessionIds.size();
            int resolvedInSessionCount = tr.resolvedSessionIds.size();

            // Check subsequent clean sessions where the same target word or phone was pronounced cleanly after last error
            int subsequentCleanSessions = countSubsequentCleanSessions(
                    tr, cleanWordSessions, cleanPhoneSessions);
            int totalResolvedOrClean = Math.max(resolvedInSessionCount, resolvedInSessionCount + subsequentCleanSessions);

            Double avgQ = tr.qualityCount > 0 ? round1(tr.qualitySum / tr.qualityCount) : null;
            String title = formatIssueTitle(tr.category, tr.issueType, tr.targetWord, tr.targetPhone);
            String cue = (tr.instructionVi != null && !tr.instructionVi.isBlank())
                    ? tr.instructionVi
                    : defaultCueForIssue(tr.issueType, tr.targetWord, tr.targetPhone);

            if (distinctCount >= MIN_DISTINCT_SESSIONS_FOR_RECURRING) {
                String status;
                String explanation;
                if ((resolvedInSessionCount >= 2 && resolvedInSessionCount == distinctCount && tr.latestResolved)
                        || subsequentCleanSessions >= 2) {
                    status = "RECENTLY_STABLE";
                    int stableRef = subsequentCleanSessions >= 2 ? subsequentCleanSessions : resolvedInSessionCount;
                    explanation = "Đã ổn định gần đây • Phát âm chuẩn xác qua " + stableRef + " phiên gần nhất";
                } else if (totalResolvedOrClean >= 2 && totalResolvedOrClean >= (distinctCount / 2)) {
                    status = "IMPROVING";
                    explanation = "Đang tiến bộ • Đã cải thiện trong " + Math.min(totalResolvedOrClean, distinctCount) + "/" + distinctCount + " phiên luyện tập";
                } else if (totalResolvedOrClean > 0) {
                    status = "PRACTICING";
                    explanation = "Đang luyện tập • Đã có phiên cải thiện thành công (" + Math.min(totalResolvedOrClean, distinctCount) + "/" + distinctCount + " phiên)";
                } else {
                    status = "NEEDS_ATTENTION";
                    explanation = "Cần chú ý thêm • Xuất hiện trong " + distinctCount + " phiên riêng biệt, chưa khắc phục dứt điểm";
                }

                recurringIssues.add(SpeakingRecurringIssueDto.builder()
                        .issueKey(tr.key)
                        .category(tr.category)
                        .title(title)
                        .issueType(tr.issueType)
                        .targetWord(tr.targetWord)
                        .targetPhone(tr.targetPhone)
                        .observedPhone(tr.observedPhone)
                        .averageQualityScore(avgQ)
                        .status(status)
                        .statusExplanation(explanation)
                        .distinctSessionsObserved(distinctCount)
                        .totalOccurrences(tr.occurrences)
                        .resolvedSessionCount(resolvedInSessionCount)
                        .lastObservedAt(tr.lastObservedAt)
                        .displayCue(cue)
                        .evidenceWindow("30 ngày gần nhất")
                        .recentExamples(new ArrayList<>(tr.examples))
                        .practiceAgainRoute(tr.practiceRoute)
                        .practiceAgainLabel(tr.practiceLabel)
                        .build());
            } else if (distinctCount == 1) {
                singleSessionIssues.add(SpeakingRecurringIssueDto.builder()
                        .issueKey(tr.key)
                        .category(tr.category)
                        .title(title)
                        .issueType(tr.issueType)
                        .targetWord(tr.targetWord)
                        .targetPhone(tr.targetPhone)
                        .observedPhone(tr.observedPhone)
                        .averageQualityScore(avgQ)
                        .status("INSUFFICIENT_DATA")
                        .statusExplanation("Chưa đủ dữ liệu lặp lại • Mới ghi nhận trong 1 phiên, cần thêm ít nhất 1 phiên khác để kết luận")
                        .distinctSessionsObserved(1)
                        .totalOccurrences(tr.occurrences)
                        .resolvedSessionCount(resolvedInSessionCount)
                        .lastObservedAt(tr.lastObservedAt)
                        .displayCue(cue)
                        .evidenceWindow("30 ngày gần nhất")
                        .recentExamples(new ArrayList<>(tr.examples))
                        .practiceAgainRoute(tr.practiceRoute)
                        .practiceAgainLabel(tr.practiceLabel)
                        .build());
            }
        }

        sortRecurringIssues(recurringIssues);
        singleSessionIssues.sort(Comparator.comparing(
                SpeakingRecurringIssueDto::getLastObservedAt, Comparator.nullsLast(Comparator.reverseOrder())));
        if (singleSessionIssues.size() > 6) {
            singleSessionIssues = singleSessionIssues.subList(0, 6);
        }

        // Strong phoneme patterns
        List<SpeakingStrongPhonemePatternDto> strongPatterns = phonemeTrackers.values().stream()
                .filter(p -> p.observations >= MIN_PHONEME_OBS_FOR_STRONG_PATTERN
                        && p.distinctWords.size() >= 2
                        && p.attemptsCount >= 2
                        && ((double) p.acceptable / p.observations) >= STRONG_PATTERN_ACCEPTABLE_RATE
                        && (p.qualitySum / p.observations) >= STRONG_PATTERN_QUALITY_SCORE)
                .sorted(Comparator
                        .comparingDouble((PhonemePatternTracker p) -> p.qualitySum / p.observations).reversed()
                        .thenComparingInt((PhonemePatternTracker p) -> p.observations).reversed())
                .limit(6)
                .map(p -> {
                    PhoneMeta meta = lookupPhoneMeta(p.phone);
                    return SpeakingStrongPhonemePatternDto.builder()
                            .phone(p.phone)
                            .ipaDisplay(meta.ipaDisplay())
                            .categoryLabelVi(meta.categoryVi())
                            .categoryLabelEn(meta.categoryEn())
                            .observationsCount(p.observations)
                            .acceptableCount(p.acceptable)
                            .acceptableRate(Math.round(((double) p.acceptable / p.observations) * 1000.0) / 10.0)
                            .averageQualityScore(round1(p.qualitySum / p.observations))
                            .exampleWords(p.distinctWords.stream().limit(3).toList())
                            .build();
                })
                .toList();

        return new PronunciationEvaluation(
                distinctAssessedSessionIds.size(),
                metricsDto,
                recurringIssues,
                singleSessionIssues,
                strongPatterns
        );
    }

    private List<SpeakingRecurringIssueDto> computeGrammarVocabIssues(List<SpeakingTurnFeedback> feedbacks) {
        if (feedbacks == null || feedbacks.isEmpty()) {
            return List.of();
        }
        Map<String, List<FeedbackOcc>> grouped = new LinkedHashMap<>();
        for (SpeakingTurnFeedback fb : feedbacks) {
            if (fb.getCorrectionsJson() == null || fb.getCorrectionsJson().isBlank()) continue;
            if (fb.getTurn() == null || fb.getTurn().getSession() == null) continue;
            try {
                List<TurnCorrectionDto> corrections = objectMapper.readValue(
                        fb.getCorrectionsJson(), new TypeReference<List<TurnCorrectionDto>>() {});
                for (TurnCorrectionDto corr : corrections) {
                    String cat = corr.type() != null ? corr.type().toUpperCase(Locale.ROOT) : "GRAMMAR";
                    String key = cat + ":" + normalizeCorrectionKey(corr.explanation(), corr.original());
                    grouped.computeIfAbsent(key, k -> new ArrayList<>()).add(new FeedbackOcc(fb, corr, cat));
                }
            } catch (Exception e) {
                log.debug("Failed to parse roleplay turn correction JSON: {}", e.getMessage());
            }
        }

        List<SpeakingRecurringIssueDto> out = new ArrayList<>();
        for (Map.Entry<String, List<FeedbackOcc>> entry : grouped.entrySet()) {
            List<FeedbackOcc> list = entry.getValue();
            Set<Long> sessionIds = list.stream()
                    .map(o -> o.fb.getTurn().getSession().getId())
                    .collect(Collectors.toSet());
            if (sessionIds.size() < MIN_DISTINCT_SESSIONS_FOR_RECURRING) continue;

            FeedbackOcc latest = list.getLast();
            int distinctCount = sessionIds.size();
            String cat = latest.category;
            String title = formatGrammarVocabTitle(cat, latest.corr);
            String cue = latest.corr.explanation() != null && !latest.corr.explanation().isBlank()
                    ? latest.corr.explanation()
                    : "Chú ý sử dụng đúng cấu trúc ngữ pháp và cách diễn đạt tự nhiên.";

            List<SpeakingIssueExampleDto> examples = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            for (int i = list.size() - 1; i >= 0 && examples.size() < 3; i--) {
                FeedbackOcc o = list.get(i);
                String orig = o.corr.original() != null ? o.corr.original() : "";
                if (seen.add(orig.toLowerCase(Locale.ROOT))) {
                    SpeakingScenario sc = o.fb.getTurn().getSession().getScenario();
                    examples.add(SpeakingIssueExampleDto.builder()
                            .originalPhrase(orig)
                            .suggestedPhrase(o.corr.suggestion())
                            .explanation(o.corr.explanation())
                            .sentenceSnippet(o.fb.getTurn().getText())
                            .sourceTitle(sc != null ? sc.getTitle() : "Hội thoại AI Role-play")
                            .sourceId(sc != null ? sc.getId() : null)
                            .mode("ROLEPLAY")
                            .timestamp(o.fb.getCreatedAt())
                            .build());
                }
            }

            SpeakingScenario latestSc = latest.fb.getTurn().getSession().getScenario();
            String route = latestSc != null ? "/speaking/roleplay/" + latestSc.getId() : "/speaking?mode=roleplay";

            out.add(SpeakingRecurringIssueDto.builder()
                    .issueKey(entry.getKey())
                    .category(cat)
                    .title(title)
                    .issueType(cat)
                    .targetWord(latest.corr.original())
                    .status("NEEDS_ATTENTION")
                    .statusExplanation("Gặp phải trong " + distinctCount + " phiên hội thoại gần đây")
                    .distinctSessionsObserved(distinctCount)
                    .totalOccurrences(list.size())
                    .resolvedSessionCount(0)
                    .lastObservedAt(latest.fb.getCreatedAt())
                    .displayCue(cue)
                    .evidenceWindow("30 ngày gần nhất")
                    .recentExamples(examples)
                    .practiceAgainRoute(route)
                    .practiceAgainLabel("Luyện lại tình huống này")
                    .build());
        }
        return out;
    }

    private List<SpeakingRecentImprovementDto> buildRecentImprovements(
            List<SpeakingShadowingAttempt> attempts,
            Map<Long, VisibleMaterialMeta> visibleMaterials
    ) {
        List<SpeakingRecentImprovementDto> out = new ArrayList<>();
        for (int i = attempts.size() - 1; i >= 0 && out.size() < 5; i--) {
            SpeakingShadowingAttempt att = attempts.get(i);
            if (!Boolean.TRUE.equals(att.getResolvedThisSession())) continue;
            String issueType = att.getPrimaryIssueType();
            if (issueType == null || "VALID_VARIANT".equalsIgnoreCase(issueType)) continue;
            Long sourceId = att.getSession() != null ? att.getSession().getSourceId() : null;
            VisibleMaterialMeta mat = sourceId != null ? visibleMaterials.get(sourceId) : null;
            out.add(SpeakingRecentImprovementDto.builder()
                    .sessionId(att.getSession() != null ? att.getSession().getId() : null)
                    .materialTitle(mat != null ? mat.title() : "Bài luyện Shadowing")
                    .targetWord(att.getTargetWord())
                    .targetPhone(null)
                    .issueType(issueType)
                    .retryCount(att.getRetryIndex() != null ? att.getRetryIndex() : 1)
                    .resolvedAt(att.getCreatedAt())
                    .note("Đã sửa thành công trong lần thử lại cùng phiên")
                    .build());
        }
        return out;
    }

    private long countRecurringTargetsLightweight(Long userId, LocalDateTime since) {
        Map<String, Set<Long>> sessionsByKey = new HashMap<>();

        for (ShadowingIssueMarkerRow row : queryRepository.findShadowingIssueMarkersSince(userId, since)) {
            if (row.sessionId() == null || !isActionableIssueType(row.primaryIssueType())) continue;
            String word = row.targetWord() != null ? row.targetWord().toLowerCase(Locale.ROOT).trim() : "";
            String key = "PRON:" + row.primaryIssueType().toUpperCase(Locale.ROOT).trim() + (word.isEmpty() ? "" : ":" + word);
            sessionsByKey.computeIfAbsent(key, k -> new HashSet<>()).add(row.sessionId());
        }

        for (FeedbackCorrectionMarkerRow row : queryRepository.findFeedbackCorrectionMarkersSince(userId, since)) {
            if (row.sessionId() == null || row.correctionsJson() == null || row.correctionsJson().isBlank()) continue;
            try {
                List<TurnCorrectionDto> corrs = objectMapper.readValue(
                        row.correctionsJson(), new TypeReference<List<TurnCorrectionDto>>() {});
                for (TurnCorrectionDto corr : corrs) {
                    String cat = corr.type() != null ? corr.type().toUpperCase(Locale.ROOT) : "GRAMMAR";
                    String key = cat + ":" + normalizeCorrectionKey(corr.explanation(), corr.original());
                    sessionsByKey.computeIfAbsent(key, k -> new HashSet<>()).add(row.sessionId());
                }
            } catch (Exception ignored) {}
        }

        return sessionsByKey.values().stream()
                .filter(s -> s.size() >= MIN_DISTINCT_SESSIONS_FOR_RECURRING)
                .count();
    }

    private ParsedV2Payload parseV2Json(String json) {
        if (json == null || json.isBlank()) return null;
        try {
            JsonNode root = objectMapper.readTree(json);
            if (!root.isObject()) return null;

            String status = root.path("status").asText("");
            boolean abstained = "ABSTAINED".equalsIgnoreCase(status)
                    || (!root.path("abstentionReason").isMissingNode()
                        && !root.path("abstentionReason").isNull()
                        && !root.path("abstentionReason").asText("").isBlank());

            Double segmental = null;
            Double intonation = null;
            Double rhythm = null;
            Double fluency = null;
            JsonNode overall = root.path("overall");
            if (overall.isObject()) {
                if (overall.hasNonNull("segmentalScore")) segmental = overall.get("segmentalScore").asDouble();
                if (overall.hasNonNull("intonationScore")) intonation = overall.get("intonationScore").asDouble();
                if (overall.hasNonNull("rhythmScore")) rhythm = overall.get("rhythmScore").asDouble();
                if (overall.hasNonNull("fluencyScore")) fluency = overall.get("fluencyScore").asDouble();
            }

            Double stressScore = null;
            int stressMatched = 0;
            int stressAssessed = 0;
            JsonNode lex = root.path("lexicalStress");
            if (lex.isObject()
                    && "ALIGNED_VOWEL_PROMINENCE_V1".equals(lex.path("method").asText())
                    && "ASSESSED".equals(lex.path("status").asText())) {
                int assessed = lex.path("assessed").asInt(0);
                int matched = lex.path("matched").asInt(-1);
                if (assessed >= 1 && matched >= 0 && matched <= assessed) {
                    stressAssessed = assessed;
                    stressMatched = matched;
                    stressScore = 100.0 * matched / assessed;
                }
            } else if (lex.isObject() && "ASSESSED".equals(lex.path("status").asText()) && overall.hasNonNull("stressScore")) {
                stressScore = overall.get("stressScore").asDouble();
            }

            String priorityIssueType = null;
            String priorityWord = null;
            String priorityPhone = null;
            String priorityObserved = null;
            String priorityInstructionVi = null;
            JsonNode priorities = root.path("priorities");
            if (priorities.isArray() && !priorities.isEmpty()) {
                JsonNode p0 = priorities.get(0);
                priorityIssueType = textOrNull(p0, "targetUnit");
                if (priorityIssueType == null) priorityIssueType = textOrNull(p0, "targetType");
                if (priorityIssueType == null) priorityIssueType = textOrNull(p0, "issue");
                priorityWord = textOrNull(p0, "word");
                priorityPhone = normalizePhoneSymbol(textOrNull(p0, "phone"));
                priorityObserved = normalizePhoneSymbol(textOrNull(p0, "observed"));
                priorityInstructionVi = textOrNull(p0, "instructionVi");
            }

            return new ParsedV2Payload(
                    abstained,
                    segmental,
                    stressScore,
                    stressMatched,
                    stressAssessed,
                    intonation,
                    rhythm,
                    fluency,
                    priorityIssueType,
                    priorityWord,
                    priorityPhone,
                    priorityObserved,
                    priorityInstructionVi,
                    root.path("words"),
                    root.path("phones")
            );
        } catch (Exception e) {
            return null;
        }
    }

    private void ingestPhonemeObservations(
            ParsedV2Payload v2,
            Long sessionId,
            LocalDateTime ts,
            Map<String, PhonemePatternTracker> trackers,
            Map<String, Map<Long, LocalDateTime>> cleanWordSessions,
            Map<String, Map<Long, LocalDateTime>> cleanPhoneSessions
    ) {
        Map<Integer, String> wordByIndex = new HashMap<>();
        if (v2.wordsNode != null && v2.wordsNode.isArray()) {
            for (JsonNode wNode : v2.wordsNode) {
                String w = cleanDisplayWord(textOrNull(wNode, "word"));
                int wIdx = wNode.path("wordIndex").asInt(-1);
                if (w != null && wIdx >= 0) {
                    wordByIndex.put(wIdx, w);
                }
                if (sessionId != null && w != null
                        && "GOOD".equalsIgnoreCase(wNode.path("status").asText())
                        && wNode.path("accuracyScore").asDouble(0.0) >= 80.0) {
                    cleanWordSessions
                            .computeIfAbsent(w.toLowerCase(Locale.ROOT), k -> new HashMap<>())
                            .merge(sessionId, ts, (a, b) -> a.isAfter(b) ? a : b);
                }
            }
        }

        JsonNode phonesSource = (v2.phonesNode != null && v2.phonesNode.isArray() && !v2.phonesNode.isEmpty())
                ? v2.phonesNode
                : null;

        Set<String> seenPhonesInThisAttempt = new HashSet<>();
        if (phonesSource != null) {
            for (JsonNode pNode : phonesSource) {
                ingestSinglePhoneNode(
                        pNode,
                        wordByIndex.get(pNode.path("wordIndex").asInt(-1)),
                        sessionId,
                        ts,
                        seenPhonesInThisAttempt,
                        trackers,
                        cleanPhoneSessions
                );
            }
        } else if (v2.wordsNode != null && v2.wordsNode.isArray()) {
            for (JsonNode wNode : v2.wordsNode) {
                String w = cleanDisplayWord(textOrNull(wNode, "word"));
                JsonNode wPhones = wNode.path("phones");
                if (wPhones.isArray()) {
                    for (JsonNode pNode : wPhones) {
                        ingestSinglePhoneNode(
                                pNode,
                                w,
                                sessionId,
                                ts,
                                seenPhonesInThisAttempt,
                                trackers,
                                cleanPhoneSessions
                        );
                    }
                }
            }
        }
    }

    private void ingestSinglePhoneNode(
            JsonNode pNode,
            String word,
            Long sessionId,
            LocalDateTime ts,
            Set<String> seenPhonesInThisAttempt,
            Map<String, PhonemePatternTracker> trackers,
            Map<String, Map<Long, LocalDateTime>> cleanPhoneSessions
    ) {
        if (!pNode.path("abstentionReason").isMissingNode() && !pNode.path("abstentionReason").isNull()) {
            String reason = pNode.path("abstentionReason").asText("");
            if (!reason.isBlank()) return;
        }
        String qualityClass = pNode.path("qualityClass").asText("");
        if (qualityClass.isBlank() || "UNCERTAIN".equalsIgnoreCase(qualityClass)) {
            return;
        }
        String rawPhone = textOrNull(pNode, "expectedPhone");
        String normPhone = normalizePhoneSymbol(rawPhone);
        if (normPhone == null) return;

        double qScore = pNode.path("qualityScore").asDouble(Double.NaN);
        if (!Double.isFinite(qScore)) return;

        PhonemePatternTracker tr = trackers.computeIfAbsent(normPhone, PhonemePatternTracker::new);
        tr.observations++;
        tr.qualitySum += qScore;
        boolean acceptable = "ACCEPTABLE".equalsIgnoreCase(qualityClass);
        if (acceptable) {
            tr.acceptable++;
            if (word != null) {
                tr.distinctWords.add(word);
            }
            if (sessionId != null && qScore >= 80.0) {
                cleanPhoneSessions
                        .computeIfAbsent(normPhone, k -> new HashMap<>())
                        .merge(sessionId, ts, (a, b) -> a.isAfter(b) ? a : b);
            }
        }
        if (seenPhonesInThisAttempt.add(normPhone)) {
            tr.attemptsCount++;
        }
    }

    private void recordIssueOccurrence(
            Map<String, IssueTracker> trackers,
            String issueType,
            String targetWord,
            String targetPhone,
            String observedPhone,
            Double qualityScore,
            String instructionVi,
            Long sessionId,
            boolean resolvedThisSession,
            LocalDateTime timestamp,
            String snippet,
            String sourceTitle,
            Long sourceId,
            String mode,
            String practiceRoute,
            String practiceLabel
    ) {
        String cleanWord = cleanDisplayWord(targetWord);
        String cleanPhone = normalizePhoneSymbol(targetPhone);
        String cleanObsPhone = normalizePhoneSymbol(observedPhone);
        String normType = issueType.toUpperCase(Locale.ROOT).trim();
        String category = normType.contains("STRESS") ? "STRESS" : "PRONUNCIATION";

        String keySuffix = cleanWord != null
                ? cleanWord.toLowerCase(Locale.ROOT)
                : (cleanPhone != null ? cleanPhone : "");
        String key = category + ":" + normType + (keySuffix.isEmpty() ? "" : ":" + keySuffix);

        IssueTracker tr = trackers.computeIfAbsent(key, k -> new IssueTracker(k, category, issueType));
        tr.occurrences++;
        tr.sessionIds.add(sessionId);
        if (resolvedThisSession) {
            tr.resolvedSessionIds.add(sessionId);
        }
        tr.latestResolved = resolvedThisSession;
        if (tr.lastObservedAt == null || (timestamp != null && timestamp.isAfter(tr.lastObservedAt))) {
            tr.lastObservedAt = timestamp;
            tr.practiceRoute = practiceRoute;
            tr.practiceLabel = practiceLabel;
        }
        if (cleanWord != null) tr.targetWord = cleanWord;
        if (cleanPhone != null) tr.targetPhone = cleanPhone;
        if (cleanObsPhone != null) tr.observedPhone = cleanObsPhone;
        if (instructionVi != null && !instructionVi.isBlank()) tr.instructionVi = instructionVi;
        if (qualityScore != null && Double.isFinite(qualityScore)) {
            tr.qualitySum += qualityScore;
            tr.qualityCount++;
        }

        String dedupExampleKey = (cleanWord != null ? cleanWord : (snippet != null ? snippet : mode)).toLowerCase(Locale.ROOT);
        if (tr.seenExamples.add(dedupExampleKey) && tr.examples.size() < 3) {
            tr.examples.add(SpeakingIssueExampleDto.builder()
                    .targetWord(cleanWord)
                    .sentenceSnippet(snippet)
                    .sourceTitle(sourceTitle)
                    .sourceId(sourceId)
                    .mode(mode)
                    .timestamp(timestamp)
                    .build());
        }
    }

    private int countSubsequentCleanSessions(
            IssueTracker tr,
            Map<String, Map<Long, LocalDateTime>> cleanWordSessions,
            Map<String, Map<Long, LocalDateTime>> cleanPhoneSessions
    ) {
        if (tr.lastObservedAt == null) return 0;
        Set<Long> cleanLaterIds = new HashSet<>();
        if (tr.targetWord != null) {
            Map<Long, LocalDateTime> bySess = cleanWordSessions.get(tr.targetWord.toLowerCase(Locale.ROOT));
            if (bySess != null) {
                for (Map.Entry<Long, LocalDateTime> e : bySess.entrySet()) {
                    if (!tr.sessionIds.contains(e.getKey()) && e.getValue().isAfter(tr.lastObservedAt)) {
                        cleanLaterIds.add(e.getKey());
                    }
                }
            }
        }
        if (tr.targetPhone != null) {
            Map<Long, LocalDateTime> bySess = cleanPhoneSessions.get(tr.targetPhone);
            if (bySess != null) {
                for (Map.Entry<Long, LocalDateTime> e : bySess.entrySet()) {
                    if (!tr.sessionIds.contains(e.getKey()) && e.getValue().isAfter(tr.lastObservedAt)) {
                        cleanLaterIds.add(e.getKey());
                    }
                }
            }
        }
        return cleanLaterIds.size();
    }

    private static void sortRecurringIssues(List<SpeakingRecurringIssueDto> issues) {
        issues.sort(Comparator
                .comparingInt((SpeakingRecurringIssueDto i) -> statusPriorityRank(i.getStatus()))
                .thenComparing(SpeakingRecurringIssueDto::getDistinctSessionsObserved, Comparator.nullsLast(Comparator.reverseOrder()))
                .thenComparing(SpeakingRecurringIssueDto::getLastObservedAt, Comparator.nullsLast(Comparator.reverseOrder())));
    }

    private static int statusPriorityRank(String status) {
        if (status == null) return 2;
        return switch (status.toUpperCase(Locale.ROOT)) {
            case "NEEDS_ATTENTION" -> 0;
            case "PRACTICING" -> 1;
            case "IMPROVING" -> 2;
            case "RECENTLY_STABLE" -> 3;
            default -> 4;
        };
    }

    static int computeCurrentStreak(Set<LocalDate> activeDays, LocalDate today) {
        if (activeDays == null || activeDays.isEmpty()) return 0;
        LocalDate check;
        if (activeDays.contains(today)) {
            check = today;
        } else if (activeDays.contains(today.minusDays(1))) {
            check = today.minusDays(1);
        } else {
            return 0;
        }
        int streak = 0;
        while (activeDays.contains(check)) {
            streak++;
            check = check.minusDays(1);
        }
        return streak;
    }

    private int extractAudioDurationSec(String json) {
        if (json == null || json.isBlank()) return 0;
        try {
            double sec = objectMapper.readTree(json).path("audioQuality").path("durationSec").asDouble(0.0);
            return Double.isFinite(sec) && sec > 0 ? (int) Math.min(180L, Math.round(sec)) : 0;
        } catch (Exception e) {
            return 0;
        }
    }

    private static List<SpeakingShadowingAttempt> filterGenuineShadowingAttempts(List<SpeakingShadowingAttempt> list) {
        if (list == null || list.isEmpty()) return List.of();
        return list.stream().filter(a -> a != null && !Boolean.TRUE.equals(a.getIsMocked())).toList();
    }

    private static List<SpeakingQuickCheck> filterGenuineQuickChecks(List<SpeakingQuickCheck> list) {
        if (list == null || list.isEmpty()) return List.of();
        return list.stream().filter(q -> q != null && !Boolean.TRUE.equals(q.getIsMocked())).toList();
    }

    private static boolean isActionableIssueType(String issueType) {
        if (issueType == null || issueType.isBlank()) return false;
        return !EXCLUDED_ISSUE_TYPES.contains(issueType.toUpperCase(Locale.ROOT).trim());
    }

    private static String normalizeModeFilter(String mode) {
        if (mode == null || mode.isBlank()) return "ALL";
        String upper = mode.trim().toUpperCase(Locale.ROOT);
        if (!ALLOWED_MODES.contains(upper)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported mode filter: " + mode);
        }
        return upper;
    }

    private static String normalizeStatusFilter(String status) {
        if (status == null || status.isBlank()) return "ALL";
        String upper = status.trim().toUpperCase(Locale.ROOT);
        if (!ALLOWED_STATUSES.contains(upper)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported status filter: " + status);
        }
        return upper;
    }

    private static void requireUserId(Long userId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required");
        }
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode child = node.path(field);
        if (child.isMissingNode() || child.isNull()) return null;
        String v = child.asText("").trim();
        return v.isEmpty() ? null : v;
    }

    private static String cleanDisplayWord(String word) {
        if (word == null) return null;
        String trimmed = word.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    static String normalizePhoneSymbol(String raw) {
        if (raw == null) return null;
        String cleaned = raw.trim().replace("/", "").replaceAll("[012]$", "").trim();
        if (cleaned.isEmpty()) return null;
        return cleaned.toUpperCase(Locale.ROOT);
    }

    private static String normalizeCorrectionKey(String explanation, String original) {
        String base = (explanation != null && !explanation.isBlank()) ? explanation : (original != null ? original : "general");
        return base.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "_").replaceAll("_+", "_");
    }

    private static String formatIssueTitle(String category, String issueType, String targetWord, String targetPhone) {
        if ("STRESS".equalsIgnoreCase(category)) {
            return targetWord != null
                    ? "Trọng âm từ \"" + targetWord + "\""
                    : "Trọng âm từ đa âm tiết";
        }
        if (targetWord != null && targetPhone != null) {
            PhoneMeta meta = lookupPhoneMeta(targetPhone);
            return "Âm " + meta.ipaDisplay() + " trong từ \"" + targetWord + "\"";
        }
        if (targetWord != null) {
            return "Phát âm từ \"" + targetWord + "\"";
        }
        if (targetPhone != null) {
            PhoneMeta meta = lookupPhoneMeta(targetPhone);
            return "Âm vị " + meta.ipaDisplay() + " (" + meta.categoryVi() + ")";
        }
        return SpeakingProgressAggregationService.mapIssueTypeToLearnerLabel(issueType);
    }

    private static String defaultCueForIssue(String issueType, String targetWord, String targetPhone) {
        if (targetPhone != null) {
            PhoneMeta meta = lookupPhoneMeta(targetPhone);
            if (targetWord != null) {
                return "Chú ý khẩu hình âm " + meta.ipaDisplay() + " (" + meta.categoryVi().toLowerCase(Locale.ROOT) + ") khi phát âm từ \"" + targetWord + "\".";
            }
            return "Chú ý giữ rõ khẩu hình âm " + meta.ipaDisplay() + " (" + meta.categoryVi().toLowerCase(Locale.ROOT) + ").";
        }
        if (issueType != null && issueType.toUpperCase(Locale.ROOT).contains("STRESS")) {
            return "Nhấn rõ âm tiết mang trọng âm chính và hạ nhẹ các âm tiết không nhấn.";
        }
        if (targetWord != null) {
            return "Chú ý phát âm rõ ràng các âm vị trọng tâm trong từ \"" + targetWord + "\".";
        }
        return "Giữ nhịp độ vừa phải và phát âm rõ từng cụm âm trong câu.";
    }

    private static String formatGrammarVocabTitle(String category, TurnCorrectionDto corr) {
        if ("VOCABULARY".equalsIgnoreCase(category)) {
            return "Từ vựng: " + (corr.original() != null ? "\"" + corr.original() + "\"" : "Cách chọn từ");
        }
        if ("NATURALNESS".equalsIgnoreCase(category)) {
            return "Độ tự nhiên: " + (corr.original() != null ? "\"" + corr.original() + "\"" : "Cách diễn đạt");
        }
        return "Ngữ pháp: " + (corr.explanation() != null && corr.explanation().length() <= 44
                ? corr.explanation()
                : "Cấu trúc câu");
    }

    private static double round1(double v) {
        return Math.round(v * 10.0) / 10.0;
    }

    private static PhoneMeta lookupPhoneMeta(String normalizedPhone) {
        if (normalizedPhone == null) {
            return new PhoneMeta("/?/", "Âm vị tiếng Anh", "English phoneme");
        }
        PhoneMeta found = PHONE_METADATA.get(normalizedPhone.toUpperCase(Locale.ROOT));
        if (found != null) return found;
        return new PhoneMeta("/" + normalizedPhone.toLowerCase(Locale.ROOT) + "/", "Âm vị tiếng Anh", "English phoneme");
    }

    private static Map<String, PhoneMeta> buildPhoneMetadata() {
        Map<String, PhoneMeta> m = new HashMap<>();
        m.put("TH", new PhoneMeta("/θ/", "Âm răng vô thanh", "Voiceless dental fricative"));
        m.put("DH", new PhoneMeta("/ð/", "Âm răng hữu thanh", "Voiced dental fricative"));
        m.put("SH", new PhoneMeta("/ʃ/", "Âm xát vòm lợi", "Postalveolar fricative"));
        m.put("ZH", new PhoneMeta("/ʒ/", "Âm xát hữu thanh", "Voiced postalveolar fricative"));
        m.put("CH", new PhoneMeta("/tʃ/", "Âm tắc xát vô thanh", "Voiceless affricate"));
        m.put("JH", new PhoneMeta("/dʒ/", "Âm tắc xát hữu thanh", "Voiced affricate"));
        m.put("NG", new PhoneMeta("/ŋ/", "Âm mũi ngạc mềm", "Velar nasal"));
        m.put("R", new PhoneMeta("/r/", "Âm quặt lưỡi", "Alveolar approximant"));
        m.put("L", new PhoneMeta("/l/", "Âm bên đầu lưỡi", "Lateral approximant"));
        m.put("S", new PhoneMeta("/s/", "Âm xát đầu lưỡi", "Voiceless sibilant"));
        m.put("Z", new PhoneMeta("/z/", "Âm xát đầu lưỡi hữu thanh", "Voiced sibilant"));
        m.put("F", new PhoneMeta("/f/", "Âm môi-răng vô thanh", "Labiodental fricative"));
        m.put("V", new PhoneMeta("/v/", "Âm môi-răng hữu thanh", "Voiced labiodental"));
        m.put("P", new PhoneMeta("/p/", "Âm bật hai môi", "Bilabial plosive"));
        m.put("B", new PhoneMeta("/b/", "Âm bật hai môi hữu thanh", "Voiced bilabial plosive"));
        m.put("T", new PhoneMeta("/t/", "Âm bật đầu lưỡi", "Alveolar plosive"));
        m.put("D", new PhoneMeta("/d/", "Âm bật đầu lưỡi hữu thanh", "Voiced alveolar plosive"));
        m.put("K", new PhoneMeta("/k/", "Âm bật ngạc mềm", "Velar plosive"));
        m.put("G", new PhoneMeta("/ɡ/", "Âm bật ngạc mềm hữu thanh", "Voiced velar plosive"));
        m.put("M", new PhoneMeta("/m/", "Âm mũi hai môi", "Bilabial nasal"));
        m.put("N", new PhoneMeta("/n/", "Âm mũi đầu lưỡi", "Alveolar nasal"));
        m.put("HH", new PhoneMeta("/h/", "Âm xát thanh hầu", "Glottal fricative"));
        m.put("W", new PhoneMeta("/w/", "Bán nguyên âm tròn môi", "Labio-velar approximant"));
        m.put("Y", new PhoneMeta("/j/", "Bán nguyên âm mặt lưỡi", "Palatal approximant"));
        m.put("IY", new PhoneMeta("/iː/", "Nguyên âm dài căng", "Close front tense vowel"));
        m.put("IH", new PhoneMeta("/ɪ/", "Nguyên âm ngắn thả lỏng", "Near-close front lax vowel"));
        m.put("AE", new PhoneMeta("/æ/", "Nguyên âm mở trước", "Near-open front vowel"));
        m.put("EH", new PhoneMeta("/e/", "Nguyên âm giữa trước", "Mid front vowel"));
        m.put("AH", new PhoneMeta("/ʌ/", "Nguyên âm giữa trung tâm", "Mid central vowel"));
        m.put("AA", new PhoneMeta("/ɑː/", "Nguyên âm mở sau", "Open back vowel"));
        m.put("AO", new PhoneMeta("/ɔː/", "Nguyên âm tròn môi sau", "Open-mid back rounded vowel"));
        m.put("UH", new PhoneMeta("/ʊ/", "Nguyên âm ngắn tròn môi", "Near-close back lax vowel"));
        m.put("UW", new PhoneMeta("/uː/", "Nguyên âm dài tròn môi", "Close back tense vowel"));
        m.put("ER", new PhoneMeta("/ɜːr/", "Nguyên âm cong lưỡi", "R-colored central vowel"));
        m.put("EY", new PhoneMeta("/eɪ/", "Nguyên âm đôi", "Closing diphthong"));
        m.put("AY", new PhoneMeta("/aɪ/", "Nguyên âm đôi", "Closing diphthong"));
        m.put("OY", new PhoneMeta("/ɔɪ/", "Nguyên âm đôi", "Closing diphthong"));
        m.put("AW", new PhoneMeta("/aʊ/", "Nguyên âm đôi", "Closing diphthong"));
        m.put("OW", new PhoneMeta("/oʊ/", "Nguyên âm đôi", "Closing diphthong"));
        return Map.copyOf(m);
    }

    private record PhoneMeta(String ipaDisplay, String categoryVi, String categoryEn) {}
    private record StrengthCandidate(double rank, SpeakingStrengthItemDto item) {}
    private record FeedbackOcc(SpeakingTurnFeedback fb, TurnCorrectionDto corr, String category) {}

    private record PronunciationEvaluation(
            int distinctAssessedSessionsCount,
            SpeakingPronunciationMetricsDto metrics,
            List<SpeakingRecurringIssueDto> recurringIssues,
            List<SpeakingRecurringIssueDto> singleSessionObservations,
            List<SpeakingStrongPhonemePatternDto> strongPatterns
    ) {}

    private record ParsedV2Payload(
            boolean abstained,
            Double segmentalScore,
            Double stressScore,
            int stressMatched,
            int stressAssessed,
            Double intonationScore,
            Double rhythmScore,
            Double fluencyScore,
            String priorityIssueType,
            String priorityWord,
            String priorityPhone,
            String priorityObserved,
            String priorityInstructionVi,
            JsonNode wordsNode,
            JsonNode phonesNode
    ) {}

    private static final class DailyAccumulator {
        final LocalDate date;
        boolean active;
        int completedSessions;
        int attemptsCount;
        long speakingSeconds;
        double scoreSum;
        int scoreCount;

        DailyAccumulator(LocalDate date) {
            this.date = date;
        }
    }

    private static final class PhonemePatternTracker {
        final String phone;
        int observations;
        int acceptable;
        int attemptsCount;
        double qualitySum;
        final Set<String> distinctWords = new LinkedHashSet<>();

        PhonemePatternTracker(String phone) {
            this.phone = phone;
        }
    }

    private static final class IssueTracker {
        final String key;
        final String category;
        final String issueType;
        String targetWord;
        String targetPhone;
        String observedPhone;
        String instructionVi;
        int occurrences;
        double qualitySum;
        int qualityCount;
        boolean latestResolved;
        LocalDateTime lastObservedAt;
        String practiceRoute;
        String practiceLabel;
        final Set<Long> sessionIds = new HashSet<>();
        final Set<Long> resolvedSessionIds = new HashSet<>();
        final Set<String> seenExamples = new HashSet<>();
        final List<SpeakingIssueExampleDto> examples = new ArrayList<>();

        IssueTracker(String key, String category, String issueType) {
            this.key = key;
            this.category = category;
            this.issueType = issueType;
        }
    }
}
