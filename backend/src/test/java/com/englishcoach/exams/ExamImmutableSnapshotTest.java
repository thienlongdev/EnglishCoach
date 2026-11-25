package com.englishcoach.exams;

import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamScoringRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.repository.ExamScoringRepository;
import com.englishcoach.exams.scoring.ExamAnswerNormalizer;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.service.ExamAttemptService;
import com.englishcoach.exams.service.ExamManifestService;
import com.englishcoach.exams.service.ExamManifestService.FormSnapshotResult;
import com.englishcoach.exams.service.ExamResultService;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.service.ExamTimingService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
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
class ExamImmutableSnapshotTest {

    @Mock
    private ExamContentRepository contentRepository;
    @Mock
    private ExamAttemptRepository attemptRepository;
    @Mock
    private ExamScoringRepository scoringRepository;
    @Mock
    private ExamMediaRepository mediaRepository;
    @Mock
    private ExamRightsService rightsService;
    @Mock
    private ExamTimingService timingService;

    private ExamManifestService manifestService;
    private ExamResultService resultService;
    private ExamAttemptService attemptService;

    private final UUID formId = UUID.randomUUID();
    private final UUID sectionId = UUID.randomUUID();
    private final UUID partId = UUID.randomUUID();
    private final UUID groupId = UUID.randomUUID();
    private final UUID itemId = UUID.randomUUID();
    private final UUID answerSpecId = UUID.randomUUID();
    private final Long userId = 101L;

    private FormVersionRecord testForm;
    private SectionRecord testSection;
    private PartRecord testPart;
    private GroupVersionRecord testGroup;
    private ItemVersionRecord originalItem;
    private AnswerSpecRecord testAnswerSpec;

    @BeforeEach
    void setUp() {
        manifestService = new ExamManifestService(contentRepository, attemptRepository);
        ExamAnswerNormalizer normalizer = new ExamAnswerNormalizer();
        ExamObjectiveScorer objectiveScorer = new ExamObjectiveScorer(normalizer);
        resultService = new ExamResultService(
                attemptRepository,
                scoringRepository,
                contentRepository,
                mediaRepository,
                objectiveScorer
        );
        attemptService = new ExamAttemptService(
                attemptRepository,
                contentRepository,
                rightsService,
                timingService,
                manifestService
        );

        testForm = new FormVersionRecord(
                formId, "IELTS-ACAD-TEST-01", 1, "IELTS Academic Test 01", ExamFamily.IELTS,
                "ACADEMIC", "FULL", null, null, null, LifecycleState.PUBLISHED,
                null, 1L, "form_hash_123", Instant.now(), null, Instant.now(), "PASS"
        );

        testSection = new SectionRecord(
                sectionId, formId, SkillType.READING, 1, "sec_reading_01", null,
                3600, Map.of("timeLimit", 3600), true, "PASS"
        );

        testPart = new PartRecord(
                partId, sectionId, "P1", 1, "Read the text and answer questions 1-5", Map.of()
        );

        testGroup = new GroupVersionRecord(
                groupId, "group_r1", 1, "MULTIPLE_CHOICE", "READING_COMPREHENSION",
                SkillType.READING, "Science", 1.0, null, "grp_hash", Instant.now()
        );

        originalItem = new ItemVersionRecord(
                itemId, groupId, "R1_Q01", 1, "Original snapshot question prompt: What is photosynthesis?",
                "MULTIPLE_CHOICE", Map.of("A", "Process 1", "B", "Process 2"), "BIOLOGY",
                null, "item_hash", Instant.now(), 1
        );

        testAnswerSpec = new AnswerSpecRecord(
                answerSpecId, itemId, Map.of("exact", "A"), Map.of(), 1, 1, 1.0,
                "Explanation for question 1", null, Instant.now()
        );
    }

    private void stubCatalogGraph() {
        when(contentRepository.findSectionsByFormId(formId)).thenReturn(List.of(testSection));
        when(contentRepository.findPartsBySectionId(sectionId)).thenReturn(List.of(testPart));
        when(contentRepository.findGroupsByPartId(partId)).thenReturn(List.of(testGroup));
        when(contentRepository.findStimuliByGroupId(groupId)).thenReturn(List.of());
        when(contentRepository.findItemsByGroupId(groupId)).thenReturn(List.of(originalItem));
        lenient().when(contentRepository.findAnswerSpecByItemId(itemId)).thenReturn(Optional.of(testAnswerSpec));
    }

