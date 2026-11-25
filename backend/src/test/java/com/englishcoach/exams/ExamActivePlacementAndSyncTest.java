package com.englishcoach.exams;

import com.englishcoach.exams.exception.ExamConcurrencyException;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamForbiddenException;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamNotFoundException;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.service.ExamAttemptService;
import com.englishcoach.exams.service.ExamManifestService;
import com.englishcoach.exams.service.ExamResponseService;
import com.englishcoach.exams.service.ExamTimingService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
public class ExamActivePlacementAndSyncTest {

    @Mock
    private ExamAttemptRepository attemptRepository;

    @Mock
    private ExamContentRepository contentRepository;

    @Mock
    private ExamTimingService timingService;

    @InjectMocks
    private ExamResponseService responseService;

    @InjectMocks
    private ExamAttemptService attemptService;

    @InjectMocks
    private ExamManifestService manifestService;

    private final UUID attemptId = UUID.randomUUID();
    private final UUID formId = UUID.randomUUID();
    private final UUID activeSectionId = UUID.randomUUID();
    private final UUID futureSectionId = UUID.randomUUID();
    private final Long userId = 42L;

    private AttemptRecord createAttempt(ExamAttemptMode mode) {
        return new AttemptRecord(
                attemptId, userId, formId, ExamFamily.IELTS, "ACADEMIC", "FULL",
                mode, null, null, ExamAttemptStatus.IN_PROGRESS,
                5L, 1L, "token", Instant.now().plus(1, ChronoUnit.HOURS),
                "hash", Map.of(), null, Instant.now().minus(10, ChronoUnit.MINUTES),
                null, null, null, List.of(), Instant.now(), Instant.now()
        );
    }

    private AttemptSectionRecord createAttemptSection(UUID sectionId, ExamSectionState state, String phase) {
        return new AttemptSectionRecord(
                UUID.randomUUID(), attemptId, sectionId, state, phase,
                Instant.now(), Instant.now().plusSeconds(1800), null, Map.of(), Instant.now()
        );
    }

    @Test
    @DisplayName("EXAMS-V4-04: Saving response to placement in active section succeeds")
    void testSaveResponseToActiveSectionSucceeds() {
        AttemptRecord attempt = createAttempt(ExamAttemptMode.EXAM_SIMULATION);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findCommandReceipt(eq(userId), eq("SAVE_RESPONSES"), any())).thenReturn(Optional.empty());

        AttemptSectionRecord sec1 = createAttemptSection(activeSectionId, ExamSectionState.ACTIVE, "LISTENING");
        AttemptSectionRecord sec2 = createAttemptSection(futureSectionId, ExamSectionState.PENDING, "READING");
        when(attemptRepository.findSectionsByAttemptId(attemptId)).thenReturn(List.of(sec1, sec2));

        UUID itemId = UUID.randomUUID();
        when(attemptRepository.resolvePlacement(attemptId, activeSectionId, "p_sec1_q1"))
                .thenReturn(Optional.of(new ExamAttemptRepository.PlacementResolution(itemId, activeSectionId)));
        when(attemptRepository.upsertResponse(any(), any(), any(), any(), any(), any(), any(), anyBoolean(), any(), any()))
                .thenReturn(1L);

        SaveResponseBatchRequest req = new SaveResponseBatchRequest(
                "cmd-save-active",
                5L,
                List.of(new ResponseItemCommand("p_sec1_q1", itemId, Map.of("answer", "A"), null, null, false, 0L))
        );

