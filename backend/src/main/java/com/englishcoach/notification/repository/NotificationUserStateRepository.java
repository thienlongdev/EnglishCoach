package com.englishcoach.notification.repository;

import com.englishcoach.notification.entity.NotificationUserState;
import com.englishcoach.notification.entity.NotificationUserStateId;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.Optional;

@Repository
public interface NotificationUserStateRepository extends JpaRepository<NotificationUserState, NotificationUserStateId> {

    Optional<NotificationUserState> findByNotificationIdAndUserId(Long notificationId, Long userId);

    @Modifying
    @Transactional
    @Query(value = """
        INSERT INTO public.notification_user_states (notification_id, user_id, read_at)
        VALUES (:notificationId, :userId, :now)
        ON CONFLICT (notification_id, user_id)
        DO UPDATE SET read_at = COALESCE(public.notification_user_states.read_at, EXCLUDED.read_at)
    """, nativeQuery = true)
    int markAsRead(
            @Param("notificationId") Long notificationId,
            @Param("userId") Long userId,
            @Param("now") Instant now
    );

    @Modifying
    @Transactional
    @Query(value = """
        INSERT INTO public.notification_user_states (notification_id, user_id, read_at, dismissed_at)
        VALUES (:notificationId, :userId, :now, :now)
        ON CONFLICT (notification_id, user_id)
        DO UPDATE SET 
            dismissed_at = COALESCE(public.notification_user_states.dismissed_at, EXCLUDED.dismissed_at),
            read_at = COALESCE(public.notification_user_states.read_at, EXCLUDED.read_at)
    """, nativeQuery = true)
    int dismiss(
            @Param("notificationId") Long notificationId,
            @Param("userId") Long userId,
            @Param("now") Instant now
    );

    @Modifying
    @Transactional
    @Query(value = """
        INSERT INTO public.notification_user_states (notification_id, user_id, read_at)
        SELECT n.id, :userId, :now
        FROM public.notifications n
        LEFT JOIN public.notification_user_states s 
            ON s.notification_id = n.id AND s.user_id = :userId
        WHERE n.publish_at <= :now
          AND (n.expires_at IS NULL OR n.expires_at > :now)
          AND (n.scope = 'GLOBAL' OR (n.scope = 'USER' AND n.target_user_id = :userId))
          AND (s.dismissed_at IS NULL)
          AND (s.read_at IS NULL)
        ON CONFLICT (notification_id, user_id)
        DO UPDATE SET read_at = COALESCE(public.notification_user_states.read_at, EXCLUDED.read_at)
    """, nativeQuery = true)
    int markAllAsReadForUser(
            @Param("userId") Long userId,
            @Param("now") Instant now
    );
}
