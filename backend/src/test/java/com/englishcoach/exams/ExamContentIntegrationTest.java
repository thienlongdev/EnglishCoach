package com.englishcoach.exams;

import com.englishcoach.exams.model.ExamContentRecords.FormVersionRecord;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.LifecycleState;
import com.englishcoach.exams.model.ExamTypes.ReviewDecision;
import com.englishcoach.exams.model.ExamTypes.ReviewGate;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.service.ExamPublicationService;
import com.englishcoach.exams.service.ExamRightsService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * STEP-099: ExamContentIntegrationTest
 * Tests content authoring, review gates, author separation, and publication rights.
 */
@ExtendWith(MockitoExtension.class)
public class ExamContentIntegrationTest {

    @Mock
    private ExamContentRepository contentRepository;

    @Mock
    private ExamRightsService rightsService;

    private ExamPublicationService publicationService;

    @BeforeEach
    void setUp() {
        // Exams Phase 2: publication re-validates content; these tests cover the review/rights gates.
        com.englishcoach.exams.validation.ExamContentValidationService validation = mock(com.englishcoach.exams.validation.ExamContentValidationService.class);
        lenient().when(validation.revalidate(any(), any())).thenAnswer(inv ->
                com.englishcoach.exams.validation.ExamContentFixtures.validReport(inv.getArgument(0)));
        publicationService = new ExamPublicationService(contentRepository, rightsService, null, validation);
    }

    private FormVersionRecord createTestForm(UUID formId, Long authorId, LifecycleState state) {
        return new FormVersionRecord(
                formId,
                "ielts_academic_mock_1",
                1,
                "IELTS Academic Practice Test 1",
                ExamFamily.IELTS,
                "ACADEMIC",
                "FULL",
                UUID.randomUUID(),
                UUID.randomUUID(),
                UUID.randomUUID(),
                state,
                UUID.randomUUID(),
                authorId,
                "closure_hash_v1",
                null,
                null,
                Instant.now()
        );
    }

    @Test
    @DisplayName("Content Gate: Author cannot review their own form")
    void testAuthorCannotReviewOwnForm() {
        UUID formId = UUID.randomUUID();
        Long authorId = 42L;
        FormVersionRecord form = createTestForm(formId, authorId, LifecycleState.DRAFT);

        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(form));

