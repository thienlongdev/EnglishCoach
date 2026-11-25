package com.englishcoach.speaking.service;

import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.speaking.dto.*;
import com.englishcoach.speaking.entity.SpeakingScenario;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingShadowingAttempt;
import com.englishcoach.speaking.entity.SpeakingTurnFeedback;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository;
import com.englishcoach.speaking.repository.SpeakingTurnFeedbackRepository;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
@Slf4j
public class SpeakingProgressAggregationService {

    public static final String PROGRESS_POLICY_VERSION = "SPEAKING_PROGRESS_POLICY_v1";
    public static final int RECURRENCE_MIN_DISTINCT_SESSIONS = 2;
    public static final int RECURRENCE_LOOKBACK_DAYS = 30;

    private final SpeakingSessionRepository sessionRepository;
    private final SpeakingShadowingAttemptRepository attemptRepository;
    private final ListeningMaterialRepository materialRepository;
    private final SpeakingTurnFeedbackRepository feedbackRepository;
    private final com.englishcoach.speaking.repository.SpeakingTurnRepository speakingTurnRepository;
    private final SpeakingShadowingService shadowingService;
    private final SpeakingShadowingUnitService unitService;
    private final UserRepository userRepository;
    private final com.englishcoach.speaking.repository.SpeakingQuickCheckRepository quickCheckRepository;
    private final SpeakingQuickCheckService quickCheckService;

    private static final ObjectMapper MAPPER = new ObjectMapper();



    @Transactional(readOnly = true)
    public SpeakingProgressSummaryDto getSpeakingProgressSummary(Long userId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required");
        }

        LocalDateTime now = LocalDateTime.now();
        LocalDateTime sevenDaysAgo = now.minusDays(7);
        LocalDateTime thirtyDaysAgo = now.minusDays(RECURRENCE_LOOKBACK_DAYS);

        // 1. Active session (if any)
        ShadowingSessionStateDto activeSessionDto = null;
        Optional<SpeakingSession> activeSessionOpt = sessionRepository.findFirstByUserIdAndModeAndStatusOrderByCreatedAtDesc(
                userId, "SHADOWING", "ACTIVE"
        );
        if (activeSessionOpt.isPresent()) {
            try {
                activeSessionDto = shadowingService.getSessionState(userId, activeSessionOpt.get().getId());
            } catch (Exception e) {
                log.warn("Could not hydrate active session {}: {}", activeSessionOpt.get().getId(), e.getMessage());
            }
        }

        // 2. Fetch sessions in 30-day window
        List<SpeakingSession> sessions30d = sessionRepository.findByUserIdAndModeAndCreatedAtAfterOrderByCreatedAtDesc(
                userId, "SHADOWING", thirtyDaysAgo
        );

        long completed7d = 0;
        long completed30d = 0;
        long sentences7d = 0;
        long sentences30d = 0;
        Set<LocalDate> practiceDays7dSet = new HashSet<>();
        Set<LocalDate> practiceDays30dSet = new HashSet<>();

        for (SpeakingSession s : sessions30d) {
            LocalDate date = s.getCreatedAt().toLocalDate();
            practiceDays30dSet.add(date);
            int sentences = s.getCompletedUnitsCount() != null ? s.getCompletedUnitsCount() : 0;
            sentences30d += sentences;

            if ("COMPLETED".equals(s.getStatus())) {
                completed30d++;
            }

            if (s.getCreatedAt().isAfter(sevenDaysAgo)) {
                practiceDays7dSet.add(date);
                sentences7d += sentences;
                if ("COMPLETED".equals(s.getStatus())) {
                    completed7d++;
                }
            }
        }

        // 3. Fetch attempts in 30-day window for retry and resolution stats
        List<SpeakingShadowingAttempt> attempts30d = attemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(
                userId, thirtyDaysAgo
        );

        long retries30d = 0;
        long resolvedCount30d = 0;
        for (SpeakingShadowingAttempt att : attempts30d) {
            if (att.getRetryIndex() != null && att.getRetryIndex() > 0) {
                retries30d++;
            }
            if (Boolean.TRUE.equals(att.getResolvedThisSession())) {
                resolvedCount30d++;
            }
        }

        SpeakingPracticeSummaryDto practiceSummary = SpeakingPracticeSummaryDto.builder()
                .sessionsCompleted7d(completed7d)
                .sessionsCompleted30d(completed30d)
                .sentencesPracticed7d(sentences7d)
                .sentencesPracticed30d(sentences30d)
                .practiceDays7d(practiceDays7dSet.size())
                .practiceDays30d(practiceDays30dSet.size())
                .retries30d(retries30d)
                .resolvedThisSessionCount30d(resolvedCount30d)
                .build();

        // 4. Recent sessions (up to 5 across all speaking modes)
        List<SpeakingSession> recentSessionsRaw = sessionRepository.findByUserIdOrderByCreatedAtDesc(
                userId, PageRequest.of(0, 5)
        ).getContent();
        List<SpeakingSessionSummaryDto> recentSessions = mapToSessionSummaries(recentSessionsRaw, userId);

        // 5. Recurring issues (distinct session rule >= 2, Weakness Profile 2.0)
        List<SpeakingTurnFeedback> feedbacks30d = feedbackRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(
                userId, thirtyDaysAgo
        );
        List<SpeakingRecurringIssueDto> recurringIssues = computeComprehensiveRecurringIssues(attempts30d, feedbacks30d);

        // 6. Recent improvements (session-grounded within-session resolutions)
        List<SpeakingRecentImprovementDto> recentImprovements = computeRecentImprovements(attempts30d);

        // 7. Authentic Pronunciation V2.2 metrics aggregation from persisted attempts & quick checks
        List<com.englishcoach.speaking.entity.SpeakingQuickCheck> quickChecks30d = quickCheckRepository
                .findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(userId, thirtyDaysAgo);
        SpeakingPronunciationMetricsDto pronunciationMetrics = computePronunciationMetrics(attempts30d, quickChecks30d);

