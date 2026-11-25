package com.englishcoach.writing.repository;

import com.englishcoach.writing.entity.WritingErrorMemoryEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public interface WritingErrorMemoryRepository extends JpaRepository<WritingErrorMemoryEntity, String> {
    List<WritingErrorMemoryEntity> findTop3ByUserIdAndIsMutedFalseOrderByLastSeenAtDesc(Long userId);
    Optional<WritingErrorMemoryEntity> findByUserIdAndPatternCode(Long userId, String patternCode);
    List<WritingErrorMemoryEntity> findByUserIdOrderByLastSeenAtDesc(Long userId);
    List<WritingErrorMemoryEntity> findByUserIdAndDueForPracticeTrueOrderByNextPracticeDueAtAsc(Long userId);
    List<WritingErrorMemoryEntity> findByUserIdAndIsMutedFalseOrderByOccurrenceCountDesc(Long userId);
}
