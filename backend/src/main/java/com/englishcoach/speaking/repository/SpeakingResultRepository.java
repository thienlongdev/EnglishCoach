package com.englishcoach.speaking.repository;

import com.englishcoach.speaking.entity.SpeakingResult;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface SpeakingResultRepository extends JpaRepository<SpeakingResult, Long> {
    List<SpeakingResult> findByUserIdOrderByCreatedAtDesc(Long userId);

    @Query("SELECT AVG(r.accuracyScore) FROM SpeakingResult r WHERE r.user.id = :userId AND r.accuracyScore IS NOT NULL")
    Double getAverageAccuracyScoreByUserId(@Param("userId") Long userId);
}
