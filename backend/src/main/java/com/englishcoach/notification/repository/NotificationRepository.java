package com.englishcoach.notification.repository;

import com.englishcoach.notification.entity.Notification;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

@Repository
public interface NotificationRepository extends JpaRepository<Notification, Long> {

    interface GlobalNotificationStateProjection {
        Long getNotificationId();
        Boolean getIsRead();
        Boolean getIsDismissed();
    }

    /**
     * R12: Split OR across scope into UNION ALL of two partial-index-backed branches
     * ({@code idx_notifications_global_publish} and {@code idx_notifications_user_target_publish}).
     */
    @Query(value = """
        SELECT id,
               type,
               title,
               body,
               action_url AS actionUrl,
               publish_at AS publishAt,
               is_read AS isRead
        FROM (
            (
                SELECT n.id,
                       n.type,
                       n.title,
                       n.body,
                       n.action_url,
                       n.publish_at,
                       (s.read_at IS NOT NULL) AS is_read
                FROM public.notifications n
                LEFT JOIN public.notification_user_states s
                    ON s.notification_id = n.id AND s.user_id = :userId
                WHERE n.scope = 'GLOBAL'
                  AND n.publish_at <= :now
                  AND (n.expires_at IS NULL OR n.expires_at > :now)
                  AND s.dismissed_at IS NULL
                ORDER BY n.publish_at DESC, n.id DESC
                LIMIT :limit
            )
            UNION ALL
            (
                SELECT n.id,
                       n.type,
                       n.title,
                       n.body,
                       n.action_url,
                       n.publish_at,
                       (s.read_at IS NOT NULL) AS is_read
                FROM public.notifications n
                LEFT JOIN public.notification_user_states s
                    ON s.notification_id = n.id AND s.user_id = :userId
                WHERE n.scope = 'USER'
                  AND n.target_user_id = :userId
                  AND n.publish_at <= :now
                  AND (n.expires_at IS NULL OR n.expires_at > :now)
                  AND s.dismissed_at IS NULL
                ORDER BY n.publish_at DESC, n.id DESC
                LIMIT :limit
            )
        ) combined
        ORDER BY publish_at DESC, id DESC
        LIMIT :limit
    """, nativeQuery = true)
    List<LearnerNotificationProjection> findVisibleNotificationsForUser(
            @Param("userId") Long userId,
            @Param("now") Instant now,
            @Param("limit") int limit
    );

    @Query(value = """
        SELECT n.id AS id,
               n.type AS type,
               n.title AS title,
               n.body AS body,
               n.action_url AS actionUrl,
               n.publish_at AS publishAt,
               (s.read_at IS NOT NULL) AS isRead
        FROM public.notifications n
        LEFT JOIN public.notification_user_states s
            ON s.notification_id = n.id AND s.user_id = :userId
        WHERE n.scope = 'USER'
          AND n.target_user_id = :userId
          AND n.publish_at <= :now
          AND (n.expires_at IS NULL OR n.expires_at > :now)
          AND s.dismissed_at IS NULL
        ORDER BY n.publish_at DESC, n.id DESC
        LIMIT :limit
    """, nativeQuery = true)
    List<LearnerNotificationProjection> findVisibleUserScopedNotifications(
            @Param("userId") Long userId,
            @Param("now") Instant now,
            @Param("limit") int limit
    );

    @Query("""
        SELECT n FROM Notification n
        WHERE n.scope = com.englishcoach.notification.entity.NotificationScope.GLOBAL
          AND (n.expiresAt IS NULL OR n.expiresAt > :now)
        ORDER BY n.publishAt DESC, n.id DESC
    """)
    List<Notification> findAllNonExpiredGlobalNotifications(@Param("now") Instant now);

    @Query(value = """
        SELECT s.notification_id AS notificationId,
               (s.read_at IS NOT NULL) AS isRead,
               (s.dismissed_at IS NOT NULL) AS isDismissed
        FROM public.notification_user_states s
        WHERE s.user_id = :userId
          AND s.notification_id IN (:notificationIds)
    """, nativeQuery = true)
    List<GlobalNotificationStateProjection> findUserStatesForNotifications(
            @Param("userId") Long userId,
            @Param("notificationIds") Collection<Long> notificationIds
    );

