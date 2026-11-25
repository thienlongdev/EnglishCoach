package com.englishcoach.content.controller;

import com.englishcoach.content.dto.*;
import com.englishcoach.content.service.ContentService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import com.englishcoach.common.security.UserDetailsImpl;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;

import java.time.LocalDate;
import java.util.List;

@RestController
@RequestMapping("/api/v1/content")
@RequiredArgsConstructor
public class ContentController {

    private final ContentService contentService;

    @GetMapping("/feed")
    public ResponseEntity<List<FeedArticleDto>> getFeed() {
        return ResponseEntity.ok(contentService.getFeed());
    }

    @GetMapping("/listening/today")
    public ResponseEntity<ListeningTodayDto> getListeningToday() {
        return contentService.getListeningToday(LocalDate.now())
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    @GetMapping("/dictation/today")
    public ResponseEntity<DictationTodayDto> getDictationToday() {
        return contentService.getDictationToday(LocalDate.now())
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    @GetMapping("/vocabulary/trending")
    public ResponseEntity<List<TrendingVocabularyDto>> getTrendingVocabulary(
            @RequestParam(required = false) @org.springframework.format.annotation.DateTimeFormat(iso = org.springframework.format.annotation.DateTimeFormat.ISO.DATE) LocalDate date) {
        return ResponseEntity.ok(date != null ? contentService.getDailyVocabulary(date) : contentService.getTrendingVocabulary());
    }

    @GetMapping("/vocabulary/daily")
    public ResponseEntity<List<TrendingVocabularyDto>> getDailyVocabulary(
            @RequestParam(required = false) @org.springframework.format.annotation.DateTimeFormat(iso = org.springframework.format.annotation.DateTimeFormat.ISO.DATE) LocalDate date) {
        return ResponseEntity.ok(date != null ? contentService.getDailyVocabulary(date) : contentService.getTrendingVocabulary());
    }

    @GetMapping("/reading/{articleId}")
    public ResponseEntity<ReadingArticleDto> getReadingContent(
            @PathVariable Long articleId,
            @AuthenticationPrincipal UserDetailsImpl currentUser) {
        Long userId = (currentUser != null) ? currentUser.getId() : null;
        return ResponseEntity.ok(contentService.getReadingContent(articleId, userId));
    }

    @PostMapping("/reading/save/{articleId}")
    public ResponseEntity<SaveReadingResponseDto> saveReadingMaterial(
            @PathVariable Long articleId,
            @AuthenticationPrincipal UserDetailsImpl currentUser) {
        if (currentUser == null || currentUser.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required to save reading material");
        }
        SaveReadingResponseDto response = contentService.saveReadingArticle(articleId, currentUser.getId());
        if (response.isAlreadySaved()) {
            return ResponseEntity.ok(response);
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }
}
