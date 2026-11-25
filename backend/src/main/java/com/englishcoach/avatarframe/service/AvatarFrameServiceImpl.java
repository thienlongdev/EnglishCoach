package com.englishcoach.avatarframe.service;

import com.englishcoach.avatarframe.dto.AvatarFrameDto;
import com.englishcoach.avatarframe.dto.AvatarFrameOwnershipDto;
import com.englishcoach.avatarframe.dto.AvatarFrameProgressDto;
import com.englishcoach.avatarframe.dto.AvatarFrameSeriesDto;
import com.englishcoach.avatarframe.entity.AvatarFrame;
import com.englishcoach.avatarframe.entity.AvatarFrameSeries;
import com.englishcoach.avatarframe.entity.UserAvatarFrame;
import com.englishcoach.avatarframe.evaluator.PrestigeEvaluationEngine;
import com.englishcoach.avatarframe.repository.AvatarFrameRepository;
import com.englishcoach.avatarframe.repository.UserAvatarFrameRepository;
import com.englishcoach.common.cache.BoundedTtlCache;
import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.notification.service.NotificationService;
import com.englishcoach.premium.entity.PremiumSubscription;
import com.englishcoach.premium.repository.PremiumSubscriptionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
@Slf4j
public class AvatarFrameServiceImpl implements AvatarFrameService {

    private static final String ACTIVE_FRAMES_CACHE_KEY = "active-frames";
    private static final AvatarFrameProgressDto EQUIPPED_DISPLAY_PROGRESS = new AvatarFrameProgressDto(
            1.0, 1.0, 100.0, "EQUIPPED", "ELIGIBLE", "", ""
    );

    private final AvatarFrameRepository avatarFrameRepository;
    private final UserAvatarFrameRepository userAvatarFrameRepository;
    private final PrestigeEvaluationEngine prestigeEvaluationEngine;
    private final NotificationService notificationService;

    // Immutable active frame definition catalog: cached 15 minutes to eliminate repetitive JOIN queries.
    private final BoundedTtlCache<String, List<AvatarFrame>> activeFramesCache =
            new BoundedTtlCache<>(1, Duration.ofMinutes(15).toMillis());

    @Autowired(required = false)
    private PremiumSubscriptionRepository premiumSubscriptionRepository;

    /** Official-administrator override (owner policy 2026-10-02); absent in slim unit tests ⇒ no override. */
    @Autowired(required = false)
    private com.englishcoach.auth.policy.AdminIdentityService adminIdentityService;

    /** Ownership source of the admin override rows (already allowed by {@code ck_user_avatar_frames_source}). */
    static final String ADMIN_OVERRIDE_SOURCE = "ADMIN_GRANT";

    /** Lineages owned by another module may be offered to its audience only (Echo Garden frames, V87); absent ⇒ everyone. */
    @Autowired(required = false)
    private List<FrameAudience> frameAudiences;

    private boolean offered(Long userId, AvatarFrame frame) {
        if (frameAudiences == null || frameAudiences.isEmpty()) return true;
        String lineage = frame.getSeries() != null ? frame.getSeries().getLineage() : null;
        for (FrameAudience audience : frameAudiences) {
            if (!audience.offered(userId, lineage)) return false;
        }
        return true;
    }

    /**
     * The official administrator may preview and equip EVERY active frame. Isolated override: learners' ownership,
     * evaluators and unlock rules are untouched; no achievement / rank row is invented — an ADMIN_GRANT ownership row is
     * written only when the admin actually equips a frame it has not earned (rendering everywhere reads
     * {@code user_avatar_frames.is_equipped}, so equipping needs that row).
     */
    private boolean isOfficialAdmin(Long userId) {
        return userId != null && adminIdentityService != null && adminIdentityService.isOfficialAdmin(userId);
    }

    private static AvatarFrameOwnershipDto adminVirtualOwnership(long ownerCount) {
        return new AvatarFrameOwnershipDto(true, false, null, ADMIN_OVERRIDE_SOURCE, null, ownerCount);
    }

    private static final Set<String> CEREMONY_TIERS = Set.of("A", "S", "SS", "SSS");

