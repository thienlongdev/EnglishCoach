package com.englishcoach.notification.service;

import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.notification.dto.CreateNotificationCommand;
import com.englishcoach.notification.entity.NotificationCategory;
import com.englishcoach.notification.entity.NotificationType;
import com.englishcoach.progress.config.LearningProgressProperties;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The daily Flashcards review reminder ("Bạn có N từ cần ôn hôm nay"). Lazy: it is reconciled when the signed-in
 * learner's bell asks for its notifications, never by a scheduler, AI or a page render. At most one reminder per learner
 * per local day (dedupe key {@code FLASHCARD_DUE:<date>} + the unique index on (user_id, dedupe_key)), only when cards
 * the learner studied earlier reach their due day (never NEW cards, never a card rated Khó in today's session; see
 * {@code FlashcardRepository#countReviewDueByUserId}), and it marks itself read once nothing is due
 * any more, so the bell never keeps an outdated count. A small in-memory memo keeps the bell's polling off the database:
 * once the day's reminder is settled the learner costs nothing until the next local day.
 */
@Slf4j
@Service
public class FlashcardDueReminderService {

    static final String KEY_PREFIX = "FLASHCARD_DUE:";
    static final String ACTION_URL = "/flashcards?review=learned";
    /** Nothing due yet today: look again at most this often (a card can come due later in the day). */
    static final long RECHECK_NONE_DUE_MILLIS = 30 * 60_000L;
    /** Reminder still unread: re-count at most this often to notice that the learner finished. */
    static final long RECHECK_UNREAD_MILLIS = 60_000L;
    private static final int MEMO_CAPACITY = 20_000;

    enum Phase { NONE_DUE, REMINDER_UNREAD, SETTLED }

    record Memo(LocalDate day, Phase phase, long checkedAtMillis) {}

    private final NotificationService notificationService;
    private final FlashcardRepository flashcardRepository;
    private final NamedParameterJdbcTemplate jdbc;
    private final LearningProgressProperties learningProperties;
    private final Map<Long, Memo> memo = java.util.Collections.synchronizedMap(new LinkedHashMap<>(256, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<Long, Memo> eldest) {
            return size() > MEMO_CAPACITY;
        }
    });
    /** Learners whose reconciliation is running: a simultaneous second read (navbar + popover at page load) skips. */
    private final java.util.Set<Long> inFlight = java.util.concurrent.ConcurrentHashMap.newKeySet();
    /** Test seam: the current time in milliseconds. */
    java.util.function.LongSupplier clock = System::currentTimeMillis;

    public FlashcardDueReminderService(NotificationService notificationService, FlashcardRepository flashcardRepository,
                                       NamedParameterJdbcTemplate jdbc, LearningProgressProperties learningProperties) {
        this.notificationService = notificationService;
        this.flashcardRepository = flashcardRepository;
        this.jdbc = jdbc;
        this.learningProperties = learningProperties;
    }

    /** Never throws: a reminder problem must not break the bell. */
    public void reconcile(Long userId) {
        if (userId == null || !inFlight.add(userId)) return;
        try {
            reconcileOrThrow(userId);
        } catch (Exception e) {
            log.warn("[Notifications] Flashcard due reminder not reconciled for user {}: {}", userId, e.getClass().getSimpleName());
        } finally {
            inFlight.remove(userId);
        }
    }

    void reconcileOrThrow(Long userId) {
        ZoneId zone = learningProperties != null ? learningProperties.getZoneId() : ZoneId.of("Asia/Ho_Chi_Minh");
        LocalDate today = LocalDate.now(zone);
        long now = clock.getAsLong();
        Memo known = memo.get(userId);
        if (known != null && known.day().equals(today)) {
            if (known.phase() == Phase.SETTLED) return;
            long wait = known.phase() == Phase.NONE_DUE ? RECHECK_NONE_DUE_MILLIS : RECHECK_UNREAD_MILLIS;
            if (now - known.checkedAtMillis() < wait) return;
        }

        String key = KEY_PREFIX + today;
        java.time.LocalDateTime dayStart = com.englishcoach.flashcard.service.FlashcardService.learningDayStart(zone);
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT n.id, (s.read_at IS NOT NULL OR s.dismissed_at IS NOT NULL OR n.is_read) AS done
                FROM public.notifications n
                LEFT JOIN public.notification_user_states s ON s.notification_id = n.id AND s.user_id = :u
                WHERE n.user_id = :u AND n.dedupe_key = :k
                """, new MapSqlParameterSource().addValue("u", userId).addValue("k", key));

        Phase phase;
        if (!rows.isEmpty()) {
            boolean done = Boolean.TRUE.equals(rows.get(0).get("done"));
            if (done) {
                phase = Phase.SETTLED;
            } else if (flashcardRepository.countReviewDueByUserId(userId, dayStart) == 0) {
                // everything that was due has been reviewed: the reminder stays in the history, read
                notificationService.markAsRead(userId, ((Number) rows.get(0).get("id")).longValue());
                phase = Phase.SETTLED;
            } else {
                phase = Phase.REMINDER_UNREAD;
            }
        } else {
            long due = flashcardRepository.countReviewDueByUserId(userId, dayStart);
            if (due == 0) {
                phase = Phase.NONE_DUE;
            } else {
                try {
                    notificationService.create(new CreateNotificationCommand(userId, NotificationCategory.MILESTONE,
                            NotificationType.REVIEW_DUE, NotificationTemplates.flashcardDueTitle(due),
                            NotificationTemplates.flashcardDueContent(due), ACTION_URL, key));
                } catch (RuntimeException raced) {
                    // another tab created it in the same moment (unique index): that one row stands
                    log.debug("[Notifications] Due reminder already created for user {}", userId);
                }
                phase = Phase.REMINDER_UNREAD;
            }
        }
        memo.put(userId, new Memo(today, phase, now));
    }

    /** Forgets a learner's memo, so the next bell read reconciles at once (used after a rating). */
    public void forget(Long userId) {
        if (userId != null) memo.remove(userId);
    }
}
