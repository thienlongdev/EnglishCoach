package com.englishcoach.community.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.community.dto.CommunityUserRestrictionDto;
import com.englishcoach.community.dto.CreateRestrictionRequest;
import com.englishcoach.community.entity.CommunityRestrictionType;
import com.englishcoach.community.entity.CommunityUserRestriction;
import com.englishcoach.community.repository.CommunityUserRestrictionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.Optional;

@Service
@RequiredArgsConstructor
@Slf4j
public class CommunityRestrictionService {

    private final CommunityUserRestrictionRepository restrictionRepository;
    private final UserRepository userRepository;

    private static final DateTimeFormatter DATE_TIME_FORMATTER = DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm")
            .withZone(ZoneId.of("Asia/Ho_Chi_Minh"));

    @Transactional(readOnly = true)
    public void assertCanPost(Long userId) {
        if (userId == null) return;
        Optional<CommunityUserRestriction> opt = getActiveRestriction(userId);
        if (opt.isPresent()) {
            CommunityUserRestriction r = opt.get();
            if (r.getRestrictionType() == CommunityRestrictionType.SUSPEND_COMMUNITY
                    || r.getRestrictionType() == CommunityRestrictionType.READ_ONLY
                    || r.getRestrictionType() == CommunityRestrictionType.NO_POST) {
                throw new AccessDeniedException(buildUserFacingMessage(r));
            }
        }
    }

    @Transactional(readOnly = true)
    public void assertCanComment(Long userId) {
        if (userId == null) return;
        Optional<CommunityUserRestriction> opt = getActiveRestriction(userId);
        if (opt.isPresent()) {
            CommunityUserRestriction r = opt.get();
            if (r.getRestrictionType() == CommunityRestrictionType.SUSPEND_COMMUNITY
                    || r.getRestrictionType() == CommunityRestrictionType.READ_ONLY
                    || r.getRestrictionType() == CommunityRestrictionType.NO_COMMENT) {
                throw new AccessDeniedException(buildUserFacingMessage(r));
            }
        }
    }

    @Transactional(readOnly = true)
    public void assertCanReact(Long userId) {
        if (userId == null) return;
        Optional<CommunityUserRestriction> opt = getActiveRestriction(userId);
        if (opt.isPresent()) {
            CommunityUserRestriction r = opt.get();
            if (r.getRestrictionType() == CommunityRestrictionType.SUSPEND_COMMUNITY) {
                throw new AccessDeniedException(buildUserFacingMessage(r));
            }
        }
    }

    @Transactional(readOnly = true)
    public Optional<CommunityUserRestriction> getActiveRestriction(Long userId) {
        if (userId == null) return Optional.empty();
        return restrictionRepository.findLatestActiveRestriction(userId, Instant.now());
    }

    @Transactional(readOnly = true)
    public Optional<CommunityUserRestrictionDto> getActiveRestrictionDto(Long userId) {
        return getActiveRestriction(userId).map(this::toDto);
    }

    @Transactional(readOnly = true)
    public List<CommunityUserRestrictionDto> getRestrictionHistory(Long targetUserId) {
        return restrictionRepository.findHistoryByUserId(targetUserId).stream()
                .map(this::toDto)
                .toList();
    }

