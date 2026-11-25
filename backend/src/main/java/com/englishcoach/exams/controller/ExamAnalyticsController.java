package com.englishcoach.exams.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.analytics.ExamAnalyticsRecords.ExamAnalyticsDto;
import com.englishcoach.exams.analytics.ExamLearnerAnalyticsService;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Exams Phase 8 — the learner's own Exams analytics + mistake intelligence + recommended practice in ONE read-only
 * contract. The subject is ALWAYS the authenticated principal: there is no user-id parameter, so one learner can never
 * read another learner's analytics. Deterministic, no AI call, no write.
 */
@RestController
@RequestMapping("/api/v1/exams")
public class ExamAnalyticsController {

    private final ExamLearnerAnalyticsService analyticsService;
    /** Exams Phase 9F: analytics re-scores up to the bounded window of snapshots — throttled per learner. */
    private final com.englishcoach.exams.security.ExamRateLimiter rateLimiter;

    @org.springframework.beans.factory.annotation.Autowired
    public ExamAnalyticsController(ExamLearnerAnalyticsService analyticsService, com.englishcoach.exams.security.ExamRateLimiter rateLimiter) {
        this.analyticsService = analyticsService;
        this.rateLimiter = rateLimiter != null ? rateLimiter : com.englishcoach.exams.security.ExamRateLimiter.disabled();
    }

    public ExamAnalyticsController(ExamLearnerAnalyticsService analyticsService) {
        this(analyticsService, null);
    }

    @GetMapping("/analytics")
    public ResponseEntity<ExamAnalyticsDto> getAnalytics(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(required = false) String family
    ) {
        if (userDetails == null) return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        rateLimiter.check(com.englishcoach.exams.security.ExamRateLimiter.Operation.ANALYTICS, userDetails.getId());
        ExamFamily fam = null;
        if (family != null && !family.isBlank()) {
            fam = ExamFamily.fromString(family);
            if (fam == null) throw new IllegalArgumentException("EXAM_FAMILY_INVALID");
        }
        return ResponseEntity.ok(analyticsService.getAnalytics(userDetails.getId(), fam));
    }
}