        return SpeakingProgressSummaryDto.builder()
                .policyVersion(PROGRESS_POLICY_VERSION)
                .activeSession(activeSessionDto)
                .practiceSummary(practiceSummary)
                .recentSessions(recentSessions)
                .recurringIssues(recurringIssues)
                .recentImprovements(recentImprovements)
                .pronunciationMetrics(pronunciationMetrics)
                .generatedAt(now)
                .build();
    }

    @Transactional(readOnly = true)
    public SpeakingSessionHistoryPageDto getSpeakingSessionHistory(Long userId, int page, int size) {
        return getSpeakingSessionHistory(userId, null, page, size);
    }

    @Transactional(readOnly = true)
    public SpeakingSessionHistoryPageDto getSpeakingSessionHistory(Long userId, String mode, int page, int size) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required");
        }

        int safePage = Math.max(0, page);
        int safeSize = Math.max(1, Math.min(size, 50));

        Page<SpeakingSession> sessionPage;
        if (mode != null && !mode.isBlank() && !"ALL".equalsIgnoreCase(mode)) {
            sessionPage = sessionRepository.findByUserIdAndModeOrderByCreatedAtDesc(
                    userId, mode.toUpperCase(), PageRequest.of(safePage, safeSize)
            );
        } else {
            sessionPage = sessionRepository.findByUserIdOrderByCreatedAtDesc(
                    userId, PageRequest.of(safePage, safeSize)
            );
            if (sessionPage == null) {
                sessionPage = sessionRepository.findByUserIdAndModeOrderByCreatedAtDesc(
                        userId, "SHADOWING", PageRequest.of(safePage, safeSize)
                );
            }
        }

        List<SpeakingSessionSummaryDto> content = mapToSessionSummaries(sessionPage.getContent(), userId);

        return SpeakingSessionHistoryPageDto.builder()
                .content(content)
                .page(sessionPage.getNumber())
                .size(sessionPage.getSize())
                .totalElements(sessionPage.getTotalElements())
                .totalPages(sessionPage.getTotalPages())
                .hasNext(sessionPage.hasNext())
                .build();
    }

    @Transactional(readOnly = true)
    public SpeakingSessionDetailDto getSpeakingSessionDetail(Long userId, Long sessionId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required");
        }

        SpeakingSession session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Session not found: " + sessionId));

        if (!session.getUser().getId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Access denied: Session belongs to another user");
        }

        if ("QUICK_CHECK".equalsIgnoreCase(session.getMode())) {
            QuickCheckResponseDto qcDto = quickCheckService.getQuickCheckBySessionId(userId, sessionId);
            String transcript = qcDto != null ? (qcDto.getIntendedTranscript() != null && !qcDto.getIntendedTranscript().isBlank() ? qcDto.getIntendedTranscript() : qcDto.getWhisperTranscript()) : "Quick Check";
            return SpeakingSessionDetailDto.builder()
                    .sessionId(session.getId())
                    .materialId(null)
                    .materialTitle(transcript)
                    .mode(session.getMode())
                    .status(session.getStatus())
                    .currentUnitIndex(1)
                    .completedUnitsCount(1)
                    .totalUnitsCount(1)
                    .createdAt(session.getCreatedAt())
                    .updatedAt(session.getUpdatedAt())
                    .sentences(Collections.emptyList())
                    .turns(Collections.emptyList())
                    .quickCheck(qcDto)
                    .build();
        }

        if ("ROLEPLAY".equalsIgnoreCase(session.getMode())) {
            SpeakingScenario scenario = session.getScenario();
            String scenarioTitle = scenario != null ? scenario.getTitle() : "AI Role-play";
            String learnerRole = scenario != null ? scenario.getLearnerRole() : null;
            String aiRole = scenario != null ? scenario.getAiRole() : null;
            String learnerGoal = scenario != null ? scenario.getLearnerGoal() : null;
            List<String> targetVocab = (scenario != null && scenario.getTargetVocabulary() != null)
                    ? scenario.getTargetVocabulary()
                    : Collections.emptyList();

            List<com.englishcoach.speaking.entity.SpeakingTurn> turns = speakingTurnRepository.findBySessionIdOrderBySequenceNumberAsc(sessionId);
            List<SpeakingTurnFeedback> feedbacks = feedbackRepository.findBySessionId(sessionId);
            Map<Long, SpeakingTurnFeedback> feedbackByTurnId = feedbacks.stream()
                    .collect(Collectors.toMap(f -> f.getTurn().getId(), f -> f, (existing, replacing) -> existing));

            List<SpeakingTurnDto> turnDtos = turns.stream()
                    .map(t -> {
                        SpeakingTurnFeedback fb = feedbackByTurnId.get(t.getId());
                        SpeakingTurnFeedbackDto fbDto = fb != null ? SpeakingTurnFeedbackDto.fromEntity(fb) : null;
                        return SpeakingTurnDto.fromEntity(t, fbDto);
                    })
                    .collect(Collectors.toList());

            return SpeakingSessionDetailDto.builder()
                    .sessionId(session.getId())
                    .materialId(scenario != null ? scenario.getId() : null)
                    .materialTitle(scenarioTitle)
                    .scenarioId(scenario != null ? scenario.getId() : null)
                    .scenarioTitle(scenarioTitle)
                    .learnerRole(learnerRole)
                    .aiRole(aiRole)
                    .learnerGoal(learnerGoal)
                    .targetVocabulary(targetVocab)
                    .mode(session.getMode())
                    .status(session.getStatus())
                    .currentUnitIndex(session.getCurrentUnitIndex())
                    .completedUnitsCount(session.getCompletedUnitsCount())
                    .totalUnitsCount(session.getTotalUnitsCount())
                    .createdAt(session.getCreatedAt())
                    .updatedAt(session.getUpdatedAt())
                    .sentences(Collections.emptyList())
                    .turns(turnDtos)
                    .build();
        }

        String materialTitle = "Shadowing Practice";
        if (session.getSourceId() != null) {
            Optional<ListeningMaterial> mat = materialRepository.findByIdAndVisibleToUser(session.getSourceId(), userId)
                    .filter(m -> isMaterialVisibleToUser(m, userId));
            if (mat.isPresent()) {
                materialTitle = mat.get().getTitle();
            }
        }

        List<SpeakingShadowingAttempt> attempts = attemptRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
        Map<Long, List<SpeakingShadowingAttempt>> attemptsByUnitId = attempts.stream()
                .filter(a -> a.getShadowingUnit() != null)
                .collect(Collectors.groupingBy(a -> a.getShadowingUnit().getId(), LinkedHashMap::new, Collectors.toList()));

        List<SpeakingShadowingUnitDto> unitDtos = Collections.emptyList();
        if (session.getSourceId() != null) {
            unitDtos = unitService.getOrGenerateUnits(session.getSourceId(), userId);
        }

        List<SpeakingSentenceDetailDto> sentenceDetails = new ArrayList<>();
        if (unitDtos != null && !unitDtos.isEmpty()) {
            for (SpeakingShadowingUnitDto unit : unitDtos) {
                List<SpeakingShadowingAttempt> unitAttempts = attemptsByUnitId.getOrDefault(unit.id(), Collections.emptyList());
                List<SpeakingShadowingAttemptDto> attemptDtos = unitAttempts.stream()
                        .map(shadowingService::mapToDto)
                        .collect(Collectors.toList());

                String unitState = "NOT_STARTED";
                String lockedTargetId = null;
                String targetWord = null;
                String primaryIssueType = null;

                if (!unitAttempts.isEmpty()) {
                    unitState = "ATTEMPTED";
                    SpeakingShadowingAttempt latest = unitAttempts.get(unitAttempts.size() - 1);
                    if (Boolean.TRUE.equals(latest.getResolvedThisSession())) {
                        unitState = "RESOLVED_THIS_SESSION";
                    }
                    lockedTargetId = latest.getActiveTargetId();
                    targetWord = latest.getTargetWord();
                    primaryIssueType = latest.getPrimaryIssueType();
                }

                sentenceDetails.add(SpeakingSentenceDetailDto.builder()
                        .unitId(unit.id())
                        .unitIndex(unit.sequenceNumber())
                        .text(unit.displayText())
                        .unitState(unitState)
                        .lockedTargetId(lockedTargetId)
                        .targetWord(targetWord)
                        .primaryIssueType(primaryIssueType)
                        .attempts(attemptDtos)
                        .build());
            }
        } else if (!attemptsByUnitId.isEmpty()) {
            int idx = 0;
            for (Map.Entry<Long, List<SpeakingShadowingAttempt>> entry : attemptsByUnitId.entrySet()) {
                List<SpeakingShadowingAttempt> unitAttempts = entry.getValue();
                List<SpeakingShadowingAttemptDto> attemptDtos = unitAttempts.stream()
                        .map(shadowingService::mapToDto)
                        .collect(Collectors.toList());

                SpeakingShadowingAttempt latest = unitAttempts.get(unitAttempts.size() - 1);
                String unitState = Boolean.TRUE.equals(latest.getResolvedThisSession()) ? "RESOLVED_THIS_SESSION" : "ATTEMPTED";

                sentenceDetails.add(SpeakingSentenceDetailDto.builder()
                        .unitId(entry.getKey())
                        .unitIndex(idx++)
                        .text(latest.getLearnerTranscript())
                        .unitState(unitState)
                        .lockedTargetId(latest.getActiveTargetId())
                        .targetWord(latest.getTargetWord())
                        .primaryIssueType(latest.getPrimaryIssueType())
                        .attempts(attemptDtos)
                        .build());
            }
        }

        return SpeakingSessionDetailDto.builder()
                .sessionId(session.getId())
                .materialId(session.getSourceId())
                .materialTitle(materialTitle)
                .mode(session.getMode())
                .status(session.getStatus())
                .currentUnitIndex(session.getCurrentUnitIndex())
                .completedUnitsCount(session.getCompletedUnitsCount())
                .totalUnitsCount(session.getTotalUnitsCount())
                .createdAt(session.getCreatedAt())
                .updatedAt(session.getUpdatedAt())
                .sentences(sentenceDetails)
                .build();
    }

    @Transactional(readOnly = true)
    public List<SpeakingRecurringIssueDto> getRecurringIssues(Long userId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required");
        }
        LocalDateTime thirtyDaysAgo = LocalDateTime.now().minusDays(RECURRENCE_LOOKBACK_DAYS);
        List<SpeakingShadowingAttempt> attempts = attemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(
                userId, thirtyDaysAgo
        );
        List<SpeakingTurnFeedback> feedbacks = feedbackRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(
                userId, thirtyDaysAgo
        );
        return computeComprehensiveRecurringIssues(attempts, feedbacks);
    }

    public List<SpeakingRecurringIssueDto> computeComprehensiveRecurringIssues(
            List<SpeakingShadowingAttempt> attempts,
            List<SpeakingTurnFeedback> feedbacks
    ) {
        List<SpeakingRecurringIssueDto> results = new ArrayList<>();

        // 1. Compute Pronunciation Recurring Issues
        results.addAll(computePronunciationRecurringIssues(attempts));

        // 2. Compute Grammar / Vocabulary / Naturalness Recurring Issues
        if (feedbacks != null && !feedbacks.isEmpty()) {
            results.addAll(computeGrammarAndVocabRecurringIssues(feedbacks));
        }

        // Deterministic Ranking: distinctSessionsObserved desc, lastObservedAt desc
        results.sort(Comparator
                .comparing(SpeakingRecurringIssueDto::getDistinctSessionsObserved, Comparator.nullsLast(Comparator.reverseOrder()))
                .thenComparing(SpeakingRecurringIssueDto::getLastObservedAt, Comparator.nullsLast(Comparator.reverseOrder())));

        return results;
    }

    private List<SpeakingRecurringIssueDto> computePronunciationRecurringIssues(List<SpeakingShadowingAttempt> attempts) {
        // Group by stable key: issueType + targetWord
        Map<String, List<SpeakingShadowingAttempt>> grouped = new HashMap<>();

        for (SpeakingShadowingAttempt att : attempts) {
            String issueType = att.getPrimaryIssueType();
            if (issueType == null || issueType.isBlank()) {
                continue;
            }
            // Strict Exclusion: VALID_VARIANT, NO_SAFE_TARGET, INCONCLUSIVE, technical errors
            if ("VALID_VARIANT".equalsIgnoreCase(issueType) ||
                "NO_SAFE_TARGET".equalsIgnoreCase(issueType) ||
                "INCONCLUSIVE".equalsIgnoreCase(issueType) ||
                "RUNTIME_BUSY".equalsIgnoreCase(issueType) ||
                "TIMEOUT".equalsIgnoreCase(issueType) ||
                "NO_SPEECH".equalsIgnoreCase(issueType)) {
                continue;
            }

            String word = att.getTargetWord() != null ? att.getTargetWord().toLowerCase().trim() : "";
            String key = "PRONUNCIATION:" + issueType + (word.isEmpty() ? "" : ":" + word);
            grouped.computeIfAbsent(key, k -> new ArrayList<>()).add(att);
        }

        List<SpeakingRecurringIssueDto> results = new ArrayList<>();

        for (Map.Entry<String, List<SpeakingShadowingAttempt>> entry : grouped.entrySet()) {
            List<SpeakingShadowingAttempt> attList = entry.getValue();

            // Calculate distinct sessions
            Set<Long> distinctSessions = attList.stream()
                    .map(a -> a.getSession().getId())
                    .collect(Collectors.toSet());

            if (distinctSessions.size() >= RECURRENCE_MIN_DISTINCT_SESSIONS) {
                SpeakingShadowingAttempt latest = attList.get(attList.size() - 1);
                String issueType = latest.getPrimaryIssueType();
                String targetWord = latest.getTargetWord();

                // Count distinct sessions where target was resolved
                Set<Long> resolvedSessions = attList.stream()
                        .filter(a -> Boolean.TRUE.equals(a.getResolvedThisSession()))
                        .map(a -> a.getSession().getId())
                        .collect(Collectors.toSet());

                int distinctCount = distinctSessions.size();
                int resolvedCount = resolvedSessions.size();

                // Determine Status per SPEAKING_PROFILE_POLICY_v1 / v2
                String status;
                String statusExplanation;
                boolean latestResolved = Boolean.TRUE.equals(latest.getResolvedThisSession());
                if (resolvedCount >= 2 && resolvedCount == distinctCount && latestResolved) {
                    status = "RECENTLY_STABLE";
                    statusExplanation = "Đã ổn định gần đây • Khắc phục thành công qua " + resolvedCount + "/" + distinctCount + " phiên luyện tập";
                } else if (resolvedCount >= 2 && resolvedCount >= (distinctCount / 2)) {
                    status = "IMPROVING";
                    statusExplanation = "Đang tiến bộ • Đã cải thiện thành công trong " + resolvedCount + "/" + distinctCount + " phiên luyện tập";
                } else if (resolvedCount > 0) {
                    status = "PRACTICING";
                    statusExplanation = "Đang tích cực luyện tập • Đã có phiên cải thiện thành công (" + resolvedCount + "/" + distinctCount + " phiên)";
                } else {
                    status = "NEEDS_ATTENTION";
                    statusExplanation = "Cần chú ý thêm • Xuất hiện trong " + distinctCount + " phiên gần đây chưa có phiên cải thiện dứt điểm";
                }

                String extractedPhone = extractPriorityField(latest.getProductSafeResultJson(), "phone");
                String extractedObserved = extractPriorityField(latest.getProductSafeResultJson(), "observed");
                String extractedInstruction = extractPriorityField(latest.getProductSafeResultJson(), "instructionVi");
                String category = (issueType != null && issueType.toUpperCase(Locale.ROOT).contains("STRESS")) ? "STRESS" : "PRONUNCIATION";

                String title = formatPronunciationIssueTitle(issueType, targetWord);
                String displayCue = (extractedInstruction != null && !extractedInstruction.isBlank())
                        ? extractedInstruction
                        : generateSafeDisplayCue(issueType, targetWord);

                // Collect up to 3 distinct examples (batch-free: group visible materials upfront if needed)
                List<SpeakingIssueExampleDto> examples = new ArrayList<>();
                Set<String> seenWords = new HashSet<>();
                for (int i = attList.size() - 1; i >= 0 && examples.size() < 3; i--) {
                    SpeakingShadowingAttempt a = attList.get(i);
                    String exWord = a.getTargetWord() != null ? a.getTargetWord() : "từ mục tiêu";
                    if (seenWords.add(exWord.toLowerCase())) {
                        String snippet = (a.getShadowingUnit() != null)
                                ? a.getShadowingUnit().getDisplayText()
                                : (a.getLearnerTranscript() != null ? a.getLearnerTranscript() : exWord);

                        String sourceTitle = "Bài luyện Shadowing";
                        if (a.getSession().getSourceId() != null) {
                            Long ownerId = a.getSession().getUser() != null ? a.getSession().getUser().getId() : null;
                            Optional<ListeningMaterial> m = materialRepository.findByIdAndVisibleToUser(a.getSession().getSourceId(), ownerId)
                                    .filter(mat -> isMaterialVisibleToUser(mat, ownerId));
                            if (m.isPresent()) sourceTitle = m.get().getTitle();
                        }

                        examples.add(SpeakingIssueExampleDto.builder()
                                .targetWord(exWord)
                                .sentenceSnippet(snippet)
                                .sourceTitle(sourceTitle)
                                .sourceId(a.getSession().getSourceId())
                                .mode("SHADOWING")
                                .timestamp(a.getCreatedAt())
                                .build());
                    }
                }

                Long practiceSourceId = latest.getSession().getSourceId();
                String practiceRoute = practiceSourceId != null ? "/speaking/shadowing/" + practiceSourceId : "/speaking?mode=shadowing";

                results.add(SpeakingRecurringIssueDto.builder()
                        .issueKey(entry.getKey())
                        .category(category)
                        .title(title)
                        .issueType(issueType)
                        .targetWord(targetWord)
                        .targetPhone(extractedPhone)
                        .observedPhone(extractedObserved)
                        .status(status)
                        .statusExplanation(statusExplanation)
                        .distinctSessionsObserved(distinctCount)
                        .totalOccurrences(attList.size())
                        .resolvedSessionCount(resolvedCount)
                        .lastObservedAt(latest.getCreatedAt())
                        .displayCue(displayCue)
                        .evidenceWindow("30 ngày gần nhất")
                        .recentExamples(examples)
                        .practiceAgainRoute(practiceRoute)
                        .practiceAgainLabel("Luyện lại bài này")
                        .build());
            }
        }

        return results;
    }

    private List<SpeakingRecurringIssueDto> computeGrammarAndVocabRecurringIssues(List<SpeakingTurnFeedback> feedbacks) {
        Map<String, List<FeedbackCorrectionOccurrence>> grouped = new HashMap<>();

        for (SpeakingTurnFeedback fb : feedbacks) {
            if (fb.getCorrectionsJson() == null || fb.getCorrectionsJson().isBlank()) {
                continue;
            }
            try {
                List<TurnCorrectionDto> corrections = MAPPER.readValue(
                        fb.getCorrectionsJson(),
                        new TypeReference<List<TurnCorrectionDto>>() {}
                );
                for (TurnCorrectionDto corr : corrections) {
                    String cat = (corr.type() != null) ? corr.type().toUpperCase() : "GRAMMAR";
                    String explanation = (corr.explanation() != null) ? corr.explanation().trim() : "";
                    String issueKey = cat + ":" + normalizeCorrectionKey(explanation, corr.original());

                    grouped.computeIfAbsent(issueKey, k -> new ArrayList<>()).add(
                            new FeedbackCorrectionOccurrence(fb, corr, cat)
                    );
                }
            } catch (Exception e) {
                log.debug("Failed to parse correction JSON: {}", e.getMessage());
            }
        }

        List<SpeakingRecurringIssueDto> results = new ArrayList<>();

        for (Map.Entry<String, List<FeedbackCorrectionOccurrence>> entry : grouped.entrySet()) {
            List<FeedbackCorrectionOccurrence> occList = entry.getValue();

            Set<Long> distinctSessions = occList.stream()
                    .map(o -> o.feedback.getTurn().getSession().getId())
                    .collect(Collectors.toSet());

            if (distinctSessions.size() >= RECURRENCE_MIN_DISTINCT_SESSIONS) {
                FeedbackCorrectionOccurrence latest = occList.get(occList.size() - 1);
                String cat = latest.category;
                int distinctCount = distinctSessions.size();

                String status = "NEEDS_ATTENTION";
                String statusExplanation = "Gặp phải trong " + distinctCount + " phiên hội thoại gần đây";

                String title = formatGrammarVocabTitle(cat, latest.correction);
                String displayCue = (latest.correction.explanation() != null && !latest.correction.explanation().isBlank())
                        ? latest.correction.explanation()
                        : "Chú ý sử dụng đúng cấu trúc ngữ pháp và từ vựng phù hợp.";

                List<SpeakingIssueExampleDto> examples = new ArrayList<>();
                Set<String> seenPhrases = new HashSet<>();
                for (int i = occList.size() - 1; i >= 0 && examples.size() < 3; i--) {
                    FeedbackCorrectionOccurrence o = occList.get(i);
                    String orig = o.correction.original() != null ? o.correction.original() : "";
                    if (seenPhrases.add(orig.toLowerCase())) {
                        SpeakingScenario sc = o.feedback.getTurn().getSession().getScenario();
                        String scTitle = sc != null ? sc.getTitle() : "Hội thoại AI";
                        Long scId = sc != null ? sc.getId() : null;

                        examples.add(SpeakingIssueExampleDto.builder()
                                .originalPhrase(orig)
                                .suggestedPhrase(o.correction.suggestion())
                                .explanation(o.correction.explanation())
                                .sentenceSnippet(o.feedback.getTurn().getText())
                                .sourceTitle(scTitle)
                                .sourceId(scId)
                                .mode("ROLEPLAY")
                                .timestamp(o.feedback.getCreatedAt())
                                .build());
                    }
                }

                SpeakingScenario latestSc = latest.feedback.getTurn().getSession().getScenario();
                String practiceRoute = latestSc != null ? "/speaking/roleplay/" + latestSc.getId() : "/speaking?mode=roleplay";

                results.add(SpeakingRecurringIssueDto.builder()
                        .issueKey(entry.getKey())
                        .category(cat)
                        .title(title)
                        .issueType(cat)
                        .targetWord(latest.correction.original())
                        .targetPhone(null)
                        .status(status)
                        .statusExplanation(statusExplanation)
                        .distinctSessionsObserved(distinctCount)
                        .totalOccurrences(occList.size())
                        .resolvedSessionCount(0)
                        .lastObservedAt(latest.feedback.getCreatedAt())
                        .displayCue(displayCue)
                        .evidenceWindow("30 ngày gần nhất")
                        .recentExamples(examples)
                        .practiceAgainRoute(practiceRoute)
                        .practiceAgainLabel("Luyện lại tình huống này")
                        .build());
            }
        }

        return results;
    }

    private String normalizeCorrectionKey(String explanation, String original) {
        String base = (explanation != null && !explanation.isBlank()) ? explanation : (original != null ? original : "general");
        return base.toLowerCase().replaceAll("[^a-z0-9]", "_").replaceAll("_+", "_");
    }

    public static String mapIssueTypeToLearnerLabel(String issueType) {
        if (issueType == null || issueType.isBlank()) return "Phát âm";
        String norm = issueType.toUpperCase().trim();
        if (norm.contains("PHONE_SUBSTITUTION")) return "Thay thế âm";
        if (norm.contains("PHONE_DELETION")) return "Bỏ âm";
        if (norm.contains("PHONE_INSERTION")) return "Thêm âm";
        if (norm.contains("STRESS")) return "Trọng âm từ";
        if (norm.contains("DENTAL")) return "Âm răng (/θ/, /ð/)";
        if (norm.contains("LABIODENTAL")) return "Âm môi-răng (/v/, /f/)";
        if (norm.contains("ALVEOLAR")) return "Âm lợi / đầu lưỡi (/r/, /l/)";
        if (norm.contains("PAUSE")) return "Ngắt nghỉ câu";
        if (norm.contains("INTONATION")) return "Ngữ điệu câu";
        if (norm.contains("RHYTHM")) return "Nhịp điệu câu";
        if (norm.contains("CONTENT")) return "Khớp nội dung";
        return "Phát âm";
    }

    private String formatPronunciationIssueTitle(String issueType, String targetWord) {
        if (targetWord != null && !targetWord.isBlank()) {
            return "Phát âm từ \"" + targetWord + "\"";
        }
        return mapIssueTypeToLearnerLabel(issueType);
    }

    private String extractPriorityField(String json, String fieldName) {
        if (json == null || json.isBlank()) return null;
        try {
            com.fasterxml.jackson.databind.JsonNode priorities = MAPPER.readTree(json).path("priorities");
            if (priorities.isArray() && !priorities.isEmpty()) {
                com.fasterxml.jackson.databind.JsonNode first = priorities.get(0).path(fieldName);
                if (!first.isMissingNode() && !first.isNull()) {
                    String val = first.asText("").trim();
                    return val.isEmpty() ? null : val;
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    private SpeakingPronunciationMetricsDto computePronunciationMetrics(
            List<SpeakingShadowingAttempt> attempts,
            List<com.englishcoach.speaking.entity.SpeakingQuickCheck> quickChecks
    ) {
        int attemptsSize = attempts != null ? attempts.size() : 0;
        int quickChecksSize = quickChecks != null ? quickChecks.size() : 0;
        if (attemptsSize == 0 && quickChecksSize == 0) {
            return SpeakingPronunciationMetricsDto.builder()
                    .scoredAttemptsCount(0L)
                    .totalAttemptsCount(0L)
                    .abstainedAttemptsCount(0L)
                    .sttOnlyAttemptsCount(0L)
                    .lexicalStressMatchedWords(0L)
                    .lexicalStressAssessedWords(0L)
                    .lexicalStressAssessmentsCount(0L)
                    .contentMatchAttemptsCount(0L)
                    .shadowingScoredCount(0L)
                    .quickCheckScoredCount(0L)
                    .roleplayScoredCount(0L)
                    .build();
        }

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

        if (attempts != null) {
            for (SpeakingShadowingAttempt att : attempts) {
                if (att.getAccuracyScore() != null) {
                    sumAccuracy += att.getAccuracyScore();
                    countAccuracy++;
                }
                boolean scoredThisAttempt = false;
                if (att.getPronunciationScore() != null) {
                    sumPron += att.getPronunciationScore();
                    countPron++;
                    shadowingScored++;
                    scoredThisAttempt = true;
                }
                if (att.getFluencyScore() != null) {
                    sumFluency += att.getFluencyScore();
                    countFluency++;
                }

                boolean explicitlyAbstained = "ABSTAINED".equalsIgnoreCase(att.getAnalysisStatus());
                String json = att.getProductSafeResultJson();
                if (json != null && !json.isBlank()) {
                    try {
                        com.fasterxml.jackson.databind.JsonNode root = MAPPER.readTree(json);
                        if ("ABSTAINED".equalsIgnoreCase(root.path("status").asText())) {
                            explicitlyAbstained = true;
                        }
                        com.fasterxml.jackson.databind.JsonNode overall = root.path("overall");
                        if (overall.isObject()) {
                            if (overall.hasNonNull("segmentalScore")) {
                                sumSegmental += overall.get("segmentalScore").asDouble();
                                countSegmental++;
                            }
                            com.fasterxml.jackson.databind.JsonNode lex = root.path("lexicalStress");
                            if ("ALIGNED_VOWEL_PROMINENCE_V1".equals(lex.path("method").asText())
                                    && "ASSESSED".equals(lex.path("status").asText())) {
                                int assessed = lex.path("assessed").asInt(0);
                                int matched = lex.path("matched").asInt(-1);
                                if (assessed >= 1 && matched >= 0 && matched <= assessed) {
                                    stressAssessedWords += assessed;
                                    stressMatchedWords += matched;
                                    sumStress += (100.0 * matched / assessed);
                                    countStress++;
                                }
                            } else if ("ASSESSED".equals(lex.path("status").asText()) && overall.hasNonNull("stressScore")) {
                                sumStress += overall.get("stressScore").asDouble();
                                countStress++;
                            }
                            if (overall.hasNonNull("intonationScore")) {
                                sumPitch += overall.get("intonationScore").asDouble();
                                countPitch++;
                            }
                            if (overall.hasNonNull("rhythmScore")) {
                                sumRhythm += overall.get("rhythmScore").asDouble();
                                countRhythm++;
                            }
                            if (att.getFluencyScore() == null && overall.hasNonNull("fluencyScore")) {
                                sumFluency += overall.get("fluencyScore").asDouble();
                                countFluency++;
                            }
                        }
                    } catch (Exception ignored) {}
                }
                if (!scoredThisAttempt) {
                    if (explicitlyAbstained) abstainedCount++;
                    else sttOnlyCount++;
                }
            }
        }

        if (quickChecks != null) {
            for (com.englishcoach.speaking.entity.SpeakingQuickCheck qc : quickChecks) {
                boolean scoredThisQc = false;
                if (qc.getOverallScore() != null) {
                    sumPron += qc.getOverallScore();
                    countPron++;
                    quickCheckScored++;
                    scoredThisQc = true;
                }
                if (qc.getPhonemeScore() != null) {
                    sumSegmental += qc.getPhonemeScore();
                    countSegmental++;
                }
                String qcJson = qc.getPronunciationDiagnosticsJson();
                boolean qcAbstained = false;
                if (qcJson != null && !qcJson.isBlank()) {
                    try {
                        com.fasterxml.jackson.databind.JsonNode root = MAPPER.readTree(qcJson);
                        if ("ABSTAINED".equalsIgnoreCase(root.path("status").asText())) {
                            qcAbstained = true;
                        }
                        com.fasterxml.jackson.databind.JsonNode lex = root.path("lexicalStress");
                        if ("ALIGNED_VOWEL_PROMINENCE_V1".equals(lex.path("method").asText())
                                && "ASSESSED".equals(lex.path("status").asText())) {
                            int assessed = lex.path("assessed").asInt(0);
                            int matched = lex.path("matched").asInt(-1);
                            if (assessed >= 1 && matched >= 0 && matched <= assessed) {
                                stressAssessedWords += assessed;
                                stressMatchedWords += matched;
                            }
                        }
                    } catch (Exception ignored) {}
                }
                Integer measuredStress = com.englishcoach.speaking.dto.PronunciationV2ResponseDto.historicalStressScore(qcJson);
                if (measuredStress != null) {
                    sumStress += measuredStress;
                    countStress++;
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
                if (!scoredThisQc) {
                    if (qcAbstained) abstainedCount++;
                    else sttOnlyCount++;
                }
            }
        }

        return SpeakingPronunciationMetricsDto.builder()
                .averagePronunciationScore(countPron > 0 ? Math.round(sumPron / countPron * 10.0) / 10.0 : null)
                .averageContentMatchScore(countAccuracy > 0 ? Math.round(sumAccuracy / countAccuracy * 10.0) / 10.0 : null)
                .averagePhonemeScore(countSegmental > 0 ? Math.round(sumSegmental / countSegmental * 10.0) / 10.0 : null)
                .averageStressScore(countStress > 0 ? Math.round(sumStress / countStress * 10.0) / 10.0 : null)
                .averagePitchScore(countPitch > 0 ? Math.round(sumPitch / countPitch * 10.0) / 10.0 : null)
                .averageRhythmScore(countRhythm > 0 ? Math.round(sumRhythm / countRhythm * 10.0) / 10.0 : null)
                .averageFluencyScore(countFluency > 0 ? Math.round(sumFluency / countFluency * 10.0) / 10.0 : null)
                .scoredAttemptsCount((long) countPron)
                .totalAttemptsCount((long) (attemptsSize + quickChecksSize))
                .abstainedAttemptsCount(abstainedCount)
                .sttOnlyAttemptsCount(sttOnlyCount)
                .lexicalStressMatchedWords(stressMatchedWords)
                .lexicalStressAssessedWords(stressAssessedWords)
                .lexicalStressAssessmentsCount((long) countStress)
                .contentMatchAttemptsCount((long) countAccuracy)
                .shadowingScoredCount(shadowingScored)
                .quickCheckScoredCount(quickCheckScored)
                .roleplayScoredCount(0L)
                .build();
    }

    private String formatGrammarVocabTitle(String category, TurnCorrectionDto correction) {
        if ("VOCABULARY".equalsIgnoreCase(category)) {
            return "Từ vựng: " + (correction.original() != null ? "\"" + correction.original() + "\"" : "Cách dùng từ");
        }
        if ("NATURALNESS".equalsIgnoreCase(category)) {
            return "Độ tự nhiên diễn đạt: " + (correction.original() != null ? "\"" + correction.original() + "\"" : "Ngữ cảnh");
        }
        return "Ngữ pháp: " + (correction.explanation() != null && correction.explanation().length() <= 40 ? correction.explanation() : "Cấu trúc câu");
    }

    private List<SpeakingRecentImprovementDto> computeRecentImprovements(List<SpeakingShadowingAttempt> attempts) {
        List<SpeakingRecentImprovementDto> improvements = new ArrayList<>();

        // Iterate backwards from most recent
        for (int i = attempts.size() - 1; i >= 0 && improvements.size() < 5; i--) {
            SpeakingShadowingAttempt att = attempts.get(i);
            if (Boolean.TRUE.equals(att.getResolvedThisSession())) {
                String issueType = att.getPrimaryIssueType();
                if (issueType != null && !"VALID_VARIANT".equalsIgnoreCase(issueType)) {
                    String title = "Shadowing Practice";
                    if (att.getSession().getSourceId() != null) {
                        Long ownerId = att.getSession().getUser() != null ? att.getSession().getUser().getId() : null;
                        Optional<ListeningMaterial> m = materialRepository.findByIdAndVisibleToUser(att.getSession().getSourceId(), ownerId)
                                .filter(mat -> isMaterialVisibleToUser(mat, ownerId));
                        if (m.isPresent()) title = m.get().getTitle();
                    }

                    improvements.add(SpeakingRecentImprovementDto.builder()
                            .sessionId(att.getSession().getId())
                            .materialTitle(title)
                            .targetWord(att.getTargetWord())
                            .targetPhone(null)
                            .issueType(issueType)
                            .retryCount(att.getRetryIndex() != null ? att.getRetryIndex() : 1)
                            .resolvedAt(att.getCreatedAt())
                            .note("Đã sửa thành công trong lần thử lại cùng phiên")
                            .build());
                }
            }
        }
        return improvements;
    }

    private List<SpeakingSessionSummaryDto> mapToSessionSummaries(List<SpeakingSession> sessions, Long userId) {
        if (sessions.isEmpty()) return Collections.emptyList();

        List<Long> sessionIds = sessions.stream().map(SpeakingSession::getId).collect(Collectors.toList());
        List<SpeakingShadowingAttempt> allAttempts = attemptRepository.findBySessionIdIn(sessionIds);

        Map<Long, List<SpeakingShadowingAttempt>> attemptsBySession = allAttempts.stream()
                .collect(Collectors.groupingBy(a -> a.getSession().getId()));

        List<com.englishcoach.speaking.entity.SpeakingTurn> allTurns = speakingTurnRepository.findBySessionIdIn(sessionIds);
        Map<Long, List<com.englishcoach.speaking.entity.SpeakingTurn>> turnsBySession = allTurns.stream()
                .collect(Collectors.groupingBy(t -> t.getSession().getId()));

        // Batch fetch material titles (strictly scoped to materials visible to userId)
        Set<Long> materialIds = sessions.stream()
                .filter(s -> !"ROLEPLAY".equalsIgnoreCase(s.getMode()) && !"QUICK_CHECK".equalsIgnoreCase(s.getMode()))
                .map(SpeakingSession::getSourceId)
                .filter(Objects::nonNull)
                .collect(Collectors.toSet());
        Map<Long, String> materialTitles = new HashMap<>();
        if (!materialIds.isEmpty()) {
            materialRepository.findAllById(materialIds).stream()
                    .filter(m -> isMaterialVisibleToUser(m, userId))
                    .forEach(m -> materialTitles.put(m.getId(), m.getTitle()));
        }

        List<Long> qcSessionIds = sessions.stream()
                .filter(s -> "QUICK_CHECK".equalsIgnoreCase(s.getMode()))
                .map(SpeakingSession::getId)
                .collect(Collectors.toList());
        Map<Long, com.englishcoach.speaking.entity.SpeakingQuickCheck> qcBySession = new HashMap<>();
        if (!qcSessionIds.isEmpty()) {
            quickCheckRepository.findBySessionIdIn(qcSessionIds)
                    .forEach(qc -> {
                        if (qc.getSession() != null) {
                            qcBySession.put(qc.getSession().getId(), qc);
                        }
                    });
        }

        List<SpeakingSessionSummaryDto> summaries = new ArrayList<>();
        for (SpeakingSession s : sessions) {
            boolean isQuickCheck = "QUICK_CHECK".equalsIgnoreCase(s.getMode());
            if (isQuickCheck) {
                com.englishcoach.speaking.entity.SpeakingQuickCheck qc = qcBySession.get(s.getId());
                String title = (qc != null && qc.getIntendedTranscript() != null && !qc.getIntendedTranscript().isBlank())
                        ? qc.getIntendedTranscript()
                        : (qc != null && qc.getWhisperTranscript() != null ? qc.getWhisperTranscript() : "Quick Check");
                summaries.add(SpeakingSessionSummaryDto.builder()
                        .sessionId(s.getId())
                        .materialId(null)
                        .materialTitle(title)
                        .mode(s.getMode())
                        .status(s.getStatus())
                        .sentencesPracticed(1)
                        .totalSentences(1)
                        .attemptCount(1)
                        .retryCount(0)
                        .resolvedTargetCount(0)
                        .createdAt(s.getCreatedAt())
                        .updatedAt(s.getUpdatedAt())
                        .build());
            } else if ("ROLEPLAY".equalsIgnoreCase(s.getMode())) {
                List<com.englishcoach.speaking.entity.SpeakingTurn> turns = turnsBySession.getOrDefault(s.getId(), Collections.emptyList());
                long learnerTurns = turns.stream().filter(t -> "LEARNER".equalsIgnoreCase(t.getSpeaker())).count();
                String title = s.getScenario() != null ? s.getScenario().getTitle() : "AI Role-play";
                summaries.add(SpeakingSessionSummaryDto.builder()
                        .sessionId(s.getId())
                        .materialId(s.getScenario() != null ? s.getScenario().getId() : null)
                        .materialTitle(title)
                        .mode(s.getMode())
                        .status(s.getStatus())
                        .sentencesPracticed((int) learnerTurns)
                        .totalSentences((int) learnerTurns)
                        .attemptCount((int) learnerTurns)
                        .retryCount(0)
                        .resolvedTargetCount(0)
                        .createdAt(s.getCreatedAt())
                        .updatedAt(s.getUpdatedAt())
                        .build());
            } else {
                List<SpeakingShadowingAttempt> atts = attemptsBySession.getOrDefault(s.getId(), Collections.emptyList());
                int retries = 0;
                int resolved = 0;
                for (SpeakingShadowingAttempt a : atts) {
                    if (a.getRetryIndex() != null && a.getRetryIndex() > 0) retries++;
                    if (Boolean.TRUE.equals(a.getResolvedThisSession())) resolved++;
                }

                String title = materialTitles.getOrDefault(s.getSourceId(), "Shadowing Practice");

                summaries.add(SpeakingSessionSummaryDto.builder()
                        .sessionId(s.getId())
                        .materialId(s.getSourceId())
                        .materialTitle(title)
                        .mode(s.getMode())
                        .status(s.getStatus())
                        .sentencesPracticed(s.getCompletedUnitsCount() != null ? s.getCompletedUnitsCount() : 0)
                        .totalSentences(s.getTotalUnitsCount() != null ? s.getTotalUnitsCount() : 0)
                        .attemptCount(atts.size())
                        .retryCount(retries)
                        .resolvedTargetCount(resolved)
                        .createdAt(s.getCreatedAt())
                        .updatedAt(s.getUpdatedAt())
                        .build());
            }
        }
        return summaries;
    }

    private String generateSafeDisplayCue(String issueType, String targetWord) {
        if (targetWord != null && !targetWord.isBlank()) {
            return "Chú ý phát âm rõ ràng, chuẩn xác âm vị trọng tâm trong từ \"" + targetWord + "\".";
        }
        if (issueType != null && issueType.toUpperCase().contains("STRESS")) {
            return "Chú ý nhấn đúng trọng âm và nhịp điệu tự nhiên của từ.";
        }
        if (issueType != null && issueType.toUpperCase().contains("INTONATION")) {
            return "Chú ý ngữ điệu lên xuống tự nhiên theo cấu trúc câu.";
        }
        return "Luyện tập cử động khẩu hình rõ ràng và nhất quán trong các câu tiếp theo.";
    }

    private static boolean isMaterialVisibleToUser(ListeningMaterial m, Long userId) {
        if (m == null) return false;
        if (m.isSystem() && m.getOwnerUserId() == null) return true;
        return userId != null && userId.equals(m.getOwnerUserId());
    }

    private record FeedbackCorrectionOccurrence(
            SpeakingTurnFeedback feedback,
            TurnCorrectionDto correction,
            String category
    ) {}
}
