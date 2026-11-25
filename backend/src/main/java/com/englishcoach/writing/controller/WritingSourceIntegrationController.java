package com.englishcoach.writing.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.writing.dto.CreateSessionFromSourceRequest;
import com.englishcoach.writing.dto.WritingSessionDto;
import com.englishcoach.writing.dto.WritingSourceContextDto;
import com.englishcoach.writing.enums.WritingSourceType;
import com.englishcoach.writing.service.WritingSourceAdapterService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Slf4j
@RestController
@RequestMapping("/api/v1/writing/sources")
@RequiredArgsConstructor
public class WritingSourceIntegrationController {

    private final WritingSourceAdapterService sourceAdapterService;

    private Long requireUserId(UserDetailsImpl userDetails) {
        if (userDetails == null || userDetails.getId() == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required for writing source operations");
        }
        return userDetails.getId();
    }

    @GetMapping("/available")
    public ResponseEntity<List<WritingSourceContextDto>> getAvailableSources(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(required = false) WritingSourceType sourceType
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(sourceAdapterService.getAvailableSourceContexts(userId, sourceType));
    }

    @GetMapping("/context")
    public ResponseEntity<WritingSourceContextDto> getSourceContext(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam WritingSourceType sourceType,
            @RequestParam(required = false) String sourceId
    ) {
        Long userId = requireUserId(userDetails);
        return ResponseEntity.ok(sourceAdapterService.getSourceContext(userId, sourceType, sourceId));
    }

    @PostMapping("/create-session")
    public ResponseEntity<WritingSessionDto> createSessionFromSource(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @Valid @RequestBody CreateSessionFromSourceRequest request
    ) {
        Long userId = requireUserId(userDetails);
        WritingSessionDto session = sourceAdapterService.createSessionFromSource(
                userId, request.getSourceType(), request.getSourceId()
        );
        return ResponseEntity.status(HttpStatus.CREATED).body(session);
    }
}
