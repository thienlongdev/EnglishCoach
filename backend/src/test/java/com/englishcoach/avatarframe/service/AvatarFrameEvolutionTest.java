package com.englishcoach.avatarframe.service;

import com.englishcoach.avatarframe.dto.AvatarFrameDto;
import com.englishcoach.avatarframe.entity.AvatarFrame;
import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.avatarframe.entity.AvatarFrameSeries;
import com.englishcoach.avatarframe.entity.UserAvatarFrame;
import com.englishcoach.avatarframe.evaluator.MetricEvaluationResult;
import com.englishcoach.avatarframe.evaluator.PrestigeEvaluationEngine;
import com.englishcoach.avatarframe.evaluator.StreakEvaluator;
import com.englishcoach.avatarframe.repository.AvatarFrameRepository;
import com.englishcoach.avatarframe.repository.AvatarFrameRequirementRepository;
import com.englishcoach.avatarframe.repository.UserAvatarFrameRepository;
import com.englishcoach.notification.service.NotificationService;
import com.englishcoach.progress.dto.UnifiedStreakDto;
import com.englishcoach.progress.service.UnifiedProgressService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class AvatarFrameEvolutionTest {

    @Mock
    private AvatarFrameRepository avatarFrameRepository;

    @Mock
    private UserAvatarFrameRepository userAvatarFrameRepository;

    @Mock
    private AvatarFrameRequirementRepository requirementRepository;

    @Mock
    private UnifiedProgressService unifiedProgressService;

    @Mock
    private NotificationService notificationService;

    private PrestigeEvaluationEngine prestigeEvaluationEngine;
    private AvatarFrameServiceImpl avatarFrameService;

    private AvatarFrameSeries streakSeries;
    private AvatarFrame stage1Frame;
    private AvatarFrame stage2Frame;
    private AvatarFrame stage3Frame;

    private AvatarFrameRequirement reqStage1;
    private AvatarFrameRequirement reqStage2;
    private AvatarFrameRequirement reqStage3;

    @BeforeEach
    void setUp() {
        StreakEvaluator streakEvaluator = new StreakEvaluator(unifiedProgressService);
        prestigeEvaluationEngine = new PrestigeEvaluationEngine(List.of(streakEvaluator), requirementRepository);

        avatarFrameService = new AvatarFrameServiceImpl(
                avatarFrameRepository,
                userAvatarFrameRepository,
                prestigeEvaluationEngine,
                notificationService
        );

        streakSeries = AvatarFrameSeries.builder().id(1L).slug("streak").name("Streak Flame").lineage("ACHIEVEMENT").build();

        stage1Frame = AvatarFrame.builder().id(1L).series(streakSeries).slug("streak_flame_stage_1").name("Đốm Lửa").tier("C").unlockType("METRIC_THRESHOLD").isActive(true).build();
        stage2Frame = AvatarFrame.builder().id(2L).series(streakSeries).slug("streak_flame_stage_2").name("Song Diệm").tier("B").unlockType("METRIC_THRESHOLD").isActive(true).build();
        stage3Frame = AvatarFrame.builder().id(3L).series(streakSeries).slug("streak_flame_stage_3").name("Hỏa Diệm Lam").tier("A").unlockType("METRIC_THRESHOLD").isActive(true).build();

        reqStage1 = AvatarFrameRequirement.builder().id(1L).frame(stage1Frame).metricType("STREAK_DAYS").operator("GTE").targetValue("7").build();
        reqStage2 = AvatarFrameRequirement.builder().id(2L).frame(stage2Frame).metricType("STREAK_DAYS").operator("GTE").targetValue("30").build();
        reqStage3 = AvatarFrameRequirement.builder().id(3L).frame(stage3Frame).metricType("STREAK_DAYS").operator("GTE").targetValue("100").build();

        lenient().when(requirementRepository.findByFrameId(1L)).thenReturn(List.of(reqStage1));
        lenient().when(requirementRepository.findByFrameId(2L)).thenReturn(List.of(reqStage2));
        lenient().when(requirementRepository.findByFrameId(3L)).thenReturn(List.of(reqStage3));

        lenient().when(avatarFrameRepository.findAllActiveWithSeries()).thenReturn(List.of(stage1Frame, stage2Frame, stage3Frame));
    }

    @Test
    @DisplayName("Evolution Chain: verifies multi-threshold progression (7 -> 30 -> 100 days) under Collection model")
    void testEvolutionChain_multiThresholdProgression() {
        Long userId = 42L;
        List<UserAvatarFrame> ownedLedger = new ArrayList<>();
        when(userAvatarFrameRepository.findByUserIdWithFrame(userId)).thenAnswer(inv -> new ArrayList<>(ownedLedger));
        Map<Long, AvatarFrame> frameById = Map.of(1L, stage1Frame, 2L, stage2Frame, 3L, stage3Frame);
        when(userAvatarFrameRepository.grantIfAbsent(eq(userId), anyLong(), any(Instant.class), any(), anyString())).thenAnswer(inv -> {
            Long frameId = inv.getArgument(1);
            Instant unlockedAt = inv.getArgument(2);
            Instant expiresAt = inv.getArgument(3);
            String source = inv.getArgument(4);
            boolean alreadyOwned = ownedLedger.stream().anyMatch(u -> u.getFrame().getId().equals(frameId));
            if (alreadyOwned) {
                return 0;
            }
            ownedLedger.add(UserAvatarFrame.builder()
                    .id((long) (ownedLedger.size() + 100))
                    .userId(userId)
                    .frame(frameById.get(frameId))
                    .unlockedAt(unlockedAt)
                    .expiresAt(expiresAt)
                    .source(source)
                    .isEquipped(false)
                    .build());
            return 1;
        });

        // ─────────────────────────────────────────────────────────────
        // Step 1: Streak = 5 days (Below Stage 1 target 7)
        // ─────────────────────────────────────────────────────────────
        when(unifiedProgressService.getStreak(userId)).thenReturn(new UnifiedStreakDto(5, 5, true));
        List<AvatarFrameDto> grantedAt5 = avatarFrameService.reconcileUserEligibility(userId);

        assertThat(grantedAt5).isEmpty();
        assertThat(ownedLedger).isEmpty();

        // Check catalogue view at 5 days
        when(userAvatarFrameRepository.countGroupedByFrameId()).thenReturn(Collections.emptyList());
        List<AvatarFrameDto> catalogueAt5 = avatarFrameService.getCatalogue(userId);
        assertThat(catalogueAt5.get(0).progress().status()).isEqualTo("PROGRESSING");
        assertThat(catalogueAt5.get(0).progress().percent()).isEqualTo(71.4);
        assertThat(catalogueAt5.get(0).ownership().owned()).isFalse();

        // ─────────────────────────────────────────────────────────────
        // Step 2: Streak reaches 7 days -> Unlocks Stage 1
        // ─────────────────────────────────────────────────────────────
        when(unifiedProgressService.getStreak(userId)).thenReturn(new UnifiedStreakDto(7, 7, true));
        List<AvatarFrameDto> grantedAt7 = avatarFrameService.reconcileUserEligibility(userId);

        assertThat(grantedAt7).hasSize(1);
        assertThat(grantedAt7.get(0).slug()).isEqualTo("streak_flame_stage_1");
        assertThat(ownedLedger).hasSize(1);
        assertThat(ownedLedger.get(0).getFrame().getSlug()).isEqualTo("streak_flame_stage_1");

        // Idempotent: repeated reconcile with same streak grants nothing new
        List<AvatarFrameDto> reReconcile7 = avatarFrameService.reconcileUserEligibility(userId);
        assertThat(reReconcile7).isEmpty();
        assertThat(ownedLedger).hasSize(1);

        // ─────────────────────────────────────────────────────────────
        // Step 3: Streak reaches 35 days -> Unlocks Stage 2; Stage 1 remains owned (Collection Model)
        // ─────────────────────────────────────────────────────────────
        when(unifiedProgressService.getStreak(userId)).thenReturn(new UnifiedStreakDto(35, 35, true));
        List<AvatarFrameDto> grantedAt35 = avatarFrameService.reconcileUserEligibility(userId);

        assertThat(grantedAt35).hasSize(1);
        assertThat(grantedAt35.get(0).slug()).isEqualTo("streak_flame_stage_2");
        assertThat(ownedLedger).hasSize(2);
        assertThat(ownedLedger.stream().map(u -> u.getFrame().getSlug()))
                .containsExactlyInAnyOrder("streak_flame_stage_1", "streak_flame_stage_2");

        // ─────────────────────────────────────────────────────────────
        // Step 4: Streak reaches 105 days -> Unlocks Stage 3 (Tier A) & sends ceremony notification
        // ─────────────────────────────────────────────────────────────
        when(unifiedProgressService.getStreak(userId)).thenReturn(new UnifiedStreakDto(105, 105, true));
        List<AvatarFrameDto> grantedAt105 = avatarFrameService.reconcileUserEligibility(userId);

        assertThat(grantedAt105).hasSize(1);
        assertThat(grantedAt105.get(0).slug()).isEqualTo("streak_flame_stage_3");
        assertThat(ownedLedger).hasSize(3);
        assertThat(ownedLedger.stream().map(u -> u.getFrame().getSlug()))
                .containsExactlyInAnyOrder("streak_flame_stage_1", "streak_flame_stage_2", "streak_flame_stage_3");

        // Ceremony notification sent for Tier A (Stage 3)
        verify(notificationService, atLeastOnce()).create(any());
    }
}
