package com.englishcoach.listening.repository;

import com.englishcoach.listening.entity.ListeningSession;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import java.util.List;

public interface ListeningSessionRepository extends JpaRepository<ListeningSession, Long> {
    @org.springframework.data.jpa.repository.Lock(jakarta.persistence.LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT s FROM ListeningSession s WHERE s.id = :id")
    java.util.Optional<ListeningSession> forUpdate(@Param("id") Long id);

    List<ListeningSession> findByListeningMaterialId(Long materialId);

    @Query("SELECT s FROM ListeningSession s WHERE s.user.id = :userId AND s.endedAt IS NOT NULL ORDER BY s.id DESC")
    List<ListeningSession> findCompletedSessionsByUserId(@Param("userId") Long userId);

    @Query("SELECT COUNT(s) FROM ListeningSession s WHERE s.user.id = :userId AND s.endedAt IS NOT NULL")
    long countCompletedSessionsByUserId(@Param("userId") Long userId);

    @Query("SELECT s FROM ListeningSession s WHERE s.endedAt IS NULL AND s.closedEarlyAt IS NULL")
    List<ListeningSession> findUnendedSessions();

    /** Unended sessions as [sessionId, materialId, userId (nullable)]: the start-up reconciliation needs no entity. */
    @Query("SELECT s.id, m.id, u.id FROM ListeningSession s JOIN s.listeningMaterial m LEFT JOIN s.user u WHERE s.endedAt IS NULL AND s.closedEarlyAt IS NULL")
    List<Object[]> findUnendedSessionKeys();

    /** Ends the given sessions as the reconciliation always did: at their start time, or now when they have none. */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("UPDATE ListeningSession s SET s.endedAt = COALESCE(s.startedAt, :now) WHERE s.id IN :ids AND s.endedAt IS NULL AND s.closedEarlyAt IS NULL")
    int markEnded(@Param("ids") java.util.Collection<Long> ids, @Param("now") java.time.LocalDateTime now);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = "DELETE FROM listening_sessions WHERE listening_material_id = :materialId", nativeQuery = true)
    void deleteByListeningMaterialId(@Param("materialId") Long materialId);
}
