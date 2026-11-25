package com.englishcoach.exams;

import com.englishcoach.exams.model.ExamContentRecords.FormVersionRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.security.ExamPermissionService;
import com.englishcoach.exams.service.ExamPublicationService;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.content.ExamContentPackage.PackageImportRecord;
import com.englishcoach.exams.content.ExamBankOriginalPractice;
import com.englishcoach.exams.content.ToeicPracticePublication;
import com.englishcoach.exams.practice.ExamPracticeReadiness.ScopeReadiness;
import com.englishcoach.exams.practice.ExamPracticeScope;
import com.englishcoach.exams.validation.ExamContentValidationService;
import com.englishcoach.exams.validation.ExamContentValidationStatus;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Exact-hash gate and two-person publication regression coverage. */
@ExtendWith(MockitoExtension.class)
class ExamPublicationGateTest {

    private static final String HASH = "e".repeat(64);

    @Mock
    private ExamContentRepository repository;

    @Mock
    private ExamRightsService rightsService;

    @Mock
    private ExamPermissionService permissionService;

    @Test
    void refusesPublicationWithOnlyOneApprovedReviewer() {
        UUID formId = UUID.randomUUID();
        when(repository.findFormById(formId)).thenReturn(Optional.of(form(formId)));
        when(repository.findCurrentClosureHash(formId)).thenReturn(Optional.of(HASH));
        when(repository.findReviewSummary(formId)).thenReturn(Optional.of(new ExamContentPackageReviewSummaryBuilder()
                .approval(ReviewGate.CONTENT_QA, 20L)
                .approval(ReviewGate.ANSWER_QA, 20L)
                .approval(ReviewGate.LEGAL_QA, 20L)
                .build()));

        assertThrows(IllegalStateException.class,
                () -> new ExamPublicationService(repository, rightsService)
                        .publishForm(formId, 20L, "publish"));
        verify(rightsService, never()).verifyFormRights(any(), any());
    }

    @Test
    void publishesOnlyAfterThreeCurrentHashGatesAndTwoReviewers() {
        UUID formId = UUID.randomUUID();
        when(repository.findFormById(formId)).thenReturn(Optional.of(form(formId)));
        when(repository.findCurrentClosureHash(formId)).thenReturn(Optional.of(HASH));
        when(repository.findReviewSummary(formId)).thenReturn(Optional.of(new ExamContentPackageReviewSummaryBuilder()
                .approval(ReviewGate.CONTENT_QA, 20L)
                .approval(ReviewGate.ANSWER_QA, 20L)
                .approval(ReviewGate.LEGAL_QA, 21L)
                .build()));
        when(permissionService.hasOperatorPermission(77L, "EXAMS_PUBLISH")).thenReturn(true);
        when(rightsService.verifyFormRights(formId, com.englishcoach.exams.content.ExamRightsDecisionPolicy.Operation.PUBLICATION)).thenReturn(true);

        // Exams Phase 2: publication re-validates content; these tests cover the review/rights gates.
        com.englishcoach.exams.validation.ExamContentValidationService validation = mock(com.englishcoach.exams.validation.ExamContentValidationService.class);
        lenient().when(validation.revalidate(any(), any())).thenAnswer(inv ->
                com.englishcoach.exams.validation.ExamContentFixtures.validReport(inv.getArgument(0)));
        assertDoesNotThrow(() -> new ExamPublicationService(repository, rightsService, permissionService, validation)
                .publishForm(formId, 77L, "publish"));
        verify(repository).updateFormLifecycle(eq(formId), eq(LifecycleState.PUBLISHED), any(), isNull());
        verify(permissionService).hasOperatorPermission(77L, "EXAMS_PUBLISH");
    }

    private FormVersionRecord form(UUID formId) {
        return new FormVersionRecord(formId, "publication-gate", 1, "Publication gate", ExamFamily.IELTS,
                "ACADEMIC", "FULL", UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                LifecycleState.LEGAL_QA, UUID.randomUUID(), 10L, HASH, null, null, Instant.now());
    }

