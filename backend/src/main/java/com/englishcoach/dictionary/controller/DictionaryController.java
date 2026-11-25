package com.englishcoach.dictionary.controller;

import com.englishcoach.dictionary.dto.CanonicalDictionaryResponse;
import com.englishcoach.dictionary.dto.CollocationsResponse;
import com.englishcoach.dictionary.dto.DictionaryResponse;
import com.englishcoach.dictionary.dto.PhrasesResponse;
import com.englishcoach.dictionary.service.DictionaryEngine;
import com.englishcoach.dictionary.service.DictionaryService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@Slf4j
@RestController
@RequestMapping({"/api/dictionary", "/api/v1/dictionary"})
@RequiredArgsConstructor
public class DictionaryController {

    public static final int MAX_WORD_LENGTH = 80;

    private final DictionaryEngine dictionaryEngine;
    private final DictionaryService dictionaryService;

    private static boolean isValidWordInput(String word) {
        return word != null && !word.isBlank() && word.length() <= MAX_WORD_LENGTH;
    }

    /**
     * Unified Dictionary Engine V2 lookup endpoint.
     * Returns the full canonical dictionary entry with multiple senses, pronunciations, examples, etc.
     */
    @GetMapping("/v2/lookup")
    public ResponseEntity<CanonicalDictionaryResponse> lookupV2(
            @RequestParam String word,
            @RequestParam(defaultValue = "en-en") String mode) {
        if (!isValidWordInput(word)) {
            return ResponseEntity.badRequest().build();
        }
        try {
            CanonicalDictionaryResponse response = dictionaryEngine.lookup(word, mode);
            if (response == null) {
                return ResponseEntity.notFound().build();
            }
            return ResponseEntity.ok(response);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().build();
        } catch (Exception e) {
            log.error("Dictionary lookup error for '{}': {}", word, e.getMessage());
            return ResponseEntity.internalServerError().build();
        }
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.englishcoach.dictionary.provider.LocalEnViLexicalProvider localEnVi;

    /**
     * Autocomplete for vocabulary search fields: up to {@code limit} (≤ 10) corpus words starting with {@code q}
     * (2–40 characters), each with its first Vietnamese meaning. Local and bounded; never calls a provider or AI.
     */
    @GetMapping("/v2/suggest")
    public ResponseEntity<java.util.List<com.englishcoach.dictionary.provider.LocalEnViLexicalProvider.Suggestion>> suggest(
            @RequestParam String q,
            @RequestParam(defaultValue = "8") int limit) {
        if (localEnVi == null) return ResponseEntity.ok(java.util.List.of());
        return ResponseEntity.ok()
                .cacheControl(org.springframework.http.CacheControl.maxAge(java.time.Duration.ofHours(1)).cachePrivate())
                .body(localEnVi.suggest(q, limit));
    }

    /**
     * Collocations endpoint grouped by lexical patterns (Verb + Noun, Adjective + Noun, etc.)
     */
    @GetMapping("/v2/collocations")
    public ResponseEntity<CollocationsResponse> getCollocations(@RequestParam String word) {
        if (!isValidWordInput(word)) {
            return ResponseEntity.badRequest().build();
        }
        try {
            return ResponseEntity.ok(dictionaryEngine.getCollocations(word));
        } catch (Exception e) {
            log.error("Collocations error for '{}': {}", word, e.getMessage());
            return ResponseEntity.internalServerError().build();
        }
    }

    /**
     * Phrasal verbs and idioms endpoint.
     */
    @GetMapping("/v2/phrases")
    public ResponseEntity<PhrasesResponse> getPhrases(@RequestParam String word) {
        if (!isValidWordInput(word)) {
            return ResponseEntity.badRequest().build();
        }
        try {
            return ResponseEntity.ok(dictionaryEngine.getPhrases(word));
        } catch (Exception e) {
            log.error("Phrases error for '{}': {}", word, e.getMessage());
            return ResponseEntity.internalServerError().build();
        }
    }

    /**
     * Legacy endpoint preserved for backward compatibility.
     * Calls DictionaryEngine deterministically (no LLM).
     */
    @GetMapping("/lookup")
    public ResponseEntity<DictionaryResponse> lookupWord(@RequestParam String word) {
        if (!isValidWordInput(word)) {
            return ResponseEntity.badRequest().build();
        }
        try {
            DictionaryResponse response = dictionaryService.lookupWord(word);
            if (response == null) {
                return ResponseEntity.notFound().build();
            }
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.warn("Legacy lookup error for '{}': {}", word, e.getMessage());
            return ResponseEntity.badRequest().build();
        }
    }
}
