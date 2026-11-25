package com.englishcoach.exams.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.model.ExamSpeakingRecords.*;
import com.englishcoach.exams.service.ExamSpeakingRuntimeService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

@Slf4j
@RestController
@RequestMapping("/api/v1/exams/attempts/{attemptId}/speaking")
@RequiredArgsConstructor
public class ExamSpeakingController {

    private final ExamSpeakingRuntimeService speakingRuntimeService;
    private final com.englishcoach.exams.media.ExamMediaService mediaService;

    @GetMapping({"", "/state"})
    public ResponseEntity<SpeakingRuntimeStateDto> getSpeakingState(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID attemptId
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(speakingRuntimeService.getOrInitializeSpeakingState(userDetails.getId(), attemptId));
    }

    @PostMapping("/prepare")
    public ResponseEntity<SpeakingRuntimeStateDto> startPreparation(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID attemptId,
            @RequestBody(required = false) StartPreparationCommand cmd
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(speakingRuntimeService.startPreparation(userDetails.getId(), attemptId, cmd));
    }

    @PostMapping("/start-recording")
    public ResponseEntity<SpeakingRuntimeStateDto> startRecording(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID attemptId,
            @RequestBody(required = false) StartRecordingCommand cmd
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(speakingRuntimeService.startRecording(userDetails.getId(), attemptId, cmd));
    }

    @PostMapping("/stop-recording")
    public ResponseEntity<SpeakingRuntimeStateDto> stopRecording(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID attemptId,
            @RequestBody(required = false) StopRecordingCommand cmd
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(speakingRuntimeService.stopRecording(userDetails.getId(), attemptId, cmd));
    }

    @GetMapping("/turns/{turnKey}")
    public ResponseEntity<SpeakingTurnDto> getSpeakingTurn(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID attemptId,
            @PathVariable String turnKey
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(speakingRuntimeService.getSpeakingTurn(userDetails.getId(), attemptId, turnKey));
    }

    @PostMapping("/complete-turn")
    public ResponseEntity<SpeakingRuntimeStateDto> completeTurn(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID attemptId,
            @RequestBody CompleteTurnCommand cmd
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        return ResponseEntity.ok(speakingRuntimeService.completeTurn(userDetails.getId(), attemptId, cmd));
    }

    @PostMapping("/turns/{turnKey}/recordings")
    public ResponseEntity<com.englishcoach.exams.model.ExamMediaRecords.InitiateRecordingResponseDto> initiateTurnRecording(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable UUID attemptId,
            @PathVariable String turnKey,
            @RequestBody(required = false) com.englishcoach.exams.model.ExamMediaRecords.InitiateRecordingRequest request
    ) {
        if (userDetails == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }
        com.englishcoach.exams.model.ExamMediaRecords.InitiateRecordingRequest effectiveReq =
                new com.englishcoach.exams.model.ExamMediaRecords.InitiateRecordingRequest(
                        attemptId,
                        request != null && request.placementId() != null ? request.placementId() : null,
                        request != null && request.codec() != null ? request.codec() : "audio/webm",
                        request != null && request.deviceMeta() != null ? request.deviceMeta() : java.util.Map.of(),
                        turnKey,
                        request != null ? request.commandId() : null,
                        request != null ? request.expectedAttemptRevision() : null
                );
        return ResponseEntity.ok(mediaService.initiateRecording(userDetails.getId(), attemptId, effectiveReq));
    }
}
