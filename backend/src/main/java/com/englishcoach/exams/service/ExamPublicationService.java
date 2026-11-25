package com.englishcoach.exams.service;

import com.englishcoach.exams.model.ExamContentRecords.FormVersionRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.security.ExamPermissionService;
import com.englishcoach.exams.validation.ExamContentValidationService;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import java.util.Set;
import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamOwnerProductionAuthorization;
import com.englishcoach.exams.content.ToeicPracticePublication;
import com.englishcoach.exams.practice.ExamPracticeReadiness.FormFacts;
import com.englishcoach.exams.validation.ExamContentValidationStatus;

import static com.englishcoach.exams.content.ExamContentPackage.ReviewSummary;

/**
 * Content lifecycle and human-gate adapter. Import remains DRAFT-only;
 * publication is a separate transaction that verifies the exact closure hash,
 * complete rights closure, gate order, and independent human reviewers.
 */
@Slf4j
@Service
public class ExamPublicationService {

    private final ExamContentRepository contentRepository;
    private final ExamRightsService rightsService;
    private final ExamPermissionService permissionService;
    /** Exams Phase 2 publication gate; null only in legacy constructors ⇒ publication is refused (fail closed). */
    private final ExamContentValidationService validationService;
    @Autowired
    private com.englishcoach.exams.content.ToeicPackagePublication toeicPackages;

    /** Trusted corpus release service only; no request body can set qualified scopes or grant QA. */
    @Transactional
    public void activateQualifiedPractice(ExamContentPackage pkg, Set<String> qualifiedScopes, Long actorId,
                                         com.englishcoach.exams.practice.ExamPracticeService practice) {
        if (actorId == null || actorId <= 0 || permissionService != null
                && !permissionService.hasOperatorPermission(actorId, "EXAMS_PUBLISH"))
            throw new IllegalStateException("CONTENT_PUBLISH_PERMISSION_REQUIRED");
        if (!ExamOwnerProductionAuthorization.covers(pkg) || qualifiedScopes == null || qualifiedScopes.isEmpty())
            throw new IllegalStateException("CORPUS_PRACTICE_QUALIFICATION_REQUIRED");
        var imported = contentRepository.findPackageImport(pkg.manifest().packageId(), pkg.manifest().packageVersion(), true).orElseThrow();
        if (!"IMPORTED".equals(imported.status()) || !pkg.manifest().contentHash().equals(imported.contentHash())
                || !pkg.form().id().equals(imported.formId())) throw new IllegalStateException("CORPUS_PRACTICE_IMPORT_MISMATCH");
        var form = contentRepository.findFormById(imported.formId()).orElseThrow();
        if (form.lifecycleState() != LifecycleState.DRAFT && form.lifecycleState() != LifecycleState.PILOT)
            throw new IllegalStateException("CORPUS_PRACTICE_LIFECYCLE_INVALID");
        if (!rightsService.verifyFormRights(form.id(), com.englishcoach.exams.content.ExamRightsDecisionPolicy.Operation.PUBLICATION))
            throw new IllegalStateException("RIGHTS_VERIFICATION_FAILED");
        contentRepository.updateFormLifecycle(form.id(), LifecycleState.PILOT, null, null);
        validationService.invalidate(form.id());
        var scopes = practice.evaluateForm(form.id()).scopes();
        Set<String> actual = new java.util.TreeSet<>();
        for (var scope : scopes) {
            if (!scope.ready()) throw new IllegalStateException("CORPUS_PRACTICE_RUNTIME_NOT_READY");
            actual.add(scope.scope().scopeCode());
        }
        if (!actual.equals(qualifiedScopes)) throw new IllegalStateException("CORPUS_PRACTICE_SCOPE_MISMATCH");
        if (form.lifecycleState() != LifecycleState.PILOT) contentRepository.insertAuditEvent(actorId,
                "CORPUS_QUALIFIED_PRACTICE_ACTIVATED", "FORM_VERSION", form.id().toString(), null, pkg.manifest().contentHash(),
                "Owner-authorized production Practice; exact qualified scopes " + actual + "; no full simulation or human approval granted", null);
    }