    @Transactional
    public CommunityUserRestrictionDto createRestriction(Long adminId, CreateRestrictionRequest request) {
        User admin = userRepository.findById(adminId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy quản trị viên"));
        User targetUser = userRepository.findById(request.getTargetUserId())
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy người dùng"));

        Instant now = Instant.now();
        Instant expiresAt = calculateExpiration(now, request.getDuration(), request.getCustomExpiresAt());

        // Revoke any previous active restrictions for clean replacement
        List<CommunityUserRestriction> activeExisting = restrictionRepository.findActiveRestrictions(targetUser.getId(), now);
        for (CommunityUserRestriction prev : activeExisting) {
            prev.setRevokedAt(now);
            prev.setRevokedByAdmin(admin);
            restrictionRepository.save(prev);
        }

        CommunityUserRestriction restriction = CommunityUserRestriction.builder()
                .targetUser(targetUser)
                .restrictionType(request.getRestrictionType())
                .reason(request.getReason().trim())
                .createdByAdmin(admin)
                .createdAt(now)
                .expiresAt(expiresAt)
                .build();

        restriction = restrictionRepository.save(restriction);
        log.info("Admin {} imposed {} on user {} until {}",
                adminId, request.getRestrictionType(), targetUser.getId(), expiresAt);

        return toDto(restriction);
    }

    @Transactional
    public CommunityUserRestrictionDto revokeRestriction(Long adminId, Long restrictionId) {
        User admin = userRepository.findById(adminId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy quản trị viên"));

        CommunityUserRestriction restriction = restrictionRepository.findById(restrictionId)
                .orElseThrow(() -> new NoSuchElementException("Không tìm thấy bản ghi hạn chế"));

        if (restriction.getRevokedAt() == null) {
            restriction.setRevokedAt(Instant.now());
            restriction.setRevokedByAdmin(admin);
            restriction = restrictionRepository.save(restriction);
            log.info("Admin {} revoked restriction {} on user {}", adminId, restrictionId, restriction.getTargetUser().getId());
        }

        return toDto(restriction);
    }

    private Instant calculateExpiration(Instant now, String duration, Instant customExpiresAt) {
        if (duration == null) return null;
        return switch (duration.toUpperCase()) {
            case "1_DAY" -> now.plus(1, ChronoUnit.DAYS);
            case "3_DAYS" -> now.plus(3, ChronoUnit.DAYS);
            case "7_DAYS" -> now.plus(7, ChronoUnit.DAYS);
            case "30_DAYS" -> now.plus(30, ChronoUnit.DAYS);
            case "CUSTOM" -> {
                if (customExpiresAt == null || customExpiresAt.isBefore(now)) {
                    throw new IllegalArgumentException("Thời gian kết thúc tùy chỉnh không hợp lệ");
                }
                yield customExpiresAt;
            }
            case "PERMANENT" -> null;
            default -> throw new IllegalArgumentException("Khoảng thời gian không hợp lệ: " + duration);
        };
    }

    public String buildUserFacingMessage(CommunityUserRestriction r) {
        String durationStr = r.getExpiresAt() != null
                ? " đến " + DATE_TIME_FORMATTER.format(r.getExpiresAt())
                : "";

        return switch (r.getRestrictionType()) {
            case SUSPEND_COMMUNITY ->
                    "Tài khoản của bạn tạm thời bị đình chỉ mọi tương tác trong Cộng đồng" + durationStr + ".";
            case READ_ONLY ->
                    "Bạn chỉ có thể xem Cộng đồng" + durationStr + ". Không thể đăng bài hoặc bình luận.";
            case NO_POST ->
                    "Bạn tạm thời không thể đăng bài mới trong Cộng đồng" + durationStr + ".";
            case NO_COMMENT ->
                    "Bạn tạm thời không thể bình luận trong Cộng đồng" + durationStr + ".";
        };
    }

    private CommunityUserRestrictionDto toDto(CommunityUserRestriction r) {
        return CommunityUserRestrictionDto.builder()
                .id(r.getId())
                .targetUserId(r.getTargetUser().getId())
                .targetUserName(r.getTargetUser().getName())
                .restrictionType(r.getRestrictionType())
                .reason(r.getReason())
                .createdByAdminId(r.getCreatedByAdmin().getId())
                .createdByAdminName(r.getCreatedByAdmin().getName())
                .createdAt(r.getCreatedAt())
                .expiresAt(r.getExpiresAt())
                .revokedAt(r.getRevokedAt())
                .active(r.isActive())
                .userMessage(buildUserFacingMessage(r))
                .build();
    }
}
