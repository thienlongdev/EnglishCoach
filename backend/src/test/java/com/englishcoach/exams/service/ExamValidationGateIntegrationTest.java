package com.englishcoach.exams.service;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.exception.ExamExceptionHandler;
import com.englishcoach.exams.model.ExamAttemptRecords.AttemptRecord;
import com.englishcoach.exams.model.ExamAttemptRecords.CreateAttemptRequest;
import com.englishcoach.exams.model.ExamContentRecords.CatalogFormDto;
import com.englishcoach.exams.model.ExamContentRecords.FormVersionRecord;
import com.englishcoach.exams.model.ExamContentRecords.SectionRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.validation.ExamContentValidationService;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.time.Instant;
import java.util.*;

import static com.englishcoach.exams.validation.ExamContentFixtures.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * Exams Phase 2: catalog, attempt creation, publication and the learner error all consume the SAME authoritative
 * validation (replaces the Phase 0 ExamContentIntegrityService tests; containment guarantees preserved).
 */
class ExamValidationGateIntegrationTest {

    // ─── catalog ───────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("Catalog: runnable skills, full flag, modes and status come from the validation; no health string leaks")
    void catalogUsesValidation() {
        ExamContentValidationService validation = mock(ExamContentValidationService.class);
        UUID broken = UUID.randomUUID();
        UUID ok = UUID.randomUUID();
        UUID partial = UUID.randomUUID();
        when(validation.evaluate(broken)).thenReturn(validate(toeicLr(k -> {
            k.flattenPart3 = true;
            k.placeholderPrompts = true;
        })));
        when(validation.evaluate(ok)).thenReturn(validate(toeicLr(null)));
        when(validation.evaluate(partial)).thenReturn(validate(toeicLr(k -> k.listeningAudio = false)));
        ExamContentService content = new ExamContentService(mock(ExamContentRepository.class), new ExamsProperties(), validation);

        CatalogFormDto b = content.applyValidation(catalog(broken));
        assertEquals(List.of(), b.runnableSkills());
        assertFalse(b.fullExamRunnable());
        assertTrue(b.contentReviewRequired());
        assertEquals(List.of(), b.availableModes());
        assertEquals("INVALID", b.validationStatus());
        assertNull(b.primaryHealthStatus());

        CatalogFormDto o = content.applyValidation(catalog(ok));
        assertEquals(List.of("LISTENING", "READING"), o.runnableSkills());
        assertTrue(o.fullExamRunnable());
        assertFalse(o.contentReviewRequired());
        assertEquals(List.of("PRACTICE", "EXAM_SIMULATION"), o.availableModes());

        CatalogFormDto p = content.applyValidation(catalog(partial));
        assertEquals(List.of("READING"), p.runnableSkills(), "perfect Reading + broken Listening ⇒ Reading practice only");
        assertEquals(List.of("READING"), p.simulationSkills());
        assertFalse(p.fullExamRunnable());
        assertEquals(List.of("PRACTICE"), p.availableModes());
        assertEquals("NEEDS_REVIEW", p.validationStatus());
    }

    @Test
    @DisplayName("Catalog DTO default is fail-closed (nothing runnable before validation)")
    void catalogDefaultFailsClosed() {
        CatalogFormDto raw = new CatalogFormDto(UUID.randomUUID(), "K", 1, "T", ExamFamily.TOEIC, "LR", "FULL", null, 120, 200,
                List.of("LISTENING", "READING"), LifecycleState.PUBLISHED, null);
        assertEquals(List.of(), raw.runnableSkills());
        assertFalse(raw.fullExamRunnable());
        assertTrue(raw.contentReviewRequired());
        assertEquals("UNKNOWN", raw.validationStatus());
    }

    private static CatalogFormDto catalog(UUID id) {
        return new CatalogFormDto(id, "FORM_REAL_X", 1, "TOEIC LR", ExamFamily.TOEIC, "LR", "FULL", "Economy", 120, 200,
                List.of("LISTENING", "READING"), LifecycleState.PILOT, null);
    }

    // ─── attempt start gate ────────────────────────────────────────────────────────────────

    @Nested
    class StartGate {
        ExamAttemptRepository attempts;
        ExamContentRepository contentRepo;
        ExamRightsService rights;
        ExamManifestService manifest;
        ExamContentValidationService validation;
        ExamAttemptService service;
        final UUID formId = UUID.randomUUID();
        FormVersionRecord form;

