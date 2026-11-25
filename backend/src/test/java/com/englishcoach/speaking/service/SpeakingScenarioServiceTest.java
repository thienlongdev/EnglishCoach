package com.englishcoach.speaking.service;

import com.englishcoach.speaking.dto.SpeakingScenarioDto;
import com.englishcoach.speaking.dto.SpeakingScenarioSummaryDto;
import com.englishcoach.speaking.entity.SpeakingScenario;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.speaking.entity.SpeakingTurnFeedback;
import com.englishcoach.speaking.entity.enums.CefrLevel;
import com.englishcoach.speaking.entity.enums.ScenarioCategory;
import com.englishcoach.speaking.repository.SpeakingScenarioRepository;
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
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SpeakingScenarioServiceTest {

    @Mock
    private SpeakingScenarioRepository speakingScenarioRepository;

    @Mock
    private com.englishcoach.speaking.repository.SpeakingSessionRepository speakingSessionRepository;

    @Mock
    private com.englishcoach.speaking.repository.SpeakingTurnRepository speakingTurnRepository;

    @Mock
    private com.englishcoach.speaking.repository.SpeakingTurnFeedbackRepository speakingTurnFeedbackRepository;

    @Mock
    private com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository speakingShadowingAttemptRepository;

    @Mock
    private SpeakingAudioStorageService speakingAudioStorageService;

    @InjectMocks
    private SpeakingScenarioService speakingScenarioService;

    private SpeakingScenario sampleScenario;

    @BeforeEach
    void setUp() {
        sampleScenario = SpeakingScenario.builder()
                .id(1L)
                .title("Hotel Check-in")
                .description("Check into your room at the Grand Horizon Hotel")
                .cefrLevel(CefrLevel.B1)
                .category(ScenarioCategory.TRAVEL)
                .learnerRole("Hotel Guest")
                .aiRole("Front Desk Receptionist")
                .learnerGoal("Successfully check in and confirm breakfast times.")
                .targetVocabulary(List.of("reservation", "amenities", "upgrade"))
                .targetGrammar(List.of("Could you check if...", "I was wondering if..."))
                .initialAiMessage("Good afternoon, welcome to the Grand Horizon Hotel!")
                .successCriteria(List.of("Confirm reservation", "Ask for quiet room"))
                .completionConditions("Complete at least 3 turns.")
                .evaluationRubric("Task Completion (40%), Politeness (30%), Vocab (30%)")
                .optionalHints(List.of("Use indirect questions."))
                .estimatedMinutes(5)
                .createdAt(LocalDateTime.now())
                .build();
    }

    @Test
    @DisplayName("getScenarios should return lightweight Summary DTO without collection loading")
    void testGetScenariosSummary() {
        when(speakingScenarioRepository.findByFilters(CefrLevel.B1, ScenarioCategory.TRAVEL))
                .thenReturn(List.of(sampleScenario));

        List<SpeakingScenarioSummaryDto> summaries = speakingScenarioService.getScenarios(CefrLevel.B1, ScenarioCategory.TRAVEL);

        assertThat(summaries).hasSize(1);
        SpeakingScenarioSummaryDto summary = summaries.get(0);
        assertThat(summary.id()).isEqualTo(1L);
        assertThat(summary.title()).isEqualTo("Hotel Check-in");
        assertThat(summary.cefrLevel()).isEqualTo("B1");
        assertThat(summary.category()).isEqualTo("TRAVEL");
        assertThat(summary.learnerRole()).isEqualTo("Hotel Guest");
        assertThat(summary.aiRole()).isEqualTo("Front Desk Receptionist");

        verify(speakingScenarioRepository, times(1)).findByFilters(CefrLevel.B1, ScenarioCategory.TRAVEL);
    }

    @Test
    @DisplayName("getScenarioById should return full instructional contract DTO")
    void testGetScenarioByIdSuccess() {
        when(speakingScenarioRepository.findByIdAndAccessible(1L, null)).thenReturn(Optional.of(sampleScenario));

        SpeakingScenarioDto dto = speakingScenarioService.getScenarioById(1L);

        assertThat(dto).isNotNull();
        assertThat(dto.id()).isEqualTo(1L);
        assertThat(dto.title()).isEqualTo("Hotel Check-in");
        assertThat(dto.learnerGoal()).isEqualTo("Successfully check in and confirm breakfast times.");
        assertThat(dto.targetVocabulary()).containsExactly("reservation", "amenities", "upgrade");
        assertThat(dto.targetGrammar()).containsExactly("Could you check if...", "I was wondering if...");
        assertThat(dto.successCriteria()).containsExactly("Confirm reservation", "Ask for quiet room");
        assertThat(dto.completionConditions()).isEqualTo("Complete at least 3 turns.");
        assertThat(dto.evaluationRubric()).isEqualTo("Task Completion (40%), Politeness (30%), Vocab (30%)");
        assertThat(dto.optionalHints()).containsExactly("Use indirect questions.");

        verify(speakingScenarioRepository, times(1)).findByIdAndAccessible(1L, null);
    }

    @Test
    @DisplayName("getScenarioById should throw 404 ResponseStatusException when not found or inaccessible")
    void testGetScenarioByIdNotFound() {
        when(speakingScenarioRepository.findByIdAndAccessible(999L, null)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> speakingScenarioService.getScenarioById(999L))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("404 NOT_FOUND");

        verify(speakingScenarioRepository, times(1)).findByIdAndAccessible(999L, null);
    }

    @Test
    @DisplayName("Cross-user isolation: User B cannot retrieve User A's custom scenario by ID")
    void testCrossUserScenarioIsolation() {
        when(speakingScenarioRepository.findByIdAndAccessible(50L, 2L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> speakingScenarioService.getScenarioById(2L, 50L))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("404 NOT_FOUND");

        verify(speakingScenarioRepository, times(1)).findByIdAndAccessible(50L, 2L);
    }

    @Test
    @DisplayName("deleteCustomScenario: Owner can delete their own custom scenario")
    void testDeleteCustomScenarioSuccess() {
        SpeakingScenario customScenario = SpeakingScenario.builder()
                .id(200L)
                .title("Custom Interview")
                .ownerUserId(1L)
                .isSystem(false)
                .build();
        when(speakingScenarioRepository.findById(200L)).thenReturn(Optional.of(customScenario));
        when(speakingSessionRepository.findByScenarioId(200L)).thenReturn(List.of());

        speakingScenarioService.deleteCustomScenario(1L, 200L);

        verify(speakingScenarioRepository, times(1)).delete(customScenario);
    }

    @Test
    @DisplayName("deleteCustomScenario: Cascades deletion to sessions, turns, feedbacks, and deletes audio files")
    void testDeleteCustomScenarioWithSessionsAndTurnsCascadesAndCleansAudio() {
        SpeakingScenario customScenario = SpeakingScenario.builder()
                .id(200L)
                .title("Custom Interview")
                .ownerUserId(1L)
                .isSystem(false)
                .build();
        when(speakingScenarioRepository.findById(200L)).thenReturn(Optional.of(customScenario));

        SpeakingSession session = SpeakingSession.builder().id(10L).scenario(customScenario).build();
        when(speakingSessionRepository.findByScenarioId(200L)).thenReturn(List.of(session));

        SpeakingTurn turn = SpeakingTurn.builder()
                .id(100L)
                .session(session)
                .audioRef("1/attempt_100.bin")
                .build();
        when(speakingTurnRepository.findBySessionIdIn(List.of(10L))).thenReturn(List.of(turn));

        SpeakingTurnFeedback feedback = SpeakingTurnFeedback.builder().id(50L).turn(turn).build();
        when(speakingTurnFeedbackRepository.findByTurnIdIn(List.of(100L))).thenReturn(List.of(feedback));

        speakingScenarioService.deleteCustomScenario(1L, 200L);

        verify(speakingAudioStorageService, times(1)).deleteAttemptAudioByRef("1/attempt_100.bin");
        verify(speakingTurnFeedbackRepository, times(1)).deleteAll(List.of(feedback));
        verify(speakingTurnRepository, times(1)).deleteAll(List.of(turn));
        verify(speakingSessionRepository, times(1)).deleteAll(List.of(session));
        verify(speakingScenarioRepository, times(1)).delete(customScenario);
    }

    @Test
    @DisplayName("deleteCustomScenario: Attempting to delete system scenario throws 403 Forbidden")
    void testDeleteSystemScenarioForbidden() {
        SpeakingScenario systemScenario = SpeakingScenario.builder()
                .id(1L)
                .title("System Hotel")
                .ownerUserId(null)
                .isSystem(true)
                .build();
        when(speakingScenarioRepository.findById(1L)).thenReturn(Optional.of(systemScenario));

        assertThatThrownBy(() -> speakingScenarioService.deleteCustomScenario(1L, 1L))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("403 FORBIDDEN");

        verify(speakingScenarioRepository, never()).delete(any());
    }

    @Test
    @DisplayName("deleteCustomScenario: Non-owner trying to delete another user's scenario throws 404")
    void testDeleteOtherUserScenarioNotFound() {
        SpeakingScenario otherUserScenario = SpeakingScenario.builder()
                .id(300L)
                .title("User B Scenario")
                .ownerUserId(2L)
                .isSystem(false)
                .build();
        when(speakingScenarioRepository.findById(300L)).thenReturn(Optional.of(otherUserScenario));

        assertThatThrownBy(() -> speakingScenarioService.deleteCustomScenario(1L, 300L))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("404 NOT_FOUND");

        verify(speakingScenarioRepository, never()).delete(any());
    }

    @Test
    @DisplayName("CefrLevel.fromString and ScenarioCategory.fromString validation")
    void testEnumParsingValidation() {
        assertThat(CefrLevel.fromString("B1")).isEqualTo(CefrLevel.B1);
        assertThat(CefrLevel.fromString("b1")).isEqualTo(CefrLevel.B1);
        assertThat(CefrLevel.fromString("ALL")).isNull();
        assertThat(CefrLevel.fromString("")).isNull();
        assertThat(CefrLevel.fromString(null)).isNull();

        assertThatThrownBy(() -> CefrLevel.fromString("INVALID_LEVEL"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Invalid CEFR level");

        assertThat(ScenarioCategory.fromString("TRAVEL")).isEqualTo(ScenarioCategory.TRAVEL);
        assertThat(ScenarioCategory.fromString("travel")).isEqualTo(ScenarioCategory.TRAVEL);
        assertThat(ScenarioCategory.fromString("ALL")).isNull();

        assertThatThrownBy(() -> ScenarioCategory.fromString("UNKNOWN_CAT"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Invalid Scenario Category");
    }

    @Test
    @DisplayName("createCustomScenario should validate that mission is required")
    void testCreateCustomScenarioMissingMission() {
        var req = new com.englishcoach.speaking.dto.CreateCustomScenarioRequestDto(
                "Order coffee", "A2", "At coffee shop", "Customer", "Barista", "   ", List.of(), null, null
        );

        assertThatThrownBy(() -> speakingScenarioService.createCustomScenario(1L, req))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("Mission goal is required");
    }

    @Test
    @DisplayName("createCustomScenario succeeds when mission is provided")
    void testCreateCustomScenarioSuccess() {
        var req = new com.englishcoach.speaking.dto.CreateCustomScenarioRequestDto(
                "Order coffee", "A2", "At coffee shop", "Customer", "Barista", "Order an oat latte", List.of("latte"), 4, "5"
        );

        when(speakingScenarioRepository.save(any(SpeakingScenario.class))).thenAnswer(invocation -> {
            SpeakingScenario toSave = invocation.getArgument(0);
            toSave.setId(100L);
            toSave.setCreatedAt(LocalDateTime.now());
            return toSave;
        });

        SpeakingScenarioDto result = speakingScenarioService.createCustomScenario(1L, req);

        assertThat(result).isNotNull();
        assertThat(result.id()).isEqualTo(100L);
        assertThat(result.isCustom()).isTrue();
        assertThat(result.learnerGoal()).isEqualTo("Order an oat latte");
        verify(speakingScenarioRepository, times(1)).save(any(SpeakingScenario.class));
    }
}
