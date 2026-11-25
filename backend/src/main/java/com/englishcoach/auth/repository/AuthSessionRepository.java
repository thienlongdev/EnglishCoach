package com.englishcoach.auth.repository;

import com.englishcoach.auth.entity.AuthSession;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface AuthSessionRepository extends JpaRepository<AuthSession, UUID> {
    Optional<AuthSession> findBySessionGrantDigest(String sessionGrantDigest);

    List<AuthSession> findByUserIdAndState(Long userId, String state);

    @Modifying
    @Query("UPDATE AuthSession s SET s.state = 'REVOKED', s.revokedAt = :now, s.revokedReason = :reason WHERE s.user.id = :userId AND s.state IN ('ACTIVE', 'PENDING')")
    int revokeAllActiveSessionsForUser(@Param("userId") Long userId, @Param("now") Instant now, @Param("reason") String reason);

    @Modifying
    @Query("UPDATE AuthSession s SET s.state = 'REVOKED', s.revokedAt = :now, s.revokedReason = :reason WHERE s.id = :sessionId AND s.state = 'ACTIVE'")
    int revokeSessionById(@Param("sessionId") UUID sessionId, @Param("now") Instant now, @Param("reason") String reason);

    /**
     * The session and its account in ONE statement, outside any transaction (a declared query method has none): the
     * read every authenticated request makes. The database is a network round trip away, so this is one exchange
     * where loading the user and then the session in two transactions were five.
     */
    @Query("SELECT s FROM AuthSession s JOIN FETCH s.user WHERE s.id = :sessionId")
    Optional<AuthSession> findWithUserById(@Param("sessionId") UUID sessionId);

    /** Slides the idle window of an ACTIVE session (its own short transaction; 0 rows when it is no longer active). */
    @org.springframework.transaction.annotation.Transactional
    @Modifying
    // The idle window only ever slides forward: a website session's stored deadline is always earlier than the new one,
    // and an Echo Anywhere session keeps its longer window (set at sign-in / refresh) instead of shrinking to a day.
    @Query("UPDATE AuthSession s SET s.lastSeenAt = :now, s.idleExpiresAt = CASE WHEN s.idleExpiresAt > :idleExpiresAt THEN s.idleExpiresAt ELSE :idleExpiresAt END, s.deviceLabel = COALESCE(s.deviceLabel, :deviceLabel) WHERE s.id = :sessionId AND s.state = 'ACTIVE'")
    int touchActive(@Param("sessionId") UUID sessionId, @Param("now") Instant now, @Param("idleExpiresAt") Instant idleExpiresAt,
                    @Param("deviceLabel") String deviceLabel);

    /** The account's ACTIVE sessions still inside both lifetimes, most recently used first (session list). */
    @Query("SELECT s FROM AuthSession s WHERE s.user.id = :userId AND s.state = 'ACTIVE' AND s.idleExpiresAt > :now AND s.absoluteExpiresAt > :now ORDER BY COALESCE(s.lastSeenAt, s.activatedAt, s.createdAt) DESC")
    List<AuthSession> findLiveForUser(@Param("userId") Long userId, @Param("now") Instant now);

    /** Ends one ACTIVE session only if it belongs to that account (0 rows: not theirs, or already ended). */
    @org.springframework.transaction.annotation.Transactional
    @Modifying
    @Query("UPDATE AuthSession s SET s.state = 'REVOKED', s.revokedAt = :now, s.revokedReason = :reason WHERE s.id = :sessionId AND s.user.id = :userId AND s.state = 'ACTIVE'")
    int revokeOwned(@Param("sessionId") UUID sessionId, @Param("userId") Long userId, @Param("now") Instant now, @Param("reason") String reason);

    /** Ends every ACTIVE or PENDING session of the account except one (the caller's own). */
    @org.springframework.transaction.annotation.Transactional
    @Modifying
    @Query("UPDATE AuthSession s SET s.state = 'REVOKED', s.revokedAt = :now, s.revokedReason = :reason WHERE s.user.id = :userId AND s.state IN ('ACTIVE', 'PENDING') AND s.id <> :keepId")
    int revokeOthers(@Param("userId") Long userId, @Param("keepId") UUID keepId, @Param("now") Instant now, @Param("reason") String reason);

    /** Revokes an ACTIVE session whose lifetime has run out (its own short transaction). */
    @org.springframework.transaction.annotation.Transactional
    @Modifying
    @Query("UPDATE AuthSession s SET s.state = 'REVOKED', s.revokedAt = :now, s.revokedReason = :reason WHERE s.id = :sessionId AND s.state = 'ACTIVE'")
    int expireActive(@Param("sessionId") UUID sessionId, @Param("now") Instant now, @Param("reason") String reason);
}
