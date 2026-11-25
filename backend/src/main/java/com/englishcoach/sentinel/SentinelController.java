package com.englishcoach.sentinel;

import com.englishcoach.common.security.UserDetailsImpl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import java.util.*;

/**
 * Echo Sentinel page endpoints. Authenticated (global rule) and CSRF-checked (global filter) like every API write; an
 * attempt is reached only with its id AND its secret AND the owner's session (anything else answers 404).
 */
@RestController
@RequestMapping("/api/v1/sentinel")
public class SentinelController {
    private final SentinelService sentinel;
    private final SentinelExamIntegrity examIntegrity;
    public SentinelController(SentinelService sentinel, org.springframework.beans.factory.ObjectProvider<SentinelExamIntegrity> examIntegrity) {
        this.sentinel = sentinel; this.examIntegrity = examIntegrity.getIfAvailable();
    }

    public record BeginRequest(String activity, Boolean acknowledged, Integer policyVersion) {}
    public record Report(String token, Boolean visible, String kind) {}

    @GetMapping("/policies")
    public Map<String, Object> policies() {
        var out = new LinkedHashMap<String, Object>();
        out.put("policyVersion", SentinelPolicy.POLICY_VERSION);
        out.put("heartbeatMs", SentinelPolicy.HEARTBEAT_MS);
        out.put("continuityGraceMs", SentinelPolicy.CONTINUITY_GRACE_MS);
        out.put("blurGraceMs", SentinelPolicy.BLUR_GRACE_MS);
        out.put("activities", SentinelPolicy.activities().stream().map(a -> Map.of("key", a.key(), "mode", a.mode().name(),
            "integrated", a.integrated(), "scope", a.scope())).toList());
        return out;
    }

    @PostMapping("/attempts")
    public ResponseEntity<?> begin(@AuthenticationPrincipal UserDetailsImpl user, @RequestBody(required = false) BeginRequest body) {
        return run(() -> {
            if (body == null) throw new SentinelService.Refusal("INVALID_REQUEST", 400);
            return sentinel.begin(id(user), body.activity(), Boolean.TRUE.equals(body.acknowledged()), body.policyVersion());
        });
    }

    @PostMapping("/attempts/{id}/heartbeat")
    public ResponseEntity<?> heartbeat(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id, @RequestBody(required = false) Report body) {
        return run(() -> sentinel.heartbeat(id(user), id, body == null ? null : body.token(), body == null || !Boolean.FALSE.equals(body.visible())));
    }

    @PostMapping("/attempts/{id}/violation")
    public ResponseEntity<?> violation(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id, @RequestBody(required = false) Report body) {
        return run(() -> sentinel.violation(id(user), id, body == null ? null : body.token(), body == null ? null : body.kind()));
    }

    public record BindRequest(String token, String subject) {}

    /** Exam simulation: binds the acknowledged attempt to the learner's own running simulation (once per exam attempt). */
    @PostMapping("/attempts/{id}/bind")
    public ResponseEntity<?> bind(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID id, @RequestBody(required = false) BindRequest body) {
        return run(() -> {
            long uid = id(user);
            if (body == null || body.subject() == null || examIntegrity == null) throw new SentinelService.Refusal("INVALID_REQUEST", 400);
            UUID exam;
            try { exam = UUID.fromString(body.subject()); } catch (IllegalArgumentException e) { throw new SentinelService.Refusal("INVALID_REQUEST", 400); }
            if (!examIntegrity.bindable(uid, exam)) throw new SentinelService.Refusal("SUBJECT_NOT_FOUND", 404);
            var a = sentinel.bindSubject(uid, id + "." + body.token(), SentinelPolicy.EXAM_SIMULATION, exam.toString());
            if (a == null) throw new SentinelService.Refusal("SENTINEL_INVALID", 409);
            return sentinel.status(uid, id, body.token());
        });
    }

    /** A page opened a running exam simulation without the attempt secret (reload, another tab): the attempt ends. */
    @PostMapping("/subjects/EXAM_SIMULATION/{exam}/reopen")
    public ResponseEntity<?> reopen(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable UUID exam) {
        return run(() -> {
            var s = sentinel.reopen(id(user), SentinelPolicy.EXAM_SIMULATION, exam.toString());
            return s == null ? Map.of("state", "UNBOUND") : s;
        });
    }

    private static long id(UserDetailsImpl user) {
        if (user == null) throw new SentinelService.Refusal("AUTH_REQUIRED", 401);
        return user.getId();
    }
    private static ResponseEntity<?> run(java.util.function.Supplier<Object> action) {
        try { return ResponseEntity.ok(action.get()); }
        catch (SentinelService.Refusal r) { return ResponseEntity.status(r.status).body(Map.of("code", r.code)); }
    }
}
