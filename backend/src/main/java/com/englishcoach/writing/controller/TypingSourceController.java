package com.englishcoach.writing.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.writing.dto.TypingSourceDto;
import com.englishcoach.writing.service.TypingSourceService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/writing/typing/sources")
@RequiredArgsConstructor
public class TypingSourceController {
    private final TypingSourceService service;
    private Long userId(UserDetailsImpl user) {
        if (user == null || user.getId() == null) throw new AccessDeniedException("Authentication required");
        return user.getId();
    }
    @GetMapping
    public ResponseEntity<TypingSourceDto.Page> list(@AuthenticationPrincipal UserDetailsImpl user,
            @RequestParam String category, @RequestParam(defaultValue = "0") int page) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.list(userId(user), category, page));
    }
    @GetMapping("/{id}")
    public ResponseEntity<TypingSourceDto> detail(@AuthenticationPrincipal UserDetailsImpl user,
            @PathVariable String id, @RequestParam String category) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(service.detail(userId(user), category, id));
    }
}
