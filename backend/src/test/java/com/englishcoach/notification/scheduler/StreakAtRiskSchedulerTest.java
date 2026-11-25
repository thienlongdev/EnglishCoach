package com.englishcoach.notification.scheduler;

import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.entity.Notification;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.service.NotificationService;
import com.englishcoach.progress.config.LearningProgressProperties;
import com.englishcoach.progress.dto.UnifiedStreakDto;
import com.englishcoach.progress.service.UnifiedProgressService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class StreakAtRiskSchedulerTest {

    @Mock
    private NotificationService notificationService;

    @Mock
    private UnifiedProgressService unifiedProgressService;

    @Mock
    private LearningProgressProperties learningProperties;

    @Mock
    private NamedParameterJdbcTemplate jdbcTemplate;

    private StreakAtRiskScheduler scheduler;

    @BeforeEach
    void setUp() {
        when(learningProperties.getZoneId()).thenReturn(ZoneId.of("Asia/Ho_Chi_Minh"));
        lenient().when(learningProperties.getTimeZone()).thenReturn("Asia/Ho_Chi_Minh");

        scheduler = new StreakAtRiskScheduler(
                notificationService,
                unifiedProgressService,
                learningProperties,
                jdbcTemplate
        );
    }

    @Test
    @DisplayName("P0-D: Selects at-risk users only (streak >= 1, not active today), skips studied-today and streak 0")
    void testCheckAndNotifyStreakAtRisk_FiltersCorrectly() {
        Long atRiskUser = 101L;
        Long streakZeroUser = 102L;
        Long activeTodayUser = 103L;

        // Mock DB returning 3 candidates from yesterday's activity
        when(jdbcTemplate.query(anyString(), any(MapSqlParameterSource.class), any(RowMapper.class)))
                .thenReturn(List.of(atRiskUser, streakZeroUser, activeTodayUser))
                .thenReturn(List.of()); // second page empty

        // User 1: Streak 5, not active today -> SHOULD notify
        when(unifiedProgressService.getStreak(atRiskUser))
                .thenReturn(new UnifiedStreakDto(5, 10, false));

        // User 2: Streak 0 -> SHOULD SKIP
        when(unifiedProgressService.getStreak(streakZeroUser))
                .thenReturn(new UnifiedStreakDto(0, 0, false));

        // User 3: Streak 3, active today -> SHOULD SKIP
        when(unifiedProgressService.getStreak(activeTodayUser))
                .thenReturn(new UnifiedStreakDto(3, 3, true));

        when(notificationService.create(any(CreateNotificationCommand.class)))
                .thenReturn(Optional.of(Notification.builder().id(999L).build()));

        scheduler.checkAndNotifyStreakAtRisk();

        ArgumentCaptor<CreateNotificationCommand> cmdCaptor = ArgumentCaptor.forClass(CreateNotificationCommand.class);
        verify(notificationService, times(1)).create(cmdCaptor.capture());

        CreateNotificationCommand cmd = cmdCaptor.getValue();
        assertThat(cmd.userId()).isEqualTo(atRiskUser);
        assertThat(cmd.category()).isEqualTo(NotificationCategory.STREAK);
        assertThat(cmd.dedupeKey()).startsWith("STREAK_AT_RISK:");
        assertThat(cmd.content()).contains("5");
    }

    @Test
    @DisplayName("P0-D: Second run on same day is a no-op (idempotent dedupe)")
    void testSecondRunIsNoOp() {
        when(jdbcTemplate.query(anyString(), any(MapSqlParameterSource.class), any(RowMapper.class)))
                .thenReturn(List.of()); // DB returns 0 candidates because dedupeKey already exists

        scheduler.checkAndNotifyStreakAtRisk();

        verify(notificationService, never()).create(any());
    }
}
