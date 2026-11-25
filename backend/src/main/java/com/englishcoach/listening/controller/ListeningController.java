package com.englishcoach.listening.controller;

import com.englishcoach.listening.dto.CreateListeningMaterialRequest;
import com.englishcoach.listening.dto.ListeningMaterialDetailDto;
import com.englishcoach.listening.dto.ListeningMaterialSummaryDto;
import com.englishcoach.listening.service.ListeningService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/listening")
@RequiredArgsConstructor
public class ListeningController {

    private final ListeningService listeningService;
    private final com.englishcoach.auth.policy.AdminIdentityService adminIdentityService;

    @GetMapping("/library")
    public ResponseEntity<List<com.englishcoach.listening.dto.ListeningLibraryItemDto>> getSharedLibrary() {
        return ResponseEntity.ok(listeningService.getSharedLibrary());
    }

    @GetMapping({"/library/categories", "/categories"})
    public ResponseEntity<List<com.englishcoach.listening.dto.ListeningCategoryDto>> getLibraryCategories() {
        return ResponseEntity.ok(listeningService.getLibraryCategories());
    }

    @GetMapping("/materials")
    public ResponseEntity<List<ListeningMaterialSummaryDto>> getMaterials(
            @RequestParam(required = false) String cefrLevel,
            @RequestParam(required = false) String topic,
            @RequestParam(required = false) String accent,
            @RequestParam(required = false, defaultValue = "false") boolean personalOnly,
            @org.springframework.security.core.annotation.AuthenticationPrincipal com.englishcoach.common.security.UserDetailsImpl currentUser) {
        Long userId = currentUser != null ? currentUser.getId() : null;
        if (personalOnly) {
            return ResponseEntity.ok(listeningService.getPersonalMaterials(cefrLevel, topic, accent, userId));
        }
        List<ListeningMaterialSummaryDto> materials = listeningService.getAllMaterials(cefrLevel, topic, accent, userId);
        return ResponseEntity.ok(materials);
    }

    @GetMapping("/materials/{id}")
    public ResponseEntity<ListeningMaterialDetailDto> getMaterialById(
            @PathVariable Long id,
            @org.springframework.security.core.annotation.AuthenticationPrincipal com.englishcoach.common.security.UserDetailsImpl currentUser) {
        Long userId = currentUser != null ? currentUser.getId() : null;
        ListeningMaterialDetailDto material = listeningService.getMaterialById(id, userId);
        return ResponseEntity.ok(material);
    }

    @PostMapping("/materials")
    public ResponseEntity<ListeningMaterialDetailDto> createMaterial(
            @Valid @RequestBody CreateListeningMaterialRequest request,
            @org.springframework.security.core.annotation.AuthenticationPrincipal com.englishcoach.common.security.UserDetailsImpl currentUser) {
        if (currentUser == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required to create listening material");
        }
        ListeningMaterialDetailDto material = listeningService.createMaterial(request, currentUser.getId());
        return ResponseEntity.status(HttpStatus.CREATED).body(material);
    }

    @GetMapping("/materials/{id}/exercises")
    public ResponseEntity<List<com.englishcoach.listening.dto.ListeningExerciseDto>> getExercises(
            @PathVariable Long id,
            @org.springframework.security.core.annotation.AuthenticationPrincipal com.englishcoach.common.security.UserDetailsImpl currentUser) {
        Long userId = currentUser != null ? currentUser.getId() : null;
        return ResponseEntity.ok(listeningService.getExercisesForMaterial(id, userId));
    }

    @PostMapping("/exercises/{exerciseId}/attempts")
    public ResponseEntity<com.englishcoach.listening.dto.ExerciseAttemptResponse> submitAttempt(
            @PathVariable Long exerciseId,
            @Valid @RequestBody com.englishcoach.listening.dto.ExerciseAttemptRequest request,
            @org.springframework.security.core.annotation.AuthenticationPrincipal com.englishcoach.common.security.UserDetailsImpl currentUser) {
        Long userId = currentUser != null ? currentUser.getId() : null;
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(listeningService.submitExerciseAttempt(exerciseId, request, userId));
    }