    public ExamPublicationService(ExamContentRepository contentRepository, ExamRightsService rightsService) {
        this(contentRepository, rightsService, null, null);
    }

    public ExamPublicationService(ExamContentRepository contentRepository,
                                  ExamRightsService rightsService,
                                  ExamPermissionService permissionService) {
        this(contentRepository, rightsService, permissionService, null);
    }

    @Autowired
    public ExamPublicationService(ExamContentRepository contentRepository,
                                  ExamRightsService rightsService,
                                  ExamPermissionService permissionService,
                                  ExamContentValidationService validationService) {
        this.contentRepository = contentRepository;
        this.rightsService = rightsService;
        this.permissionService = permissionService;
        this.validationService = validationService;
    }

    @Transactional
    public void submitReview(UUID formId, ReviewGate gate, Long reviewerUserId, ReviewDecision decision,
                             String reviewedClosureHash, String notes) {
        Optional<FormVersionRecord> formOpt = contentRepository.findFormById(formId);
        if (formOpt.isEmpty()) throw new IllegalArgumentException("Form not found: " + formId);
        FormVersionRecord form = formOpt.get();

        if (reviewerUserId == null || reviewerUserId <= 0) {
            throw new IllegalArgumentException("HUMAN_REVIEWER_REQUIRED: A real authenticated reviewer is required");
        }
        if (form.authorId() != null && form.authorId().equals(reviewerUserId)) {
            throw new IllegalStateException("AUTHOR_SELF_REVIEW_FORBIDDEN: Author cannot review their own form");
        }
        if (gate == null || decision == null) throw new IllegalArgumentException("Review gate and decision are required");
        if (permissionService != null && !permissionService.hasOperatorPermission(reviewerUserId, reviewerPermission(gate))) {
            throw new IllegalStateException("CONTENT_REVIEW_PERMISSION_REQUIRED: Reviewer lacks the required gate permission");
        }
        if (reviewedClosureHash == null || reviewedClosureHash.isBlank()) {
            throw new IllegalArgumentException("REVIEW_CLOSURE_HASH_REQUIRED: Review must identify the exact dependency closure");
        }

        // Exams Phase 9A: a review decision is recorded ONLY against the form's current, known content closure — an
        // unknown closure refuses the decision (fail closed; no "best effort" review).
        Optional<String> currentHash = contentRepository.findCurrentClosureHash(formId);
        if (currentHash.isEmpty() || currentHash.get().isBlank()) {
            throw new IllegalStateException("REVIEW_CLOSURE_UNAVAILABLE: The form's current content closure is unknown");
        }
        if (!reviewedClosureHash.equalsIgnoreCase(currentHash.get())) {
            throw new IllegalStateException("STALE_REVIEW_HASH: Review was produced for a different content closure");
        }
        if (decision == ReviewDecision.APPROVED && !isGateOrderAllowed(form.lifecycleState(), gate)) {
            throw new IllegalStateException("REVIEW_GATE_ORDER_INVALID: Required prior gate has not been approved");
        }

        contentRepository.insertContentReview(formId, gate, reviewerUserId, decision, reviewedClosureHash, notes);
        if (decision == ReviewDecision.APPROVED) {
            LifecycleState nextState = nextState(gate);
            contentRepository.updateFormLifecycle(formId, nextState, null, null);
            contentRepository.insertAuditEvent(reviewerUserId, "CONTENT_REVIEW_APPROVED", "FORM_VERSION",
                    formId.toString(), form.contentHash(), reviewedClosureHash,
                    notes == null ? "Approved " + gate.name() : notes, null);
        } else {
            contentRepository.updateFormLifecycle(formId, LifecycleState.DRAFT, null, null);
            contentRepository.insertAuditEvent(reviewerUserId, "CONTENT_REVIEW_REJECTED", "FORM_VERSION",
                    formId.toString(), form.contentHash(), reviewedClosureHash,
                    notes == null ? "Rejected " + gate.name() : notes, null);
        }
    }

    @Transactional
    public void publishForm(UUID formId) {
        publishForm(formId, null, "Publication gate approved");
    }

