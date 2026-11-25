package com.englishcoach.exams.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.content.ExamContentBootstrapService;
import com.englishcoach.exams.content.ExamContentPackage;
import com.englishcoach.exams.content.ExamContentPackageImporter;
import com.englishcoach.exams.content.ExamContentPackageValidationException;
import com.englishcoach.exams.content.ExamContentPackageValidator;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.security.ExamPermissionService;
import com.englishcoach.exams.service.ExamContentService;
import com.englishcoach.exams.validation.ExamContentValidationService;
import com.englishcoach.exams.validation.ExamContentValidationStatus;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** Admin adapters for package validation/import.  No raw SQL editing is exposed. */
@RestController
@RequestMapping("/api/v1/admin/exams/content-packages")
@RequiredArgsConstructor
public class ExamContentAdminController {

    private final ExamContentPackageValidator validator;
    private final ExamContentPackageImporter importer;
    private final ExamContentService contentService;
    private final ExamPermissionService permissionService;
    private final ExamContentBootstrapService bootstrapService;
    private final com.englishcoach.exams.config.ExamsProperties examsProperties;
    private final ExamContentValidationService validationService;
    private final com.englishcoach.exams.practice.ExamPracticeService practiceService;
    /** Exams Phase 9A: canonical official-administrator re-check on every content-package endpoint. */
    private final com.englishcoach.auth.policy.AdminIdentityService adminIdentity;
    @org.springframework.beans.factory.annotation.Autowired
    private com.englishcoach.exams.content.ExamOriginalPracticeBootstrapService originalPractice;
    @org.springframework.beans.factory.annotation.Autowired
    private com.englishcoach.exams.content.ExamCorpusPracticeReleaseService corpusPracticeRelease;
    @org.springframework.beans.factory.annotation.Autowired
    private com.englishcoach.exams.content.ExamPrivatePackageDrafts privateDrafts;

    @org.springframework.beans.factory.annotation.Autowired
    private com.englishcoach.exams.content.ToeicPublicationBatch toeicBatch;

    @GetMapping("/toeic-publication-batch")
    public ResponseEntity<?> toeicBatchState(@AuthenticationPrincipal UserDetailsImpl user) {
        if (!authorizedAuthor(user) || !permissionService.hasOperatorPermission(user.getId(),"EXAMS_PUBLISH"))
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        return ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(
                Map.of("pending",toeicBatch.pending(),"progress",toeicBatch.progress()));
    }

    @com.englishcoach.auth.mfa.RequireStepUp
    @PostMapping("/toeic-publication-batch")
    public ResponseEntity<?> publishToeicBatch(@AuthenticationPrincipal UserDetailsImpl user,
            @RequestBody java.util.List<com.englishcoach.exams.content.ToeicPublicationBatch.Selected> selected) {
        if (!authorizedAuthor(user) || !permissionService.hasOperatorPermission(user.getId(),"EXAMS_PUBLISH"))
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        return ResponseEntity.accepted().body(toeicBatch.start(selected,user.getId()));
    }

    @PostMapping("/forms/{formId}/release-original-bank-practice")
    public ResponseEntity<?> releaseOriginalBankPractice(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID formId) {
        if (!authorizedAuthor(user) || !permissionService.hasOperatorPermission(user.getId(), "EXAMS_PUBLISH"))
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        try {
            return ResponseEntity.ok(originalPractice.releaseBankPractice(formId, user.getId()));
        } catch (IllegalArgumentException | IllegalStateException | java.util.NoSuchElementException ex) {
            return ResponseEntity.unprocessableEntity().body(Map.of("code", "ORIGINAL_BANK_PRACTICE_UNAVAILABLE"));
        }
    }

    @PostMapping(value = "/private-drafts", consumes = "application/json")
    public ResponseEntity<?> retainPrivateDraft(@AuthenticationPrincipal UserDetailsImpl user, @RequestBody String raw) {
        if (!authorizedAuthor(user)) return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        var receipt = privateDrafts.retain(raw, user.getId());
        return ResponseEntity.status(receipt.replay() ? HttpStatus.OK : HttpStatus.CREATED).body(receipt);
    }