        @BeforeEach
        void setUp() {
            attempts = mock(ExamAttemptRepository.class);
            contentRepo = mock(ExamContentRepository.class);
            rights = mock(ExamRightsService.class);
            manifest = mock(ExamManifestService.class);
            validation = mock(ExamContentValidationService.class);
            service = new ExamAttemptService(attempts, contentRepo, rights, mock(ExamTimingService.class), manifest,
                    null, null, validation);
            form = new FormVersionRecord(formId, "FORM_REAL_ECONOMY_TOEIC_VOL_1_TEST_01", 1, "Economy", ExamFamily.TOEIC, "LR", "FULL",
                    null, null, null, LifecycleState.PUBLISHED, null, null, "h", Instant.now(), null, Instant.now(), null);
            when(contentRepo.findFormById(formId)).thenReturn(Optional.of(form));
            when(rights.verifyFormRights(formId)).thenReturn(true);
            when(attempts.findActiveSimulationAttempt(any())).thenReturn(Optional.empty());
            when(contentRepo.findSectionsByFormId(formId)).thenReturn(List.of(
                    new SectionRecord(UUID.randomUUID(), formId, SkillType.LISTENING, 1, "L", null, 2700, Map.of(), true, null),
                    new SectionRecord(UUID.randomUUID(), formId, SkillType.READING, 2, "R", null, 4500, Map.of(), true, null)));
            UUID created = UUID.randomUUID();
            lenient().when(manifest.serializeFormSnapshot(form)).thenReturn(new ExamManifestService.FormSnapshotResult(Map.of(), "v4.0", "hash"));
            lenient().when(attempts.insertAttempt(any())).thenReturn(created);
            lenient().when(attempts.findAttemptById(created)).thenReturn(Optional.of(attempt(created)));
            lenient().when(attempts.findSectionsByAttemptId(created)).thenReturn(List.of());
            lenient().when(attempts.findResponsesByAttemptId(created)).thenReturn(List.of());
        }

        private CreateAttemptRequest sim(String id) {
            return new CreateAttemptRequest(formId, ExamAttemptMode.EXAM_SIMULATION, null, null, id, null);
        }

        @Test
        @DisplayName("13. Full simulation + invalid form ⇒ blocked server-side, nothing persisted (replay too)")
        void simulationBlocked() {
            when(validation.evaluate(formId)).thenReturn(validate(toeicLr(k -> k.flattenPart3 = true)));
            IllegalStateException ex = assertThrows(IllegalStateException.class, () -> service.createAttempt(1L, sim("m1")));
            assertTrue(ex.getMessage().startsWith(ExamContentValidationService.UNDER_REVIEW_CODE));
            assertThrows(IllegalStateException.class, () -> service.createAttempt(1L, sim("m1")), "same mutation replayed");
            verify(attempts, never()).insertAttempt(any());
            verify(manifest, never()).serializeFormSnapshot(any());
        }

        @Test
        @DisplayName("14. Full simulation + valid form ⇒ allowed")
        void simulationAllowed() {
            when(validation.evaluate(formId)).thenReturn(validate(toeicLr(null)));
            assertNotNull(service.createAttempt(1L, sim("m2")));
            verify(attempts).insertAttempt(any());
        }

        @Test
        @DisplayName("Mode-aware: broken Listening ⇒ Reading practice allowed, Listening practice and full simulation refused")
        void modeAware() {
            when(validation.evaluate(formId)).thenReturn(validate(toeicLr(k -> k.listeningAudio = false)));
            assertNotNull(service.createAttempt(1L,
                    new CreateAttemptRequest(formId, ExamAttemptMode.PRACTICE, null, null, "m3", List.of("READING"))));
            assertThrows(IllegalStateException.class, () -> service.createAttempt(1L,
                    new CreateAttemptRequest(formId, ExamAttemptMode.PRACTICE, null, null, "m4", List.of("LISTENING"))));
            assertThrows(IllegalStateException.class, () -> service.createAttempt(1L, sim("m5")));
            verify(attempts, times(1)).insertAttempt(any());
        }

        @Test
        @DisplayName("Practice-only skill: practice allowed, skill-scoped simulation refused")
        void practiceOnlySkill() {
            when(validation.evaluate(formId)).thenReturn(validate(toeicLr(k -> k.part4Audio = false)));
            assertNotNull(service.createAttempt(1L,
                    new CreateAttemptRequest(formId, ExamAttemptMode.PRACTICE, null, null, "m6", List.of("LISTENING"))));
            assertThrows(IllegalStateException.class, () -> service.createAttempt(1L,
                    new CreateAttemptRequest(formId, ExamAttemptMode.EXAM_SIMULATION, null, null, "m7", List.of("LISTENING"))));
        }

        @Test
        @DisplayName("11. Unknown validation (service error or legacy constructor) ⇒ every mode refused")
        void unknownRefused() {
            when(validation.evaluate(formId)).thenReturn(ExamFormValidationReport.unknown(formId, "VALIDATION_ERROR", NOW));
            assertThrows(IllegalStateException.class, () -> service.createAttempt(1L,
                    new CreateAttemptRequest(formId, ExamAttemptMode.PRACTICE, null, null, "m8", List.of("READING"))));
            ExamAttemptService legacy = new ExamAttemptService(attempts, contentRepo, rights, mock(ExamTimingService.class), manifest);
            assertThrows(IllegalStateException.class, () -> legacy.createAttempt(1L, sim("m9")));
            verify(attempts, never()).insertAttempt(any());
        }

