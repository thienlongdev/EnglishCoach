package com.englishcoach.speaking.service;

import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.speaking.dto.*;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingShadowingAttempt;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.speaking.entity.SpeakingTurnFeedback;
import com.englishcoach.speaking.repository.*;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.*;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
@Slf4j
public class SpeakingProgressService {

    private final SpeakingTurnRepository speakingTurnRepository;
    private final SpeakingSessionRepository speakingSessionRepository;
    private final SpeakingResultRepository speakingResultRepository;
    private final SpeakingTurnFeedbackRepository speakingTurnFeedbackRepository;
    private final SpeakingShadowingAttemptRepository speakingShadowingAttemptRepository;
    private final ListeningMaterialRepository listeningMaterialRepository;
    private final SpeakingProgressAggregationService progressAggregationService;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Transactional(readOnly = true)
    public SpeakingProgressDto getUserSpeakingProgress(Long userId) {
        if (userId == null) {
            return new SpeakingProgressDto(0L, 0L, 0L, 0.0, 0L, 0,
                    new SpeakingWeaknessProfileDto(List.of(), List.of()), List.of());
        }

        // 1. Qualified Speaking Duration (Learner Turns + Completed Shadowing)
        Long learnerTurnDuration = speakingTurnRepository.sumLearnerSpeakingDurationSeconds(userId);
        Long shadowingDuration = speakingSessionRepository.sumCompletedShadowingDurationSeconds(userId);
        long totalQualifiedSeconds = (learnerTurnDuration != null ? learnerTurnDuration : 0L)
                + (shadowingDuration != null ? shadowingDuration : 0L);

        // 2. Completed Sessions Count
        Long totalCompletedSessions = speakingSessionRepository.countCompletedSessionsByUserId(userId);
        if (totalCompletedSessions == null) totalCompletedSessions = 0L;

        // 3. Learner Roleplay Turns Count (strictly excludes assistant turns & mocked turns)
        Long totalRoleplayTurns = speakingTurnRepository.countLearnerRoleplayTurns(userId);
        if (totalRoleplayTurns == null) totalRoleplayTurns = 0L;

        // 4. Average Word/Transcript Accuracy Score (Honest score from verified attempts)
        Double avgScore = speakingResultRepository.getAverageAccuracyScoreByUserId(userId);
        double roundedAccuracy = (avgScore != null) ? Math.round(avgScore * 10.0) / 10.0 : 0.0;

        // 5. Target Vocabulary Distinct Count
        Long targetVocabCount = speakingTurnRepository.countDistinctTargetVocabularyUsed(userId);
        if (targetVocabCount == null) targetVocabCount = 0L;

        LocalDateTime thirtyDaysAgo = LocalDateTime.now().minusDays(30);
        List<SpeakingShadowingAttempt> attempts30d = speakingShadowingAttemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(
                userId, thirtyDaysAgo
        );
        if (attempts30d == null) {
            attempts30d = List.of();
        }

        // 6. Streak Calculation (unites genuine turns, sessions, and shadowing attempts)
        int streakDays = calculateStreak(userId, attempts30d);

        // 7. Weakness Profile 2.0 (Aggregate Pronunciation + Grammar/Vocab Recurring Issues)
        SpeakingWeaknessProfileDto weaknessProfile = buildWeaknessProfile(userId);

        // 8. Recent Activities (Rich Practice Memory Cards)
        List<SpeakingRecentActivityDto> recentActivities = getRecentActivities(userId);

        long activeTargets = (weaknessProfile.issues() != null) ? weaknessProfile.issues().size() : 0L;

        long resolvedCount = attempts30d.stream()
                .filter(a -> Boolean.TRUE.equals(a.getResolvedThisSession()))
                .count();

        return SpeakingProgressDto.builder()
                .totalQualifiedSpeakingSeconds(totalQualifiedSeconds)
                .totalCompletedSessions(totalCompletedSessions)
                .totalRoleplayTurns(totalRoleplayTurns)
                .averageWordAccuracy(roundedAccuracy)
                .targetVocabularyUsed(targetVocabCount)
                .currentStreakDays(streakDays)
                .activeRecurringTargetsCount(activeTargets)
                .recentImprovementsCount(resolvedCount)
                .weaknessProfile(weaknessProfile)
                .recentActivity(recentActivities)
                .build();
    }

