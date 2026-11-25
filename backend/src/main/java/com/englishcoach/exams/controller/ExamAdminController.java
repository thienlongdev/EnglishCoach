package com.englishcoach.exams.controller;

import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.model.ExamScoringRecords.ReviewCaseRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.security.ExamPermissionService;
import com.englishcoach.exams.service.ExamPublicationService;
import com.englishcoach.exams.service.ExamResultService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Exams lifecycle administration (review gates, publish, retire, scoring review cases).
 *
 * <p>Exams Phase 9A: two layers of authorization on EVERY endpoint — the URL rule {@code /api/v1/admin/** hasRole('ADMIN')}
 * and a re-check of the CURRENT official administrator ({@link AdminIdentityService}: users row role + e-mail, never a
 * token claim) before any service call (403 {@code FORBIDDEN}, never 500). A review decision must name the exact content
 * closure it was made for: there is no default / fallback hash.
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/admin/exams")
@RequiredArgsConstructor
public class ExamAdminController {

    private final ExamPublicationService publicationService;
    private final ExamPermissionService permissionService;
    private final ExamResultService resultService;
    private final AdminIdentityService adminIdentity;

    static final int MAX_REVIEW_CASES_PAGE = 100;

    private static ResponseEntity<Map<String, Object>> error(HttpStatus status, String code, String message) {
        return ResponseEntity.status(status).body(Map.of("code", code, "message", message));
    }

    /** null ⇒ the caller is the official administrator; otherwise the 401 / 403 response to return. */
    private ResponseEntity<Map<String, Object>> denied(UserDetailsImpl userDetails) {
        if (userDetails == null) return error(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", "Authentication required");
        if (adminIdentity == null || !adminIdentity.isOfficialAdmin(userDetails.getId())) {
            return error(HttpStatus.FORBIDDEN, "FORBIDDEN", "Administrator access required");
        }
        return null;
    }

    @PostMapping("/forms/{id}/reviews")
    public ResponseEntity<Map<String, Object>> submitReview(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id,
            @RequestBody(required = false) Map<String, String> body
    ) {
        ResponseEntity<Map<String, Object>> denied = denied(userDetails);
        if (denied != null) return denied;
        if (body == null) return error(HttpStatus.BAD_REQUEST, "REVIEW_REQUEST_INVALID", "gate, decision and hash are required");

        ReviewGate gate;
        ReviewDecision decision;
        try {
            gate = ReviewGate.valueOf(String.valueOf(body.get("gate")));
            decision = ReviewDecision.valueOf(String.valueOf(body.get("decision")));
        } catch (IllegalArgumentException e) {
            return error(HttpStatus.BAD_REQUEST, "REVIEW_REQUEST_INVALID", "gate and decision must be known values");
        }
        // Exams Phase 9A: the reviewed closure hash is REQUIRED — it must equal the form's CURRENT closure (verified by
        // the service); a missing hash is refused, never replaced by a default.
        String hash = body.get("hash");
        if (hash == null || hash.isBlank()) {
            return error(HttpStatus.BAD_REQUEST, "REVIEW_CLOSURE_HASH_REQUIRED", "the reviewed content closure hash is required");
        }
        String notes = body.getOrDefault("notes", "");

        publicationService.submitReview(id, gate, userDetails.getId(), decision, hash.trim(), notes);
        return ResponseEntity.ok(Map.of("formId", id, "gate", gate.name(), "decision", decision.name()));
    }

    @com.englishcoach.auth.mfa.RequireStepUp
    @PostMapping("/forms/{id}/publish")
    public ResponseEntity<Map<String, Object>> publishForm(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id
    ) {
        ResponseEntity<Map<String, Object>> denied = denied(userDetails);
        if (denied != null) return denied;
        publicationService.publishForm(id, userDetails.getId(), "Publication gate approved by content operations");
        return ResponseEntity.ok(Map.of("formId", id, "status", "PUBLISHED"));
    }

    @com.englishcoach.auth.mfa.RequireStepUp
    @PostMapping("/forms/{id}/retire")
    public ResponseEntity<Map<String, Object>> retireForm(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id
    ) {
        ResponseEntity<Map<String, Object>> denied = denied(userDetails);
        if (denied != null) return denied;
        publicationService.retireForm(id, userDetails.getId(), "Retired by content operations");
        return ResponseEntity.ok(Map.of("formId", id, "status", "RETIRED"));
    }

    @GetMapping("/review-cases")
    public ResponseEntity<?> getReviewCases(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(defaultValue = "20") int limit,
            @RequestParam(defaultValue = "0") int offset
    ) {
        ResponseEntity<Map<String, Object>> denied = denied(userDetails);
        if (denied != null) return denied;
        List<ReviewCaseRecord> cases = resultService.findOpenReviewCases(
                Math.min(Math.max(limit, 1), MAX_REVIEW_CASES_PAGE), Math.max(offset, 0));
        return ResponseEntity.ok(cases);
    }

    @PostMapping("/review-cases/{id}/decisions")
    public ResponseEntity<Map<String, Object>> submitCaseDecision(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID id,
            @RequestBody Map<String, Object> decisionPayload
    ) {
        ResponseEntity<Map<String, Object>> denied = denied(userDetails);
        if (denied != null) return denied;
        resultService.resolveReviewCase(id, userDetails.getId(), decisionPayload);
        return ResponseEntity.ok(Map.of("caseId", id, "status", "RESOLVED"));
    }
}
