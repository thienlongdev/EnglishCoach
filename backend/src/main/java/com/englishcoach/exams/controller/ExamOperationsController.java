package com.englishcoach.exams.controller;

import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.operations.ExamOperationsRecords.*;
import com.englishcoach.exams.operations.ExamOperationsService;
import com.englishcoach.exams.operations.ExamQaDecisionLedger;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.util.Map;
import java.util.UUID;

/**
 * Exams Phase 8D — admin Exams operations center. Two layers of authorization: the URL rule
 * {@code /api/v1/admin/** hasRole('ADMIN')} and a re-check of the CURRENT official administrator
 * ({@link AdminIdentityService}, 403 — never 500). Learners can reach none of it.
 *
 * <p>Read-only except one append-only action: a fingerprinted human QA decision (reviewer = the authenticated admin,
 * timestamp = server). There is deliberately NO import / publish / retire / force / skip / override endpoint here:
 * imports stay planner + executor driven, publication and retirement stay plans until the Phase 10 release gate.
 */
@RestController
@RequestMapping("/api/v1/admin/exams/operations")
@RequiredArgsConstructor
public class ExamOperationsController {

    private final ExamOperationsService operationsService;
    private final AdminIdentityService adminIdentity;

    private boolean admin(UserDetailsImpl user) {
        return user != null && adminIdentity.isOfficialAdmin(user.getId());
    }

    private static ResponseEntity<Map<String, Object>> error(int status, String code, String message) {
        return ResponseEntity.status(status).body(Map.of("code", code, "message", message));
    }

    @GetMapping("/overview")
    public ResponseEntity<?> overview(@AuthenticationPrincipal UserDetailsImpl user) {
        if (!admin(user)) return error(403, "FORBIDDEN", "Administrator access required");
        return ResponseEntity.ok(operationsService.overview());
    }

    @GetMapping("/packages/detail")
    public ResponseEntity<?> packageDetail(@AuthenticationPrincipal UserDetailsImpl user, @RequestParam String testId) {
        if (!admin(user)) return error(403, "FORBIDDEN", "Administrator access required");
        return operationsService.packageDetail(testId).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> error(404, "PACKAGE_NOT_FOUND", "No staged package " + testId + " (or the staging view is not configured)"));
    }

    /** Hash-verified staged image of a package (local crop review). Never a learner path; no raw-source zip members. */
    @GetMapping("/packages/media")
    public ResponseEntity<?> packageMedia(@AuthenticationPrincipal UserDetailsImpl user, @RequestParam String testId,
                                          @RequestParam String sha256) throws IOException {
        if (!admin(user)) return error(403, "FORBIDDEN", "Administrator access required");
        if (sha256 == null || !sha256.matches("^[0-9a-fA-F]{64}$")) return error(400, "SHA256_INVALID", "sha256 required");
        return operationsService.imageBytes(testId, sha256).<ResponseEntity<?>>map(bytes -> ResponseEntity.ok()
                        .cacheControl(CacheControl.noStore())
                        .contentType(MediaType.parseMediaType(operationsService.imageMime(testId, sha256).orElse("application/octet-stream")))
                        .body(bytes))
                .orElseGet(() -> error(404, "MEDIA_NOT_PREVIEWABLE", "Not a verified staged image of this package"));
    }

    @PostMapping("/qa/decisions")
    public ResponseEntity<?> recordDecision(@AuthenticationPrincipal UserDetailsImpl user, @RequestBody QaDecisionRequest request) {
        if (!admin(user)) return error(403, "FORBIDDEN", "Administrator access required");
        try {
            return ResponseEntity.status(HttpStatus.CREATED).body(operationsService.recordDecision(user.getId(), request));
        } catch (ExamQaDecisionLedger.Rejected r) {
            return error(r.status(), r.code(), r.getMessage());
        }
    }

    @GetMapping("/forms/{formId}")
    public ResponseEntity<?> persistedForm(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID formId) {
        if (!admin(user)) return error(403, "FORBIDDEN", "Administrator access required");
        return operationsService.persistedForm(formId).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> error(404, "FORM_NOT_FOUND", "Form not found"));
    }
}