    @Transactional
    public void publishForm(UUID formId, Long actorId, String reason) {
        if (toeicPackages != null && toeicPackages.publishIfCovered(formId, actorId)) return;
        Optional<FormVersionRecord> formOpt = contentRepository.findFormById(formId);
        if (formOpt.isEmpty()) throw new IllegalArgumentException("Form not found: " + formId);
        FormVersionRecord form = formOpt.get();

        if (permissionService != null && actorId != null
                && !permissionService.hasOperatorPermission(actorId, "EXAMS_PUBLISH")) {
            throw new IllegalStateException("CONTENT_PUBLISH_PERMISSION_REQUIRED: Publisher lacks EXAMS_PUBLISH permission");
        }

        var ownerDecision = ToeicPracticePublication.forForm(formId);
        if (ownerDecision != null) {
            publishOwnerReadingPractice(formId, actorId, ownerDecision);
            return;
        }
        if (form.lifecycleState() != LifecycleState.LEGAL_QA && form.lifecycleState() != LifecycleState.CALIBRATED) {
            throw new IllegalStateException("PUBLICATION_STATE_INVALID: Form must complete legal QA before publication");
        }
        Optional<String> currentHash = contentRepository.findCurrentClosureHash(formId);
        Optional<ReviewSummary> summary = contentRepository.findReviewSummary(formId);
        // Exams Phase 9A: no known content closure ⇒ the exact-hash review gates cannot be proven ⇒ refused (was skipped)
        if (currentHash.isEmpty() || currentHash.get().isBlank()) {
            throw new IllegalStateException("PUBLICATION_REVIEW_GATES_INCOMPLETE: The form's content closure is unknown");
        }
        {
            String closureHash = currentHash.get();
            if (summary.isEmpty()
                    || !summary.get().hasApprovedGate(ReviewGate.CONTENT_QA.name(), closureHash)
                    || !summary.get().hasApprovedGate(ReviewGate.ANSWER_QA.name(), closureHash)
                    || !summary.get().hasApprovedGate(ReviewGate.LEGAL_QA.name(), closureHash)
                    || summary.get().distinctApprovedReviewers() < 2) {
                throw new IllegalStateException("PUBLICATION_REVIEW_GATES_INCOMPLETE: Three exact-hash gates and two independent human reviewers are required");
            }
        }
        // Production rights accept the pinned owner production basis; independent QA gates remain required.
        if (!rightsService.verifyFormRights(formId, com.englishcoach.exams.content.ExamRightsDecisionPolicy.Operation.PUBLICATION)) {
            throw new IllegalStateException("RIGHTS_VERIFICATION_FAILED: Content rights incomplete or invalid");
        }
        // Exams Phase 2: publication re-runs the authoritative validation (explicit trigger) and only a form that is
        // full-simulation eligible may become PUBLISHED. Unknown validation refuses publication.
        ExamFormValidationReport validation = validationService != null
                ? validationService.revalidate(formId, ExamContentValidationService.Trigger.PUBLICATION)
                : ExamFormValidationReport.unknown(formId, "VALIDATION_SERVICE_UNAVAILABLE", Instant.now());
        if (!validation.fullSimulationEligible()) {
            throw new IllegalStateException("PUBLICATION_CONTENT_VALIDATION_FAILED: status=" + validation.status()
                    + " codes=" + validation.blockingCodes());
        }

        contentRepository.updateFormLifecycle(formId, LifecycleState.PUBLISHED, Instant.now(), null);
        contentRepository.insertAuditEvent(actorId, "CONTENT_FORM_PUBLISHED", "FORM_VERSION",
                formId.toString(), form.contentHash(), form.contentHash(), reason, null);
        log.info("Form {} published successfully as version {}", form.logicalKey(), form.version());
    }

