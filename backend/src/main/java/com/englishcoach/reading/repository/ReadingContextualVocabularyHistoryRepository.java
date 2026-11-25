package com.englishcoach.reading.repository;

import com.englishcoach.reading.entity.ReadingContextualVocabularyHistory;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface ReadingContextualVocabularyHistoryRepository extends JpaRepository<ReadingContextualVocabularyHistory, Long> {

    List<ReadingContextualVocabularyHistory> findByUserIdAndReadingMaterialIdOrderByCreatedAtDesc(
            Long userId,
            Long readingMaterialId
    );

    Optional<ReadingContextualVocabularyHistory> findByUserIdAndReadingMaterialIdAndExplanationId(
            Long userId,
            Long readingMaterialId,
            Long explanationId
    );

    Optional<ReadingContextualVocabularyHistory> findByIdAndUserId(Long id, Long userId);

    void deleteByIdAndUserId(Long id, Long userId);
}
