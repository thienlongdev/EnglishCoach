package com.englishcoach.speaking.repository;

import com.englishcoach.speaking.entity.SpeakingTurnFeedback;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface SpeakingTurnFeedbackRepository extends JpaRepository<SpeakingTurnFeedback, Long> {

    @Query("SELECT f FROM SpeakingTurnFeedback f WHERE f.turn.id = :turnId")
    Optional<SpeakingTurnFeedback> findByTurnId(@Param("turnId") Long turnId);

    @Query("SELECT f FROM SpeakingTurnFeedback f JOIN f.turn t JOIN t.session s WHERE s.user.id = :userId AND (f.isMocked IS NULL OR f.isMocked = false)")
    List<SpeakingTurnFeedback> findGenuineFeedbacksByUserId(@Param("userId") Long userId);

    @Query("SELECT f FROM SpeakingTurnFeedback f JOIN f.turn t JOIN t.session s WHERE s.user.id = :userId AND f.createdAt >= :after AND (f.isMocked IS NULL OR f.isMocked = false) ORDER BY f.createdAt ASC")
    List<SpeakingTurnFeedback> findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(@Param("userId") Long userId, @Param("after") java.time.LocalDateTime after);

    @Query("SELECT f FROM SpeakingTurnFeedback f WHERE f.turn.session.id = :sessionId")
    List<SpeakingTurnFeedback> findBySessionId(@Param("sessionId") Long sessionId);

    @Query("SELECT f FROM SpeakingTurnFeedback f WHERE f.turn.id IN :turnIds")
    List<SpeakingTurnFeedback> findByTurnIdIn(@Param("turnIds") List<Long> turnIds);

    @org.springframework.data.jpa.repository.Modifying
    @Query("DELETE FROM SpeakingTurnFeedback f WHERE f.turn.id IN :turnIds")
    void deleteByTurnIdIn(@Param("turnIds") List<Long> turnIds);
}
