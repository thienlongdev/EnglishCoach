package com.englishcoach.speaking.service;

import com.englishcoach.speaking.dto.SpeakingProgressDto;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.speaking.entity.SpeakingTurnFeedback;
import com.englishcoach.speaking.repository.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.LocalDateTime;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SpeakingProgressServiceTest {

    @Mock
    private SpeakingTurnRepository speakingTurnRepository;

    @Mock
    private SpeakingSessionRepository speakingSessionRepository;

    @Mock
    private SpeakingResultRepository speakingResultRepository;

    @Mock
    private SpeakingTurnFeedbackRepository speakingTurnFeedbackRepository;

    @Mock
    private SpeakingShadowingAttemptRepository speakingShadowingAttemptRepository;

    @Mock
    private com.englishcoach.listening.repository.ListeningMaterialRepository listeningMaterialRepository;

    @Mock
    private SpeakingProgressAggregationService progressAggregationService;

    @InjectMocks
    private SpeakingProgressService speakingProgressService;

    private Long userId;

    @BeforeEach
    void setUp() {
        userId = 1L;
        org.mockito.Mockito.lenient().when(speakingShadowingAttemptRepository.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(any(), any()))
                .thenReturn(java.util.List.of());
        org.mockito.Mockito.lenient().when(speakingShadowingAttemptRepository.findBySessionIdIn(any()))
                .thenReturn(java.util.List.of());
        org.mockito.Mockito.lenient().when(speakingTurnRepository.findBySessionIdIn(any()))
                .thenReturn(java.util.List.of());
        org.mockito.Mockito.lenient().when(progressAggregationService.getRecurringIssues(any()))
                .thenReturn(java.util.List.of());
    }

    @Test
    @DisplayName("Zero-data: New user with no activity returns clean empty defaults")
    void testZeroDataReturnsGracefulEmptyDefaults() {
        when(speakingTurnRepository.sumLearnerSpeakingDurationSeconds(userId)).thenReturn(0L);
        when(speakingSessionRepository.sumCompletedShadowingDurationSeconds(userId)).thenReturn(0L);
        when(speakingSessionRepository.countCompletedSessionsByUserId(userId)).thenReturn(0L);
        when(speakingTurnRepository.countLearnerRoleplayTurns(userId)).thenReturn(0L);
        when(speakingResultRepository.getAverageAccuracyScoreByUserId(userId)).thenReturn(null);
        when(speakingTurnRepository.countDistinctTargetVocabularyUsed(userId)).thenReturn(0L);
        when(speakingTurnRepository.findGenuineTurnCreatedTimes(userId)).thenReturn(List.of());
        when(speakingSessionRepository.findSessionCreatedTimes(userId)).thenReturn(List.of());
        when(speakingTurnFeedbackRepository.findGenuineFeedbacksByUserId(userId)).thenReturn(List.of());
        when(speakingSessionRepository.findRecentSessionsByUserId(eq(userId), any())).thenReturn(List.of());

        SpeakingProgressDto progress = speakingProgressService.getUserSpeakingProgress(userId);

        assertThat(progress).isNotNull();
        assertThat(progress.totalQualifiedSpeakingSeconds()).isEqualTo(0L);
        assertThat(progress.totalCompletedSessions()).isEqualTo(0L);
        assertThat(progress.totalRoleplayTurns()).isEqualTo(0L);
        assertThat(progress.averageWordAccuracy()).isEqualTo(0.0);
        assertThat(progress.targetVocabularyUsed()).isEqualTo(0L);
        assertThat(progress.currentStreakDays()).isEqualTo(0);
        assertThat(progress.weaknessProfile().topCorrectionCategories()).isEmpty();
        assertThat(progress.recentActivity()).isEmpty();
    }

    @Test
    @DisplayName("Aggregation: Genuine learner turns and completed shadowing accurately sum practice time and stats")
    void testGenuineProgressAggregation() {
        when(speakingTurnRepository.sumLearnerSpeakingDurationSeconds(userId)).thenReturn(120L);
        when(speakingSessionRepository.sumCompletedShadowingDurationSeconds(userId)).thenReturn(300L);
        when(speakingSessionRepository.countCompletedSessionsByUserId(userId)).thenReturn(5L);
        when(speakingTurnRepository.countLearnerRoleplayTurns(userId)).thenReturn(14L);
        when(speakingResultRepository.getAverageAccuracyScoreByUserId(userId)).thenReturn(87.654);
        when(speakingTurnRepository.countDistinctTargetVocabularyUsed(userId)).thenReturn(8L);

        LocalDateTime today = LocalDateTime.now();
        when(speakingTurnRepository.findGenuineTurnCreatedTimes(userId)).thenReturn(List.of(today));
        when(speakingSessionRepository.findSessionCreatedTimes(userId)).thenReturn(List.of(today));
        when(speakingTurnFeedbackRepository.findGenuineFeedbacksByUserId(userId)).thenReturn(List.of());
        when(speakingSessionRepository.findRecentSessionsByUserId(eq(userId), any())).thenReturn(List.of());

        SpeakingProgressDto progress = speakingProgressService.getUserSpeakingProgress(userId);

        assertThat(progress.totalQualifiedSpeakingSeconds()).isEqualTo(420L); // 120 + 300
        assertThat(progress.totalCompletedSessions()).isEqualTo(5L);
        assertThat(progress.totalRoleplayTurns()).isEqualTo(14L);
        assertThat(progress.averageWordAccuracy()).isEqualTo(87.7); // rounded to 1 decimal
        assertThat(progress.targetVocabularyUsed()).isEqualTo(8L);
        assertThat(progress.currentStreakDays()).isGreaterThanOrEqualTo(1);
    }

    @Test
    @DisplayName("Weakness Profile: Accurately parses and counts correction categories from feedback")
    void testWeaknessProfileAggregatesCorrectionCategories() {
        SpeakingTurn turn = SpeakingTurn.builder().id(10L).build();
        SpeakingTurnFeedback fb1 = SpeakingTurnFeedback.builder()
                .id(1L)
                .turn(turn)
                .correctionsJson("[{\"type\":\"GRAMMAR\",\"original\":\"a\",\"suggestion\":\"b\",\"explanation\":\"c\"},{\"type\":\"NATURALNESS\",\"original\":\"d\",\"suggestion\":\"e\",\"explanation\":\"f\"}]")
                .build();
        SpeakingTurnFeedback fb2 = SpeakingTurnFeedback.builder()
                .id(2L)
                .turn(turn)
                .correctionsJson("[{\"type\":\"GRAMMAR\",\"original\":\"x\",\"suggestion\":\"y\",\"explanation\":\"z\"}]")
                .build();

        when(speakingTurnRepository.sumLearnerSpeakingDurationSeconds(userId)).thenReturn(0L);
        when(speakingSessionRepository.sumCompletedShadowingDurationSeconds(userId)).thenReturn(0L);
        when(speakingSessionRepository.countCompletedSessionsByUserId(userId)).thenReturn(0L);
        when(speakingTurnRepository.countLearnerRoleplayTurns(userId)).thenReturn(0L);
        when(speakingResultRepository.getAverageAccuracyScoreByUserId(userId)).thenReturn(null);
        when(speakingTurnRepository.countDistinctTargetVocabularyUsed(userId)).thenReturn(0L);
        when(speakingTurnRepository.findGenuineTurnCreatedTimes(userId)).thenReturn(List.of());
        when(speakingSessionRepository.findSessionCreatedTimes(userId)).thenReturn(List.of());
        when(speakingTurnFeedbackRepository.findGenuineFeedbacksByUserId(userId)).thenReturn(List.of(fb1, fb2));
        when(speakingSessionRepository.findRecentSessionsByUserId(eq(userId), any())).thenReturn(List.of());

        SpeakingProgressDto progress = speakingProgressService.getUserSpeakingProgress(userId);

        assertThat(progress.weaknessProfile().topCorrectionCategories()).hasSize(2);
        assertThat(progress.weaknessProfile().topCorrectionCategories().get(0).category()).isEqualTo("GRAMMAR");
        assertThat(progress.weaknessProfile().topCorrectionCategories().get(0).count()).isEqualTo(2L);
        assertThat(progress.weaknessProfile().topCorrectionCategories().get(1).category()).isEqualTo("NATURALNESS");
        assertThat(progress.weaknessProfile().topCorrectionCategories().get(1).count()).isEqualTo(1L);
    }
}
