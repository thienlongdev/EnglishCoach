package com.englishcoach.speaking.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.speaking.dto.SpeakingTurnFeedbackDto;
import com.englishcoach.speaking.entity.SpeakingScenario;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.speaking.entity.SpeakingTurnFeedback;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingTurnFeedbackRepository;
import com.englishcoach.speaking.repository.SpeakingTurnRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SpeakingFeedbackServiceTest {

    @Mock
    private SpeakingSessionRepository speakingSessionRepository;

    @Mock
    private SpeakingTurnRepository speakingTurnRepository;

    @Mock
    private SpeakingTurnFeedbackRepository speakingTurnFeedbackRepository;

    @Mock
    private SpeakingContextService speakingContextService;

    @InjectMocks
    private SpeakingFeedbackService speakingFeedbackService;

    private User sampleUser;
    private SpeakingSession sampleSession;
    private SpeakingTurn learnerTurn;
    private SpeakingTurn assistantTurn;

    @BeforeEach
    void setUp() {
        sampleUser = User.builder().id(10L).email("learner@test.com").build();

        sampleSession = SpeakingSession.builder()
                .id(100L)
                .user(sampleUser)
                .mode("ROLEPLAY")
                .status("ACTIVE")
                .build();

        learnerTurn = SpeakingTurn.builder()
                .id(500L)
                .session(sampleSession)
                .sequenceNumber(1)
                .speaker("LEARNER")
                .text("I want order coffee")
                .createdAt(LocalDateTime.now())
                .build();

        assistantTurn = SpeakingTurn.builder()
                .id(501L)
                .session(sampleSession)
                .sequenceNumber(2)
                .speaker("ASSISTANT")
                .text("Certainly! What size would you like?")
                .createdAt(LocalDateTime.now())
                .build();
    }

    @Test
    @DisplayName("Security: Requesting feedback for another user's session throws 403 Forbidden")
    void testUnauthorizedSessionAccessReturnsForbidden() {
        when(speakingSessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));

        assertThatThrownBy(() -> speakingFeedbackService.getOrGenerateFeedback(999L, 100L, 500L))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("403 FORBIDDEN");
    }

    @Test
    @DisplayName("Turn Validation: Requesting feedback for an ASSISTANT turn throws 400 Bad Request")
    void testNonLearnerTurnThrowsBadRequest() {
        when(speakingSessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));
        when(speakingTurnRepository.findById(501L)).thenReturn(Optional.of(assistantTurn));

        assertThatThrownBy(() -> speakingFeedbackService.getOrGenerateFeedback(10L, 100L, 501L))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("400 BAD_REQUEST");
    }

    @Test
    @DisplayName("Idempotency: Re-requesting feedback returns existing persisted feedback without regenerating")
    void testIdempotencyReturnsCachedFeedbackWithoutAiCall() {
        SpeakingTurnFeedback existingFeedback = SpeakingTurnFeedback.builder()
                .id(1L)
                .turn(learnerTurn)
                .summary("Clear order request.")
                .positiveFeedback("Good pronunciation.")
                .correctionsJson("[{\"type\":\"NATURALNESS\",\"original\":\"want order\",\"suggestion\":\"would like to order\",\"explanation\":\"Polite phrasing\",\"priority\":\"HIGH\"}]")
                .isMocked(false)
                .createdAt(LocalDateTime.now())
                .build();

        when(speakingSessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));
        when(speakingTurnRepository.findById(500L)).thenReturn(Optional.of(learnerTurn));
        when(speakingTurnFeedbackRepository.findByTurnId(500L)).thenReturn(Optional.of(existingFeedback));

        SpeakingTurnFeedbackDto dto = speakingFeedbackService.getOrGenerateFeedback(10L, 100L, 500L);

        assertThat(dto).isNotNull();
        assertThat(dto.summary()).isEqualTo("Clear order request.");
        assertThat(dto.corrections()).hasSize(1);
        assertThat(dto.corrections().get(0).type()).isEqualTo("NATURALNESS");
        assertThat(dto.corrections().get(0).suggestion()).isEqualTo("would like to order");

        // Verify save was NOT called again
        verify(speakingTurnFeedbackRepository, never()).save(any());
    }
}