    /**
     * R12: Split OR across scope into UNION ALL of two index-backed count branches.
     */
    @Query(value = """
        SELECT CAST(COALESCE(SUM(cnt), 0) AS BIGINT)
        FROM (
            SELECT COUNT(*) AS cnt
            FROM public.notifications n
            LEFT JOIN public.notification_user_states s
                ON s.notification_id = n.id AND s.user_id = :userId
            WHERE n.scope = 'GLOBAL'
              AND n.publish_at <= :now
              AND (n.expires_at IS NULL OR n.expires_at > :now)
              AND s.dismissed_at IS NULL
              AND s.read_at IS NULL
            UNION ALL
            SELECT COUNT(*) AS cnt
            FROM public.notifications n
            LEFT JOIN public.notification_user_states s
                ON s.notification_id = n.id AND s.user_id = :userId
            WHERE n.scope = 'USER'
              AND n.target_user_id = :userId
              AND n.publish_at <= :now
              AND (n.expires_at IS NULL OR n.expires_at > :now)
              AND s.dismissed_at IS NULL
              AND s.read_at IS NULL
        ) counts
    """, nativeQuery = true)
    long countUnreadForUser(
            @Param("userId") Long userId,
            @Param("now") Instant now
    );

    @Query(value = """
        SELECT COUNT(*) > 0
        FROM public.notifications n
        WHERE n.id = :notificationId
          AND n.publish_at <= :now
          AND (n.expires_at IS NULL OR n.expires_at > :now)
          AND (n.scope = 'GLOBAL' OR (n.scope = 'USER' AND n.target_user_id = :userId))
    """, nativeQuery = true)
    boolean isNotificationAccessibleToUser(
            @Param("notificationId") Long notificationId,
            @Param("userId") Long userId,
            @Param("now") Instant now
    );

    /**
     * Idempotent native insert for USER-scoped notifications matching partial unique index
     * {@code idx_notifications_user_dedupe_key (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL}.
     * Avoids PostgreSQL 25P02 aborted-transaction poisoning on concurrent duplicate dedupe keys.
     */
    @Query(value = """
        INSERT INTO public.notifications (
            scope, type, category, user_id, target_user_id, sender, title, body,
            action_url, dedupe_key, is_read, publish_at, created_at, updated_at
        ) VALUES (
            'USER', :type, :category, :userId, :userId, :sender, :title, :body,
            :actionUrl, :dedupeKey, false, :publishAt, :publishAt, :publishAt
        )
        ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING id
    """, nativeQuery = true)
    Optional<Long> insertUserNotificationIdempotent(
            @Param("type") String type,
            @Param("category") String category,
            @Param("userId") Long userId,
            @Param("sender") String sender,
            @Param("title") String title,
            @Param("body") String body,
            @Param("actionUrl") String actionUrl,
            @Param("dedupeKey") String dedupeKey,
            @Param("publishAt") Instant publishAt
    );

    boolean existsByUserIdAndDedupeKey(Long userId, String dedupeKey);

    Optional<Notification> findByUserIdAndDedupeKey(Long userId, String dedupeKey);

    @org.springframework.data.jpa.repository.Modifying
    @org.springframework.transaction.annotation.Transactional
    @Query(value = """
        UPDATE public.notifications
        SET is_read = true, read_at = :now
        WHERE id = :notificationId AND (user_id = :userId OR target_user_id = :userId)
    """, nativeQuery = true)
    int markNotificationAsRead(
            @Param("notificationId") Long notificationId,
            @Param("userId") Long userId,
            @Param("now") Instant now
    );

    @org.springframework.data.jpa.repository.Modifying
    @org.springframework.transaction.annotation.Transactional
    @Query(value = """
        UPDATE public.notifications
        SET is_read = true, read_at = :now
        WHERE (user_id = :userId OR target_user_id = :userId) AND is_read = false
    """, nativeQuery = true)
    int markAllNotificationsAsReadForUser(
            @Param("userId") Long userId,
            @Param("now") Instant now
    );

    @org.springframework.data.jpa.repository.Modifying
    @org.springframework.transaction.annotation.Transactional
    @Query(value = """
        DELETE FROM public.notifications
        WHERE is_read = true AND read_at IS NOT NULL AND read_at < :threshold
    """, nativeQuery = true)
    int deleteReadNotificationsOlderThan(@Param("threshold") Instant threshold);

    @org.springframework.data.jpa.repository.Modifying
    @org.springframework.transaction.annotation.Transactional
    @Query(value = """
        DELETE FROM public.notifications
        WHERE id IN (
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) as rn
                FROM public.notifications
                WHERE user_id IS NOT NULL
            ) ranked
            WHERE ranked.rn > :cap
        )
    """, nativeQuery = true)
    int pruneUserNotificationsOverCap(@Param("cap") int cap);

    Page<Notification> findAllByOrderByCreatedAtDesc(Pageable pageable);
}
