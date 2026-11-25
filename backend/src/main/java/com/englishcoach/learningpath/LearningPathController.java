package com.englishcoach.learningpath;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.learningpath.LearningPathDtos.*;
import jakarta.validation.Valid;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

/**
 * Echo Learning Path ("Lộ trình học"). Signed-in learners only (authenticated by the default rule); every call is
 * scoped to the principal — no endpoint takes a user id. State-changing work (creating the day, linking evidence)
 * happens only on POST / PUT (CSRF-protected); the summary GET writes nothing. No endpoint calls an AI service.
 */
@RestController
@Validated
@RequestMapping("/api/v1/learning-path")
public class LearningPathController {

    private final LearningPathService service;

    public LearningPathController(LearningPathService service) {
        this.service = service;
    }

    /** Today's tasks (created on the first visit of the day, then stable); links new evidence. */
    @PostMapping("/today")
    public ResponseEntity<TodayView> today(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(service.today(owner(user)));
    }

    @PutMapping("/goal")
    public ResponseEntity<TodayView> goal(@AuthenticationPrincipal UserDetailsImpl user, @Valid @RequestBody GoalRequest request) {
        return ok(service.setGoal(owner(user), request));
    }

    /** Read-only progress summary (Tiến trình học tập). */
    @GetMapping("/summary")
    public ResponseEntity<ProgressSummary> summary(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(service.summary(owner(user)));
    }

    /** Explicit "Cập nhật bằng Learner DNA": a proposal only; nothing changes until it is applied. */
    @PostMapping("/dna-proposals")
    public ResponseEntity<ProposalView> propose(@AuthenticationPrincipal UserDetailsImpl user) {
        return ok(service.propose(owner(user)));
    }

    @PostMapping("/dna-proposals/{id}/apply")
    public ResponseEntity<TodayView> apply(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable long id) {
        return ok(service.apply(owner(user), id));
    }

    @PostMapping("/dna-proposals/{id}/cancel")
    public ResponseEntity<Void> cancel(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable long id) {
        service.cancel(owner(user), id);
        return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
    }

    private static long owner(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new LearningPathException(401, "AUTH_REQUIRED");
        return user.getId();
    }

    private static <T> ResponseEntity<T> ok(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
