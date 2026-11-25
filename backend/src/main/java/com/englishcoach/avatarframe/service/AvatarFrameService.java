package com.englishcoach.avatarframe.service;

import com.englishcoach.avatarframe.dto.AvatarFrameDto;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

public interface AvatarFrameService {

    /**
     * Retrieves the complete frame catalogue with the user's authoritative ownership context
     * and real derived progress metrics. Automatically self-heals / auto-unlocks eligible frames.
     *
     * @param userId Authenticated user ID (null for anonymous visitors)
     * @return Ordered list of catalogue frame DTOs
     */
    List<AvatarFrameDto> getCatalogue(Long userId);

    /**
     * Retrieves the user's inventory of owned avatar frames.
     *
     * @param userId Authenticated user ID
     * @return List of owned AvatarFrameDtos
     */
    List<AvatarFrameDto> getInventory(Long userId);

    /**
     * Retrieves a single frame definition with ownership and progress context.
     *
     * @param userId Authenticated user ID (or null)
     * @param slug Unique slug of the frame
     * @return AvatarFrameDto
     */
    AvatarFrameDto getFrameBySlug(Long userId, String slug);

    /**
     * Authoritatively equips an owned, non-expired, active frame for the authenticated user.
     * Strictly enforces single-equipped invariant atomically.
     *
     * @param userId Authenticated user ID
     * @param frameSlug Unique slug of the target frame
     * @return Equipped AvatarFrameDto
     */
    AvatarFrameDto equipFrame(Long userId, String frameSlug);

    /**
     * Authoritatively unequips the user's current frame (idempotent).
     * No-frame state is valid and persistent.
     *
     * @param userId Authenticated user ID
     */
    void unequipFrame(Long userId);

    /**
     * Retrieves the user's currently equipped frame, if any.
     *
     * @param userId Authenticated user ID
     * @return Optional AvatarFrameDto
     */
    Optional<AvatarFrameDto> getEquippedFrame(Long userId);

    /**
     * Batch-loads currently equipped, non-expired avatar frames for display surfaces (e.g., community feeds)
     * in a single query, bypassing {@code PrestigeEvaluationEngine.computeProgress}.
     */
    default Map<Long, AvatarFrameDto> getEquippedFramesBatch(Set<Long> userIds) {
        if (userIds == null || userIds.isEmpty()) {
            return Map.of();
        }
        Map<Long, AvatarFrameDto> out = new HashMap<>();
        for (Long userId : userIds) {
            if (userId != null) {
                getEquippedFrame(userId).ifPresent(dto -> out.put(userId, dto));
            }
        }
        return out;
    }

    /**
     * Evaluates domain metrics and automatically unlocks any newly eligible frames
     * for the user. Emits unlock notifications for high-tier frames.
     * Idempotent and safe to run on-demand or on learning events.
     *
     * @param userId Authenticated user ID
     * @return List of newly unlocked AvatarFrameDtos
     */
    List<AvatarFrameDto> reconcileUserEligibility(Long userId);
}