        // Author attempting to review their own form must be rejected
        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                publicationService.submitReview(formId, ReviewGate.CONTENT_QA, authorId, ReviewDecision.APPROVED, "hash", "notes")
        );
        assertTrue(ex.getMessage().contains("AUTHOR_SELF_REVIEW_FORBIDDEN"));
    }

    @Test
    @DisplayName("Content Gate: Independent reviewer can approve form and advance lifecycle")
    void testIndependentReviewerCanApproveForm() {
        UUID formId = UUID.randomUUID();
        Long authorId = 42L;
        Long reviewerId = 99L; // Different user
        FormVersionRecord form = createTestForm(formId, authorId, LifecycleState.DRAFT);

        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(form));
        // Exams Phase 9A: a review is recorded only against the form's current, known content closure
        when(contentRepository.findCurrentClosureHash(formId)).thenReturn(Optional.of("hash"));

        assertDoesNotThrow(() ->
                publicationService.submitReview(formId, ReviewGate.CONTENT_QA, reviewerId, ReviewDecision.APPROVED, "hash", "all good")
        );

        verify(contentRepository).insertContentReview(eq(formId), eq(ReviewGate.CONTENT_QA), eq(reviewerId), eq(ReviewDecision.APPROVED), eq("hash"), eq("all good"));
        verify(contentRepository).updateFormLifecycle(eq(formId), eq(LifecycleState.CONTENT_QA), isNull(), isNull());
    }

    @Test
    @DisplayName("Exams Phase 9A: unknown content closure — no review decision is recorded and publication is refused")
    void testUnknownClosureFailsClosed() {
        UUID formId = UUID.randomUUID();
        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(createTestForm(formId, 42L, LifecycleState.LEGAL_QA)));
        when(contentRepository.findCurrentClosureHash(formId)).thenReturn(Optional.empty());
        IllegalStateException review = assertThrows(IllegalStateException.class, () ->
                publicationService.submitReview(formId, ReviewGate.LEGAL_QA, 99L, ReviewDecision.APPROVED, "any_hash", "x"));
        assertTrue(review.getMessage().startsWith("REVIEW_CLOSURE_UNAVAILABLE"));
        IllegalStateException publish = assertThrows(IllegalStateException.class, () -> publicationService.publishForm(formId));
        assertTrue(publish.getMessage().startsWith("PUBLICATION_REVIEW_GATES_INCOMPLETE"));
        verify(contentRepository, never()).insertContentReview(any(), any(), any(), any(), any(), any());
        verify(contentRepository, never()).updateFormLifecycle(any(), any(), any(), any());
        verify(rightsService, never()).verifyFormRights(any(), any());
    }

    @Test
    @DisplayName("Rights Enforcement: Cannot publish form with unverified or benchmark-only rights")
    void testCannotPublishWithoutValidRights() {
        UUID formId = UUID.randomUUID();
        FormVersionRecord form = createTestForm(formId, 42L, LifecycleState.LEGAL_QA);

        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(form));
        // Exams Phase 9A: the exact-hash review gates must be provable (no unknown-closure skip) — rights checked next
        when(contentRepository.findCurrentClosureHash(formId)).thenReturn(Optional.of("closure_hash_v1"));
        when(contentRepository.findReviewSummary(formId)).thenReturn(Optional.of(new com.englishcoach.exams.content.ExamContentPackage.ReviewSummary(java.util.List.of(
                new com.englishcoach.exams.content.ExamContentPackage.ReviewGateApproval("CONTENT_QA", 90L, "APPROVED", "closure_hash_v1", Instant.now()),
                new com.englishcoach.exams.content.ExamContentPackage.ReviewGateApproval("ANSWER_QA", 90L, "APPROVED", "closure_hash_v1", Instant.now()),
                new com.englishcoach.exams.content.ExamContentPackage.ReviewGateApproval("LEGAL_QA", 91L, "APPROVED", "closure_hash_v1", Instant.now())), 2)));
        when(rightsService.verifyFormRights(formId, com.englishcoach.exams.content.ExamRightsDecisionPolicy.Operation.PUBLICATION)).thenReturn(false);

        IllegalStateException ex = assertThrows(IllegalStateException.class, () ->
                publicationService.publishForm(formId)
        );
        assertTrue(ex.getMessage().contains("RIGHTS_VERIFICATION_FAILED"));
    }

    @Test
    @DisplayName("Publication Lifecycle: Approved form with valid rights publishes successfully")
    void testPublishApprovedForm() {
        UUID formId = UUID.randomUUID();
        FormVersionRecord form = createTestForm(formId, 42L, LifecycleState.LEGAL_QA);

        when(contentRepository.findFormById(formId)).thenReturn(Optional.of(form));
        when(contentRepository.findCurrentClosureHash(formId)).thenReturn(Optional.of("closure_hash_v1"));
        when(contentRepository.findReviewSummary(formId)).thenReturn(Optional.of(new com.englishcoach.exams.content.ExamContentPackage.ReviewSummary(java.util.List.of(
                new com.englishcoach.exams.content.ExamContentPackage.ReviewGateApproval("CONTENT_QA", 90L, "APPROVED", "closure_hash_v1", Instant.now()),
                new com.englishcoach.exams.content.ExamContentPackage.ReviewGateApproval("ANSWER_QA", 90L, "APPROVED", "closure_hash_v1", Instant.now()),
                new com.englishcoach.exams.content.ExamContentPackage.ReviewGateApproval("LEGAL_QA", 91L, "APPROVED", "closure_hash_v1", Instant.now())), 2)));
        when(rightsService.verifyFormRights(formId, com.englishcoach.exams.content.ExamRightsDecisionPolicy.Operation.PUBLICATION)).thenReturn(true);

        assertDoesNotThrow(() -> publicationService.publishForm(formId));
        verify(contentRepository).updateFormLifecycle(eq(formId), eq(LifecycleState.PUBLISHED), any(), isNull());
    }
}
