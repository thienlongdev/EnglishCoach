package com.englishcoach.flashcard.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.flashcard.entity.Flashcard;
import com.englishcoach.flashcard.service.FlashcardService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;

import java.util.List;

@RestController
@RequestMapping({"/api/flashcards", "/api/v1/flashcards"})
@RequiredArgsConstructor
public class FlashcardController {

    private final FlashcardService flashcardService;
    /** Daily review reminder of the bell (absent in slim test contexts). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.englishcoach.notification.service.FlashcardDueReminderService dueReminder;

    private Long getUserId(UserDetailsImpl userDetails) {
        if (userDetails != null && userDetails.getId() != null) {
            return userDetails.getId();
        }
        throw new org.springframework.security.access.AccessDeniedException("Authentication required for flashcard operations");
    }

    @GetMapping("/decks/catalog")
    public ResponseEntity<com.englishcoach.flashcard.dto.FlashcardCatalogResponse> getSystemCatalog(
            @AuthenticationPrincipal UserDetailsImpl userDetails) {
        getUserId(userDetails);
        return ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore())
                .body(flashcardService.getSystemCatalog());
    }

    @GetMapping("/decks/progress")
    public ResponseEntity<List<com.englishcoach.flashcard.dto.FlashcardCatalogResponse.Progress>> getDeckProgress(
            @AuthenticationPrincipal UserDetailsImpl userDetails) {
        return ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore())
                .body(flashcardService.getDeckProgress(getUserId(userDetails)));
    }

    @GetMapping("/decks")
    public ResponseEntity<List<com.englishcoach.flashcard.dto.VocabDeckSummaryResponse>> getDecks(
            @AuthenticationPrincipal UserDetailsImpl userDetails) {
        return ResponseEntity.ok(flashcardService.getDecks(getUserId(userDetails)));
    }

    @PostMapping("/decks/{deckId}/enroll")
    public ResponseEntity<java.util.Map<String, Object>> enrollDeck(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long deckId) {
        int enrolledCount = flashcardService.enrollDeck(getUserId(userDetails), deckId);
        return ResponseEntity.ok(java.util.Map.of("enrolledCount", enrolledCount, "deckId", deckId));
    }

    @GetMapping
    public ResponseEntity<Page<Flashcard>> getUserFlashcards(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(required = false) Long deckId,
            @RequestParam(required = false) String search,
            @RequestParam(required = false) String status,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "50") int size) {
        PageRequest pageRequest = PageRequest.of(Math.max(0, page), Math.max(1, Math.min(size, 100)));
        return ResponseEntity
                .ok(flashcardService.getUserFlashcards(getUserId(userDetails), deckId, search, status, pageRequest));
    }

    @GetMapping("/stats")
    public ResponseEntity<com.englishcoach.flashcard.dto.FlashcardStatsResponse> getFlashcardStats(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(required = false) Long deckId) {
        return ResponseEntity.ok(flashcardService.getStats(getUserId(userDetails), deckId));
    }

    public ResponseEntity<com.englishcoach.flashcard.dto.FlashcardStatsResponse> getFlashcardStats(
            UserDetailsImpl userDetails) {
        return getFlashcardStats(userDetails, null);
    }

    @GetMapping("/due-count")
    public ResponseEntity<java.util.Map<String, Object>> getDueCount(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(required = false, defaultValue = "20") int limit) {
        long dueCount = flashcardService.getDueCount(getUserId(userDetails), limit);
        long actualDue = flashcardService.countActualDue(getUserId(userDetails));
        return ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore()).body(java.util.Map.of(
                "dueCount", dueCount,
                "actualDueCount", actualDue,
                // already-studied cards due now: the number the daily review reminder speaks of
                "reviewDueCount", flashcardService.countReviewDue(getUserId(userDetails)),
                "dailyReviewLimit", limit));
    }

    @GetMapping("/due")
    public ResponseEntity<Page<Flashcard>> getDueFlashcards(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(required = false) Long deckId,
            @RequestParam(defaultValue = "false") boolean reviewOnly,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "50") int size) {
        PageRequest pageRequest = PageRequest.of(Math.max(0, page), Math.max(1, Math.min(size, 100)));
        if (reviewOnly) {
            // the reminder's list: cards already studied that are due now, whatever their deck
            return ResponseEntity.ok(flashcardService.getReviewDueFlashcards(getUserId(userDetails), pageRequest));
        }
        return ResponseEntity.ok(flashcardService.getDueFlashcards(getUserId(userDetails), deckId, pageRequest));
    }

    @PostMapping("/add")
    public ResponseEntity<Flashcard> addFlashcard(@AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam String word) {
        return ResponseEntity.ok(flashcardService.addFlashcard(getUserId(userDetails), word));
    }

    /**
     * One rating (hard / good / easy). {@code Idempotency-Key} names the learner's click: a retry of the same click
     * (timeout, lost answer) returns the stored card without moving the schedule again ({@code X-Review-Replayed}).
     */
    @PutMapping("/{id}/review")
    public ResponseEntity<Flashcard> reviewFlashcard(@AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long id,
            @RequestParam String quality,
            @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
        FlashcardService.ReviewOutcome outcome = flashcardService.review(getUserId(userDetails), id, quality, idempotencyKey);
        // the bell re-counts on its next read (marks today's reminder read once nothing is due)
        if (!outcome.replayed() && dueReminder != null) dueReminder.forget(getUserId(userDetails));
        return ResponseEntity.ok().cacheControl(org.springframework.http.CacheControl.noStore())
                .header("X-Review-Replayed", String.valueOf(outcome.replayed()))
                .body(outcome.card());
    }