    @Test
    @DisplayName("Test 1: Snapshot hash matches deterministic SHA-256 for identical form graphs")
    void testSnapshotHashMatchesDeterministicSha256() {
        stubCatalogGraph();

        FormSnapshotResult result1 = manifestService.serializeFormSnapshot(testForm);
        FormSnapshotResult result2 = manifestService.serializeFormSnapshot(testForm);

        assertNotNull(result1.snapshot());
        assertNotNull(result1.hash());
        assertEquals("v4.0", result1.version());
        assertEquals(64, result1.hash().length(), "SHA-256 hash must be 64 hexadecimal characters");

        // Idempotency: exact same hash for identical graph
        assertEquals(result1.hash(), result2.hash(), "Deterministic hash must be identical across runs");
    }

    @Test
    @DisplayName("Test 2: Content edit after create does not affect snapshot manifest")
    void testContentEditAfterCreateDoesNotAffectSnapshotManifest() {
        stubCatalogGraph();
        FormSnapshotResult snapshot = manifestService.serializeFormSnapshot(testForm);

        UUID attemptId = UUID.randomUUID();
        AttemptRecord attempt = new AttemptRecord(
                attemptId, userId, formId, ExamFamily.IELTS, "ACADEMIC", "FULL",
                ExamAttemptMode.EXAM_SIMULATION, null, null, ExamAttemptStatus.IN_PROGRESS,
                1L, 1L, "token", Instant.now().plus(1, ChronoUnit.HOURS),
                snapshot.hash(), Map.of(), null, Instant.now().minus(10, ChronoUnit.MINUTES),
                Instant.now(), Instant.now(), null, List.of(), Instant.now(), Instant.now(),
                snapshot.snapshot(), snapshot.version(), ExamSnapshotState.SNAPSHOTTED
        );

        AttemptSectionRecord asr = new AttemptSectionRecord(
                UUID.randomUUID(), attemptId, sectionId, ExamSectionState.ACTIVE,
                "EXECUTION", Instant.now(), Instant.now().plus(1, ChronoUnit.HOURS), null, Map.of(), Instant.now()
        );
        when(attemptRepository.findSectionsByAttemptId(attemptId)).thenReturn(List.of(asr));

        // Now simulate a catalog edit: Catalog item prompt is updated in database
        ItemVersionRecord mutatedCatalogItem = new ItemVersionRecord(
                itemId, groupId, "R1_Q01", 2, "MUTATED CATALOG PROMPT: This should NEVER appear in historical attempts!",
                "MULTIPLE_CHOICE", Map.of("A", "New 1", "B", "New 2"), "BIOLOGY",
                null, "item_hash_v2", Instant.now(), 1
        );
        // If catalog were queried, it would return mutatedCatalogItem
        lenient().when(contentRepository.findItemsByGroupId(groupId)).thenReturn(List.of(mutatedCatalogItem));

        // Clear invocations from initial snapshot creation
        clearInvocations(contentRepository);

        // Compile attempt manifest
        PublicAttemptManifestDto manifest = manifestService.compileAttemptManifest(attempt);

        assertNotNull(manifest);
        assertEquals(attemptId, manifest.attemptId());
        assertEquals(1, manifest.sections().size());
        assertEquals(1, manifest.sections().get(0).parts().size());
        assertEquals(1, manifest.sections().get(0).parts().get(0).groups().size());
        assertEquals(1, manifest.sections().get(0).parts().get(0).groups().get(0).items().size());

        PublicItemDto itemDto = manifest.sections().get(0).parts().get(0).groups().get(0).items().get(0);
        assertEquals("Original snapshot question prompt: What is photosynthesis?", itemDto.prompt(),
                "Manifest MUST display the snapshot prompt, not the mutated catalog prompt!");

        // Invariant check: catalog was NEVER queried during manifest compilation
        verify(contentRepository, never()).findSectionsByFormId(formId);
    }

