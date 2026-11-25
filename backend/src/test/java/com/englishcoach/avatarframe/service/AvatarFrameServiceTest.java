package com.englishcoach.avatarframe.service;

import com.englishcoach.avatarframe.dto.AvatarFrameDto;
import com.englishcoach.avatarframe.dto.AvatarFrameProgressDto;
import com.englishcoach.avatarframe.entity.AvatarFrame;
import com.englishcoach.avatarframe.entity.AvatarFrameSeries;
import com.englishcoach.avatarframe.entity.UserAvatarFrame;
import com.englishcoach.avatarframe.evaluator.PrestigeEvaluationEngine;
import com.englishcoach.avatarframe.repository.AvatarFrameRepository;
import com.englishcoach.avatarframe.repository.UserAvatarFrameRepository;
import com.englishcoach.notification.service.NotificationService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class AvatarFrameServiceTest {

    @Mock
    private AvatarFrameRepository avatarFrameRepository;

    @Mock
    private UserAvatarFrameRepository userAvatarFrameRepository;

    @Mock
    private PrestigeEvaluationEngine prestigeEvaluationEngine;

    @Mock
    private NotificationService notificationService;

    @InjectMocks
    private AvatarFrameServiceImpl avatarFrameService;

    private AvatarFrameSeries streakSeries;
    private AvatarFrame activeFrame;
    private AvatarFrame inactiveFrame;
    private AvatarFrame highTierFrame;
    private UserAvatarFrame userFrameOwned;
    private UserAvatarFrame userFrameExpired;

    @BeforeEach
    void setUp() {
        streakSeries = AvatarFrameSeries.builder()
                .id(1L)
                .slug("streak_flame")
                .name("Streak Flame")
                .lineage("ACHIEVEMENT")
                .description("Chuỗi ngày rực lửa")
                .build();

        activeFrame = AvatarFrame.builder()
                .id(10L)
                .series(streakSeries)
                .slug("streak_flame_stage_1")
                .name("Đốm Lửa")
                .tier("C")
                .renderType("STATIC_SVG")
                .posterAsset("/assets/frames/streak_flame_c.svg")
                .previewAsset("/assets/frames/streak_flame_c.svg")
                .unlockType("METRIC_THRESHOLD")
                .isActive(true)
                .build();

        highTierFrame = AvatarFrame.builder()
                .id(14L)
                .series(streakSeries)
                .slug("sss_dragon_emperor")
                .name("Long Đế Anh Ngữ")
                .tier("SSS")
                .renderType("STATIC_SVG")
                .posterAsset("/assets/frames/sss_dragon_emperor.svg")
                .previewAsset("/assets/frames/sss_dragon_emperor.svg")
                .unlockType("METRIC_THRESHOLD")
                .isActive(true)
                .build();

        inactiveFrame = AvatarFrame.builder()
                .id(99L)
                .series(streakSeries)
                .slug("retired_flame")
                .name("Retired")
                .tier("D")
                .renderType("STATIC_SVG")
                .posterAsset("/assets/frames/retired.svg")
                .previewAsset("/assets/frames/retired.svg")
                .unlockType("ADMIN_GRANT")
                .isActive(false)
                .build();

        userFrameOwned = UserAvatarFrame.builder()
                .id(100L)
                .userId(1L)
                .frame(activeFrame)
                .source("ACHIEVEMENT")
                .isEquipped(false)
                .unlockedAt(Instant.now().minus(2, ChronoUnit.DAYS))
                .expiresAt(null)
                .build();

        userFrameExpired = UserAvatarFrame.builder()
                .id(101L)
                .userId(1L)
                .frame(activeFrame)
                .source("ACHIEVEMENT")
                .isEquipped(false)
                .unlockedAt(Instant.now().minus(40, ChronoUnit.DAYS))
                .expiresAt(Instant.now().minus(10, ChronoUnit.DAYS))
                .build();
    }

    @Test
    @DisplayName("getCatalogue: returns enriched frames with derived server progress for authenticated user")
    void testGetCatalogue_withAuthenticatedUser() {
        when(avatarFrameRepository.findAllActiveWithSeries()).thenReturn(List.of(activeFrame));
        when(userAvatarFrameRepository.findByUserIdWithFrame(1L)).thenReturn(List.of(userFrameOwned));
        when(userAvatarFrameRepository.countGroupedByFrameId()).thenReturn(List.<Object[]>of(new Object[]{10L, 42L}));
        when(prestigeEvaluationEngine.computeProgress(eq(1L), eq(10L), eq(true), eq(false), eq(false)))
                .thenReturn(new AvatarFrameProgressDto(7.0, 7.0, 100.0, "STREAK_DAYS", "OWNED", "7 ngày", "7 ngày"));

        List<AvatarFrameDto> catalogue = avatarFrameService.getCatalogue(1L);

        assertThat(catalogue).hasSize(1);
        AvatarFrameDto dto = catalogue.get(0);
        assertThat(dto.slug()).isEqualTo("streak_flame_stage_1");
        assertThat(dto.name()).isEqualTo("Đốm Lửa");
        assertThat(dto.tier()).isEqualTo("C");
        assertThat(dto.lineage()).isEqualTo("ACHIEVEMENT");
        assertThat(dto.renderType()).isEqualTo("STATIC_SVG");
        assertThat(dto.ownership().owned()).isTrue();
        assertThat(dto.ownership().equipped()).isFalse();
        assertThat(dto.ownership().ownerCount()).isEqualTo(42L);
        assertThat(dto.progress()).isNotNull();
        assertThat(dto.progress().percent()).isEqualTo(100.0);
        assertThat(dto.progress().status()).isEqualTo("OWNED");

        // Verify strictly read-only invariant (Rule 24, Rule 26, Rule 57)
        verify(userAvatarFrameRepository, never()).save(any());
        verify(userAvatarFrameRepository, never()).saveAndFlush(any());
        verify(notificationService, never()).create(any());
    }

    @Test
    @DisplayName("getCatalogue: returns unowned frames for anonymous visitors")
    void testGetCatalogue_anonymousUser() {
        when(avatarFrameRepository.findAllActiveWithSeries()).thenReturn(List.of(activeFrame));
        when(userAvatarFrameRepository.countGroupedByFrameId()).thenReturn(List.<Object[]>of(new Object[]{10L, 10L}));
        when(prestigeEvaluationEngine.computeProgress(isNull(), eq(10L), eq(false), eq(false), eq(false)))
                .thenReturn(new AvatarFrameProgressDto(0.0, 7.0, 0.0, "STREAK_DAYS", "LOCKED", "0 ngày", "7 ngày"));

        List<AvatarFrameDto> catalogue = avatarFrameService.getCatalogue(null);

        assertThat(catalogue).hasSize(1);
        AvatarFrameDto dto = catalogue.get(0);
        assertThat(dto.ownership().owned()).isFalse();
        assertThat(dto.ownership().equipped()).isFalse();
        assertThat(dto.progress().percent()).isEqualTo(0.0);
        assertThat(dto.progress().status()).isEqualTo("LOCKED");

        // Verify strictly read-only invariant
        verify(userAvatarFrameRepository, never()).save(any());
        verify(userAvatarFrameRepository, never()).saveAndFlush(any());
        verify(notificationService, never()).create(any());
    }

    @Test
    @DisplayName("getInventory: returns only owned frames for user")
    void testGetInventory_returnsOwnedFrames() {
        when(avatarFrameRepository.findAllActiveWithSeries()).thenReturn(List.of(activeFrame));
        when(userAvatarFrameRepository.findByUserIdWithFrame(1L)).thenReturn(List.of(userFrameOwned));
        when(prestigeEvaluationEngine.computeProgress(any(), any(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenReturn(new AvatarFrameProgressDto(7.0, 7.0, 100.0, "STREAK_DAYS", "OWNED", "7 ngày", "7 ngày"));

        List<AvatarFrameDto> inventory = avatarFrameService.getInventory(1L);

        assertThat(inventory).hasSize(1);
        assertThat(inventory.get(0).ownership().owned()).isTrue();
    }

    @Test
    @DisplayName("reconcileUserEligibility: automatically unlocks eligible frame via ON CONFLICT grant and sends ceremony notification")
    void testReconcileUserEligibility_unlocksAndNotifies() {
        when(avatarFrameRepository.findAllActiveWithSeries()).thenReturn(List.of(highTierFrame));
        when(userAvatarFrameRepository.findByUserIdWithFrame(1L)).thenReturn(List.of());
        when(prestigeEvaluationEngine.isFrameEligible(1L, 14L)).thenReturn(true);
        when(userAvatarFrameRepository.grantIfAbsent(eq(1L), eq(14L), any(Instant.class), isNull(), eq("ACHIEVEMENT")))
                .thenReturn(1);
        when(prestigeEvaluationEngine.computeProgress(eq(1L), eq(14L), eq(true), eq(false), eq(false)))
                .thenReturn(new AvatarFrameProgressDto(365.0, 365.0, 100.0, "STREAK_DAYS", "OWNED", "365 ngày", "365 ngày"));

        List<AvatarFrameDto> newlyGranted = avatarFrameService.reconcileUserEligibility(1L);

        assertThat(newlyGranted).hasSize(1);
        assertThat(newlyGranted.get(0).slug()).isEqualTo("sss_dragon_emperor");
        verify(userAvatarFrameRepository).grantIfAbsent(eq(1L), eq(14L), any(Instant.class), isNull(), eq("ACHIEVEMENT"));
        verify(userAvatarFrameRepository, never()).saveAndFlush(any());
        verify(notificationService).create(any());
    }

    @Test
    @DisplayName("reconcileUserEligibility: concurrent grant conflict (0 rows inserted) skips cleanly without 25P02 exception")
    void testReconcileUserEligibility_concurrentConflictSkipsCleanly() {
        when(avatarFrameRepository.findAllActiveWithSeries()).thenReturn(List.of(highTierFrame));
        when(userAvatarFrameRepository.findByUserIdWithFrame(1L)).thenReturn(List.of());
        when(prestigeEvaluationEngine.isFrameEligible(1L, 14L)).thenReturn(true);
        when(userAvatarFrameRepository.grantIfAbsent(eq(1L), eq(14L), any(Instant.class), isNull(), eq("ACHIEVEMENT")))
                .thenReturn(0);

        List<AvatarFrameDto> newlyGranted = avatarFrameService.reconcileUserEligibility(1L);

        assertThat(newlyGranted).isEmpty();
        verify(notificationService, never()).create(any());
    }

    @Test
    @DisplayName("getEquippedFramesBatch: loads equipped frames in one batch without invoking PrestigeEvaluationEngine")
    void testGetEquippedFramesBatch_bypassesEvaluationEngine() {
        userFrameOwned.setEquipped(true);
        when(userAvatarFrameRepository.findEquippedByUserIdIn(java.util.Set.of(1L, 2L)))
                .thenReturn(List.of(userFrameOwned));

        java.util.Map<Long, AvatarFrameDto> result = avatarFrameService.getEquippedFramesBatch(java.util.Set.of(1L, 2L));

        assertThat(result).containsOnlyKeys(1L);
        assertThat(result.get(1L).slug()).isEqualTo("streak_flame_stage_1");
        verifyNoInteractions(prestigeEvaluationEngine);
    }

    @Test
    @DisplayName("equipFrame: successfully equips owned, active, unexpired frame atomically")
    void testEquipFrame_success() {
        when(avatarFrameRepository.findBySlug("streak_flame_stage_1")).thenReturn(Optional.of(activeFrame));
        when(userAvatarFrameRepository.findByUserIdAndFrameId(1L, 10L)).thenReturn(Optional.of(userFrameOwned));
        when(prestigeEvaluationEngine.computeProgress(any(), any(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenReturn(new AvatarFrameProgressDto(7.0, 7.0, 100.0, "STREAK_DAYS", "EQUIPPED", "7 ngày", "7 ngày"));

        AvatarFrameDto result = avatarFrameService.equipFrame(1L, "streak_flame_stage_1");

        assertThat(result).isNotNull();
        assertThat(result.slug()).isEqualTo("streak_flame_stage_1");
        assertThat(result.ownership().equipped()).isTrue();

        verify(userAvatarFrameRepository).clearEquippedFrames(1L);
        verify(userAvatarFrameRepository).saveAndFlush(userFrameOwned);
        assertThat(userFrameOwned.isEquipped()).isTrue();
    }

    @Test
    @DisplayName("equipFrame: rejects unowned frame with 403 Forbidden")
    void testEquipFrame_unowned_throwsForbidden() {
        when(avatarFrameRepository.findBySlug("streak_flame_stage_1")).thenReturn(Optional.of(activeFrame));
        when(userAvatarFrameRepository.findByUserIdAndFrameId(1L, 10L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> avatarFrameService.equipFrame(1L, "streak_flame_stage_1"))
                .isInstanceOf(ResponseStatusException.class)
                .matches(e -> ((ResponseStatusException) e).getStatusCode() == HttpStatus.FORBIDDEN);

        verify(userAvatarFrameRepository, never()).clearEquippedFrames(any());
    }

    @Test
    @DisplayName("equipFrame: rejects expired frame with 400 Bad Request")
    void testEquipFrame_expired_throwsBadRequest() {
        when(avatarFrameRepository.findBySlug("streak_flame_stage_1")).thenReturn(Optional.of(activeFrame));
        when(userAvatarFrameRepository.findByUserIdAndFrameId(1L, 10L)).thenReturn(Optional.of(userFrameExpired));

        assertThatThrownBy(() -> avatarFrameService.equipFrame(1L, "streak_flame_stage_1"))
                .isInstanceOf(ResponseStatusException.class)
                .matches(e -> ((ResponseStatusException) e).getStatusCode() == HttpStatus.BAD_REQUEST);

        verify(userAvatarFrameRepository, never()).clearEquippedFrames(any());
    }

    @Test
    @DisplayName("equipFrame: rejects inactive frame with 400 Bad Request")
    void testEquipFrame_inactive_throwsBadRequest() {
        when(avatarFrameRepository.findBySlug("retired_flame")).thenReturn(Optional.of(inactiveFrame));

        assertThatThrownBy(() -> avatarFrameService.equipFrame(1L, "retired_flame"))
                .isInstanceOf(ResponseStatusException.class)
                .matches(e -> ((ResponseStatusException) e).getStatusCode() == HttpStatus.BAD_REQUEST);

        verify(userAvatarFrameRepository, never()).clearEquippedFrames(any());
    }

    @Test
    @DisplayName("equipFrame: rejects unknown frame with 404 Not Found")
    void testEquipFrame_unknown_throwsNotFound() {
        when(avatarFrameRepository.findBySlug("unknown_slug")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> avatarFrameService.equipFrame(1L, "unknown_slug"))
                .isInstanceOf(ResponseStatusException.class)
                .matches(e -> ((ResponseStatusException) e).getStatusCode() == HttpStatus.NOT_FOUND);
    }

    @Test
    @DisplayName("equipFrame: already equipped frame returns idempotently without re-clearing")
    void testEquipFrame_alreadyEquipped_idempotent() {
        userFrameOwned.setEquipped(true);
        when(avatarFrameRepository.findBySlug("streak_flame_stage_1")).thenReturn(Optional.of(activeFrame));
        when(userAvatarFrameRepository.findByUserIdAndFrameId(1L, 10L)).thenReturn(Optional.of(userFrameOwned));
        when(prestigeEvaluationEngine.computeProgress(any(), any(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenReturn(new AvatarFrameProgressDto(7.0, 7.0, 100.0, "STREAK_DAYS", "EQUIPPED", "7 ngày", "7 ngày"));

        AvatarFrameDto result = avatarFrameService.equipFrame(1L, "streak_flame_stage_1");

        assertThat(result.ownership().equipped()).isTrue();
        verify(userAvatarFrameRepository, never()).clearEquippedFrames(any());
    }

    @Test
    @DisplayName("equipFrame: concurrent equip conflict maps to 409 Conflict")
    void testEquipFrame_concurrencyViolation_throwsConflict() {
        when(avatarFrameRepository.findBySlug("streak_flame_stage_1")).thenReturn(Optional.of(activeFrame));
        when(userAvatarFrameRepository.findByUserIdAndFrameId(1L, 10L)).thenReturn(Optional.of(userFrameOwned));
        doThrow(new DataIntegrityViolationException("duplicate key value violates unique constraint idx_user_avatar_frames_single_equipped"))
                .when(userAvatarFrameRepository).saveAndFlush(any());

        assertThatThrownBy(() -> avatarFrameService.equipFrame(1L, "streak_flame_stage_1"))
                .isInstanceOf(ResponseStatusException.class)
                .matches(e -> ((ResponseStatusException) e).getStatusCode() == HttpStatus.CONFLICT);
    }

    @Test
    @DisplayName("unequipFrame: un-equips all frames idempotently (no-frame state is valid)")
    void testUnequipFrame_success() {
        avatarFrameService.unequipFrame(1L);
        verify(userAvatarFrameRepository).clearEquippedFrames(1L);
    }

    @Test
    @DisplayName("getEquippedFrame: returns equipped frame if valid and not expired")
    void testGetEquippedFrame_valid() {
        userFrameOwned.setEquipped(true);
        when(userAvatarFrameRepository.findByUserIdAndIsEquippedTrue(1L)).thenReturn(Optional.of(userFrameOwned));
        when(prestigeEvaluationEngine.computeProgress(any(), any(), anyBoolean(), anyBoolean(), anyBoolean()))
                .thenReturn(new AvatarFrameProgressDto(7.0, 7.0, 100.0, "STREAK_DAYS", "EQUIPPED", "7 ngày", "7 ngày"));

        Optional<AvatarFrameDto> equipped = avatarFrameService.getEquippedFrame(1L);

        assertThat(equipped).isPresent();
        assertThat(equipped.get().slug()).isEqualTo("streak_flame_stage_1");
    }

    @Test
    @DisplayName("getEquippedFrame: returns empty if equipped frame has expired")
    void testGetEquippedFrame_expired() {
        userFrameExpired.setEquipped(true);
        when(userAvatarFrameRepository.findByUserIdAndIsEquippedTrue(1L)).thenReturn(Optional.of(userFrameExpired));

        Optional<AvatarFrameDto> equipped = avatarFrameService.getEquippedFrame(1L);

        assertThat(equipped).isEmpty();
        verify(userAvatarFrameRepository, never()).clearEquippedFrames(any());
    }
}
