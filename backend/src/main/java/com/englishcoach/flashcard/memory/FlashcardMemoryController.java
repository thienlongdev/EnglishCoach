package com.englishcoach.flashcard.memory;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.premium.interceptor.RequirePremiumAi;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.List;

/**
 * Echo Memory Tides 2.0 endpoints (owner brief 2026-11-12). Reads are the principal's own data only. The three AI actions
 * run only on an explicit learner click, through the existing quota interceptor (one fresh reservation per call), and
 * never write a flashcard or move the review schedule.
 */
@RestController
@RequestMapping("/api/v1/flashcards")
@RequiredArgsConstructor
public class FlashcardMemoryController {

    private final FlashcardMemoryService memory;

    private static long uid(UserDetailsImpl user) {
        if (user != null && user.getId() != null) return user.getId();
        throw new AccessDeniedException("Authentication required for flashcard operations");
    }

    @GetMapping("/memory/overview")
    public ResponseEntity<FlashcardMemoryService.Overview> overview(@AuthenticationPrincipal UserDetailsImpl user) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(memory.overview(uid(user)));
    }

    @GetMapping("/memory/tiers")
    public ResponseEntity<List<FlashcardMemoryService.CardTier>> tiers(@AuthenticationPrincipal UserDetailsImpl user,
                                                                      @RequestParam(name = "ids", required = false) String ids) {
        List<Long> parsed = new ArrayList<>();
        if (ids != null && !ids.isBlank()) {
            for (String part : ids.split(",")) {
                if (parsed.size() >= 100) break;
                try {
                    parsed.add(Long.parseLong(part.trim()));
                } catch (NumberFormatException e) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Danh sách thẻ không hợp lệ.");
                }
            }
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(memory.tiers(uid(user), parsed));
    }

    @GetMapping("/memory/fusion/candidates")
    public ResponseEntity<List<FlashcardMemoryService.FusionCandidate>> fusionCandidates(@AuthenticationPrincipal UserDetailsImpl user,
                                                                                         @RequestParam(defaultValue = "6") int limit) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(memory.fusionCandidates(uid(user), limit));
    }

    public record FusionCheckRequest(Long firstCardId, Long secondCardId, String sentence) {}

    @PostMapping("/memory/fusion/check")
    @RequirePremiumAi(value = "FLASHCARD_FUSION_CHECK", reuseClientRequestId = false)
    public ResponseEntity<FlashcardMemoryService.FusionResult> checkFusion(@AuthenticationPrincipal UserDetailsImpl user,
                                                                          @RequestBody FusionCheckRequest request) {
        if (request == null || request.firstCardId() == null || request.secondCardId() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Hãy chọn hai từ để ghép câu.");
        }
        return ResponseEntity.ok(memory.checkFusion(uid(user), request.firstCardId(), request.secondCardId(), request.sentence()));
    }

    public record ForgeRequest(Long flashcardId, String mode, String interest) {}

    @PostMapping("/memory/forge")
    @RequirePremiumAi(value = "FLASHCARD_MEMORY_FORGE", reuseClientRequestId = false)
    public ResponseEntity<FlashcardMemoryService.ForgeResult> forge(@AuthenticationPrincipal UserDetailsImpl user,
                                                                   @RequestBody ForgeRequest request) {
        if (request == null || request.flashcardId() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Hãy chọn một thẻ.");
        }
        return ResponseEntity.ok(memory.forge(uid(user), request.flashcardId(), request.mode(), request.interest()));
    }

    public record StudioRequest(String text, String level, Integer count, List<String> exclude, String only) {}

    @PostMapping("/studio/drafts")
    @RequirePremiumAi(value = "FLASHCARD_AI_STUDIO", reuseClientRequestId = false)
    public ResponseEntity<FlashcardMemoryService.StudioResult> studio(@AuthenticationPrincipal UserDetailsImpl user,
                                                                      @RequestBody StudioRequest request) {
        if (request == null || request.text() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Hãy dán một đoạn tiếng Anh.");
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(memory.studio(uid(user), request.text(), request.level(), request.count(), request.exclude(), request.only()));
    }
}
