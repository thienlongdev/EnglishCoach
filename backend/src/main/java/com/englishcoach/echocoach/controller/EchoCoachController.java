package com.englishcoach.echocoach.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.echocoach.dto.CreateSessionRequest;
import com.englishcoach.echocoach.dto.EchoCoachMessageDto;
import com.englishcoach.echocoach.dto.EchoCoachSessionDto;
import com.englishcoach.echocoach.dto.SaveMessagePairRequest;
import com.englishcoach.echocoach.service.EchoCoachService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/echo-coach/sessions")
@RequiredArgsConstructor
@Slf4j
public class EchoCoachController {

    private final EchoCoachService echoCoachService;

    @GetMapping
    public ResponseEntity<List<EchoCoachSessionDto>> getRecentSessions(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        List<EchoCoachSessionDto> sessions = echoCoachService.getRecentSessions(principal.getId());
        return ResponseEntity.ok(sessions);
    }

    @PostMapping
    public ResponseEntity<EchoCoachSessionDto> createSession(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @Valid @RequestBody(required = false) CreateSessionRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        EchoCoachSessionDto created = echoCoachService.createSession(principal.getId(), request);
        return ResponseEntity.status(HttpStatus.CREATED).body(created);
    }

    @GetMapping("/{id}/messages")
    public ResponseEntity<List<EchoCoachMessageDto>> getSessionMessages(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable("id") Long sessionId
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        List<EchoCoachMessageDto> messages = echoCoachService.getSessionMessages(principal.getId(), sessionId);
        return ResponseEntity.ok(messages);
    }

    @PostMapping("/{id}/messages")
    public ResponseEntity<List<EchoCoachMessageDto>> saveMessages(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable("id") Long sessionId,
            @Valid @RequestBody SaveMessagePairRequest request
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        List<EchoCoachMessageDto> saved = echoCoachService.saveMessages(principal.getId(), sessionId, request);
        return ResponseEntity.status(HttpStatus.CREATED).body(saved);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteSession(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable("id") Long sessionId
    ) {
        if (principal == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        echoCoachService.deleteSession(principal.getId(), sessionId);
        return ResponseEntity.noContent().build();
    }
}
