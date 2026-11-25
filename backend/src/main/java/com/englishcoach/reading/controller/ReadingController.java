package com.englishcoach.reading.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.reading.dto.*;
import com.englishcoach.reading.service.ReadingContextualService;
import com.englishcoach.reading.service.ReadingService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.http.MediaType;

import java.util.List;

@RestController
@RequestMapping("/api/v1/reading")
@RequiredArgsConstructor
public class ReadingController {

    private final ReadingService readingService;
    private final ReadingContextualService contextualService;

    /**
     * POST /api/v1/reading/materials
     * Create and save a new reading material scoped to the authenticated user.
     */
    @PostMapping("/materials")
    public ResponseEntity<ReadingMaterialResponse> addMaterial(
            @AuthenticationPrincipal UserDetailsImpl currentUser,
            @RequestBody ReadingMaterialRequest request) {

        Long userId = currentUser != null ? currentUser.getId() : null;
        ReadingMaterialResponse response = readingService.addMaterial(request, userId);
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    /**
     * POST /api/v1/reading/materials/upload
     * Upload a PDF/Image file to extract text via AI OCR service and save as
     * reading material scoped to the authenticated user.
     */
    @PostMapping(value = "/materials/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<ReadingMaterialResponse> uploadMaterial(
            @RequestParam("file") MultipartFile file,
            @RequestParam("title") String title,
            @AuthenticationPrincipal UserDetailsImpl currentUser) {

        if (currentUser == null || currentUser.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required to upload material");
        }
        ReadingMaterialResponse response = readingService.processAndSaveFile(file, currentUser.getId(), title);

        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    /**
     * GET /api/v1/reading/materials
     * Fetch reading materials visible to the authenticated user (system materials + own private materials).
     */
    @GetMapping("/materials")
    public ResponseEntity<List<ReadingMaterialResponse>> getAllMaterials(
            @AuthenticationPrincipal UserDetailsImpl currentUser) {
        Long userId = currentUser != null ? currentUser.getId() : null;
        return ResponseEntity.ok(readingService.getAllMaterials(userId));
    }

    /**
     * GET /api/v1/reading/materials/{id}
     * Fetch a specific reading material by ID if visible to the authenticated user.
     */
    @GetMapping("/materials/{id}")
    public ResponseEntity<ReadingMaterialResponse> getMaterialById(
            @AuthenticationPrincipal UserDetailsImpl currentUser,
            @PathVariable Long id) {
        Long userId = currentUser != null ? currentUser.getId() : null;
        return ResponseEntity.ok(readingService.getMaterialById(id, userId));
    }

    /**
     * DELETE /api/v1/reading/materials/{id}
     * Delete a reading material owned by the authenticated user.
     */
    @DeleteMapping("/materials/{id}")
    public ResponseEntity<Void> deleteMaterial(
            @AuthenticationPrincipal UserDetailsImpl currentUser,
            @PathVariable Long id) {
        if (currentUser == null || currentUser.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required to delete material");
        }
        readingService.deleteMaterial(id, currentUser.getId());
        return ResponseEntity.noContent().build();
    }

    /**
     * DELETE /api/v1/reading/{id}
     * Alternative path for deleting a reading material owned by the authenticated user.
     */
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteMaterialDirect(
            @AuthenticationPrincipal UserDetailsImpl currentUser,
            @PathVariable Long id) {
        if (currentUser == null || currentUser.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required to delete material");
        }
        readingService.deleteMaterial(id, currentUser.getId());
        return ResponseEntity.noContent().build();
    }

    /**
     * POST /api/v1/reading/highlights
     * Save a text highlight for the authenticated user.
     */
    @PostMapping("/highlights")
    public ResponseEntity<Void> saveHighlight(
            @AuthenticationPrincipal UserDetailsImpl currentUser,
            @RequestBody HighlightRequest request) {

        if (currentUser == null || currentUser.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required to save highlights");
        }
        Long userId = currentUser.getId();
        readingService.saveHighlight(userId, request);
        return ResponseEntity.status(HttpStatus.CREATED).build();
    }

    /**
     * POST /api/v1/reading/explain-context
     * Contextual explanation of a word or phrase within a specific reading sentence.
     * Automatically saved into the reading material's persistent vocabulary history.
     */
    @com.englishcoach.premium.interceptor.RequirePremiumAi("READING_CONTEXT_EXPLANATION")
    @PostMapping("/explain-context")
    public ResponseEntity<ContextualVocabularyResponse> explainContext(
            @AuthenticationPrincipal UserDetailsImpl currentUser,
            @Valid @RequestBody ContextualExplainRequest request) {

        if (currentUser == null || currentUser.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required for contextual explanation");
        }
        ContextualVocabularyResponse response = contextualService.explainAndSave(currentUser.getId(), request);
        return ResponseEntity.ok(response);
    }

    /**
     * POST /api/v1/reading/books/explain-selection
     * My Books: contextual meaning + translation of text selected in a book that stays on the learner's device.
     * Explicit click only; the request carries the selection, its sentence and a bounded context — no material id,
     * no file; nothing is persisted. Same Premium feature and quota as Reading's "Giải nghĩa ngữ cảnh".
     */
    @com.englishcoach.premium.interceptor.RequirePremiumAi("READING_CONTEXT_EXPLANATION")
    @PostMapping("/books/explain-selection")
    public ResponseEntity<com.englishcoach.reading.dto.ContextTranslationResponse> explainBookSelection(
            @AuthenticationPrincipal UserDetailsImpl currentUser,
            @Valid @RequestBody com.englishcoach.reading.dto.BookSelectionExplainRequest request) {

        if (currentUser == null || currentUser.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required for contextual explanation");
        }
        return ResponseEntity.ok(com.englishcoach.reading.dto.ContextTranslationResponse.of(
                contextualService.explainBookSelection(currentUser.getId(), request)));
    }

    /**
     * POST /api/v1/reading/extract-contextual-vocabulary
     * Batch extraction of useful learner vocabulary from a sentence/paragraph in a single AI call.
     * Each extracted item is saved into the shared explanation cache and added to the user's reading history.
     */
    @com.englishcoach.premium.interceptor.RequirePremiumAi("READING_CONTEXT_EXPLANATION")
    @PostMapping("/extract-contextual-vocabulary")
    public ResponseEntity<List<ContextualVocabularyResponse>> extractContextualVocabulary(
            @AuthenticationPrincipal UserDetailsImpl currentUser,
            @Valid @RequestBody ParagraphExtractRequest request) {

        if (currentUser == null || currentUser.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required for contextual extraction");
        }
        List<ContextualVocabularyResponse> responses = contextualService.extractAndSaveBatch(currentUser.getId(), request);
        return ResponseEntity.ok(responses);
    }

    /**
     * GET /api/v1/reading/materials/{id}/vocabulary-history
     * Retrieve all saved contextual vocabulary notes for the authenticated user and reading material.
     */
    @GetMapping("/materials/{id}/vocabulary-history")
    public ResponseEntity<List<ContextualVocabularyResponse>> getVocabularyHistory(
            @AuthenticationPrincipal UserDetailsImpl currentUser,
            @PathVariable("id") Long readingMaterialId) {

        if (currentUser == null || currentUser.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required for vocabulary history");
        }
        return ResponseEntity.ok(contextualService.getHistory(currentUser.getId(), readingMaterialId));
    }

    /**
     * DELETE /api/v1/reading/vocabulary-history/{id}
     * Delete a saved contextual vocabulary note owned by the authenticated user.
     */
    @DeleteMapping("/vocabulary-history/{id}")
    public ResponseEntity<Void> deleteVocabularyEntry(
            @AuthenticationPrincipal UserDetailsImpl currentUser,
            @PathVariable("id") Long entryId) {

        if (currentUser == null || currentUser.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required to delete vocabulary entry");
        }
        contextualService.deleteEntry(currentUser.getId(), entryId);
        return ResponseEntity.noContent().build();
    }
}