    /** Values allowed by {@code ck_user_avatar_frames_source} (V55). */
    private static final Set<String> GRANT_SOURCES = Set.of("ACHIEVEMENT", "RANK", "EVENT", "SEASONAL", "PREMIUM", "ADMIN_GRANT", "LEGACY", "GARDEN");

    /**
     * Ownership source of an automatic grant, derived from the series lineage. RANKED ⇒ RANK and STANDARD ⇒ ACHIEVEMENT:
     * writing the lineage itself violated the source CHECK, and the violation was swallowed as a "concurrent grant",
     * so RANKED and STANDARD frames could never be unlocked.
     */
    private static boolean isExpiredAt(UserAvatarFrame uaf, Instant now) {
        return uaf.getExpiresAt() != null && uaf.getExpiresAt().isBefore(now);
    }

    static String grantSource(String lineage) {
        if (lineage == null) return "ACHIEVEMENT";
        String l = lineage.trim().toUpperCase(java.util.Locale.ROOT);
        if ("RANKED".equals(l)) return "RANK";
        if ("STANDARD".equals(l)) return "ACHIEVEMENT";
        return GRANT_SOURCES.contains(l) ? l : "ACHIEVEMENT";
    }

    private List<AvatarFrame> getActiveFramesCached() {
        List<AvatarFrame> cached = activeFramesCache.get(ACTIVE_FRAMES_CACHE_KEY, ignored -> {
            List<AvatarFrame> rows = avatarFrameRepository.findAllActiveWithSeries();
            return rows == null || rows.isEmpty() ? List.of() : List.copyOf(rows);
        });
        return cached != null ? cached : List.of();
    }

    public void evictCatalogCache() {
        activeFramesCache.clear();
        prestigeEvaluationEngine.evictRequirementsCache();
    }

    @Override
    @Transactional(readOnly = true)
    public List<AvatarFrameDto> getCatalogue(Long userId) {
        List<AvatarFrame> frames = getActiveFramesCached();
        if (frames.isEmpty()) {
            return Collections.emptyList();
        }

        // Batch-preload all frame milestone requirements into 15-min cache (1 query instead of N queries).
        prestigeEvaluationEngine.preloadRequirements(frames.stream().map(AvatarFrame::getId).toList());

        Map<Long, UserAvatarFrame> ownershipMap = new HashMap<>();
        if (userId != null) {
            List<UserAvatarFrame> userFrames = userAvatarFrameRepository.findByUserIdWithFrame(userId);
            for (UserAvatarFrame uaf : userFrames) {
                if (uaf.getFrame() != null) {
                    ownershipMap.put(uaf.getFrame().getId(), uaf);
                }
            }
        }

        Map<Long, Long> ownerCountMap = getOwnerCountMap();
        boolean admin = isOfficialAdmin(userId);

        Instant now = Instant.now();
        return frames.stream()
                // a lineage that is not offered to this user stays out of the catalogue unless they own the frame
                .filter(frame -> ownershipMap.containsKey(frame.getId()) || offered(userId, frame))
                .map(frame -> {
            UserAvatarFrame userFrame = ownershipMap.get(frame.getId());
            if (admin && (userFrame == null || isExpiredAt(userFrame, now))) {
                long count = ownerCountMap.getOrDefault(frame.getId(), 0L);
                AvatarFrameProgressDto adminProgress = prestigeEvaluationEngine.computeProgress(userId, frame.getId(), true, false, false);
                return mapToDto(frame, adminVirtualOwnership(count), adminProgress);
            }
            boolean isOwned = userFrame != null;
            boolean isExpired = isOwned && userFrame.getExpiresAt() != null && userFrame.getExpiresAt().isBefore(now);
            boolean isEquipped = isOwned && userFrame.isEquipped() && !isExpired;

            long ownerCount = ownerCountMap.getOrDefault(frame.getId(), 0L);
            AvatarFrameOwnershipDto ownership;
            if (isOwned) {
                ownership = new AvatarFrameOwnershipDto(
                        true,
                        isEquipped,
                        userFrame.getExpiresAt(),
                        userFrame.getSource(),
                        userFrame.getUnlockedAt(),
                        ownerCount
                );
            } else {
                ownership = new AvatarFrameOwnershipDto(false, false, null, null, null, ownerCount);
            }

            AvatarFrameProgressDto progress = prestigeEvaluationEngine.computeProgress(
                    userId,
                    frame.getId(),
                    isOwned,
                    isEquipped,
                    isExpired
            );

            return mapToDto(frame, ownership, progress);
        }).collect(Collectors.toList());
    }