        private AttemptRecord attempt(UUID id) {
            return new AttemptRecord(id, 1L, formId, ExamFamily.TOEIC, "LR", "FULL", ExamAttemptMode.PRACTICE, null, null,
                    ExamAttemptStatus.CREATED, 1L, 1L, null, null, "hash", Map.of(), null, null, null, null, null,
                    List.of(), Instant.now(), Instant.now());
        }
    }

    // ─── publication gate ──────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("Publication re-validates: only a full-simulation-eligible form may become PUBLISHED; unknown refuses")
    void publicationGate() {
        ExamContentRepository repo = mock(ExamContentRepository.class);
        ExamRightsService rights = mock(ExamRightsService.class);
        ExamContentValidationService validation = mock(ExamContentValidationService.class);
        UUID formId = UUID.randomUUID();
        FormVersionRecord legalQa = new FormVersionRecord(formId, "K", 1, "T", ExamFamily.TOEIC, "LR", "FULL", null, null, null,
                LifecycleState.LEGAL_QA, null, null, "h", null, null, Instant.now(), null);
        when(repo.findFormById(formId)).thenReturn(Optional.of(legalQa));
        // Exams Phase 9A: publication needs a known closure + the exact-hash review gates (no unknown-closure skip)
        when(repo.findCurrentClosureHash(formId)).thenReturn(Optional.of("h"));
        when(repo.findReviewSummary(formId)).thenReturn(Optional.of(new com.englishcoach.exams.content.ExamContentPackage.ReviewSummary(List.of(
                new com.englishcoach.exams.content.ExamContentPackage.ReviewGateApproval("CONTENT_QA", 90L, "APPROVED", "h", Instant.now()),
                new com.englishcoach.exams.content.ExamContentPackage.ReviewGateApproval("ANSWER_QA", 90L, "APPROVED", "h", Instant.now()),
                new com.englishcoach.exams.content.ExamContentPackage.ReviewGateApproval("LEGAL_QA", 91L, "APPROVED", "h", Instant.now())), 2)));
        when(rights.verifyFormRights(formId, com.englishcoach.exams.content.ExamRightsDecisionPolicy.Operation.PUBLICATION)).thenReturn(true);
        ExamPublicationService publication = new ExamPublicationService(repo, rights, null, validation);

        when(validation.revalidate(eq(formId), any())).thenReturn(validate(toeicLr(k -> k.part6Passages = false)));
        IllegalStateException ex = assertThrows(IllegalStateException.class, () -> publication.publishForm(formId, null, "x"));
        assertTrue(ex.getMessage().startsWith("PUBLICATION_CONTENT_VALIDATION_FAILED"));
        assertTrue(ex.getMessage().contains("TOEIC_PART_6_PASSAGE_MISSING"));
        verify(repo, never()).updateFormLifecycle(any(), any(), any(), any());

        when(validation.revalidate(eq(formId), any())).thenReturn(validate(toeicLr(null)));
        publication.publishForm(formId, null, "x");
        verify(repo).updateFormLifecycle(eq(formId), eq(LifecycleState.PUBLISHED), any(), any());

        ExamPublicationService legacy = new ExamPublicationService(repo, rights);
        assertThrows(IllegalStateException.class, () -> legacy.publishForm(formId, null, "x"), "no validation ⇒ no publication");
    }

    // ─── learner-facing error ──────────────────────────────────────────────────────────────

    @Test
    @DisplayName("Rejection maps to 409 FORM_CONTENT_UNDER_REVIEW with the Vietnamese text and no internal diagnostics")
    void errorMapping() {
        var response = new ExamExceptionHandler().handleIllegalState(new IllegalStateException(
                ExamContentValidationService.UNDER_REVIEW_CODE + ": " + ExamContentValidationService.UNDER_REVIEW_MESSAGE_VI));
        assertEquals(HttpStatus.CONFLICT, response.getStatusCode());
        assertEquals("FORM_CONTENT_UNDER_REVIEW", response.getBody().code());
        assertEquals("Đề này đang được kiểm tra lại nội dung và tạm thời chưa thể làm ở chế độ thi mô phỏng.",
                response.getBody().message());
        var other = new ExamExceptionHandler().handleIllegalState(new IllegalStateException("SCOPE_NOT_RUNNABLE: x"));
        assertEquals("SCOPE_NOT_RUNNABLE", other.getBody().code(), "existing codes unchanged");
    }
}