    @Test
    @DisplayName("Test 3: Historical review reads from snapshot and never mutable catalog")
    void testHistoricalReviewReadsFromSnapshotNotCatalog() {
        stubCatalogGraph();
        FormSnapshotResult snapshot = manifestService.serializeFormSnapshot(testForm);

        UUID attemptId = UUID.randomUUID();
        AttemptRecord submittedAttempt = new AttemptRecord(
                attemptId, userId, formId, ExamFamily.IELTS, "ACADEMIC", "FULL",
                ExamAttemptMode.EXAM_SIMULATION, null, null, ExamAttemptStatus.SUBMITTED,
                5L, 1L, "token", Instant.now().plus(1, ChronoUnit.HOURS),
                snapshot.hash(), Map.of(), null, Instant.now().minus(60, ChronoUnit.MINUTES),
                Instant.now().minus(50, ChronoUnit.MINUTES), Instant.now(), null, List.of(),
                Instant.now().minus(60, ChronoUnit.MINUTES), Instant.now(),
                snapshot.snapshot(), snapshot.version(), ExamSnapshotState.SNAPSHOTTED
        );

        when(attemptRepository.findAttemptById(attemptId)).thenReturn(Optional.of(submittedAttempt));
        when(attemptRepository.findResponsesByAttemptId(attemptId)).thenReturn(List.of(
                new ResponseRecord(UUID.randomUUID(), attemptId, sectionId, "p_P1_g_group_r1_i_1",
                        itemId, Map.of("value", "A"), null, null, false, 5L, "cmd-1", Instant.now())
        ));

        // Catalog has mutated items and different answer specs
        ItemVersionRecord mutatedCatalogItem = new ItemVersionRecord(
                itemId, groupId, "R1_Q01", 3, "MUTATED_PROMPT_IN_CATALOG",
                "MULTIPLE_CHOICE", Map.of(), "BIOLOGY", null, "hash-v3", Instant.now(), 1
        );
        lenient().when(contentRepository.findItemsByFormId(formId)).thenReturn(List.of(mutatedCatalogItem));

        // Clear invocations from initial snapshot creation
        clearInvocations(contentRepository);

        // Get attempt review
        AttemptReviewDto review = resultService.getAttemptReview(attemptId, userId, false);

        assertNotNull(review);
        assertEquals(1, review.items().size());
        assertEquals("Original snapshot question prompt: What is photosynthesis?", review.items().get(0).prompt(),
                "Review MUST read the prompt from the snapshot, not the mutated catalog!");
        // Exams Phase 9B: the learner sees the canonical correct values only ({values:[...]}), still from the snapshot spec
        assertEquals(Map.of("values", java.util.List.of("A")), review.items().get(0).acceptedAnswers(),
                "Review MUST read accepted answers from snapshot answerSpec!");

        // Invariant check: catalog was NEVER queried during attempt review
        verify(contentRepository, never()).findItemsByFormId(formId);
    }

    @Test
    @DisplayName("Test 4: Legacy attempt (null snapshot / LEGACY_UNSNAPSHOTTED) reads from catalog without crashing")
    void testLegacyAttemptReadsFromCatalogWithoutCrashing() {
        UUID legacyAttemptId = UUID.randomUUID();
        AttemptRecord legacyAttempt = new AttemptRecord(
                legacyAttemptId, userId, formId, ExamFamily.IELTS, "ACADEMIC", "FULL",
                ExamAttemptMode.EXAM_SIMULATION, null, null, ExamAttemptStatus.IN_PROGRESS,
                1L, 1L, "token", Instant.now().plus(1, ChronoUnit.HOURS),
                "legacy_hash", Map.of(), null, Instant.now().minus(10, ChronoUnit.MINUTES),
                Instant.now(), Instant.now(), null, List.of(), Instant.now(), Instant.now(),
                null, null, ExamSnapshotState.LEGACY_UNSNAPSHOTTED
        );

        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(testForm));
        stubCatalogGraph();

        AttemptSectionRecord asr = new AttemptSectionRecord(
                UUID.randomUUID(), legacyAttemptId, sectionId, ExamSectionState.ACTIVE,
                "EXECUTION", Instant.now(), Instant.now().plus(1, ChronoUnit.HOURS), null, Map.of(), Instant.now()
        );
        when(attemptRepository.findSectionsByAttemptId(legacyAttemptId)).thenReturn(List.of(asr));

        PublicAttemptManifestDto manifest = manifestService.compileAttemptManifest(legacyAttempt);

        assertNotNull(manifest);
        assertEquals(legacyAttemptId, manifest.attemptId());
        assertEquals(1, manifest.sections().size());
        assertEquals(originalItem.prompt(), manifest.sections().get(0).parts().get(0).groups().get(0).items().get(0).prompt());
    }

    @Test
    @DisplayName("Test 5: Create attempt fails closed if snapshot serialization is incomplete")
    void testCreateAttemptFailsClosedIfSnapshotIncomplete() {
        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(testForm));
        when(rightsService.verifyFormRights(formId)).thenReturn(true);
        // Empty sections in catalog causes snapshot serialization to fail closed
        when(contentRepository.findSectionsByFormId(formId)).thenReturn(List.of());

        CreateAttemptRequest req = new CreateAttemptRequest(
                formId, ExamAttemptMode.EXAM_SIMULATION, null, null, "cmd-create"
        );

        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                attemptService.createAttempt(userId, req)
        );

        assertTrue(ex.getMessage().contains("SCOPE_NOT_RUNNABLE") || ex.getMessage().contains("Cannot snapshot"),
                "Must fail closed when sections are missing");
        verify(attemptRepository, never()).insertAttempt(any());
    }
}
