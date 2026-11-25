package com.englishcoach.notification.scheduler;

import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.notification.service.NotificationService;
import com.englishcoach.notification.service.NotificationTemplates;
import com.englishcoach.progress.config.LearningProgressProperties;
import com.englishcoach.progress.dto.UnifiedStreakDto;
import com.englishcoach.progress.service.UnifiedProgressService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.sql.Date;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;

@Component
@RequiredArgsConstructor
@Slf4j
public class StreakAtRiskScheduler {

    private final NotificationService notificationService;
    private final UnifiedProgressService unifiedProgressService;
    private final LearningProgressProperties learningProperties;
    private final NamedParameterJdbcTemplate jdbcTemplate;

    private static final int PAGE_SIZE = 500;

    /**
     * Evening scheduler to notify users whose streak is at risk.
     * Default runs at 20:00 user-local (Asia/Ho_Chi_Minh).
     */
    @Scheduled(
            cron = "${app.notifications.streak.at-risk-cron:0 0 20 * * *}",
            zone = "${app.learning.time-zone:Asia/Ho_Chi_Minh}"
    )
    public void checkAndNotifyStreakAtRisk() {
        ZoneId zoneId = learningProperties.getZoneId();
        LocalDate today = LocalDate.now(zoneId);
        LocalDate yesterday = today.minusDays(1);
        String dedupeKey = "STREAK_AT_RISK:" + today;

        log.info("[Streak At-Risk Scheduler] Starting evening check for date={} (timezone={})",
                today, learningProperties.getTimeZone());

        int offset = 0;
        int totalProcessed = 0;
        int totalNotified = 0;

        while (true) {
            List<Long> candidateUserIds = findCandidateAtRiskUserIds(yesterday, today, dedupeKey, PAGE_SIZE, offset);
            if (candidateUserIds.isEmpty()) {
                break;
            }

            for (Long userId : candidateUserIds) {
                totalProcessed++;
                try {
                    UnifiedStreakDto streak = unifiedProgressService.getStreak(userId);
                    if (streak.currentStreakDays() >= 1 && !streak.activeToday()) {
                        CreateNotificationCommand command = new CreateNotificationCommand(
                                userId,
                                NotificationCategory.STREAK,
                                NotificationType.STREAK,
                                NotificationTemplates.streakAtRiskTitle(),
                                NotificationTemplates.streakAtRiskContent(streak.currentStreakDays()),
                                "/flashcards",
                                dedupeKey
                        );
                        boolean created = notificationService.create(command).isPresent();
                        if (created) {
                            totalNotified++;
                        }
                    }
                } catch (Exception e) {
                    log.warn("[Streak At-Risk Scheduler] Error checking user {}: {}", userId, e.getMessage());
                }
            }

            if (candidateUserIds.size() < PAGE_SIZE) {
                break;
            }
            offset += PAGE_SIZE;
        }

        log.info("[Streak At-Risk Scheduler] Completed. Processed candidates={}, notified={}",
                totalProcessed, totalNotified);
    }

    public List<Long> findCandidateAtRiskUserIds(LocalDate yesterday, LocalDate today, String dedupeKey, int limit, int offset) {
        String sql = """
                SELECT DISTINCT act.user_id
                FROM (
                    SELECT (e.occurred_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date, e.user_id
                    FROM public.learning_activity_events e
                    UNION ALL
                    SELECT (t.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date, s.user_id
                    FROM speaking_turns t JOIN speaking_sessions s ON t.session_id = s.id
                    UNION ALL
                    SELECT (w.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date, w.user_id
                    FROM writing_submissions w
                    UNION ALL
                    SELECT (COALESCE(a.submitted_at, a.started_at, a.created_at)::timestamptz AT TIME ZONE :timeZone)::date AS act_date, a.user_id
                    FROM exams.attempts a
                ) act
                WHERE act.act_date = :yesterday
                  AND NOT EXISTS (
                      SELECT 1 FROM (
                          SELECT (e.occurred_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date, e.user_id
                          FROM public.learning_activity_events e
                          UNION ALL
                          SELECT (t.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date, s.user_id
                          FROM speaking_turns t JOIN speaking_sessions s ON t.session_id = s.id
                          UNION ALL
                          SELECT (w.created_at::timestamptz AT TIME ZONE :timeZone)::date AS act_date, w.user_id
                          FROM writing_submissions w
                          UNION ALL
                          SELECT (COALESCE(a.submitted_at, a.started_at, a.created_at)::timestamptz AT TIME ZONE :timeZone)::date AS act_date, a.user_id
                          FROM exams.attempts a
                      ) today_act
                      WHERE today_act.user_id = act.user_id AND today_act.act_date = :today
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM public.notifications n
                      WHERE (n.user_id = act.user_id OR n.target_user_id = act.user_id) AND n.dedupe_key = :dedupeKey
                  )
                ORDER BY act.user_id ASC
                LIMIT :limit OFFSET :offset
                """;

        MapSqlParameterSource params = new MapSqlParameterSource()
                .addValue("timeZone", learningProperties.getTimeZone())
                .addValue("yesterday", Date.valueOf(yesterday))
                .addValue("today", Date.valueOf(today))
                .addValue("dedupeKey", dedupeKey)
                .addValue("limit", limit)
                .addValue("offset", offset);

        return jdbcTemplate.query(sql, params, (rs, rowNum) -> rs.getLong("user_id"));
    }
}