    private int calculateStreak(Long userId, List<SpeakingShadowingAttempt> attempts30d) {
        List<LocalDateTime> turnDates = speakingTurnRepository.findGenuineTurnCreatedTimes(userId);
        List<LocalDateTime> sessionDates = speakingSessionRepository.findSessionCreatedTimes(userId);

        Set<LocalDate> activeDays = new HashSet<>();
        if (turnDates != null) {
            for (LocalDateTime t : turnDates) {
                if (t != null) activeDays.add(t.toLocalDate());
            }
        }
        if (sessionDates != null) {
            for (LocalDateTime s : sessionDates) {
                if (s != null) activeDays.add(s.toLocalDate());
            }
        }
        if (attempts30d != null) {
            for (SpeakingShadowingAttempt a : attempts30d) {
                if (a != null && a.getCreatedAt() != null && !Boolean.TRUE.equals(a.getIsMocked())) {
                    activeDays.add(a.getCreatedAt().toLocalDate());
                }
            }
        }

        if (activeDays.isEmpty()) {
            return 0;
        }

        LocalDate today = LocalDate.now();
        LocalDate yesterday = today.minusDays(1);

        LocalDate checkDate;
        if (activeDays.contains(today)) {
            checkDate = today;
        } else if (activeDays.contains(yesterday)) {
            checkDate = yesterday;
        } else {
            return 0; // Streak broken
        }

        int streak = 0;
        while (activeDays.contains(checkDate)) {
            streak++;
            checkDate = checkDate.minusDays(1);
        }

        return streak;
    }

    private SpeakingWeaknessProfileDto buildWeaknessProfile(Long userId) {
        List<SpeakingTurnFeedback> feedbacks = speakingTurnFeedbackRepository.findGenuineFeedbacksByUserId(userId);

        Map<String, Long> categoryCounts = new HashMap<>();

        if (feedbacks != null) {
            for (SpeakingTurnFeedback fb : feedbacks) {
                if (fb.getCorrectionsJson() != null && !fb.getCorrectionsJson().isBlank()) {
                    try {
                        List<TurnCorrectionDto> corrections = MAPPER.readValue(
                                fb.getCorrectionsJson(),
                                new TypeReference<List<TurnCorrectionDto>>() {}
                        );
                        for (TurnCorrectionDto corr : corrections) {
                            String type = (corr.type() != null) ? corr.type().toUpperCase() : "GENERAL";
                            categoryCounts.put(type, categoryCounts.getOrDefault(type, 0L) + 1L);
                        }
                    } catch (Exception e) {
                        log.debug("Failed to parse correction JSON for weakness aggregation: {}", e.getMessage());
                    }
                }
            }
        }

        List<CorrectionCategoryCountDto> topCategories = categoryCounts.entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue().reversed())
                .map(e -> new CorrectionCategoryCountDto(e.getKey(), e.getValue()))
                .collect(Collectors.toList());

        List<AlignmentIssueCountDto> topAlignmentIssues = List.of();

        // Hydrate Weakness Profile 2.0 Recurring Issues with multi-session evidence
        List<SpeakingRecurringIssueDto> issues = Collections.emptyList();
        try {
            issues = progressAggregationService.getRecurringIssues(userId);
        } catch (Exception e) {
            log.warn("Failed to fetch rich recurring issues for profile: {}", e.getMessage());
        }

