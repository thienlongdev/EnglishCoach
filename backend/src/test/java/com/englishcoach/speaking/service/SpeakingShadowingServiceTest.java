package com.englishcoach.speaking.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.listening.repository.TranscriptSegmentRepository;
import com.englishcoach.speaking.dto.ShadowingSegmentProgressDto;
import com.englishcoach.speaking.dto.SpeakingShadowingAttemptDto;
import com.englishcoach.speaking.dto.SpeakingShadowingAttemptRequest;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingShadowingAttempt;
import com.englishcoach.speaking.entity.SpeakingShadowingUnit;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingUnitRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.web.server.ResponseStatusException;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SpeakingShadowingServiceTest {

    @Mock
    private SpeakingShadowingAttemptRepository attemptRepository;

    @Mock
    private SpeakingShadowingUnitRepository unitRepository;

    @Mock
    private SpeakingSessionRepository sessionRepository;

    @Mock
    private TranscriptSegmentRepository segmentRepository;

    @Mock
    private UserRepository userRepository;

    @Mock
    private SpeakingShadowingUnitService unitService;

    @Mock
    private ShadowingAnalysisReceipts receipts;

    @InjectMocks
    private SpeakingShadowingService shadowingService;

    private User sampleUser;
    private SpeakingSession sampleSession;
    private SpeakingShadowingUnit sampleUnit;
    private TranscriptSegment sampleSegment;

    @BeforeEach
    void setUp() {
        sampleUser = User.builder().id(10L).email("learner@test.com").build();
        sampleSession = SpeakingSession.builder()
                .id(100L)
                .user(sampleUser)
                .sourceId(50L)
                .mode("SHADOWING")
                .status("ACTIVE")
                .build();
        ListeningMaterial material = ListeningMaterial.builder().id(50L).title("Sample Video").build();
        sampleUnit = SpeakingShadowingUnit.builder()
                .id(300L)
                .material(material)
                .sequenceNumber(1)
                .startTimeMs(1000)
                .endTimeMs(5000)
                .displayText("This is a clean practice unit.")
                .build();
        sampleSegment = TranscriptSegment.builder()
                .id(200L)
                .listeningMaterial(material)
                .startTimeMs(1000)
                .endTimeMs(5000)
                .text("This is a raw transcript segment.")
                .build();
    }

    @Test
    @DisplayName("Should successfully record a genuine shadowing attempt linked to a unit")
    void testRecordAttempt_Success() {
        SpeakingShadowingAttemptRequest request = new SpeakingShadowingAttemptRequest(
                "attempt-uuid-1234",
                300L,
                null,
                "This is a clean practice unit.",
                95.0,
                4,
                false
        );

        when(sessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));
        when(attemptRepository.findBySessionIdAndClientAttemptId(100L, "attempt-uuid-1234")).thenReturn(Optional.empty());
        when(unitRepository.findById(300L)).thenReturn(Optional.of(sampleUnit));
        when(unitService.isActiveUnit(sampleUnit)).thenReturn(true);
        when(receipts.forRecording(10L, "attempt-uuid-1234", 100L, 300L)).thenReturn(
                new ShadowingAnalysisReceipts.Receipt(
                        100L,
                        300L,
                        "a".repeat(64),
                        com.englishcoach.speaking.dto.ShadowingAnalysisResponseDto.builder()
                                .learnerTranscript("server transcript").accuracyScore(79.0).isMocked(false).build(),
                        "ASR_ONLY",
                        java.time.Instant.now(),
                        java.time.Instant.now().plusSeconds(1800),
                        null
                ));

        SpeakingShadowingAttempt savedEntity = SpeakingShadowingAttempt.builder()
                .id(1L)
                .session(sampleSession)
                .user(sampleUser)
                .shadowingUnit(sampleUnit)
                .clientAttemptId("attempt-uuid-1234")
                .learnerTranscript("This is a clean practice unit.")
                .accuracyScore(95.0)
                .durationSeconds(4)
                .isMocked(false)
                .createdAt(LocalDateTime.now())
                .build();

        when(attemptRepository.save(any(SpeakingShadowingAttempt.class))).thenReturn(savedEntity);

        SpeakingShadowingAttemptDto result = shadowingService.recordAttempt(10L, 100L, request);

        assertThat(result).isNotNull();
        assertThat(result.id()).isEqualTo(1L);
        assertThat(result.sessionId()).isEqualTo(100L);
        assertThat(result.unitId()).isEqualTo(300L);
        assertThat(result.clientAttemptId()).isEqualTo("attempt-uuid-1234");
        assertThat(result.accuracyScore()).isEqualTo(95.0);
        assertThat(result.isMocked()).isFalse();

        var saved = org.mockito.ArgumentCaptor.forClass(SpeakingShadowingAttempt.class);
        verify(attemptRepository).save(saved.capture());
        verify(receipts).markConsumed(10L, "attempt-uuid-1234");
        assertThat(saved.getValue().getAccuracyScore()).isEqualTo(79.0);
        assertThat(saved.getValue().getLearnerTranscript()).isEqualTo("server transcript");
        assertThat(saved.getValue().getAudioSha256()).isEqualTo("a".repeat(64));
        assertThat(saved.getValue().getProductContractVersion()).isEqualTo("ASR_ONLY");
    }

    @Test
    @DisplayName("Should idempotently return existing attempt if clientAttemptId repeated")
    void testRecordAttempt_IdempotentReplay() {
        SpeakingShadowingAttemptRequest request = new SpeakingShadowingAttemptRequest(
                "attempt-uuid-1234",
                300L,
                null,
                "Repeated request text",
                90.0,
                3,
                false
        );

        when(sessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));

        when(unitRepository.findById(300L)).thenReturn(Optional.of(sampleUnit));
        when(unitService.isActiveUnit(sampleUnit)).thenReturn(true);

        SpeakingShadowingAttempt existingEntity = SpeakingShadowingAttempt.builder()
                .id(1L)
                .session(sampleSession)
                .user(sampleUser)
                .shadowingUnit(sampleUnit)
                .clientAttemptId("attempt-uuid-1234")
                .learnerTranscript("Original request text")
                .accuracyScore(95.0)
                .durationSeconds(4)
                .isMocked(false)
                .createdAt(LocalDateTime.now())
                .build();

        when(attemptRepository.findBySessionIdAndClientAttemptId(100L, "attempt-uuid-1234")).thenReturn(Optional.of(existingEntity));

        SpeakingShadowingAttemptDto result = shadowingService.recordAttempt(10L, 100L, request);

        assertThat(result).isNotNull();
        assertThat(result.learnerTranscript()).isEqualTo("Original request text");
        verify(attemptRepository, never()).save(any());
    }

    @Test
    @DisplayName("Should throw 403 Forbidden if session belongs to another user")
    void testRecordAttempt_ForbiddenAnotherUser() {
        User otherUser = User.builder().id(999L).build();
        SpeakingSession otherSession = SpeakingSession.builder().id(100L).user(otherUser).build();

        when(sessionRepository.findById(100L)).thenReturn(Optional.of(otherSession));

        SpeakingShadowingAttemptRequest request = new SpeakingShadowingAttemptRequest(
                "attempt-uuid-1234",
                300L,
                null,
                "text",
                80.0,
                3,
                false
        );

        assertThatThrownBy(() -> shadowingService.recordAttempt(10L, 100L, request))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("403 FORBIDDEN");
    }

    @Test
    @DisplayName("Should throw 400 Bad Request if neither unitId nor segmentId is provided")
    void testRecordAttempt_NeitherUnitNorSegmentFound() {
        when(sessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));

        SpeakingShadowingAttemptRequest request = new SpeakingShadowingAttemptRequest(
                "attempt-uuid-1234",
                null,
                null,
                "text",
                80.0,
                3,
                false
        );

        assertThatThrownBy(() -> shadowingService.recordAttempt(10L, 100L, request))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("400 BAD_REQUEST");
    }

    @Test
    @DisplayName("Legacy segment IDs cannot be used for new attempts without an active unit ID")
    void testRecordAttempt_SegmentOnlyIsRejectedForNewWrites() {
        when(sessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));

        SpeakingShadowingAttemptRequest request = new SpeakingShadowingAttemptRequest(
                "legacy-segment-write",
                null,
                200L,
                "legacy text",
                80.0,
                3,
                false
        );

        assertThatThrownBy(() -> shadowingService.recordAttempt(10L, 100L, request))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("unitId is required");
        verify(attemptRepository, never()).save(any());
    }

    @Test
    @DisplayName("Should retrieve material progress correctly")
    void testGetMaterialProgress() {
        List<ShadowingSegmentProgressDto> mockList = List.of(
                new ShadowingSegmentProgressDto(300L, 3L, 95.0),
                new ShadowingSegmentProgressDto(301L, 1L, 88.0)
        );

        when(attemptRepository.getUnitProgressByMaterial(
                10L,
                50L,
                SpeakingShadowingUnitService.LATEST_GENERATION_VERSION
        )).thenReturn(mockList);

        List<ShadowingSegmentProgressDto> result = shadowingService.getMaterialProgress(10L, 50L);

        assertThat(result).hasSize(2);
        assertThat(result.get(0).unitId()).isEqualTo(300L);
        assertThat(result.get(0).attemptCount()).isEqualTo(3L);
        assertThat(result.get(0).bestAccuracy()).isEqualTo(95.0);
        assertThat(result.get(0).isPracticed()).isTrue();
    }
}
