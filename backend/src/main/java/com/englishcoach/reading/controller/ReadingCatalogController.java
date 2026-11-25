package com.englishcoach.reading.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.reading.service.ReadingCatalogService;
import com.englishcoach.reading.service.ReadingCompletionService;
import com.englishcoach.reading.dto.ReadingCatalogResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.http.ResponseEntity;
import org.springframework.http.CacheControl;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/reading")
@RequiredArgsConstructor
public class ReadingCatalogController {
    private final ReadingCatalogService service;
    private final ReadingCompletionService completion;
    private Long userId(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new org.springframework.security.access.AccessDeniedException("Authentication required");
        return user.getId();
    }
    @GetMapping("/catalog")
    public ResponseEntity<ReadingCatalogResponse> catalog(@AuthenticationPrincipal UserDetailsImpl user,
            @RequestParam(defaultValue="SYSTEM") String library, @RequestParam(defaultValue="0") int page,
            @RequestParam(defaultValue="18") int size, @RequestParam(defaultValue="") String search,
            @RequestParam(defaultValue="") String topic, @RequestParam(defaultValue="") String level,
            @RequestParam(defaultValue="recent") String sort) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.catalog(userId(user), library, page, size, search, topic, level, sort));
    }
    @GetMapping("/progress")
    public ResponseEntity<List<ReadingCatalogResponse.Progress>> progress(@AuthenticationPrincipal UserDetailsImpl user) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.progress(userId(user)));
    }
    /** Opening the reader: records the session start (server time); answers whether the material is already read. */
    @PostMapping("/materials/{id}/session")
    public ResponseEntity<ReadingCompletionService.State> openSession(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable long id) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(completion.open(userId(user), id));
    }
    /** "Hoàn thành bài đọc": accepted only after the server-measured minimum reading time (409 READING_TOO_FAST before). */
    @PostMapping("/materials/{id}/complete")
    public ResponseEntity<?> complete(@AuthenticationPrincipal UserDetailsImpl user, @PathVariable long id) {
        ReadingCompletionService.Completion c = completion.complete(userId(user), id);
        if (c.accepted()) return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(c.state());
        return ResponseEntity.status(409).cacheControl(CacheControl.noStore())
                .body(Map.of("code", "READING_TOO_FAST", "retryAfterSeconds", c.retryAfterSeconds()));
    }
}
