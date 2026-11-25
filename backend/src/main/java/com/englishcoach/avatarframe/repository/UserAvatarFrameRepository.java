package com.englishcoach.avatarframe.repository;

import com.englishcoach.avatarframe.entity.UserAvatarFrame;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

@Repository
public interface UserAvatarFrameRepository extends JpaRepository<UserAvatarFrame, Long> {

    @Query("SELECT u FROM UserAvatarFrame u JOIN FETCH u.frame f JOIN FETCH f.series WHERE u.userId = :userId")
    List<UserAvatarFrame> findByUserIdWithFrame(@Param("userId") Long userId);

    @Query("SELECT u FROM UserAvatarFrame u JOIN FETCH u.frame f JOIN FETCH f.series WHERE u.userId = :userId AND f.id = :frameId")
    Optional<UserAvatarFrame> findByUserIdAndFrameId(@Param("userId") Long userId, @Param("frameId") Long frameId);

    @Query("SELECT u FROM UserAvatarFrame u JOIN FETCH u.frame f JOIN FETCH f.series WHERE u.userId = :userId AND u.isEquipped = true")
    Optional<UserAvatarFrame> findByUserIdAndIsEquippedTrue(@Param("userId") Long userId);

    @Query("SELECT u FROM UserAvatarFrame u JOIN FETCH u.frame f JOIN FETCH f.series WHERE u.userId IN :userIds AND u.isEquipped = true")
    List<UserAvatarFrame> findEquippedByUserIdIn(@Param("userIds") Collection<Long> userIds);

    /**
     * Idempotent native insert for automatic prestige unlocks: avoids PostgreSQL 25P02 aborted-transaction
     * poisoning when concurrent reconciliations attempt to grant the same (user_id, frame_id).
     */
    @Modifying(flushAutomatically = true, clearAutomatically = false)
    @Query(value = """
        INSERT INTO public.user_avatar_frames (user_id, frame_id, unlocked_at, expires_at, source, is_equipped, created_at)
        VALUES (:userId, :frameId, :now, :expiresAt, :source, false, :now)
        ON CONFLICT (user_id, frame_id) DO NOTHING
    """, nativeQuery = true)
    int grantIfAbsent(
            @Param("userId") Long userId,
            @Param("frameId") Long frameId,
            @Param("now") Instant now,
            @Param("expiresAt") Instant expiresAt,
            @Param("source") String source
    );

    @Modifying
    @Query("UPDATE UserAvatarFrame u SET u.isEquipped = false WHERE u.userId = :userId AND u.isEquipped = true")
    int clearEquippedFrames(@Param("userId") Long userId);

    long countByFrameId(Long frameId);

    @Query("SELECT u.frame.id, count(u) FROM UserAvatarFrame u GROUP BY u.frame.id")
    List<Object[]> countGroupedByFrameId();

    boolean existsByUserIdAndFrameId(Long userId, Long frameId);
}
