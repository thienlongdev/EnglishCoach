package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.listening.entity.ListeningProfile;
import com.englishcoach.listening.repository.ListeningProfileRepository;
import com.englishcoach.listening.repository.ListeningSessionRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ListeningEvaluatorTest {

    @Mock
    private ListeningProfileRepository listeningProfileRepository;

    @Mock
    private ListeningSessionRepository listeningSessionRepository;

    @InjectMocks
    private ListeningEvaluator listeningEvaluator;

    @Test
    @DisplayName("ListeningEvaluator supports LISTENING_HOURS and LISTENING_SESSIONS_COMPLETED")
    void testSupports() {
        assertThat(listeningEvaluator.supports("LISTENING_HOURS")).isTrue();
        assertThat(listeningEvaluator.supports("listening_time")).isTrue();
        assertThat(listeningEvaluator.supports("LISTENING_SESSIONS_COMPLETED")).isTrue();
        assertThat(listeningEvaluator.supports("STREAK_DAYS")).isFalse();
    }

    @Test
    @DisplayName("evaluate: hours below threshold returns eligible=false and exact partial percent")
    void testEvaluate_hoursBelowThreshold() {
        // 18000 seconds = 5.0 hours
        ListeningProfile profile = ListeningProfile.builder().totalListeningTimeSeconds(18000L).build();
        when(listeningProfileRepository.findByUserId(1L)).thenReturn(Optional.of(profile));

        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("LISTENING_HOURS")
                .targetValue("10.0")
                .build();

        MetricEvaluationResult result = listeningEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isFalse();
        assertThat(result.currentValue()).isEqualTo(5.0);
        assertThat(result.targetValue()).isEqualTo(10.0);
        assertThat(result.percent()).isEqualTo(50.0);
        assertThat(result.displayCurrent()).isEqualTo("5.0 giờ nghe");
    }

    @Test
    @DisplayName("evaluate: hours above threshold returns eligible=true and 100 percent")
    void testEvaluate_hoursAboveThreshold() {
        // 72000 seconds = 20.0 hours
        ListeningProfile profile = ListeningProfile.builder().totalListeningTimeSeconds(72000L).build();
        when(listeningProfileRepository.findByUserId(1L)).thenReturn(Optional.of(profile));

        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("LISTENING_HOURS")
                .targetValue("10.0")
                .build();

        MetricEvaluationResult result = listeningEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isTrue();
        assertThat(result.currentValue()).isEqualTo(20.0);
        assertThat(result.percent()).isEqualTo(100.0);
    }

    @Test
    @DisplayName("evaluate: sessions completed target evaluates correctly")
    void testEvaluate_sessionsCompleted() {
        when(listeningSessionRepository.countCompletedSessionsByUserId(1L)).thenReturn(15L);

        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("LISTENING_SESSIONS_COMPLETED")
                .targetValue("20")
                .build();

        MetricEvaluationResult result = listeningEvaluator.evaluate(1L, req);

        assertThat(result.eligible()).isFalse();
        assertThat(result.currentValue()).isEqualTo(15.0);
        assertThat(result.percent()).isEqualTo(75.0);
        assertThat(result.displayCurrent()).isEqualTo("15 buổi nghe");
    }

    @Test
    @DisplayName("evaluate: null user safely returns 0 percent")
    void testEvaluate_nullUser() {
        AvatarFrameRequirement req = AvatarFrameRequirement.builder()
                .metricType("LISTENING_HOURS")
                .targetValue("10.0")
                .build();

        MetricEvaluationResult result = listeningEvaluator.evaluate(null, req);

        assertThat(result.eligible()).isFalse();
        assertThat(result.currentValue()).isEqualTo(0.0);
        assertThat(result.percent()).isEqualTo(0.0);
    }
}
