package com.englishcoach.avatarframe.controller;

import com.englishcoach.avatarframe.dto.AvatarFrameDto;
import com.englishcoach.avatarframe.service.AvatarFrameService;
import com.englishcoach.common.security.UserDetailsImpl;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

@RestController
@RequestMapping("/api/v1/frames")
@RequiredArgsConstructor
@Slf4j
public class AvatarFrameController {

    private final AvatarFrameService avatarFrameService;

    /**
     * Retrieves the frame catalogue with user-specific ownership, equipped status,
     * and real server-authoritative progress metrics.
     * Anonymous access returns unowned frames with 0% baseline progress.
     */
    @GetMapping("/catalogue")
    public ResponseEntity<List<AvatarFrameDto>> getCatalogue(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        Long userId = principal != null ? principal.getId() : null;
        List<AvatarFrameDto> catalogue = avatarFrameService.getCatalogue(userId);
        return ResponseEntity.ok(catalogue);
    }

    /**
     * Retrieves the authenticated user's inventory of owned frames.
     */
    @GetMapping("/inventory")
    public ResponseEntity<List<AvatarFrameDto>> getInventory(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        if (principal == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required to view inventory");
        }
        List<AvatarFrameDto> inventory = avatarFrameService.getInventory(principal.getId());
        return ResponseEntity.ok(inventory);
    }

    /**
     * Retrieves details and progress for a single avatar frame by slug.
     */
    @GetMapping("/{slug}")
    public ResponseEntity<AvatarFrameDto> getFrameBySlug(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable String slug
    ) {
        Long userId = principal != null ? principal.getId() : null;
        AvatarFrameDto frame = avatarFrameService.getFrameBySlug(userId, slug);
        return ResponseEntity.ok(frame);
    }

    /**
     * Authoritatively equips an owned frame for the authenticated user.
     * Enforces active status, unexpired ownership, and the single-equipped invariant.
     */
    @PostMapping("/{slug}/equip")
    public ResponseEntity<AvatarFrameDto> equipFrame(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @PathVariable String slug
    ) {
        if (principal == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required to equip frame");
        }
        AvatarFrameDto equipped = avatarFrameService.equipFrame(principal.getId(), slug);
        return ResponseEntity.ok(equipped);
    }

    /**
     * Authoritatively unequips the user's current frame (idempotent).
     * No-frame state is valid and persistent.
     */
    @PostMapping("/unequip")
    public ResponseEntity<Void> unequipFrame(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        if (principal == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required to unequip frame");
        }
        avatarFrameService.unequipFrame(principal.getId());
        return ResponseEntity.noContent().build();
    }

    /**
     * Explicitly reconciles eligibility and triggers auto-unlock for newly earned frames.
     */
    @PostMapping("/reconcile")
    public ResponseEntity<List<AvatarFrameDto>> reconcileEligibility(
            @AuthenticationPrincipal UserDetailsImpl principal
    ) {
        if (principal == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required to reconcile frames");
        }
        List<AvatarFrameDto> newlyUnlocked = avatarFrameService.reconcileUserEligibility(principal.getId());
        return ResponseEntity.ok(newlyUnlocked);
    }
}
