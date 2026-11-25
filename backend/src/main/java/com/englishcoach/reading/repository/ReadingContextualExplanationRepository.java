package com.englishcoach.reading.repository;

import com.englishcoach.reading.entity.ReadingContextualExplanation;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface ReadingContextualExplanationRepository extends JpaRepository<ReadingContextualExplanation, Long> {

    Optional<ReadingContextualExplanation> findByReadingMaterialIdAndNormalizedTextAndContextHashAndExplanationVersion(
            Long readingMaterialId,
            String normalizedText,
            String contextHash,
            String explanationVersion
    );

    List<ReadingContextualExplanation> findByReadingMaterialIdAndNormalizedText(
            Long readingMaterialId,
            String normalizedText
    );
}