    @PutMapping("/{id}/reset")
    public ResponseEntity<Flashcard> resetFlashcard(@AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long id) {
        return ResponseEntity.ok(flashcardService.resetFlashcard(getUserId(userDetails), id));
    }

    /** definition / partOfSpeech / exampleVi: the contextual sense approved in Echo AI Card Studio (V117), all optional. */
    public record CustomFlashcardRequest(String front, String back, String example, String ipa, String cefr,
                                         String definition, String partOfSpeech, String exampleVi) {
        public CustomFlashcardRequest(String front, String back, String example) {
            this(front, back, example, null, null, null, null, null);
        }

        public CustomFlashcardRequest(String front, String back, String example, String ipa, String cefr) {
            this(front, back, example, ipa, cefr, null, null, null);
        }
    }

    /** 201 when the card was created (or restored), 200 when the learner already had this word. */
    @PostMapping
    public ResponseEntity<Flashcard> addCustomFlashcard(@AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestBody CustomFlashcardRequest request) {
        if (request == null) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.BAD_REQUEST, "Hãy nhập từ hoặc cụm từ tiếng Anh.");
        }
        boolean hasSense = request.definition() != null || request.partOfSpeech() != null || request.exampleVi() != null;
        FlashcardService.SavedCard saved = flashcardService.saveCustomFlashcard(getUserId(userDetails), request.front(),
                request.back(), request.example(), request.ipa(), request.cefr(),
                hasSense ? new FlashcardService.ContextSense(request.definition(), request.partOfSpeech(), request.exampleVi()) : null);
        return ResponseEntity.status(saved.created() ? org.springframework.http.HttpStatus.CREATED : org.springframework.http.HttpStatus.OK)
                .header("X-Flashcard-Created", String.valueOf(saved.created()))
                .body(saved.card());
    }


    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteFlashcard(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long id) {
        flashcardService.deleteFlashcard(getUserId(userDetails), id);
        return ResponseEntity.noContent().build();
    }

    @PostMapping(value = "/upload-apkg")
    public ResponseEntity<java.util.Map<String, Object>> uploadApkg(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam("file") org.springframework.web.multipart.MultipartFile file) {
        FlashcardService.ApkgImportResult result = flashcardService.importApkgDetails(getUserId(userDetails), file);
        return ResponseEntity.ok(java.util.Map.of(
                "importedCount", result.importedCount(),
                "skippedCount", result.skippedCount(),
                "totalNotes", result.totalNotes()));
    }

    /** Starts a solo Card Blast run; the returned id must accompany the result for the run to count. */
    @PostMapping("/card-blast/start-run")
    public ResponseEntity<java.util.Map<String, String>> startCardBlastRun(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestBody(required = false) java.util.Map<String, Object> body) {
        Long deckId = null;
        Object raw = body != null ? body.get("deckId") : null;
        if (raw instanceof Number number) {
            deckId = number.longValue();
        }
        Object handle = body != null ? body.get("sentinel") : null;
        return flashcardService.startCardBlastRun(getUserId(userDetails), deckId, handle instanceof String h ? h : null)
                .map(runId -> ResponseEntity.ok(java.util.Map.of("runId", runId)))
                .orElseGet(() -> ResponseEntity.status(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS)
                        .header("Retry-After", "2")
                        .body(java.util.Map.of("message", "A run was started a moment ago")));
    }

    @PostMapping("/card-blast/finish-run")
    public ResponseEntity<java.util.Map<String, String>> finishCardBlastRun(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestBody com.englishcoach.flashcard.dto.CardBlastFinishRunRequest request) {
        boolean counted = flashcardService.recordCardBlastRun(getUserId(userDetails), request);
        return ResponseEntity.ok(java.util.Map.of(
                "message", "Run recorded successfully",
                "counted", String.valueOf(counted)));
    }
}
