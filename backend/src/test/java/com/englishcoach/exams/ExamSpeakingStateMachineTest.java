package com.englishcoach.exams;

import com.englishcoach.exams.exception.ExamConcurrencyException;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamSpeakingRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.service.ExamSpeakingRuntimeService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ExamSpeakingStateMachineTest {

    @Mock
    private ExamAttemptRepository attemptRepository;

    @Mock
    private ExamContentRepository contentRepository;

    @InjectMocks
    private ExamSpeakingRuntimeService speakingService;

    private static final Long USER_ID = 42L;
    private static final UUID ATTEMPT_ID = UUID.fromString("11111111-1111-1111-1111-111111111111");
    private static final UUID FORM_ID = UUID.fromString("22222222-2222-2222-2222-222222222222");
    private static final UUID SECTION_ID = UUID.fromString("33333333-3333-3333-3333-333333333333");
    private static final UUID ITEM_P1_ID = UUID.fromString("44444444-4444-4444-4444-444444444441");
    private static final UUID ITEM_P2_ID = UUID.fromString("44444444-4444-4444-4444-444444444442");
    private static final UUID ITEM_P3_ID = UUID.fromString("44444444-4444-4444-4444-444444444443");

    private AttemptRecord attempt;
    private AttemptSectionRecord speakingSection;

    @BeforeEach
    void setUp() {
        Map<String, Object> manifestSnapshot = createSampleSpeakingSnapshot();

        attempt = new AttemptRecord(
                ATTEMPT_ID, USER_ID, FORM_ID, ExamFamily.IELTS, "academic", "FULL",
                ExamAttemptMode.EXAM_SIMULATION, null, null, ExamAttemptStatus.IN_PROGRESS,
                1L, 1L, "token-hash", Instant.now().plusSeconds(600), "manifest-hash",
                Map.of(), Instant.now(), Instant.now(), Instant.now().plusSeconds(7200),
                null, null, List.of(), Instant.now(), Instant.now(),
                manifestSnapshot, "v4.0", ExamSnapshotState.SNAPSHOTTED
        );

        speakingSection = new AttemptSectionRecord(
                UUID.randomUUID(), ATTEMPT_ID, SECTION_ID, ExamSectionState.ACTIVE, "MAIN",
                Instant.now(), Instant.now().plusSeconds(900), null, Map.of(), Instant.now(),
                "speaking_part_1", "speak_p1_g_intro_i_01", 1, 1L
        );

        SectionRecord sectionDef = new SectionRecord(
                SECTION_ID, FORM_ID, SkillType.SPEAKING, 4, "speaking", null, 900, Map.of()
        );

        when(attemptRepository.findAttemptByIdForUpdate(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findSectionsByAttemptId(ATTEMPT_ID)).thenReturn(List.of(speakingSection));
        when(contentRepository.findSectionsByFormId(FORM_ID)).thenReturn(List.of(sectionDef));
        when(attemptRepository.findAttemptSection(ATTEMPT_ID, SECTION_ID)).thenReturn(Optional.of(speakingSection));
    }

    @Test
    void independentPracticeInitializesOnlyItsPinnedPart() {
        for (int part = 1; part <= 3; part++) {
            reset(attemptRepository);
            Map<String, Object> snapshot = originalSpeakingSnapshot();
            snapshot.put("practiceScope", Map.of("scopeVersion", "exam-practice-scope-v1",
                    "scopeType", "IELTS_SPEAKING_PART", "number", part));
            AttemptRecord scoped = new AttemptRecord(
                    ATTEMPT_ID, USER_ID, FORM_ID, ExamFamily.IELTS, "academic", "IELTS_SPEAKING_PART",
                    ExamAttemptMode.PRACTICE, null, null, ExamAttemptStatus.IN_PROGRESS,
                    1L, 1L, "token-hash", Instant.now().plusSeconds(600), "manifest-hash",
                    Map.of(), Instant.now(), Instant.now(), null,
                    null, null, List.of(), Instant.now(), Instant.now(), snapshot, "v4.0", ExamSnapshotState.SNAPSHOTTED);
            when(attemptRepository.findAttemptByIdForUpdate(ATTEMPT_ID)).thenReturn(Optional.of(scoped));
            when(attemptRepository.findSectionsByAttemptId(ATTEMPT_ID)).thenReturn(List.of(speakingSection));
            when(attemptRepository.findAttemptSection(ATTEMPT_ID, SECTION_ID)).thenReturn(Optional.of(speakingSection));
            when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID)).thenReturn(List.of());
            speakingService.getOrInitializeSpeakingState(USER_ID, ATTEMPT_ID);
            int expected = part == 2 ? 1 : 4;
            verify(attemptRepository, times(expected)).insertSpeakingTurnResponse(eq(ATTEMPT_ID), eq(SECTION_ID),
                    anyString(), any(UUID.class), startsWith("speak_p" + part + "_"), anyInt(), anyString(), anyMap());
            verify(attemptRepository, times(expected)).insertSpeakingTurnResponse(eq(ATTEMPT_ID), eq(SECTION_ID),
                    anyString(), any(UUID.class), anyString(), anyInt(), anyString(), anyMap());
            int selectedPart = part;
            verify(attemptRepository, times(expected)).insertSpeakingTurnResponse(eq(ATTEMPT_ID), eq(SECTION_ID),
                    anyString(), any(UUID.class), anyString(), anyInt(), anyString(), argThat(s ->
                            String.valueOf(s.get("prompt")).startsWith("Original Part " + selectedPart)
                            && "PINNED_ORIGINAL_PRACTICE".equals(s.get("provenance")) && !s.containsKey("mediaUrl")));
        }
    }

    @Test
    void testInitializeSpeakingTurnsFromSnapshotOrder() {
        // When no responses exist, initialize from snapshot
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID))
                .thenReturn(List.of()) // first call returns empty
                .thenReturn(createMockResponses(1)); // subsequent call returns initialized

        SpeakingRuntimeStateDto state = speakingService.getOrInitializeSpeakingState(USER_ID, ATTEMPT_ID);

        assertNotNull(state);
        assertEquals(ATTEMPT_ID, state.attemptId());
        assertEquals(SECTION_ID, state.sectionId());
        assertEquals(1, state.currentTurnCursor());

        // Verify turns were inserted into repository
        verify(attemptRepository, atLeast(3)).insertSpeakingTurnResponse(
                eq(ATTEMPT_ID), eq(SECTION_ID), anyString(), any(UUID.class),
                startsWith("speak_"), anyInt(), anyString(), anyMap()
        );

        // Turn 1 is CURRENT and prompt is returned
        assertNotNull(state.currentTurn());
        assertEquals("Part 1: Introduce yourself and where you live.", state.currentTurn().prompt());
        assertEquals("CURRENT", state.currentTurn().turnState());
    }

    @Test
    void testPromptWithholdingInSpeakingState() {
        List<ResponseRecord> mockTurns = createMockResponses(1);
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID))
                .thenReturn(mockTurns);

        SpeakingRuntimeStateDto state = speakingService.getOrInitializeSpeakingState(USER_ID, ATTEMPT_ID);

        // 1. Current turn prompt is present
        assertNotNull(state.currentTurn());
        assertEquals("Part 1: Introduce yourself and where you live.", state.currentTurn().prompt());

        // 2. Completed turns list contains zero future prompts and zero prompts overall
        assertTrue(state.completedTurns().isEmpty());

        // 3. No other prompts exist in state
        assertNull(state.completedTurns().stream()
                .filter(t -> t.turnKey().contains("p2") || t.turnKey().contains("p3"))
                .findAny().orElse(null));
    }

    @Test
    void testCannotCompleteTurnWithoutRecordingPrerequisite() {
        List<ResponseRecord> mockTurns = createMockResponses(1);
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID))
                .thenReturn(mockTurns);

        CompleteTurnCommand invalidCmd = new CompleteTurnCommand("cmd-1", 1L, null, null);

        // Must fail closed when recordingId is missing
        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                speakingService.completeTurn(USER_ID, ATTEMPT_ID, invalidCmd)
        );
        assertTrue(ex.getMessage().contains("PREREQUISITE_EVIDENCE_MISSING"));

        // Must fail closed when audio duration is too short (<500ms)
        CompleteTurnCommand shortAudioCmd = new CompleteTurnCommand("cmd-2", 1L, UUID.randomUUID(), 200);
        IllegalStateException shortEx = assertThrows(IllegalStateException.class, () ->
                speakingService.completeTurn(USER_ID, ATTEMPT_ID, shortAudioCmd)
        );
        assertTrue(shortEx.getMessage().contains("INSUFFICIENT_AUDIO_DURATION"));
    }

    @Test
    void testRevisionConflictGuard() {
        List<ResponseRecord> mockTurns = createMockResponses(1);
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID))
                .thenReturn(mockTurns);

        // Stale revision: expected 999 while current is 1
        CompleteTurnCommand staleCmd = new CompleteTurnCommand("cmd-stale", 999L, UUID.randomUUID(), 5000);

        assertThrows(ExamConcurrencyException.class, () ->
                speakingService.completeTurn(USER_ID, ATTEMPT_ID, staleCmd)
        );
    }

    @Test
    void testAtomicPartTransitionsAndCompletion() {
        UUID rec1 = UUID.randomUUID();
        UUID rec2 = UUID.randomUUID();
        UUID rec3 = UUID.randomUUID();

        // Start at Turn 1 (Part 1)
        List<ResponseRecord> turnsP1 = createMockResponses(1);
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID))
                .thenReturn(turnsP1);

        CompleteTurnCommand cmd1 = new CompleteTurnCommand("cmd-p1", 1L, rec1, 15000);
        speakingService.completeTurn(USER_ID, ATTEMPT_ID, cmd1);

        // Verify turn 1 was marked COMPLETED with recordingId rec1
        verify(attemptRepository).updateSpeakingTurnState(ATTEMPT_ID, "speak_p1_g_intro_i_01", "COMPLETED", rec1, "cmd-p1");

        // Verify Part 2 turn 2 was unlocked to PREPARING
        verify(attemptRepository).updateSpeakingTurnState(ATTEMPT_ID, "speak_p2_g_cuecard_i_01", "PREPARING", null, null);

        // Verify cursor advanced to 2
        verify(attemptRepository).updateAttemptSectionSpeakingCursor(
                ATTEMPT_ID, SECTION_ID, 2, 1L, "speak_p2_g_cuecard_i_01", "speaking_part_2"
        );
    }

    @Test
    void testPreparationAndRecordingTimingTransitions() {
        List<ResponseRecord> mockTurns = createMockResponses(2); // Cursor at Part 2
        AttemptSectionRecord sectionAtP2 = new AttemptSectionRecord(
                UUID.randomUUID(), ATTEMPT_ID, SECTION_ID, ExamSectionState.ACTIVE, "MAIN",
                Instant.now(), Instant.now().plusSeconds(900), null, Map.of(), Instant.now(),
                "speaking_part_2", "speak_p2_g_cuecard_i_01", 2, 2L
        );
        when(attemptRepository.findSectionsByAttemptId(ATTEMPT_ID)).thenReturn(List.of(sectionAtP2));
        when(attemptRepository.findAttemptSection(ATTEMPT_ID, SECTION_ID)).thenReturn(Optional.of(sectionAtP2));
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID)).thenReturn(mockTurns);

        // 1. Start preparation
        StartPreparationCommand prepCmd = new StartPreparationCommand("prep-1", 2L);
        speakingService.startPreparation(USER_ID, ATTEMPT_ID, prepCmd);

        verify(attemptRepository).updateSpeakingTurnTiming(eq(ATTEMPT_ID), eq("speak_p2_g_cuecard_i_01"), anyMap(), eq("PREPARING"));

        // 2. Start recording
        StartRecordingCommand recCmd = new StartRecordingCommand("rec-1", 2L);
        speakingService.startRecording(USER_ID, ATTEMPT_ID, recCmd);

        verify(attemptRepository).updateSpeakingTurnTiming(eq(ATTEMPT_ID), eq("speak_p2_g_cuecard_i_01"), anyMap(), eq("RECORDING"));

        // 3. Stop recording
        StopRecordingCommand stopCmd = new StopRecordingCommand("stop-1", 2L);
        speakingService.stopRecording(USER_ID, ATTEMPT_ID, stopCmd);

        verify(attemptRepository).updateSpeakingTurnState(eq(ATTEMPT_ID), eq("speak_p2_g_cuecard_i_01"), eq("UPLOADING"), isNull(), eq("stop-1"));
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private Map<String, Object> originalSpeakingSnapshot() {
        Map<String, Object> base = new HashMap<>(createSampleSpeakingSnapshot());
        var section = new HashMap<>(((List<Map<String, Object>>) base.get("sections")).getFirst());
        var parts = new ArrayList<Map<String, Object>>();
        for (var p : (List<Map<String, Object>>) section.get("parts")) {
            var part = new HashMap<>(p);
            int number = ((Number) part.get("ordinal")).intValue();
            var group = new HashMap<>(((List<Map<String, Object>>) part.get("groups")).getFirst());
            var first = ((List<Map<String, Object>>) group.get("items")).getFirst();
            var items = new ArrayList<Map<String, Object>>();
            for (int i = 1; i <= (number == 2 ? 1 : 4); i++) {
                var item = new HashMap<>(first);
                item.put("prompt", "Original Part " + number + " Question " + i);
                items.add(item);
            }
            group.put("items", items); part.put("groups", List.of(group)); parts.add(part);
        }
        section.put("parts", parts); base.put("sections", List.of(section));
        base.put("form", Map.of("logicalKey", "EC_ORIGINAL_IELTS_SPEAKING_TEST"));
        return base;
    }

    private Map<String, Object> createSampleSpeakingSnapshot() {
        Map<String, Object> item1 = Map.of(
                "id", ITEM_P1_ID.toString(),
                "ordinal", 1,
                "prompt", "Part 1: Introduce yourself and where you live.",
                "logicalItemKey", "ITEM_P1"
        );
        Map<String, Object> group1 = Map.of(
                "logicalGroupKey", "intro",
                "items", List.of(item1)
        );
        Map<String, Object> part1 = Map.of(
                "partCode", "SPEAKING_PART_1",
                "ordinal", 1,
                "placementId", "speaking_part_1",
                "groups", List.of(group1)
        );

        Map<String, Object> item2 = Map.of(
                "id", ITEM_P2_ID.toString(),
                "ordinal", 1,
                "prompt", "Part 2: Describe a book that had a major influence on you.",
                "logicalItemKey", "ITEM_P2"
        );
        Map<String, Object> group2 = Map.of(
                "logicalGroupKey", "cuecard",
                "items", List.of(item2)
        );
        Map<String, Object> part2 = Map.of(
                "partCode", "SPEAKING_PART_2",
                "ordinal", 2,
                "placementId", "speaking_part_2",
                "groups", List.of(group2)
        );

        Map<String, Object> item3 = Map.of(
                "id", ITEM_P3_ID.toString(),
                "ordinal", 1,
                "prompt", "Part 3: Discussion on reading habits in modern society.",
                "logicalItemKey", "ITEM_P3"
        );
        Map<String, Object> group3 = Map.of(
                "logicalGroupKey", "discussion",
                "items", List.of(item3)
        );
        Map<String, Object> part3 = Map.of(
                "partCode", "SPEAKING_PART_3",
                "ordinal", 3,
                "placementId", "speaking_part_3",
                "groups", List.of(group3)
        );

        Map<String, Object> section = Map.of(
                "id", SECTION_ID.toString(),
                "skill", "SPEAKING",
                "parts", List.of(part1, part2, part3)
        );

        return Map.of("sections", List.of(section));
    }

    private List<ResponseRecord> createMockResponses(int currentCursor) {
        ResponseRecord r1 = new ResponseRecord(
                UUID.randomUUID(), ATTEMPT_ID, SECTION_ID, "speaking_part_1", ITEM_P1_ID,
                Map.of(), null, currentCursor > 1 ? UUID.randomUUID() : null, false, 1L, null, Instant.now(),
                "speak_p1_g_intro_i_01", 1, "SPEAKING_TURN",
                currentCursor > 1 ? "COMPLETED" : (currentCursor == 1 ? "CURRENT" : "LOCKED"),
                Map.of("prompt", "Part 1: Introduce yourself and where you live."), null
        );

        ResponseRecord r2 = new ResponseRecord(
                UUID.randomUUID(), ATTEMPT_ID, SECTION_ID, "speaking_part_2", ITEM_P2_ID,
                Map.of(), null, currentCursor > 2 ? UUID.randomUUID() : null, false, 1L, null, Instant.now(),
                "speak_p2_g_cuecard_i_01", 2, "SPEAKING_TURN",
                currentCursor > 2 ? "COMPLETED" : (currentCursor == 2 ? "CURRENT" : "LOCKED"),
                Map.of("prompt", "Part 2: Describe a book that had a major influence on you."), null
        );

        ResponseRecord r3 = new ResponseRecord(
                UUID.randomUUID(), ATTEMPT_ID, SECTION_ID, "speaking_part_3", ITEM_P3_ID,
                Map.of(), null, null, false, 1L, null, Instant.now(),
                "speak_p3_g_discussion_i_01", 3, "SPEAKING_TURN",
                currentCursor == 3 ? "CURRENT" : "LOCKED",
                Map.of("prompt", "Part 3: Discussion on reading habits in modern society."), null
        );

        return List.of(r1, r2, r3);
    }
}
