package com.englishcoach.writing.repository;

import com.englishcoach.writing.entity.WritingPracticeEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface WritingPracticeRepository extends JpaRepository<WritingPracticeEntity, String> {
    Optional<WritingPracticeEntity> findByIdAndUserId(String id, Long userId);
    List<WritingPracticeEntity> findByUserIdOrderByCreatedAtDesc(Long userId);

    long countByUserIdAndIsCompletedTrueAndUpdatedAtAfter(Long userId, java.time.Instant after);

    long countByUserIdAndIsCompletedTrue(Long userId);
    Optional<WritingPracticeEntity> findByUserIdAndTargetPatternCodeAndIsCompletedFalse(Long userId, String targetPatternCode);
}