        SaveReceiptDto receipt = responseService.saveResponseBatch(userId, attemptId, req);
        assertNotNull(receipt);
        assertEquals(6L, receipt.attemptRevision());
        verify(attemptRepository).incrementAttemptRevision(attemptId);
    }

    @Test
    @DisplayName("EXAMS-V4-04: Saving response to placement in future/non-active section throws PLACEMENT_NOT_CURRENT")
    void testSaveResponseToFutureSectionThrowsPlacementNotCurrent() {
        AttemptRecord attempt = createAttempt(ExamAttemptMode.EXAM_SIMULATION);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findCommandReceipt(eq(userId), eq("SAVE_RESPONSES"), any())).thenReturn(Optional.empty());

        AttemptSectionRecord sec1 = createAttemptSection(activeSectionId, ExamSectionState.ACTIVE, "LISTENING");
        AttemptSectionRecord sec2 = createAttemptSection(futureSectionId, ExamSectionState.PENDING, "READING");
        when(attemptRepository.findSectionsByAttemptId(attemptId)).thenReturn(List.of(sec1, sec2));

        // Placement does NOT exist in active section
        when(attemptRepository.resolvePlacement(attemptId, activeSectionId, "p_sec2_q1")).thenReturn(Optional.empty());
        // But it exists in another section (futureSectionId)
        UUID itemId = UUID.randomUUID();
        when(attemptRepository.resolvePlacement(attemptId, "p_sec2_q1"))
                .thenReturn(Optional.of(new ExamAttemptRepository.PlacementResolution(itemId, futureSectionId)));

        SaveResponseBatchRequest req = new SaveResponseBatchRequest(
                "cmd-save-future",
                5L,
                List.of(new ResponseItemCommand("p_sec2_q1", itemId, Map.of("answer", "B"), null, null, false, 0L))
        );

        ExamConcurrencyException ex = assertThrows(ExamConcurrencyException.class, () ->
                responseService.saveResponseBatch(userId, attemptId, req)
        );

        assertEquals("PLACEMENT_NOT_CURRENT", ex.getCode());
        assertEquals(5L, ex.getCurrentRevision());
        assertEquals(5L, ex.getExpectedRevision());
        verify(attemptRepository, never()).upsertResponse(any(), any(), any(), any(), any(), any(), any(), anyBoolean(), any(), any());
    }

    @Test
    @DisplayName("EXAMS-V4-04: Saving response with unknown placement throws PLACEMENT_NOT_FOUND")
    void testSaveResponseWithUnknownPlacementThrowsPlacementNotFound() {
        AttemptRecord attempt = createAttempt(ExamAttemptMode.EXAM_SIMULATION);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findCommandReceipt(eq(userId), eq("SAVE_RESPONSES"), any())).thenReturn(Optional.empty());

        AttemptSectionRecord sec1 = createAttemptSection(activeSectionId, ExamSectionState.ACTIVE, "LISTENING");
        when(attemptRepository.findSectionsByAttemptId(attemptId)).thenReturn(List.of(sec1));

        // Not found in active section, nor in any section
        when(attemptRepository.resolvePlacement(attemptId, activeSectionId, "unknown_placement")).thenReturn(Optional.empty());
        when(attemptRepository.resolvePlacement(attemptId, "unknown_placement")).thenReturn(Optional.empty());

        SaveResponseBatchRequest req = new SaveResponseBatchRequest(
                "cmd-save-unknown",
                5L,
                List.of(new ResponseItemCommand("unknown_placement", UUID.randomUUID(), Map.of("val", 1), null, null, false, 0L))
        );

        ExamConcurrencyException ex = assertThrows(ExamConcurrencyException.class, () ->
                responseService.saveResponseBatch(userId, attemptId, req)
        );

        assertEquals("PLACEMENT_NOT_FOUND", ex.getCode());
        verify(attemptRepository, never()).upsertResponse(any(), any(), any(), any(), any(), any(), any(), anyBoolean(), any(), any());
    }

    @Test
    @DisplayName("EXAMS-V4-04: Saving response when no section is ACTIVE throws SCOPE_NOT_RUNNABLE")
    void testSaveResponseWhenNoActiveSectionThrowsScopeNotRunnable() {
        AttemptRecord attempt = createAttempt(ExamAttemptMode.EXAM_SIMULATION);
        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(attempt));
        when(attemptRepository.findCommandReceipt(eq(userId), eq("SAVE_RESPONSES"), any())).thenReturn(Optional.empty());

        // All sections are COMPLETED or PENDING
        AttemptSectionRecord sec1 = createAttemptSection(activeSectionId, ExamSectionState.COMPLETED, "LISTENING");
        AttemptSectionRecord sec2 = createAttemptSection(futureSectionId, ExamSectionState.PENDING, "READING");
        when(attemptRepository.findSectionsByAttemptId(attemptId)).thenReturn(List.of(sec1, sec2));

        SaveResponseBatchRequest req = new SaveResponseBatchRequest(
                "cmd-save-no-active",
                5L,
                List.of(new ResponseItemCommand("p_sec1_q1", UUID.randomUUID(), Map.of("val", 1), null, null, false, 0L))
        );

        ExamConcurrencyException ex = assertThrows(ExamConcurrencyException.class, () ->
                responseService.saveResponseBatch(userId, attemptId, req)
        );

        assertEquals("SCOPE_NOT_RUNNABLE", ex.getCode());
        verify(attemptRepository, never()).upsertResponse(any(), any(), any(), any(), any(), any(), any(), anyBoolean(), any(), any());
    }

    @Test
    @DisplayName("EXAMS-V4-04: Authoritative sync rejects wrong user with ExamForbiddenException and missing attempt with ExamNotFoundException")
    void testAuthoritativeSyncSecurity() {
        AttemptRecord attempt = createAttempt(ExamAttemptMode.EXAM_SIMULATION);
        when(attemptRepository.findAttemptById(attemptId)).thenReturn(Optional.of(attempt));

        // Wrong user (999L != 42L)
        assertThrows(ExamForbiddenException.class, () ->
                attemptService.getOwnedAttempt(999L, attemptId)
        );

        // Missing attempt
        UUID nonExistentId = UUID.randomUUID();
        when(attemptRepository.findAttemptById(nonExistentId)).thenReturn(Optional.empty());
        assertThrows(ExamNotFoundException.class, () ->
                attemptService.getOwnedAttempt(userId, nonExistentId)
        );

        // Correct user returns the attempt
        AttemptRecord owned = attemptService.getOwnedAttempt(userId, attemptId);
        assertNotNull(owned);
        assertEquals(attemptId, owned.id());
    }

    @Test
    @DisplayName("EXAMS-V4-04: Simulation manifest withholds prompts and stimuli for PENDING sections and suppresses exposure")
    void testSimulationManifestWithholdsPromptsForPendingSections() {
        AttemptRecord attempt = createAttempt(ExamAttemptMode.EXAM_SIMULATION);

        FormVersionRecord form = new FormVersionRecord(
                formId, "form_01", 1, "Test Form", ExamFamily.IELTS, "ACADEMIC", "FULL",
                UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(), LifecycleState.PUBLISHED,
                UUID.randomUUID(), 1L, "hash", Instant.now(), null, Instant.now()
        );
        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(form));

        SectionRecord sec1 = new SectionRecord(activeSectionId, formId, SkillType.LISTENING, 1, "sec_listening", UUID.randomUUID(), 1800, Map.of());
        SectionRecord sec2 = new SectionRecord(futureSectionId, formId, SkillType.READING, 2, "sec_reading", UUID.randomUUID(), 3600, Map.of());
        when(contentRepository.findSectionsByFormId(formId)).thenReturn(List.of(sec1, sec2));

        AttemptSectionRecord asr1 = createAttemptSection(activeSectionId, ExamSectionState.ACTIVE, "LISTENING");
        AttemptSectionRecord asr2 = createAttemptSection(futureSectionId, ExamSectionState.PENDING, "READING");
        when(attemptRepository.findSectionsByAttemptId(attemptId)).thenReturn(List.of(asr1, asr2));

        // Sec1 parts, groups, items
        UUID part1Id = UUID.randomUUID();
        when(contentRepository.findPartsBySectionId(activeSectionId)).thenReturn(List.of(
                new PartRecord(part1Id, activeSectionId, "P1", 1, "Listen carefully", Map.of())
        ));
        UUID group1Id = UUID.randomUUID();
        when(contentRepository.findGroupsByPartId(part1Id)).thenReturn(List.of(
                new GroupVersionRecord(group1Id, "g1", 1, "MULTIPLE_CHOICE", "CONSTRUCT", SkillType.LISTENING, "TOPIC", 0.5, UUID.randomUUID(), "hash", Instant.now())
        ));
        when(contentRepository.findStimuliByGroupId(group1Id)).thenReturn(List.of(
                new StimulusVersionRecord(UUID.randomUUID(), "stim_1", 1, "AUDIO", "Audio Stim", Map.of(), UUID.randomUUID(), "hash", Instant.now())
        ));
        when(contentRepository.findItemsByGroupId(group1Id)).thenReturn(List.of(
                new ItemVersionRecord(UUID.randomUUID(), group1Id, "item_active", 1, "Active question prompt", "SINGLE_CHOICE", Map.of("options", List.of("A", "B")), "CONSTRUCT", UUID.randomUUID(), "hash", Instant.now(), 1)
        ));

        // Sec2 parts, groups, items (PENDING section)
        UUID part2Id = UUID.randomUUID();
        when(contentRepository.findPartsBySectionId(futureSectionId)).thenReturn(List.of(
                new PartRecord(part2Id, futureSectionId, "P1", 1, "Read passage", Map.of())
        ));
        UUID group2Id = UUID.randomUUID();
        when(contentRepository.findGroupsByPartId(part2Id)).thenReturn(List.of(
                new GroupVersionRecord(group2Id, "g2", 1, "READING_PASSAGE", "CONSTRUCT", SkillType.READING, "TOPIC", 0.5, UUID.randomUUID(), "hash", Instant.now())
        ));
        when(contentRepository.findItemsByGroupId(group2Id)).thenReturn(List.of(
                new ItemVersionRecord(UUID.randomUUID(), group2Id, "item_future", 1, "SECRET FUTURE PROMPT", "TEXT_GAP", Map.of("key", "secret"), "CONSTRUCT", UUID.randomUUID(), "hash", Instant.now(), 1)
        ));

        PublicAttemptManifestDto manifest = manifestService.compileAttemptManifest(attempt);
        assertNotNull(manifest);
        assertEquals(2, manifest.sections().size());

        // Active Section (sec1): Prompt and stimuli ARE present
        PublicSectionDto manifestSec1 = manifest.sections().get(0);
        assertEquals(activeSectionId, manifestSec1.id());
        PublicGroupDto activeGroup = manifestSec1.parts().get(0).groups().get(0);
        assertFalse(activeGroup.stimuli().isEmpty(), "Active section stimuli must NOT be empty");
        PublicItemDto activeItem = activeGroup.items().get(0);
        assertNotNull(activeItem.prompt(), "Active section prompt must NOT be null");
        assertEquals("Active question prompt", activeItem.prompt());
        assertNotNull(activeItem.options(), "Active section options must NOT be null");

        // Pending Section (sec2): Prompt and stimuli ARE WITHHELD (null / empty)
        PublicSectionDto manifestSec2 = manifest.sections().get(1);
        assertEquals(futureSectionId, manifestSec2.id());
        PublicGroupDto futureGroup = manifestSec2.parts().get(0).groups().get(0);
        assertTrue(futureGroup.stimuli().isEmpty(), "Future section stimuli must be empty/withheld");
        PublicItemDto futureItem = futureGroup.items().get(0);
        assertNull(futureItem.prompt(), "Future section prompt must be WITHHELD (null)");
        assertNull(futureItem.options(), "Future section options must be WITHHELD (null)");

        // Exposure should only be recorded for item_active, NOT item_future
        verify(attemptRepository).recordExposure(eq(userId), eq("item_active"), eq(1), eq(attemptId), eq(ExposureType.SIMULATION));
        verify(attemptRepository, never()).recordExposure(eq(userId), eq("item_future"), anyInt(), eq(attemptId), any());
    }
}