    @com.englishcoach.premium.interceptor.RequirePremiumAi("LISTENING_YOUTUBE_IMPORT")
    @PostMapping("/import")
    public ResponseEntity<ListeningMaterialDetailDto> importMaterial(
            @Valid @RequestBody com.englishcoach.listening.dto.ImportListeningMaterialRequest request,
            @org.springframework.security.core.annotation.AuthenticationPrincipal com.englishcoach.common.security.UserDetailsImpl currentUser) {
        if (currentUser == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required to import listening material");
        }
        ListeningMaterialDetailDto material = listeningService.importMaterialFromYouTube(request, currentUser.getId());
        return ResponseEntity.status(HttpStatus.CREATED).body(material);
    }

    @PostMapping({"/admin/import", "/system/import"})
    public ResponseEntity<ListeningMaterialDetailDto> importSystemMaterial(
            @Valid @RequestBody com.englishcoach.listening.dto.ImportListeningMaterialRequest request,
            @org.springframework.security.core.annotation.AuthenticationPrincipal com.englishcoach.common.security.UserDetailsImpl currentUser) {
        if (currentUser == null || !currentUser.getAuthorities().stream().anyMatch(a -> a.getAuthority().equals("ROLE_ADMIN"))) {
            throw new org.springframework.security.access.AccessDeniedException("Admin role required to import system listening materials");
        }
        ListeningMaterialDetailDto material = listeningService.importSystemMaterial(request);
        return ResponseEntity.status(HttpStatus.CREATED).body(material);
    }

    /**
     * Re-processes an existing YouTube lesson (same id) through the local WhisperX pipeline when its stored timing is
     * invalid. Official administrator only; refused when learners already have records on the lesson (10 §BE).
     */
    @PostMapping("/system/materials/{id}/reprocess")
    public ResponseEntity<ListeningMaterialDetailDto> reprocessMaterial(
            @PathVariable Long id,
            @org.springframework.security.core.annotation.AuthenticationPrincipal com.englishcoach.common.security.UserDetailsImpl currentUser) {
        if (currentUser == null || !currentUser.getAuthorities().stream().anyMatch(a -> a.getAuthority().equals("ROLE_ADMIN"))) {
            throw new org.springframework.security.access.AccessDeniedException("Admin role required to reprocess listening materials");
        }
        adminIdentityService.requireOfficialAdmin(currentUser.getId());
        return ResponseEntity.ok(listeningService.reprocessYouTubeMaterial(id));
    }

    @DeleteMapping("/materials/{id}")
    public ResponseEntity<Void> deleteMaterial(
            @PathVariable Long id,
            @org.springframework.security.core.annotation.AuthenticationPrincipal com.englishcoach.common.security.UserDetailsImpl currentUser) {
        if (currentUser == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required to delete listening material");
        }
        listeningService.deleteMaterial(id, currentUser.getId());
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteMaterialDirect(
            @PathVariable Long id,
            @org.springframework.security.core.annotation.AuthenticationPrincipal com.englishcoach.common.security.UserDetailsImpl currentUser) {
        if (currentUser == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required to delete listening material");
        }
        listeningService.deleteMaterial(id, currentUser.getId());
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/sessions/{sessionId}/complete")
    public ResponseEntity<Void> completeSession(
            @PathVariable Long sessionId,
            @org.springframework.security.core.annotation.AuthenticationPrincipal com.englishcoach.common.security.UserDetailsImpl currentUser) {
        if (currentUser == null) {
            throw new org.springframework.security.access.AccessDeniedException("Authentication required to complete listening session");
        }
        listeningService.completeSession(sessionId, currentUser.getId());
        return ResponseEntity.ok().build();
    }
}

