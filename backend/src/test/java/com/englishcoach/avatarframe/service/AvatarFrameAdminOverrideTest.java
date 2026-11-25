package com.englishcoach.avatarframe.service;

import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.avatarframe.dto.AvatarFrameDto;
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
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.http.HttpStatus;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/**
 * Official-administrator frame override (owner policy 2026-10-02): the admin sees every frame as usable and can equip it
 * (an ADMIN_GRANT ownership row is written only on equip); learners keep the exact ownership rules.
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class AvatarFrameAdminOverrideTest {

    static final long ADMIN = 1L;
    static final long LEARNER = 42L;

    @Mock AvatarFrameRepository avatarFrameRepository;
    @Mock UserAvatarFrameRepository userAvatarFrameRepository;
    @Mock PrestigeEvaluationEngine prestigeEvaluationEngine;
    @Mock NotificationService notificationService;
    @Mock AdminIdentityService adminIdentityService;

    @InjectMocks AvatarFrameServiceImpl service;

    AvatarFrame prestige;
    AvatarFrame ranked;

    @BeforeEach
    void setUp() {
        ReflectionTestUtils.setField(service, "adminIdentityService", adminIdentityService);
        when(adminIdentityService.isOfficialAdmin(ADMIN)).thenReturn(true);
        when(adminIdentityService.isOfficialAdmin(LEARNER)).thenReturn(false);
        AvatarFrameSeries series = AvatarFrameSeries.builder().id(1L).slug("dragon").name("Dragon").lineage("PRESTIGE").build();
        prestige = AvatarFrame.builder().id(10L).series(series).slug("sss_dragon_emperor").name("Long Đế").tier("SSS")
                .renderType("STATIC_SVG").posterAsset("/p.svg").previewAsset("/p.svg").unlockType("METRIC_THRESHOLD").isActive(true).build();
        ranked = AvatarFrame.builder().id(11L).series(series).slug("ranked_master").name("Master").tier("S")
                .renderType("STATIC_SVG").posterAsset("/r.svg").previewAsset("/r.svg").unlockType("METRIC_THRESHOLD").isActive(true).build();
        when(avatarFrameRepository.findAllActiveWithSeries()).thenReturn(List.of(prestige, ranked));
        when(avatarFrameRepository.findBySlug("sss_dragon_emperor")).thenReturn(Optional.of(prestige));
        when(userAvatarFrameRepository.findByUserIdWithFrame(any())).thenReturn(List.of());
        when(userAvatarFrameRepository.findByUserIdAndFrameId(any(), any())).thenReturn(Optional.empty());
        when(userAvatarFrameRepository.saveAndFlush(any(UserAvatarFrame.class))).thenAnswer(i -> i.getArgument(0));
    }

    @Test
    @DisplayName("Official admin: catalogue shows every frame usable (ADMIN_GRANT), nothing is written")
    void adminCatalogueAllUsable() {
        List<AvatarFrameDto> list = service.getCatalogue(ADMIN);
        assertThat(list).hasSize(2).allSatisfy(f -> {
            assertThat(f.ownership().owned()).isTrue();
            assertThat(f.ownership().source()).isEqualTo("ADMIN_GRANT");
        });
        verify(userAvatarFrameRepository, never()).saveAndFlush(any());
    }

    @Test
    @DisplayName("Learner: catalogue ownership unchanged (unearned frames stay locked)")
    void learnerCatalogueUnchanged() {
        List<AvatarFrameDto> list = service.getCatalogue(LEARNER);
        assertThat(list).allSatisfy(f -> assertThat(f.ownership().owned()).isFalse());
    }

    @Test
    @DisplayName("Official admin can equip an unearned prestige frame: one ADMIN_GRANT row, equipped")
    void adminEquipsUnearned() {
        AvatarFrameDto dto = service.equipFrame(ADMIN, "sss_dragon_emperor");
        ArgumentCaptor<UserAvatarFrame> saved = ArgumentCaptor.forClass(UserAvatarFrame.class);
        verify(userAvatarFrameRepository, times(2)).saveAndFlush(saved.capture());
        UserAvatarFrame row = saved.getAllValues().get(0);
        assertThat(row.getUserId()).isEqualTo(ADMIN);
        assertThat(row.getSource()).isEqualTo("ADMIN_GRANT");
        assertThat(row.getExpiresAt()).isNull();
        assertThat(saved.getAllValues().get(1).isEquipped()).isTrue();
        verify(userAvatarFrameRepository).clearEquippedFrames(ADMIN);
        assertThat(dto.ownership().equipped()).isTrue();
    }

    @Test
    @DisplayName("Learner cannot equip an unowned frame (403) and no ownership row is created")
    void learnerCannotBypassOwnership() {
        assertThatThrownBy(() -> service.equipFrame(LEARNER, "sss_dragon_emperor"))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
        verify(userAvatarFrameRepository, never()).saveAndFlush(any());
    }

    @Test
    @DisplayName("Learner with an expired frame still gets 'expired' (override applies to the admin only)")
    void learnerExpiredUnchanged() {
        UserAvatarFrame expired = UserAvatarFrame.builder().id(5L).userId(LEARNER).frame(prestige).source("PREMIUM")
                .unlockedAt(Instant.parse("2026-01-01T00:00:00Z")).expiresAt(Instant.parse("2026-02-01T00:00:00Z")).build();
        when(userAvatarFrameRepository.findByUserIdAndFrameId(LEARNER, 10L)).thenReturn(Optional.of(expired));
        assertThatThrownBy(() -> service.equipFrame(LEARNER, "sss_dragon_emperor"))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
    }
}
