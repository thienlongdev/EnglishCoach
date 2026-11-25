package com.englishcoach.progress.service;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;

import java.sql.Timestamp;
import java.time.Instant;

@Service
@RequiredArgsConstructor
@Slf4j
public class LearningEventService {

    private final NamedParameterJdbcTemplate jdbcTemplate;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.context.ApplicationEventPublisher eventPublisher;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private UnifiedProgressService unifiedProgressService;

    /**
     * Additive, fail-safe learning event recording.
     * Guaranteed to never throw or break the surrounding transaction if an error occurs.
     */
    public boolean recordEventSafely(Long userId, String activityType, String sourceRef, Instant occurredAt) {
        return store(userId, activityType, sourceRef, occurredAt) != Stored.FAILED;
    }

    /**
     * For an occurrence that really happened even when its natural reference was used before: a flashcard's review
     * counter restarts after "reset", so {@code cardId:count} can collide with a row written before the reset and the
     * new review left no trace (streak, heatmap and the garden's pest cure never saw it). On such a collision the
     * occurrence is stored under {@code sourceRef:r<epochMillis>}; the card id stays the first {@code :} field.
     * Same fail-safe contract as {@link #recordEventSafely}.
     */
    public boolean recordOccurrenceSafely(Long userId, String activityType, String sourceRef, Instant occurredAt) {
        Instant at = occurredAt != null ? occurredAt : Instant.now();
        Stored first = store(userId, activityType, sourceRef, at);
        if (first != Stored.DUPLICATE) return first == Stored.INSERTED;
        return store(userId, activityType, sourceRef + ":r" + at.toEpochMilli(), at) != Stored.FAILED;
    }

    private enum Stored { INSERTED, DUPLICATE, FAILED }

    private Stored store(Long userId, String activityType, String sourceRef, Instant occurredAt) {
        if (userId == null || activityType == null || sourceRef == null) {
            log.warn("Skipping learning event recording: missing required parameters");
            return Stored.FAILED;
        }

        try {
            String sql = """
                    INSERT INTO public.learning_activity_events (user_id, activity_type, source_ref, occurred_at)
                    VALUES (:userId, :activityType, :sourceRef, :occurredAt)
                    ON CONFLICT (user_id, activity_type, source_ref) DO NOTHING
                    """;

            MapSqlParameterSource params = new MapSqlParameterSource()
                    .addValue("userId", userId)
                    .addValue("activityType", activityType)
                    .addValue("sourceRef", sourceRef)
                    .addValue("occurredAt", Timestamp.from(occurredAt != null ? occurredAt : Instant.now()));

            int rows = jdbcTemplate.update(sql, params);
            log.debug("Recorded learning activity event: user={}, type={}, ref={}, inserted={}",
                    userId, activityType, sourceRef, rows > 0);

            if (rows > 0 && eventPublisher != null) {
                try {
                    java.time.LocalDate today = java.time.LocalDate.now(java.time.ZoneId.of("Asia/Ho_Chi_Minh"));
                    int streakDays = 1;
                    if (unifiedProgressService != null) {
                        try {
                            com.englishcoach.progress.dto.UnifiedStreakDto streak = unifiedProgressService.getStreak(userId);
                            if (streak != null && streak.currentStreakDays() > 0) {
                                streakDays = streak.currentStreakDays();
                            }
                        } catch (Exception ex) {
                            log.debug("Failed to calculate streak for notification: {}", ex.getMessage());
                        }
                    }
                    eventPublisher.publishEvent(new com.englishcoach.notification.event.StreakExtendedNotificationEvent(
                            userId, streakDays, today
                    ));

                    if ("FLASHCARD_REVIEWED".equalsIgnoreCase(activityType)) {
                        eventPublisher.publishEvent(new com.englishcoach.notification.event.FlashcardSessionNotificationEvent(
                                userId, "DAILY_GOAL:" + today, 10, today
                        ));
                    }
                } catch (Exception ex) {
                    log.warn("Non-fatal: Failed to trigger notification domain event: {}", ex.getMessage());
                }
            }

            return rows > 0 ? Stored.INSERTED : Stored.DUPLICATE;
        } catch (Exception e) {
            log.error("Failed to record learning activity event for user {} (type={}): {}",
                    userId, activityType, e.getMessage(), e);
            return Stored.FAILED;
        }
    }
}