    @Test
    void ownerDecisionRequiresExactEditionAndRetainsPracticeOnlyAfterPublication() {
        var id = UUID.fromString("b81991f9-1397-5e9f-95bd-f0a10d4870bf");
        var decision = ToeicPracticePublication.forForm(id);
        var form = new FormVersionRecord(id, "BANK_TOEIC_ORIGINAL_LR_001_RP", 1, "Reading Practice",
                ExamFamily.TOEIC, "STANDARD_FIXED_FORM", "READING", UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID(),
                LifecycleState.PILOT, UUID.randomUUID(), 1L, decision.formHash(), null, null, Instant.now());
        when(repository.findFormById(id)).thenReturn(Optional.of(form));
        var receipt = new PackageImportRecord(UUID.randomUUID(), decision.packageId(), 1, "1.0",
                decision.packageHash(), id, "IMPORTED", 1L, "English Coach", Instant.now(), Instant.now());
        when(repository.findPackageImport(decision.packageId(), 1, true)).thenReturn(Optional.of(receipt));
        when(permissionService.hasOperatorPermission(1L, "EXAMS_PUBLISH")).thenReturn(true);
        when(rightsService.verifyFormRights(eq(id), any())).thenReturn(true);
        var validation = mock(ExamContentValidationService.class);
        var report = mock(ExamFormValidationReport.class);
        when(validation.revalidate(eq(id), any())).thenReturn(report);
        when(report.status()).thenReturn(ExamContentValidationStatus.VALID);
        when(report.contentFingerprint()).thenReturn("different", decision.fingerprint());
        var service = new ExamPublicationService(repository, rightsService, permissionService, validation);
        assertThrows(IllegalStateException.class, () -> service.publishForm(id, 1L, "test"));
        var scopes = List.of(ready(5, 30), ready(6, 16), ready(7, 54));
        when(validation.practiceScopes(eq(id), any())).thenReturn(scopes);
        service.publishForm(id, 1L, "test");
        verify(repository).updateFormLifecycle(eq(id), eq(LifecycleState.PUBLISHED), any(), isNull());
        verify(repository, never()).insertContentReview(any(), any(), any(), any(), any(), any());
        org.junit.jupiter.api.Assertions.assertTrue(ExamBankOriginalPractice.practiceOnly(id, LifecycleState.PUBLISHED));
        org.junit.jupiter.api.Assertions.assertFalse(ExamBankOriginalPractice.practiceOnly(UUID.randomUUID(), LifecycleState.PUBLISHED));
    }

    private ScopeReadiness ready(int number, int count) {
        var scope = mock(ExamPracticeScope.class);
        when(scope.family()).thenReturn(ExamFamily.TOEIC);
        when(scope.objectiveScoring()).thenReturn(true);
        when(scope.scopeCode()).thenReturn("TOEIC_PART_" + number);
        when(scope.itemCount()).thenReturn(count);
        when(scope.objectiveItemCount()).thenReturn(count);
        return new ScopeReadiness(scope, true, List.of(), null, 0, 0);
    }

    /** Keeps the test readable while using the production ReviewSummary record. */
    private static final class ExamContentPackageReviewSummaryBuilder {
        private final java.util.ArrayList<com.englishcoach.exams.content.ExamContentPackage.ReviewGateApproval> approvals = new java.util.ArrayList<>();

        ExamContentPackageReviewSummaryBuilder approval(ReviewGate gate, Long reviewer) {
            approvals.add(new com.englishcoach.exams.content.ExamContentPackage.ReviewGateApproval(
                    gate.name(), reviewer, "APPROVED", HASH, Instant.now()));
            return this;
        }

        com.englishcoach.exams.content.ExamContentPackage.ReviewSummary build() {
            return new com.englishcoach.exams.content.ExamContentPackage.ReviewSummary(approvals,
                    (int) approvals.stream().map(com.englishcoach.exams.content.ExamContentPackage.ReviewGateApproval::reviewerUserId)
                            .distinct().count());
        }
    }
}