    @Override
    @Transactional(readOnly = true)
    public List<AvatarFrameDto> getInventory(Long userId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required to view inventory");
        }
        return getCatalogue(userId).stream()
                .filter(dto -> dto.ownership() != null && dto.ownership().owned())
                .collect(Collectors.toList());
    }

    private Map<Long, Long> getOwnerCountMap() {
        Map<Long, Long> map = new HashMap<>();
        try {
            List<Object[]> rows = userAvatarFrameRepository.countGroupedByFrameId();
            for (Object[] row : rows) {
                if (row != null && row.length >= 2 && row[0] instanceof Long frameId && row[1] instanceof Long count) {
                    map.put(frameId, count);
                }
            }
        } catch (Exception ex) {
            log.debug("Batch owner count calculation fallback: {}", ex.getMessage());
        }
        return map;
    }

    @Override
    @Transactional(readOnly = true)
    public AvatarFrameDto getFrameBySlug(Long userId, String slug) {
        if (slug == null || slug.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Frame slug is required");
        }

        AvatarFrame frame = avatarFrameRepository.findBySlug(slug)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Avatar frame not found: " + slug));

        Instant now = Instant.now();
        Optional<UserAvatarFrame> userFrameOpt = userId != null
                ? userAvatarFrameRepository.findByUserIdAndFrameId(userId, frame.getId())
                : Optional.empty();

        boolean isOwned = userFrameOpt.isPresent();
        boolean admin = isOfficialAdmin(userId);
        if (!admin && (!frame.isActive() || (!isOwned && !offered(userId, frame)))) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Avatar frame not found: " + slug);
        }
        boolean isExpired = isOwned && userFrameOpt.get().getExpiresAt() != null && userFrameOpt.get().getExpiresAt().isBefore(now);
        boolean isEquipped = isOwned && userFrameOpt.get().isEquipped() && !isExpired;

        long ownerCount = userAvatarFrameRepository.countByFrameId(frame.getId());
        if ((!isOwned || isExpired) && admin) {
            return mapToDto(frame, adminVirtualOwnership(ownerCount),
                    prestigeEvaluationEngine.computeProgress(userId, frame.getId(), true, false, false));
        }
        AvatarFrameOwnershipDto ownership;
        if (isOwned) {
            UserAvatarFrame uaf = userFrameOpt.get();
            ownership = new AvatarFrameOwnershipDto(
                    true,
                    isEquipped,
                    uaf.getExpiresAt(),
                    uaf.getSource(),
                    uaf.getUnlockedAt(),
                    ownerCount
            );
        } else {
            ownership = new AvatarFrameOwnershipDto(false, false, null, null, null, ownerCount);
        }

        AvatarFrameProgressDto progress = prestigeEvaluationEngine.computeProgress(
                userId,
                frame.getId(),
                isOwned,
                isEquipped,
                isExpired
        );

        return mapToDto(frame, ownership, progress);
    }

    @Override
    @Transactional
    public AvatarFrameDto equipFrame(Long userId, String frameSlug) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required to equip frame");
        }
        if (frameSlug == null || frameSlug.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Frame slug is required");
        }

        AvatarFrame frame = avatarFrameRepository.findBySlug(frameSlug)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Avatar frame not found: " + frameSlug));

        if (!frame.isActive()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Avatar frame is inactive");
        }

        Instant now = Instant.now();
        boolean admin = isOfficialAdmin(userId);
        Optional<UserAvatarFrame> owned = userAvatarFrameRepository.findByUserIdAndFrameId(userId, frame.getId());
        UserAvatarFrame targetUserFrame;
        if (owned.isPresent()) {
            targetUserFrame = owned.get();
        } else if (admin) {
            targetUserFrame = userAvatarFrameRepository.saveAndFlush(UserAvatarFrame.builder()
                    .userId(userId).frame(frame).unlockedAt(now).expiresAt(null).source(ADMIN_OVERRIDE_SOURCE).build());
            log.info("[AvatarFrame] Official admin override: ADMIN_GRANT ownership for userId={} frame={}", userId, frameSlug);
        } else {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "User does not own this avatar frame");
        }

        if (targetUserFrame.getExpiresAt() != null && targetUserFrame.getExpiresAt().isBefore(now)) {
            if (!admin) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Avatar frame ownership has expired");
            }
            targetUserFrame.setExpiresAt(null); // admin override only: an expired frame stays usable for the admin
        }

        long ownerCount = userAvatarFrameRepository.countByFrameId(frame.getId());

        // Idempotent: already equipped
        if (targetUserFrame.isEquipped()) {
            AvatarFrameOwnershipDto ownership = new AvatarFrameOwnershipDto(
                    true, true, targetUserFrame.getExpiresAt(),
                    targetUserFrame.getSource(), targetUserFrame.getUnlockedAt(), ownerCount);
            AvatarFrameProgressDto progress = prestigeEvaluationEngine.computeProgress(userId, frame.getId(), true, true, false);
            return mapToDto(frame, ownership, progress);
        }

        try {
            // Atomic state transition: clear any existing equipped frames, then equip target
            userAvatarFrameRepository.clearEquippedFrames(userId);
            targetUserFrame.setEquipped(true);
            userAvatarFrameRepository.saveAndFlush(targetUserFrame);
        } catch (DataIntegrityViolationException ex) {
            log.error("Concurrent equip race condition detected for userId={}: {}", userId, ex.getMessage());
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Concurrent equip conflict: single equipped frame invariant violated");
        }

        AvatarFrameOwnershipDto ownership = new AvatarFrameOwnershipDto(
                true, true, targetUserFrame.getExpiresAt(),
                targetUserFrame.getSource(), targetUserFrame.getUnlockedAt(), ownerCount);
        AvatarFrameProgressDto progress = prestigeEvaluationEngine.computeProgress(userId, frame.getId(), true, true, false);
        return mapToDto(frame, ownership, progress);
    }

    @Override
    @Transactional
    public void unequipFrame(Long userId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required to unequip frame");
        }
        // Idempotent: sets all equipped frames to false for the user
        userAvatarFrameRepository.clearEquippedFrames(userId);
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<AvatarFrameDto> getEquippedFrame(Long userId) {
        if (userId == null) {
            return Optional.empty();
        }

        Optional<UserAvatarFrame> equippedOpt = userAvatarFrameRepository.findByUserIdAndIsEquippedTrue(userId);
        if (equippedOpt.isEmpty()) {
            return Optional.empty();
        }

        UserAvatarFrame uaf = equippedOpt.get();
        Instant now = Instant.now();
        if (uaf.getExpiresAt() != null && uaf.getExpiresAt().isBefore(now)) {
            return Optional.empty();
        }

        AvatarFrame frame = uaf.getFrame();
        long ownerCount = userAvatarFrameRepository.countByFrameId(frame.getId());
        AvatarFrameOwnershipDto ownership = new AvatarFrameOwnershipDto(
                true, true, uaf.getExpiresAt(),
                uaf.getSource(), uaf.getUnlockedAt(), ownerCount);
        AvatarFrameProgressDto progress = prestigeEvaluationEngine.computeProgress(userId, frame.getId(), true, true, false);
        return Optional.of(mapToDto(frame, ownership, progress));
    }

    @Override
    @Transactional(readOnly = true)
    public Map<Long, AvatarFrameDto> getEquippedFramesBatch(Set<Long> userIds) {
        if (userIds == null || userIds.isEmpty()) {
            return Map.of();
        }
        List<UserAvatarFrame> equippedRows = userAvatarFrameRepository.findEquippedByUserIdIn(userIds);
        if (equippedRows == null || equippedRows.isEmpty()) {
            return Map.of();
        }
        Instant now = Instant.now();
        Map<Long, AvatarFrameDto> result = new HashMap<>(equippedRows.size());
        for (UserAvatarFrame uaf : equippedRows) {
            if (uaf == null || uaf.getUserId() == null || uaf.getFrame() == null) {
                continue;
            }
            if (uaf.getExpiresAt() != null && uaf.getExpiresAt().isBefore(now)) {
                continue;
            }
            // Bypass PrestigeEvaluationEngine.computeProgress & countByFrameId for feed author avatars.
            AvatarFrameOwnershipDto ownership = new AvatarFrameOwnershipDto(
                    true, true, uaf.getExpiresAt(), uaf.getSource(), uaf.getUnlockedAt(), 0L);
            result.put(uaf.getUserId(), mapToDto(uaf.getFrame(), ownership, EQUIPPED_DISPLAY_PROGRESS));
        }
        return result;
    }

    @Override
    @Transactional
    public List<AvatarFrameDto> reconcileUserEligibility(Long userId) {
        if (userId == null) {
            return Collections.emptyList();
        }

        List<AvatarFrame> activeFrames = getActiveFramesCached();
        if (activeFrames.isEmpty()) {
            return Collections.emptyList();
        }
        prestigeEvaluationEngine.preloadRequirements(activeFrames.stream().map(AvatarFrame::getId).toList());

        List<UserAvatarFrame> ownedFrames = userAvatarFrameRepository.findByUserIdWithFrame(userId);
        Set<Long> ownedFrameIds = ownedFrames.stream()
                .map(uaf -> uaf.getFrame().getId())
                .collect(Collectors.toSet());

        List<AvatarFrameDto> newlyGranted = new ArrayList<>();
        Instant now = Instant.now();

        // Helper to find latest active subscription expiry for premium frames
        Instant premiumExpiry = null;
        if (premiumSubscriptionRepository != null) {
            try {
                List<PremiumSubscription> subs = premiumSubscriptionRepository.findActiveSubscriptions(userId, now);
                if (subs != null && !subs.isEmpty()) {
                    premiumExpiry = subs.stream()
                            .map(PremiumSubscription::getExpiresAt)
                            .filter(Objects::nonNull)
                            .max(Comparator.naturalOrder())
                            .orElse(null);
                }
            } catch (Exception ex) {
                log.debug("Unable to read active subscriptions for userId {}: {}", userId, ex.getMessage());
            }
        }

        for (AvatarFrame frame : activeFrames) {
            if (ownedFrameIds.contains(frame.getId())) {
                // If this is an expired premium frame but user has active subscription, renew expiry
                if ("PREMIUM_SUBSCRIPTION".equalsIgnoreCase(frame.getUnlockType()) && premiumExpiry != null) {
                    for (UserAvatarFrame owned : ownedFrames) {
                        if (owned.getFrame() != null && owned.getFrame().getId().equals(frame.getId())) {
                            if (owned.getExpiresAt() != null && owned.getExpiresAt().isBefore(now)) {
                                if (prestigeEvaluationEngine.isFrameEligible(userId, frame.getId())) {
                                    owned.setExpiresAt(premiumExpiry);
                                    userAvatarFrameRepository.saveAndFlush(owned);
                                    log.info("Renewed expired premium frame {} for userId={}", frame.getSlug(), userId);
                                }
                            }
                            break;
                        }
                    }
                }
                continue;
            }

            // Evaluate automatic unlock types: METRIC_THRESHOLD, RANK_REWARD, and PREMIUM_SUBSCRIPTION
            boolean isAutoUnlock = "METRIC_THRESHOLD".equalsIgnoreCase(frame.getUnlockType())
                    || "RANK_REWARD".equalsIgnoreCase(frame.getUnlockType())
                    || "PREMIUM_SUBSCRIPTION".equalsIgnoreCase(frame.getUnlockType());

            if (isAutoUnlock && offered(userId, frame)) {
                boolean eligible = prestigeEvaluationEngine.isFrameEligible(userId, frame.getId());
                if (eligible) {
                    String source = grantSource(frame.getSeries() != null ? frame.getSeries().getLineage() : null);
                    Instant frameExpiry = "PREMIUM_SUBSCRIPTION".equalsIgnoreCase(frame.getUnlockType()) ? premiumExpiry : null;

                    // Native INSERT ... ON CONFLICT (user_id, frame_id) DO NOTHING prevents PostgreSQL 25P02 tx poisoning.
                    int inserted = userAvatarFrameRepository.grantIfAbsent(userId, frame.getId(), now, frameExpiry, source);
                    if (inserted <= 0) {
                        log.debug("Concurrent grant race condition gracefully skipped via ON CONFLICT for userId={} frame={}",
                                userId, frame.getSlug());
                        ownedFrameIds.add(frame.getId());
                        continue;
                    }
                    ownedFrameIds.add(frame.getId());

                    long ownerCount = userAvatarFrameRepository.countByFrameId(frame.getId());
                    AvatarFrameOwnershipDto ownership = new AvatarFrameOwnershipDto(
                            true, false, frameExpiry, source, now, ownerCount);
                    AvatarFrameProgressDto progress = prestigeEvaluationEngine.computeProgress(userId, frame.getId(), true, false, false);
                    newlyGranted.add(mapToDto(frame, ownership, progress));

                    log.info("Auto-unlocked prestige frame {} ({}) for userId={}", frame.getSlug(), frame.getTier(), userId);

                    // Unlock ceremony notification for high prestige tiers
                    if (notificationService != null && CEREMONY_TIERS.contains(frame.getTier())) {
                        try {
                            notificationService.create(new CreateNotificationCommand(
                                    userId,
                                    NotificationCategory.MILESTONE,
                                    NotificationType.SYSTEM_UPDATE,
                                    "Thức Tỉnh Khung Avatar: " + frame.getName(),
                                    "Chúc mừng bạn đã đạt tiêu chuẩn và mở khóa thành công khung " + frame.getName() + " (" + frame.getTier() + ")!",
                                    "/profile",
                                    "frame_unlock_" + userId + "_" + frame.getSlug()
                            ));
                        } catch (Exception nEx) {
                            log.warn("Failed to create ceremony notification for userId={} frame={}: {}", userId, frame.getSlug(), nEx.getMessage());
                        }
                    }
                }
            }
        }

        return newlyGranted;
    }

    private String extractVisualTheme(AvatarFrame frame) {
        if (frame.getManifestJson() != null && frame.getManifestJson().contains("\"visualTheme\"")) {
            try {
                int idx = frame.getManifestJson().indexOf("\"visualTheme\"");
                int colonIdx = frame.getManifestJson().indexOf(":", idx);
                int quoteStart = frame.getManifestJson().indexOf("\"", colonIdx);
                int quoteEnd = frame.getManifestJson().indexOf("\"", quoteStart + 1);
                if (quoteStart > 0 && quoteEnd > quoteStart) {
                    return frame.getManifestJson().substring(quoteStart + 1, quoteEnd);
                }
            } catch (Exception ignored) {}
        }
        return null;
    }

    private AvatarFrameDto mapToDto(AvatarFrame frame, AvatarFrameOwnershipDto ownership, AvatarFrameProgressDto progress) {
        AvatarFrameSeries series = frame.getSeries();
        AvatarFrameSeriesDto seriesDto = series != null
                ? new AvatarFrameSeriesDto(series.getId(), series.getSlug(), series.getName())
                : new AvatarFrameSeriesDto(null, "unknown", "Unknown");

        String lineage = series != null ? series.getLineage() : "ACHIEVEMENT";
        String visualTheme = extractVisualTheme(frame);

        return new AvatarFrameDto(
                frame.getId(),
                frame.getSlug(),
                seriesDto,
                frame.getName(),
                frame.getTier(),
                lineage,
                frame.getRenderType(),
                frame.getPosterAsset(),
                frame.getPreviewAsset(),
                ownership,
                progress,
                visualTheme
        );
    }
}
