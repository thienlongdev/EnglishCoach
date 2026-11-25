package com.englishcoach.speaking.repository;

import com.englishcoach.speaking.entity.SpeakingSession;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

@Repository
public interface SpeakingSessionRepository extends JpaRepository<SpeakingSession, Long> {

    List<SpeakingSession> findByUserIdOrderByCreatedAtDesc(Long userId);

    Page<SpeakingSession> findByUserIdOrderByCreatedAtDesc(Long userId, Pageable pageable);

    Page<SpeakingSession> findByUserIdAndModeOrderByCreatedAtDesc(Long userId, String mode, Pageable pageable);

    List<SpeakingSession> findByUserIdAndModeOrderByCreatedAtDesc(Long userId, String mode);

    List<SpeakingSession> findByUserIdAndModeAndCreatedAtAfterOrderByCreatedAtDesc(Long userId, String mode, LocalDateTime since);

    @Query("SELECT COUNT(s) FROM SpeakingSession s WHERE s.user.id = :userId AND s.status = 'COMPLETED'")
    Long countCompletedSessionsByUserId(@Param("userId") Long userId);

    @Query("SELECT COALESCE(SUM(s.durationSeconds), 0) FROM SpeakingSession s WHERE s.user.id = :userId AND s.mode = 'SHADOWING' AND s.status = 'COMPLETED'")
    Long sumCompletedShadowingDurationSeconds(@Param("userId") Long userId);

    @Query("SELECT s FROM SpeakingSession s LEFT JOIN FETCH s.scenario WHERE s.user.id = :userId ORDER BY s.createdAt DESC")
    List<SpeakingSession> findRecentSessionsByUserId(@Param("userId") Long userId, Pageable pageable);

    @Query("SELECT s.createdAt FROM SpeakingSession s WHERE s.user.id = :userId ORDER BY s.createdAt DESC")
    List<LocalDateTime> findSessionCreatedTimes(@Param("userId") Long userId);

    Optional<SpeakingSession> findFirstByUserIdAndModeAndSourceIdAndStatusOrderByCreatedAtDesc(
            Long userId, String mode, Long sourceId, String status
    );

    Optional<SpeakingSession> findFirstByUserIdAndModeAndStatusOrderByCreatedAtDesc(
            Long userId, String mode, String status
    );

    List<SpeakingSession> findByScenarioId(Long scenarioId);
}