    @GetMapping(value = "/private-drafts/{id}/{version}", produces = "application/json")
    public ResponseEntity<String> readPrivateDraft(@AuthenticationPrincipal UserDetailsImpl user,
            @PathVariable String id, @PathVariable int version) {
        if (!authorizedAuthor(user)) return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        return privateDrafts.read(id, version).map(raw -> ResponseEntity.ok()
                .cacheControl(org.springframework.http.CacheControl.noStore()).body(raw))
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping("/release-qualified-corpus-practice")
    public ResponseEntity<?> releaseQualifiedCorpusPractice(@AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(defaultValue = "0") int packageIndex,
            @RequestBody(required = false) ExamContentPackage pkg) {
        if (!authorizedAuthor(userDetails) || !permissionService.hasOperatorPermission(userDetails.getId(), "EXAMS_PUBLISH"))
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        try { return ResponseEntity.ok(pkg == null ? corpusPracticeRelease.releaseQualifiedPackage(userDetails.getId(),packageIndex)
                : corpusPracticeRelease.releaseSubmittedPackage(userDetails.getId(),pkg)); }
        catch (Exception error) {
            org.slf4j.LoggerFactory.getLogger(ExamContentAdminController.class).error("Qualified corpus Practice release failed", error);
            return ResponseEntity.unprocessableEntity().body(Map.of("code", "CORPUS_PRACTICE_RELEASE_UNAVAILABLE",
                    "message", "The qualified corpus batch did not pass its live import, rights, media or runtime gates."));
        }
    }

    @PostMapping("/bootstrap-original-practice")
    public ResponseEntity<?> bootstrapOriginalPractice(@AuthenticationPrincipal UserDetailsImpl userDetails) {
        if (!authorizedAuthor(userDetails)) return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        try {
            return ResponseEntity.ok(originalPractice.bootstrap(userDetails.getId()));
        } catch (Exception e) {
            org.slf4j.LoggerFactory.getLogger(ExamContentAdminController.class).error("Original practice bootstrap failed", e);
            return ResponseEntity.unprocessableEntity().body(Map.of("code", "ORIGINAL_PRACTICE_UNAVAILABLE",
                    "message", "Original practice import did not pass its content, rights or pilot-policy checks."));
        }
    }

    @PostMapping("/bootstrap")
    public ResponseEntity<?> bootstrapCanonicalPackages(
            @AuthenticationPrincipal UserDetailsImpl userDetails
    ) {
        // Exams Phase 9A: always the authenticated official administrator (no strict-mode-only check, no fallback actor
        // id) and no raw exception text in the response (it stays in the server log).
        if (!authorizedAuthor(userDetails)) return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        try {
            return ResponseEntity.ok(bootstrapService.bootstrapCanonicalPackages(userDetails.getId()));
        } catch (Exception e) {
            org.slf4j.LoggerFactory.getLogger(ExamContentAdminController.class).error("Canonical package bootstrap failed", e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of(
                    "code", "BOOTSTRAP_FAILED", "message", "Bootstrap failed; see the server log."));
        }
    }

    @PostMapping("/validate")
    public ResponseEntity<ExamContentPackage.ValidationResult> validate(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestBody ExamContentPackage pkg
    ) {
        if (!authorizedAuthor(userDetails)) return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        ExamContentPackage.ValidationResult result = validator.validate(pkg);
        return ResponseEntity.status(result.valid() ? HttpStatus.OK : HttpStatus.UNPROCESSABLE_ENTITY).body(result);
    }

    @PostMapping("/import")
    public ResponseEntity<?> importPackage(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestBody ExamContentPackage pkg
    ) {
        if (!authorizedAuthor(userDetails)) return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        try {
            return ResponseEntity.status(HttpStatus.CREATED).body(importer.importPackage(pkg, userDetails.getId()));
        } catch (ExamContentPackageValidationException e) {
            return ResponseEntity.status(HttpStatus.UNPROCESSABLE_ENTITY).body(Map.of(
                    "code", "CONTENT_PACKAGE_INVALID", "errors", e.errors()));
        }
    }

    @GetMapping("/{packageId}/{packageVersion}")
    public ResponseEntity<?> getImportStatus(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable String packageId,
            @PathVariable int packageVersion
    ) {
        if (!authorizedRead(userDetails)) return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        return importer.findImport(packageId, packageVersion)
                .<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/forms")
    public ResponseEntity<?> listForms(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(required = false) ExamFamily family,
            @RequestParam(required = false) String lifecycleState,
            @RequestParam(defaultValue = "50") int limit,
            @RequestParam(defaultValue = "0") int offset
    ) {
        if (!authorizedRead(userDetails)) return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        return ResponseEntity.ok(contentService.getAdminFormSummaries(family, lifecycleState, limit, offset));
    }

    @GetMapping("/sources")
    public ResponseEntity<?> listSources(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(defaultValue = "50") int limit,
            @RequestParam(defaultValue = "0") int offset
    ) {
        if (!authorizedRead(userDetails)) return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        return ResponseEntity.ok(contentService.getAdminSourceSummaries(limit, offset));
    }

    /**
     * Exams Phase 2: full authoritative validation of one form (structured diagnostic codes, ids and counts only —
     * no question text) plus the persisted history. Operator/admin only; learners get the concise catalog state.
     */
    @GetMapping("/forms/{formId}/validation")
    public ResponseEntity<?> getFormValidation(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID formId,
            @RequestParam(defaultValue = "10") int historyLimit
    ) {
        if (!authorizedRead(userDetails)) return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        return validationBody(formId, validationService.evaluate(formId), historyLimit);
    }

    /** Explicit recomputation (bypasses the cache, records a new result when the content fingerprint changed). */
    @PostMapping("/forms/{formId}/validation")
    public ResponseEntity<?> revalidateForm(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID formId
    ) {
        if (!authorizedRead(userDetails)) return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        return validationBody(formId, validationService.revalidate(formId, ExamContentValidationService.Trigger.ADMIN), 10);
    }

    /**
     * Exams Phase 6: practice scope readiness of one form with the internal reason codes (ids, counts, codes — no exam
     * text). Learners only get the availability state from {@code GET /api/v1/exams/forms/{formId}/practice-scopes}.
     */
    @GetMapping("/forms/{formId}/practice-scopes")
    public ResponseEntity<?> getPracticeScopeDiagnostics(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID formId
    ) {
        if (!authorizedRead(userDetails)) return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        if (practiceService == null) return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).build();
        return ResponseEntity.ok(practiceService.getDiagnostics(formId));
    }

    private ResponseEntity<?> validationBody(UUID formId, ExamFormValidationReport report, int historyLimit) {
        if (report.status() == ExamContentValidationStatus.UNKNOWN && contentService.getFormById(formId).isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("report", report);
        body.put("availableModes", report.availableModes());
        body.put("history", validationService.history(formId, historyLimit));
        return ResponseEntity.ok(body);
    }

    private boolean officialAdmin(UserDetailsImpl userDetails) {
        return userDetails != null && adminIdentity != null && adminIdentity.isOfficialAdmin(userDetails.getId());
    }

    private boolean authorizedAuthor(UserDetailsImpl userDetails) {
        return officialAdmin(userDetails) && permissionService.hasOperatorPermission(userDetails.getId(), "EXAMS_AUTHOR");
    }

    private boolean authorizedRead(UserDetailsImpl userDetails) {
        if (!officialAdmin(userDetails)) return false;
        return permissionService.hasOperatorPermission(userDetails.getId(), "EXAMS_AUTHOR")
                || permissionService.hasOperatorPermission(userDetails.getId(), "EXAMS_CONTENT_REVIEW")
                || permissionService.hasOperatorPermission(userDetails.getId(), "EXAMS_ANSWER_REVIEW")
                || permissionService.hasOperatorPermission(userDetails.getId(), "EXAMS_LEGAL_REVIEW")
                || permissionService.hasOperatorPermission(userDetails.getId(), "EXAMS_PUBLISH");
    }

}
