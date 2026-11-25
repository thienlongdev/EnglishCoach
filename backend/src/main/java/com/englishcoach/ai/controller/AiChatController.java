package com.englishcoach.ai.controller;

import com.englishcoach.ai.dto.AiChatRequest;
import com.englishcoach.ai.dto.AiChatResponse;
import com.englishcoach.ai.service.AiChatService;
import com.englishcoach.ai.service.LearnerDnaAggregatorService;
import com.englishcoach.ai.service.LearnerDnaAggregatorService.LearnerDnaProfile;
import com.englishcoach.common.security.UserDetailsImpl;
import jakarta.validation.Valid;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.context.RequestAttributeSecurityContextRepository;
import org.springframework.beans.factory.annotation.Autowired;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

@RestController
@RequestMapping("/api/v1/ai")
@Slf4j
public class AiChatController {

    private final AiChatService aiChatService;
    private final LearnerDnaAggregatorService learnerDnaAggregatorService;

    @Autowired
    public AiChatController(AiChatService aiChatService, LearnerDnaAggregatorService learnerDnaAggregatorService) {
        this.aiChatService = aiChatService;
        this.learnerDnaAggregatorService = learnerDnaAggregatorService;
    }

    public AiChatController(AiChatService aiChatService) {
        this.aiChatService = aiChatService;
        this.learnerDnaAggregatorService = null;
    }

    @GetMapping("/learner-dna")
    public ResponseEntity<LearnerDnaProfile> getLearnerDna(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(value = "refresh", defaultValue = "false") boolean refresh) {
        Long userId = userDetails != null ? userDetails.getId() : null;
        log.info("Requesting 7-day Learner DNA: userId={}, refresh={}", userId, refresh);
        LearnerDnaProfile dna = learnerDnaAggregatorService != null
                ? learnerDnaAggregatorService.getLearnerDna(userId, refresh)
                : null;
        return ResponseEntity.ok(dna);
    }

    @PostMapping("/chat")
    public ResponseEntity<AiChatResponse> chat(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @Valid @RequestBody AiChatRequest request) {
        Long userId = userDetails != null ? userDetails.getId() : null;
        log.info("Received Echo AI chat request: userId={}, messagesCount={}", userId, request.messages().size());
        AiChatResponse response = aiChatService.chat(userId, request);
        return ResponseEntity.ok(response);
    }

    @DeleteMapping("/chat/stream/{turnId:[A-Za-z0-9-]{8,64}}")
    public ResponseEntity<Void> cancel(@AuthenticationPrincipal UserDetailsImpl principal, @PathVariable String turnId) {
        aiChatService.cancelStream(principal == null ? null : principal.getId(), turnId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping(value = "/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamChat(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @Valid @RequestBody AiChatRequest request, HttpServletRequest servletRequest, HttpServletResponse servletResponse) {
        Long userId = userDetails != null ? userDetails.getId() : null;
        // Preserve this authenticated request on the container's terminal ASYNC dispatch only.
        if (userId != null) new RequestAttributeSecurityContextRepository()
                .saveContext(SecurityContextHolder.getContext(),servletRequest,servletResponse);
        log.info("Received Echo AI streaming chat request: userId={}, messagesCount={}", userId, request.messages().size());
        return aiChatService.streamChat(userId, request);
    }
}
