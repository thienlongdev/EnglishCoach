package com.englishcoach.exams;

import com.englishcoach.exams.exception.ExamExceptionHandler.ExamForbiddenException;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamNotFoundException;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamSpeakingRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.service.ExamManifestService;
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
class ExamSpeakingProjectionTest {

    @Mock
    private ExamAttemptRepository attemptRepository;

    @Mock
    private ExamContentRepository contentRepository;

    private ExamManifestService manifestService;
    private ExamSpeakingRuntimeService speakingService;

    private static final Long USER_ID = 101L;
    private static final UUID ATTEMPT_ID = UUID.fromString("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static final UUID FORM_ID = UUID.fromString("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    private static final UUID SECTION_ID = UUID.fromString("cccccccc-cccc-cccc-cccc-cccccccccccc");

    private AttemptRecord attempt;
    private AttemptSectionRecord speakingSection;

    @BeforeEach
    void setUp() {
        manifestService = new ExamManifestService(contentRepository, attemptRepository);
        speakingService = new ExamSpeakingRuntimeService(attemptRepository, contentRepository);

        Map<String, Object> manifestSnapshot = createCompleteSpeakingSnapshot();

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
                "speaking_part_1", "speak_p1_g_work_i_01", 1, 1L
        );

        SectionRecord sectionDef = new SectionRecord(
                SECTION_ID, FORM_ID, SkillType.SPEAKING, 4, "speaking", null, 900, Map.of()
        );

        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findAttemptByIdForUpdate(ATTEMPT_ID)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findSectionsByAttemptId(ATTEMPT_ID)).thenReturn(List.of(speakingSection));
        when(contentRepository.findSectionsByFormId(FORM_ID)).thenReturn(List.of(sectionDef));
        when(attemptRepository.findAttemptSection(ATTEMPT_ID, SECTION_ID)).thenReturn(Optional.of(speakingSection));
    }

    @Test
    void testCompileManifestWithholdsFutureSpeakingPromptsAndStimuli() {
        PublicAttemptManifestDto manifest = manifestService.compileAttemptManifest(attempt);

        assertNotNull(manifest);
        assertEquals(1, manifest.sections().size());
        PublicSectionDto sec = manifest.sections().get(0);
        assertEquals(SkillType.SPEAKING, sec.skill());

        // Part 1
        PublicPartDto part1 = sec.parts().get(0);
        assertEquals("SPEAKING_PART_1", part1.partCode());
        PublicItemDto turn1 = part1.groups().get(0).items().get(0);
        assertNotNull(turn1.prompt(), "Current turn 1 prompt must be present");
        assertEquals("Do you work or are you a student?", turn1.prompt());

        PublicItemDto turn2 = part1.groups().get(0).items().get(1);
        assertNull(turn2.prompt(), "Future turn 2 prompt must be withheld");
        assertNull(turn2.options(), "Future turn 2 options must be withheld");

        // Part 2 cue card
        PublicPartDto part2 = sec.parts().get(1);
        assertEquals("SPEAKING_PART_2", part2.partCode());
        PublicGroupDto part2Group = part2.groups().get(0);
        PublicItemDto turn3 = part2Group.items().get(0);
        assertNull(turn3.prompt(), "Future Part 2 cue card prompt must be withheld");
        assertTrue(part2Group.stimuli().isEmpty(), "Part 2 cue card stimuli must be withheld");

        // Part 3 discussion
        PublicPartDto part3 = sec.parts().get(2);
        assertEquals("SPEAKING_PART_3", part3.partCode());
        PublicItemDto turn4 = part3.groups().get(0).items().get(0);
        assertNull(turn4.prompt(), "Future Part 3 prompt must be withheld");

        // Verify exposure recorded only for turn 1
        verify(attemptRepository, times(1)).recordExposure(
                eq(USER_ID), eq("ITEM_SPK_P1_01"), anyInt(), eq(ATTEMPT_ID), eq(ExposureType.SIMULATION)
        );
        verify(attemptRepository, never()).recordExposure(
                eq(USER_ID), eq("ITEM_SPK_P1_02"), anyInt(), any(UUID.class), any()
        );
        verify(attemptRepository, never()).recordExposure(
                eq(USER_ID), eq("ITEM_SPK_P2_01"), anyInt(), any(UUID.class), any()
        );
    }

    @Test
    void testCompileManifestWithholdsAllSpeakingPromptsWhenSectionIsPending() {
        AttemptSectionRecord pendingSection = new AttemptSectionRecord(
                speakingSection.id(), ATTEMPT_ID, SECTION_ID, ExamSectionState.PENDING, "MAIN",
                null, null, null, Map.of(), Instant.now(),
                null, null, 1, 1L
        );
        when(attemptRepository.findSectionsByAttemptId(ATTEMPT_ID)).thenReturn(List.of(pendingSection));

        PublicAttemptManifestDto manifest = manifestService.compileAttemptManifest(attempt);
        assertNotNull(manifest);

        PublicSectionDto sec = manifest.sections().get(0);
        for (PublicPartDto part : sec.parts()) {
            for (PublicGroupDto group : part.groups()) {
                assertTrue(group.stimuli().isEmpty(), "Stimuli must be withheld for pending section");
                for (PublicItemDto item : group.items()) {
                    assertNull(item.prompt(), "Prompt must be withheld for pending section item: " + item.id());
                }
            }
        }

        verify(attemptRepository, never()).recordExposure(anyLong(), anyString(), anyInt(), any(UUID.class), any());
    }

    @Test
    void testCompileManifestEnforcesPromptWithholdingInPracticeMode() {
        AttemptRecord practiceAttempt = new AttemptRecord(
                ATTEMPT_ID, USER_ID, FORM_ID, ExamFamily.IELTS, "academic", "FULL",
                ExamAttemptMode.PRACTICE, null, null, ExamAttemptStatus.IN_PROGRESS,
                1L, 1L, "token-hash", Instant.now().plusSeconds(600), "manifest-hash",
                Map.of(), Instant.now(), Instant.now(), Instant.now().plusSeconds(7200),
                null, null, List.of(), Instant.now(), Instant.now(),
                attempt.manifestSnapshot(), "v4.0", ExamSnapshotState.SNAPSHOTTED
        );
        when(attemptRepository.findAttemptById(ATTEMPT_ID)).thenReturn(Optional.of(practiceAttempt));

        PublicAttemptManifestDto manifest = manifestService.compileAttemptManifest(practiceAttempt);
        assertNotNull(manifest);
        assertEquals("PRACTICE_MODE", manifest.manifestScope());

        PublicSectionDto sec = manifest.sections().get(0);
        PublicItemDto turn1 = sec.parts().get(0).groups().get(0).items().get(0);
        PublicItemDto turn2 = sec.parts().get(0).groups().get(0).items().get(1);
        PublicItemDto turn3 = sec.parts().get(1).groups().get(0).items().get(0);

        assertNotNull(turn1.prompt(), "Current turn 1 prompt present in practice mode");
        assertNull(turn2.prompt(), "Future turn 2 prompt must be withheld even in practice mode");
        assertNull(turn3.prompt(), "Future turn 3 cue card must be withheld even in practice mode");
    }

    @Test
    void testSpeakingStateProjectionIncludesTransitionTokenAndLockedTurnCount() {
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID))
                .thenReturn(createMockSpeakingTurns());

        SpeakingRuntimeStateDto state = speakingService.getOrInitializeSpeakingState(USER_ID, ATTEMPT_ID);
        assertNotNull(state);
        assertNotNull(state.transitionToken(), "State transition token must not be null");
        assertNotNull(state.currentTurn().transitionToken(), "Current turn transition token must not be null");
        assertEquals(state.transitionToken(), state.currentTurn().transitionToken());
        assertEquals(4, state.totalTurns());
        assertEquals(3, state.lockedTurnCount(), "Turn 1 is current, so exactly 3 turns must be locked");
    }

    @Test
    void testGetSpeakingTurnForCurrentTurnSucceeds() {
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID))
                .thenReturn(createMockSpeakingTurns());

        SpeakingTurnDto turn = speakingService.getSpeakingTurn(USER_ID, ATTEMPT_ID, "speak_p1_g_work_i_01");
        assertNotNull(turn);
        assertEquals("speak_p1_g_work_i_01", turn.turnKey());
        assertEquals(1, turn.turnSequence());
        assertEquals("Do you work or are you a student?", turn.prompt());
        assertNotNull(turn.transitionToken());
    }

    @Test
    void testGuessedFutureTurnKeyThrowsForbidden403() {
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID))
                .thenReturn(createMockSpeakingTurns());

        // Guessing Part 2 cue card while on Part 1 turn 1
        ExamForbiddenException ex = assertThrows(ExamForbiddenException.class, () ->
                speakingService.getSpeakingTurn(USER_ID, ATTEMPT_ID, "speak_p2_g_place_i_01")
        );
        assertTrue(ex.getMessage().contains("Access to future turn is forbidden"));
    }

    @Test
    void testGuessedNonExistentTurnKeyThrowsNotFound404() {
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID))
                .thenReturn(createMockSpeakingTurns());

        assertThrows(ExamNotFoundException.class, () ->
                speakingService.getSpeakingTurn(USER_ID, ATTEMPT_ID, "speak_nonexistent_99")
        );
    }

    @Test
    void testCommandWithMismatchedTurnKeyRejectedWith403() {
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID))
                .thenReturn(createMockSpeakingTurns());

        StartPreparationCommand cmd = new StartPreparationCommand(
                "cmd-prep", 1L, "speak_p2_g_place_i_01", null
        );

        assertThrows(ExamForbiddenException.class, () ->
                speakingService.startPreparation(USER_ID, ATTEMPT_ID, cmd)
        );
    }

    @Test
    void testCommandWithInvalidTransitionTokenRejectedWith403() {
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(ATTEMPT_ID, SECTION_ID))
                .thenReturn(createMockSpeakingTurns());

        StartPreparationCommand cmd = new StartPreparationCommand(
                "cmd-prep", 1L, "speak_p1_g_work_i_01", "invalid_forged_token_xyz"
        );

        assertThrows(ExamForbiddenException.class, () ->
                speakingService.startPreparation(USER_ID, ATTEMPT_ID, cmd)
        );
    }

    private List<ResponseRecord> createMockSpeakingTurns() {
        Instant now = Instant.now();
        return List.of(
                new ResponseRecord(
                        UUID.randomUUID(), ATTEMPT_ID, SECTION_ID, "p_speaking_part_1_g_work",
                        UUID.randomUUID(), Map.of(), null, null, false, 1L,
                        "cmd-1", now, "speak_p1_g_work_i_01", 1, "AUDIO", "CURRENT",
                        Map.of("prompt", "Do you work or are you a student?"), "hash1"
                ),
                new ResponseRecord(
                        UUID.randomUUID(), ATTEMPT_ID, SECTION_ID, "p_speaking_part_1_g_work",
                        UUID.randomUUID(), Map.of(), null, null, false, 1L,
                        "cmd-2", now, "speak_p1_g_work_i_02", 2, "AUDIO", "LOCKED",
                        Map.of("prompt", "What do you like most about your studies?"), "hash2"
                ),
                new ResponseRecord(
                        UUID.randomUUID(), ATTEMPT_ID, SECTION_ID, "p_speaking_part_2_g_place",
                        UUID.randomUUID(), Map.of(), null, null, false, 1L,
                        "cmd-3", now, "speak_p2_g_place_i_01", 3, "AUDIO", "LOCKED",
                        Map.of("prompt", "Describe a place you visited that impressed you."), "hash3"
                ),
                new ResponseRecord(
                        UUID.randomUUID(), ATTEMPT_ID, SECTION_ID, "p_speaking_part_3_g_travel",
                        UUID.randomUUID(), Map.of(), null, null, false, 1L,
                        "cmd-4", now, "speak_p3_g_travel_i_01", 4, "AUDIO", "LOCKED",
                        Map.of("prompt", "Why do you think tourism is important for a country?"), "hash4"
                )
        );
    }

    private Map<String, Object> createCompleteSpeakingSnapshot() {
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("version", "v4.0");

        Map<String, Object> form = new LinkedHashMap<>();
        form.put("id", FORM_ID.toString());
        form.put("title", "IELTS Academic Complete Speaking Test");
        form.put("family", "IELTS");
        root.put("form", form);

        Map<String, Object> sec = new LinkedHashMap<>();
        sec.put("id", SECTION_ID.toString());
        sec.put("skill", "SPEAKING");
        sec.put("ordinal", 4);
        sec.put("specSectionKey", "speaking");
        sec.put("durationSeconds", 900);
        sec.put("timingPolicy", Map.of());

        // Part 1
        Map<String, Object> part1 = new LinkedHashMap<>();
        part1.put("id", UUID.randomUUID().toString());
        part1.put("partCode", "SPEAKING_PART_1");
        part1.put("ordinal", 1);
        part1.put("instructions", "Answer the examiner's general questions.");

        Map<String, Object> grp1 = new LinkedHashMap<>();
        grp1.put("id", UUID.randomUUID().toString());
        grp1.put("logicalGroupKey", "GRP_WORK");
        grp1.put("questionType", "SPEAKING_INTERVIEW");
        grp1.put("skill", "SPEAKING");
        grp1.put("stimuli", List.of());

        Map<String, Object> itm1 = new LinkedHashMap<>();
        itm1.put("id", UUID.randomUUID().toString());
        itm1.put("logicalItemKey", "ITEM_SPK_P1_01");
        itm1.put("version", 1);
        itm1.put("ordinal", 1);
        itm1.put("prompt", "Do you work or are you a student?");
        itm1.put("interactionType", "AUDIO_RECORDING");

        Map<String, Object> itm2 = new LinkedHashMap<>();
        itm2.put("id", UUID.randomUUID().toString());
        itm2.put("logicalItemKey", "ITEM_SPK_P1_02");
        itm2.put("version", 1);
        itm2.put("ordinal", 2);
        itm2.put("prompt", "What do you like most about your studies?");
        itm2.put("interactionType", "AUDIO_RECORDING");

        grp1.put("items", List.of(itm1, itm2));
        part1.put("groups", List.of(grp1));

        // Part 2
        Map<String, Object> part2 = new LinkedHashMap<>();
        part2.put("id", UUID.randomUUID().toString());
        part2.put("partCode", "SPEAKING_PART_2");
        part2.put("ordinal", 2);
        part2.put("instructions", "You will talk about a topic for 1 to 2 minutes.");

        Map<String, Object> stimCueCard = new LinkedHashMap<>();
        stimCueCard.put("id", UUID.randomUUID().toString());
        stimCueCard.put("logicalStimulusKey", "STIM_CUE_CARD_01");
        stimCueCard.put("kind", "CUE_CARD");
        stimCueCard.put("title", "Historic Place");
        stimCueCard.put("bodyPayload", Map.of("points", List.of("Where it was", "When you went")));
        stimCueCard.put("assets", List.of(Map.of("assetId", UUID.randomUUID().toString(), "role", "EXAMINER_AUDIO")));

        Map<String, Object> grp2 = new LinkedHashMap<>();
        grp2.put("id", UUID.randomUUID().toString());
        grp2.put("logicalGroupKey", "GRP_PLACE");
        grp2.put("questionType", "SPEAKING_LONG_TURN");
        grp2.put("skill", "SPEAKING");
        grp2.put("stimuli", List.of(stimCueCard));

        Map<String, Object> itm3 = new LinkedHashMap<>();
        itm3.put("id", UUID.randomUUID().toString());
        itm3.put("logicalItemKey", "ITEM_SPK_P2_01");
        itm3.put("version", 1);
        itm3.put("ordinal", 1);
        itm3.put("prompt", "Describe a place you visited that impressed you.");
        itm3.put("interactionType", "AUDIO_RECORDING");

        grp2.put("items", List.of(itm3));
        part2.put("groups", List.of(grp2));

        // Part 3
        Map<String, Object> part3 = new LinkedHashMap<>();
        part3.put("id", UUID.randomUUID().toString());
        part3.put("partCode", "SPEAKING_PART_3");
        part3.put("ordinal", 3);
        part3.put("instructions", "Discuss more abstract issues related to Part 2.");

        Map<String, Object> grp3 = new LinkedHashMap<>();
        grp3.put("id", UUID.randomUUID().toString());
        grp3.put("logicalGroupKey", "GRP_TRAVEL");
        grp3.put("questionType", "SPEAKING_DISCUSSION");
        grp3.put("skill", "SPEAKING");
        grp3.put("stimuli", List.of());

        Map<String, Object> itm4 = new LinkedHashMap<>();
        itm4.put("id", UUID.randomUUID().toString());
        itm4.put("logicalItemKey", "ITEM_SPK_P3_01");
        itm4.put("version", 1);
        itm4.put("ordinal", 1);
        itm4.put("prompt", "Why do you think tourism is important for a country?");
        itm4.put("interactionType", "AUDIO_RECORDING");

        grp3.put("items", List.of(itm4));
        part3.put("groups", List.of(grp3));

        sec.put("parts", List.of(part1, part2, part3));
        root.put("sections", List.of(sec));

        return root;
    }
}
