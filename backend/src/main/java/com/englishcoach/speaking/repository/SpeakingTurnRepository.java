package com.englishcoach.speaking.repository;

import com.englishcoach.speaking.entity.SpeakingTurn;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface SpeakingTurnRepository extends JpaRepository<SpeakingTurn, Long> {

    @Query("SELECT t FROM SpeakingTurn t LEFT JOIN FETCH t.detectedVocabulary WHERE t.session.id = :sessionId ORDER BY t.sequenceNumber ASC")
    List<SpeakingTurn> findBySessionIdOrderBySequenceNumberAsc(@Param("sessionId") Long sessionId);

    @Query("SELECT t FROM SpeakingTurn t WHERE t.session.id IN :sessionIds")
    List<SpeakingTurn> findBySessionIdIn(@Param("sessionIds") List<Long> sessionIds);

    Optional<SpeakingTurn> findBySessionIdAndClientTurnId(Long sessionId, String clientTurnId);

    Optional<SpeakingTurn> findByClientTurnId(String clientTurnId);

    @Query("SELECT COALESCE(MAX(t.sequenceNumber), 0) FROM SpeakingTurn t WHERE t.session.id = :sessionId")
    Integer findMaxSequenceNumberBySessionId(@Param("sessionId") Long sessionId);

    @Query("SELECT COALESCE(SUM(t.durationSeconds), 0) FROM SpeakingTurn t WHERE t.session.user.id = :userId AND t.speaker = 'LEARNER' AND (t.isMocked IS NULL OR t.isMocked = false)")
    Long sumLearnerSpeakingDurationSeconds(@Param("userId") Long userId);

    @Query("SELECT COUNT(t) FROM SpeakingTurn t WHERE t.session.user.id = :userId AND t.speaker = 'LEARNER' AND (t.isMocked IS NULL OR t.isMocked = false)")
    Long countLearnerRoleplayTurns(@Param("userId") Long userId);

    @Query("SELECT COUNT(DISTINCT v) FROM SpeakingTurn t JOIN t.detectedVocabulary v WHERE t.session.user.id = :userId AND t.speaker = 'LEARNER' AND (t.isMocked IS NULL OR t.isMocked = false)")
    Long countDistinctTargetVocabularyUsed(@Param("userId") Long userId);

    @Query("SELECT t.createdAt FROM SpeakingTurn t WHERE t.session.user.id = :userId AND t.speaker = 'LEARNER' AND (t.isMocked IS NULL OR t.isMocked = false) ORDER BY t.createdAt DESC")
    List<java.time.LocalDateTime> findGenuineTurnCreatedTimes(@Param("userId") Long userId);

    @Query("SELECT t FROM SpeakingTurn t WHERE t.session.user.id = :userId AND t.speaker = 'LEARNER' AND (t.isMocked IS NULL OR t.isMocked = false) AND t.createdAt >= :since ORDER BY t.createdAt DESC")
    List<SpeakingTurn> findRecentLearnerTurnsByUserId(@Param("userId") Long userId, @Param("since") java.time.LocalDateTime since, org.springframework.data.domain.Pageable pageable);
}
