package com.englishcoach.speaking.controller;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.premium.interceptor.RequirePremiumAi;
import com.englishcoach.speaking.dto.CreateCustomScenarioRequestDto;
import com.englishcoach.speaking.dto.ScenarioCatalogMetadataDto;
import com.englishcoach.speaking.dto.SpeakingScenarioDto;
import com.englishcoach.speaking.dto.SpeakingScenarioSummaryDto;
import com.englishcoach.speaking.entity.enums.CefrLevel;
import com.englishcoach.speaking.entity.enums.ScenarioCategory;
import com.englishcoach.speaking.service.SpeakingScenarioService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/speaking/scenarios")
@RequiredArgsConstructor
public class SpeakingScenarioController {

    private final SpeakingScenarioService speakingScenarioService;

    @GetMapping
    public ResponseEntity<List<SpeakingScenarioSummaryDto>> getScenarios(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestParam(required = false) String cefrLevel,
            @RequestParam(required = false) String category) {
        Long userId = userDetails != null ? userDetails.getId() : null;
        CefrLevel parsedCefr = CefrLevel.fromString(cefrLevel);
        ScenarioCategory parsedCategory = ScenarioCategory.fromString(category);
        List<SpeakingScenarioSummaryDto> scenarios = speakingScenarioService.getScenarios(userId, parsedCefr, parsedCategory);
        return ResponseEntity.ok(scenarios);
    }

    @GetMapping("/metadata")
    public ResponseEntity<ScenarioCatalogMetadataDto> getCatalogMetadata(
            @AuthenticationPrincipal UserDetailsImpl userDetails) {
        Long userId = userDetails != null ? userDetails.getId() : null;
        return ResponseEntity.ok(speakingScenarioService.getCatalogMetadata(userId));
    }

    @GetMapping("/{id}")
    public ResponseEntity<SpeakingScenarioDto> getScenarioById(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long id) {
        Long userId = userDetails != null ? userDetails.getId() : null;
        SpeakingScenarioDto scenario = speakingScenarioService.getScenarioById(userId, id);
        return ResponseEntity.ok(scenario);
    }

    @PutMapping("/{id}")
    public ResponseEntity<SpeakingScenarioDto> updateCustomScenario(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long id,
            @RequestBody CreateCustomScenarioRequestDto request) {
        if (userDetails == null) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.UNAUTHORIZED, "Authentication required to update custom scenario");
        }
        SpeakingScenarioDto scenario = speakingScenarioService.updateCustomScenario(userDetails.getId(), id, request);
        return ResponseEntity.ok(scenario);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteCustomScenario(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @PathVariable Long id) {
        if (userDetails == null) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.UNAUTHORIZED, "Authentication required to delete custom scenario");
        }
        speakingScenarioService.deleteCustomScenario(userDetails.getId(), id);
        return ResponseEntity.noContent().build();
    }

    @RequirePremiumAi(value = "SPEAKING_ROLEPLAY", reuseClientRequestId = false)
    @PostMapping("/custom")
    public ResponseEntity<SpeakingScenarioDto> createCustomScenario(
            @AuthenticationPrincipal UserDetailsImpl userDetails,
            @RequestBody CreateCustomScenarioRequestDto request) {
        if (userDetails == null) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.UNAUTHORIZED, "Authentication required to create custom scenario");
        }
        SpeakingScenarioDto scenario = speakingScenarioService.createCustomScenario(userDetails.getId(), request);
        return ResponseEntity.ok(scenario);
    }
}