    private void publishOwnerReadingPractice(UUID id, Long actor, ToeicPracticePublication decision) {
        if (actor == null || actor <= 0 || permissionService == null || validationService == null)
            throw new IllegalStateException("CONTENT_PUBLISH_PERMISSION_REQUIRED");
        contentRepository.lockPackageIdentity(decision.packageId(), 1);
        var receipt = contentRepository.findPackageImport(decision.packageId(), 1, true).orElseThrow();
        var form = contentRepository.findFormById(id).orElseThrow();
        if (form.family() != ExamFamily.TOEIC || !"READING".equals(form.scope()) || form.version() != 1
                || !decision.formHash().equals(form.contentHash()) || !id.equals(receipt.formId())
                || !"IMPORTED".equals(receipt.status()) || !decision.packageHash().equals(receipt.contentHash())
                || (form.lifecycleState() != LifecycleState.PILOT && form.lifecycleState() != LifecycleState.PUBLISHED))
            throw new IllegalStateException("TOEIC_PUBLICATION_EDITION_MISMATCH");
        if (!rightsService.verifyFormRights(id, com.englishcoach.exams.content.ExamRightsDecisionPolicy.Operation.PUBLICATION))
            throw new IllegalStateException("RIGHTS_VERIFICATION_FAILED");
        var report = validationService.revalidate(id, ExamContentValidationService.Trigger.PUBLICATION);
        if (report.status() != ExamContentValidationStatus.VALID || !decision.fingerprint().equals(report.contentFingerprint())
                || !decision.matchesScopes(validationService.practiceScopes(id, new FormFacts(true, true))))
            throw new IllegalStateException("TOEIC_PUBLICATION_CONTENT_MISMATCH");
        if (form.lifecycleState() == LifecycleState.PUBLISHED) return;
        contentRepository.updateFormLifecycle(id, LifecycleState.PUBLISHED, Instant.now(), null);
        contentRepository.insertAuditEvent(actor, "TOEIC_OWNER_PRACTICE_PUBLISHED", "FORM_VERSION", id.toString(),
                form.contentHash(), decision.packageHash(), "Owner-authorized Reading Practice, 2026-11-17. "
                        + "Exact machine-reviewed edition, Parts 5–7. No human review recorded.", null);
    }

    @Transactional
    public void retireForm(UUID formId) {
        retireForm(formId, null, "Retired by content operations");
    }

    @Transactional
    public void retireForm(UUID formId, Long actorId, String reason) {
        Optional<FormVersionRecord> formOpt = contentRepository.findFormById(formId);
        if (formOpt.isEmpty()) throw new IllegalArgumentException("Form not found: " + formId);
        FormVersionRecord form = formOpt.get();
        if (permissionService != null && actorId != null
                && !permissionService.hasOperatorPermission(actorId, "EXAMS_PUBLISH")) {
            throw new IllegalStateException("CONTENT_PUBLISH_PERMISSION_REQUIRED: Publisher lacks EXAMS_PUBLISH permission");
        }
        contentRepository.updateFormLifecycle(formId, LifecycleState.RETIRED, null, Instant.now());
        contentRepository.insertAuditEvent(actorId, "CONTENT_FORM_RETIRED", "FORM_VERSION",
                formId.toString(), form.contentHash(), form.contentHash(), reason, null);
        log.info("Form {} retired", formId);
    }

    private boolean isGateOrderAllowed(LifecycleState state, ReviewGate gate) {
        return switch (gate) {
            case CONTENT_QA -> state == LifecycleState.DRAFT || state == LifecycleState.CONTENT_QA;
            case ANSWER_QA -> state == LifecycleState.CONTENT_QA || state == LifecycleState.ANSWER_QA;
            case LEGAL_QA -> state == LifecycleState.ANSWER_QA || state == LifecycleState.LEGAL_QA;
        };
    }

    private LifecycleState nextState(ReviewGate gate) {
        return switch (gate) {
            case CONTENT_QA -> LifecycleState.CONTENT_QA;
            case ANSWER_QA -> LifecycleState.ANSWER_QA;
            case LEGAL_QA -> LifecycleState.LEGAL_QA;
        };
    }

    private String reviewerPermission(ReviewGate gate) {
        return switch (gate) {
            case CONTENT_QA -> "EXAMS_CONTENT_REVIEW";
            case ANSWER_QA -> "EXAMS_ANSWER_REVIEW";
            case LEGAL_QA -> "EXAMS_LEGAL_REVIEW";
        };
    }
}