        return SpeakingWeaknessProfileDto.builder()
                .issues(issues)
                .topCorrectionCategories(topCategories)
                .topAlignmentIssues(topAlignmentIssues)
                .build();
    }

    private List<SpeakingRecentActivityDto> getRecentActivities(Long userId) {
        List<SpeakingSession> recentSessions = speakingSessionRepository.findRecentSessionsByUserId(
                userId,
                PageRequest.of(0, 5)
        );

        if (recentSessions == null || recentSessions.isEmpty()) return List.of();

        List<Long> sessionIds = recentSessions.stream().map(SpeakingSession::getId).toList();
        List<SpeakingShadowingAttempt> shadowingAttempts = speakingShadowingAttemptRepository.findBySessionIdIn(sessionIds);
        Map<Long, List<SpeakingShadowingAttempt>> attemptsBySession = shadowingAttempts.stream()
                .collect(Collectors.groupingBy(a -> a.getSession().getId()));

        List<SpeakingTurn> roleplayTurns = speakingTurnRepository.findBySessionIdIn(sessionIds);
        Map<Long, List<SpeakingTurn>> turnsBySession = roleplayTurns.stream()
                .collect(Collectors.groupingBy(t -> t.getSession().getId()));

        Set<Long> materialIds = recentSessions.stream()
                .map(SpeakingSession::getSourceId)
                .filter(Objects::nonNull)
                .collect(Collectors.toSet());
        Map<Long, String> materialTitles = new HashMap<>();
        if (!materialIds.isEmpty()) {
            listeningMaterialRepository.findAllById(materialIds).stream()
                    .filter(m -> isMaterialVisibleToUser(m, userId))
                    .forEach(m -> materialTitles.put(m.getId(), m.getTitle()));
        }

        return recentSessions.stream()
                .map(s -> {
                    String mode = s.getMode() != null ? s.getMode().toUpperCase() : "SHADOWING";
                    String title;
                    String contentTitle;
                    String summary;
                    String targetWord = null;

                    if ("ROLEPLAY".equals(mode)) {
                        title = "Hội thoại AI Role-play";
                        contentTitle = (s.getScenario() != null) ? s.getScenario().getTitle() : "Tình huống giao tiếp thực tế";
                        List<SpeakingTurn> turns = turnsBySession.getOrDefault(s.getId(), Collections.emptyList());
                        int turnCount = turns.size();
                        summary = turnCount > 0
                                ? turnCount + " lượt đối thoại • Tự động phản hồi"
                                : "Đang bắt đầu phiên hội thoại";
                    } else if ("QUICK_CHECK".equals(mode)) {
                        title = "Kiểm tra nhanh";
                        contentTitle = "Kiểm tra phát âm và diễn đạt";
                        summary = "COMPLETED".equalsIgnoreCase(s.getStatus())
                                ? "Đã hoàn thành kiểm tra nhanh"
                                : "Phiên kiểm tra nhanh";
                    } else {
                        title = "Luyện tập Shadowing";
                        contentTitle = materialTitles.getOrDefault(s.getSourceId(), "Bài luyện tập nói nhại");
                        List<SpeakingShadowingAttempt> atts = attemptsBySession.getOrDefault(s.getId(), Collections.emptyList());
                        int retries = 0;
                        int resolved = 0;
                        for (SpeakingShadowingAttempt a : atts) {
                            if (a.getRetryIndex() != null && a.getRetryIndex() > 0) retries++;
                            if (Boolean.TRUE.equals(a.getResolvedThisSession())) {
                                resolved++;
                                if (targetWord == null && a.getTargetWord() != null) {
                                    targetWord = a.getTargetWord();
                                }
                            }
                        }

                        int completed = s.getCompletedUnitsCount() != null ? s.getCompletedUnitsCount() : 0;
                        int total = s.getTotalUnitsCount() != null ? s.getTotalUnitsCount() : (completed > 0 ? completed : 1);

                        if (resolved > 0 && targetWord != null) {
                            summary = completed + "/" + total + " câu • Đã cải thiện âm trong từ \"" + targetWord + "\"";
                        } else if (retries > 0) {
                            summary = completed + "/" + total + " câu • " + retries + " lần thử lại trong phiên";
                        } else {
                            summary = "Hoàn thành " + completed + "/" + total + " câu luyện tập";
                        }
                    }

                    return SpeakingRecentActivityDto.builder()
                            .sessionId(s.getId())
                            .mode(mode)
                            .title(title)
                            .contentTitle(contentTitle)
                            .summary(summary)
                            .status(s.getStatus())
                            .durationSeconds(s.getDurationSeconds() != null ? s.getDurationSeconds() : 0)
                            .targetWord(targetWord)
                            .sourceId(s.getSourceId())
                            .completedUnits(s.getCompletedUnitsCount())
                            .totalUnits(s.getTotalUnitsCount())
                            .createdAt(s.getCreatedAt())
                            .build();
                })
                .collect(Collectors.toList());
    }

    private static boolean isMaterialVisibleToUser(ListeningMaterial m, Long userId) {
        if (m == null) return false;
        if (m.isSystem() && m.getOwnerUserId() == null) return true;
        return userId != null && userId.equals(m.getOwnerUserId());
    }
}
