package com.englishcoach.proficiency.placement;

import com.englishcoach.common.security.UserDetailsImpl;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * "Bài xếp lớp nhanh" API (authenticated by the default chain; always the caller's own data).
 * The client receives questions only (no level / answer key) and sends only the chosen option index (or null) per question.
 */
@RestController
@RequestMapping("/api/v1/proficiency/placement")
@RequiredArgsConstructor
public class PlacementController {

    private final PlacementService service;

    public record SubmitRequest(List<Integer> answers) {}

    @GetMapping("/me")
    public PlacementService.MeResponse me(@AuthenticationPrincipal UserDetailsImpl principal) {
        return service.me(requireUser(principal), Instant.now());
    }

    /** {@code replace=true} = "Làm lại từ đầu": abandons the unfinished attempt explicitly; otherwise 409 ACTIVE_ATTEMPT. */
    @PostMapping("/start")
    public PlacementService.StartResponse start(@AuthenticationPrincipal UserDetailsImpl principal,
                                                @RequestParam(name = "replace", defaultValue = "false") boolean replace) {
        return service.start(requireUser(principal), Instant.now(), replace);
    }

    public record ProgressRequest(List<Integer> answers) {}

    /** Unfinished attempt (questions without keys + saved answers); 204 when there is none. */
    @GetMapping("/active")
    public ResponseEntity<PlacementService.ActiveResponse> active(@AuthenticationPrincipal UserDetailsImpl principal) {
        return service.active(requireUser(principal), Instant.now())
                .map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }

    /** Autosave of the answers given so far. */
    @PutMapping("/{attemptId}/progress")
    public PlacementService.SaveResponse saveProgress(@AuthenticationPrincipal UserDetailsImpl principal,
                                                      @PathVariable UUID attemptId, @RequestBody ProgressRequest body) {
        return service.saveProgress(requireUser(principal), attemptId, body == null ? null : body.answers(), Instant.now());
    }

    @PostMapping("/{attemptId}/abandon")
    public ResponseEntity<Void> abandon(@AuthenticationPrincipal UserDetailsImpl principal, @PathVariable UUID attemptId) {
        service.abandon(requireUser(principal), attemptId, Instant.now());
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{attemptId}/submit")
    public PlacementService.SubmitResponse submit(@AuthenticationPrincipal UserDetailsImpl principal,
                                                  @PathVariable UUID attemptId, @RequestBody SubmitRequest body) {
        return service.submit(requireUser(principal), attemptId, body == null ? null : body.answers(), Instant.now());
    }

    private static long requireUser(UserDetailsImpl principal) {
        if (principal == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        }
        return principal.getId();
    }
}
