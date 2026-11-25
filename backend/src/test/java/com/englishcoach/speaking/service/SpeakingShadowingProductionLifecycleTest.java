package com.englishcoach.speaking.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.speaking.dto.*;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingShadowingAttempt;
import com.englishcoach.speaking.entity.SpeakingShadowingUnit;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingUnitRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.web.server.ResponseStatusException;

import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SpeakingShadowingProductionLifecycleTest {

    @Mock
    private SpeakingShadowingAttemptRepository attemptRepository;

    @Mock
    private SpeakingShadowingUnitRepository unitRepository;

    @Mock
    private SpeakingSessionRepository sessionRepository;

    @Mock
    private UserRepository userRepository;

    @Mock
    private SpeakingShadowingUnitService unitService;

    @Spy
    private ObjectMapper objectMapper = new ObjectMapper();

    @InjectMocks
    private SpeakingShadowingService shadowingService;

    private User sampleUser;
    private SpeakingSession sampleSession;
    private SpeakingShadowingUnit sampleUnit;
    private ListeningMaterial sampleMaterial;

    @BeforeEach
    void setUp() {
        sampleUser = User.builder().id(10L).email("learner@test.com").build();
        sampleMaterial = ListeningMaterial.builder().id(50L).title("Practice Video").build();
        sampleSession = SpeakingSession.builder()
                .id(100L)
                .user(sampleUser)
                .mode("SHADOWING")
                .status("ACTIVE")
                .sourceType("LISTENING")
                .sourceId(50L)
                .currentUnitIndex(0)
                .completedUnitsCount(0)
                .totalUnitsCount(2)
                .build();
        sampleUnit = SpeakingShadowingUnit.builder()
                .id(300L)
                .material(sampleMaterial)
                .sequenceNumber(1)
                .startTimeMs(1000)
                .endTimeMs(4000)
                .displayText("I think this is great.")
                .build();
    }

    @Test
    @DisplayName("Should resume existing active session if one is in progress")
    void testGetOrCreateActiveSession_ExistingResumed() {
        when(userRepository.findById(10L)).thenReturn(Optional.of(sampleUser));
        when(sessionRepository.findFirstByUserIdAndModeAndSourceIdAndStatusOrderByCreatedAtDesc(10L, "SHADOWING", 50L, "ACTIVE"))
                .thenReturn(Optional.of(sampleSession));
        when(sessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));
        when(attemptRepository.findBySessionIdOrderByCreatedAtAsc(100L)).thenReturn(Collections.emptyList());
        when(unitService.getOrGenerateUnits(50L, 10L)).thenReturn(List.of(
                new SpeakingShadowingUnitDto(300L, 50L, 1, 1000, 4000, "I think this is great.", 3, com.englishcoach.speaking.entity.ShadowingTimingQuality.EXACT, com.englishcoach.speaking.entity.ShadowingTimingStrategy.EXACT_WORD_ALIGNMENT, 0L, null, false)
        ));

        ShadowingSessionStateDto state = shadowingService.getOrCreateActiveSession(10L, 50L);

        assertThat(state).isNotNull();
        assertThat(state.sessionId()).isEqualTo(100L);
        assertThat(state.status()).isEqualTo("ACTIVE");
        verify(sessionRepository, never()).save(any(SpeakingSession.class));
    }

    @Test
    @DisplayName("Should create new session if no active session exists")
    void testGetOrCreateActiveSession_NewCreated() {
        when(userRepository.findById(10L)).thenReturn(Optional.of(sampleUser));
        when(sessionRepository.findFirstByUserIdAndModeAndSourceIdAndStatusOrderByCreatedAtDesc(10L, "SHADOWING", 50L, "ACTIVE"))
                .thenReturn(Optional.empty());
        when(unitService.getOrGenerateUnits(50L, 10L)).thenReturn(List.of(
                new SpeakingShadowingUnitDto(300L, 50L, 1, 1000, 4000, "I think this is great.", 3, com.englishcoach.speaking.entity.ShadowingTimingQuality.EXACT, com.englishcoach.speaking.entity.ShadowingTimingStrategy.EXACT_WORD_ALIGNMENT, 0L, null, false)
        ));
        when(sessionRepository.save(any(SpeakingSession.class))).thenReturn(sampleSession);
        when(sessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));
        when(attemptRepository.findBySessionIdOrderByCreatedAtAsc(100L)).thenReturn(Collections.emptyList());

        ShadowingSessionStateDto state = shadowingService.getOrCreateActiveSession(10L, 50L);

        assertThat(state).isNotNull();
        assertThat(state.sessionId()).isEqualTo(100L);
        verify(sessionRepository, times(1)).save(any(SpeakingSession.class));
    }

    @Test
    @DisplayName("Should rehydrate productSafeResultJson from persisted attempt on session refresh")
    void testGetSessionState_RehydratesEcsmResult() throws Exception {
        EcsmAnalysisResponseDto originalResponse = EcsmAnalysisResponseDto.builder()
                .requestId("ecsm-req-123")
                .status("ANALYSIS_COMPLETE")
                .segmentalAvailable(true)
                .prosodyAvailable(true)
                .build();
        String json = objectMapper.writeValueAsString(originalResponse);

        SpeakingShadowingAttempt attempt = SpeakingShadowingAttempt.builder()
                .id(1L)
                .user(sampleUser)
                .session(sampleSession)
                .shadowingUnit(sampleUnit)
                .clientAttemptId("attempt-uuid-001")
                .productSafeResultJson(json)
                .build();

        when(sessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));
        when(attemptRepository.findBySessionIdOrderByCreatedAtAsc(100L)).thenReturn(List.of(attempt));
        when(unitService.getOrGenerateUnits(50L, 10L)).thenReturn(List.of(
                new SpeakingShadowingUnitDto(300L, 50L, 1, 1000, 4000, "I think this is great.", 3, com.englishcoach.speaking.entity.ShadowingTimingQuality.EXACT, com.englishcoach.speaking.entity.ShadowingTimingStrategy.EXACT_WORD_ALIGNMENT, 0L, null, false)
        ));

        ShadowingSessionStateDto state = shadowingService.getSessionState(10L, 100L);

        assertThat(state).isNotNull();
        assertThat(state.activeAttempt()).isNotNull();
        assertThat(state.activeAttempt().clientAttemptId()).isEqualTo("attempt-uuid-001");
        assertThat(state.rehydratedEcsmResult()).isNotNull();
        assertThat(state.rehydratedEcsmResult().getRequestId()).isEqualTo("ecsm-req-123");
    }

    @Test
    @DisplayName("Should record ECSM attempt with retry lineage and locked target")
    void testRecordEcsmAttempt_SuccessWithLineage() {
        SpeakingShadowingAttempt parentAttempt = SpeakingShadowingAttempt.builder()
                .id(1L)
                .clientAttemptId("parent-uuid-001")
                .retryIndex(0)
                .build();

        when(sessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));
        when(attemptRepository.findBySessionIdAndClientAttemptId(100L, "child-uuid-002")).thenReturn(Optional.empty());
        when(unitRepository.findById(300L)).thenReturn(Optional.of(sampleUnit));
        when(attemptRepository.findBySessionIdAndClientAttemptId(100L, "parent-uuid-001")).thenReturn(Optional.of(parentAttempt));

        SpeakingShadowingAttempt savedAttempt = SpeakingShadowingAttempt.builder()
                .id(2L)
                .session(sampleSession)
                .user(sampleUser)
                .shadowingUnit(sampleUnit)
                .clientAttemptId("child-uuid-002")
                .parentAttemptId("parent-uuid-001")
                .retryIndex(1)
                .activeTargetId("TARGET_WORD_0_TH")
                .build();
        when(attemptRepository.save(any(SpeakingShadowingAttempt.class))).thenReturn(savedAttempt);

        EcsmAnalysisResponseDto responseDto = EcsmAnalysisResponseDto.builder()
                .requestId("ecsm-child-123")
                .status("ANALYSIS_COMPLETE")
                .retryPlan(Map.of("primary_target", Map.of("issue_type", "ARTICULATORY_VOICING_MISMATCH", "word", "think")))
                .retryComparison(Map.of("comparison_state", "IMPROVED", "resolved_this_session", true))
                .build();

        SpeakingShadowingAttemptDto recorded = shadowingService.recordEcsmAttempt(
                10L, 100L, 300L, "child-uuid-002", "parent-uuid-001", "TARGET_WORD_0_TH", responseDto
        );

        assertThat(recorded).isNotNull();
        assertThat(recorded.clientAttemptId()).isEqualTo("child-uuid-002");
        assertThat(recorded.parentAttemptId()).isEqualTo("parent-uuid-001");
        assertThat(recorded.retryIndex()).isEqualTo(1);
        verify(sessionRepository, times(1)).save(sampleSession);
    }

    @Test
    @DisplayName("Should advance unit and transition session to COMPLETED on final unit")
    void testAdvanceSessionUnit_CompletesSession() {
        when(sessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));
        when(attemptRepository.findBySessionIdOrderByCreatedAtAsc(100L)).thenReturn(Collections.emptyList());
        when(attemptRepository.countBySessionIdAndShadowingUnitId(100L, 300L)).thenReturn(1);
        when(attemptRepository.countBySessionIdAndShadowingUnitId(100L, 301L)).thenReturn(1);
        when(unitService.getOrGenerateUnits(50L, 10L)).thenReturn(List.of(
                new SpeakingShadowingUnitDto(300L, 50L, 1, 1000, 4000, "Unit 1", 3, com.englishcoach.speaking.entity.ShadowingTimingQuality.EXACT, com.englishcoach.speaking.entity.ShadowingTimingStrategy.EXACT_WORD_ALIGNMENT, 0L, null, false),
                new SpeakingShadowingUnitDto(301L, 50L, 2, 4000, 7000, "Unit 2", 3, com.englishcoach.speaking.entity.ShadowingTimingQuality.EXACT, com.englishcoach.speaking.entity.ShadowingTimingStrategy.EXACT_WORD_ALIGNMENT, 0L, null, false)
        ));

        // Advance 1st unit
        ShadowingSessionStateDto step1 = shadowingService.advanceSessionUnit(10L, 100L, 300L, "COMPLETE");
        assertThat(step1.completedUnitsCount()).isEqualTo(1);
        assertThat(step1.currentUnitIndex()).isEqualTo(1);
        assertThat(step1.status()).isEqualTo("ACTIVE");

        // Advance 2nd (final) unit
        ShadowingSessionStateDto step2 = shadowingService.advanceSessionUnit(10L, 100L, 301L, "COMPLETE");
        assertThat(step2.completedUnitsCount()).isEqualTo(2);
        assertThat(step2.currentUnitIndex()).isEqualTo(2);
        assertThat(step2.status()).isEqualTo("COMPLETED");
    }
}
