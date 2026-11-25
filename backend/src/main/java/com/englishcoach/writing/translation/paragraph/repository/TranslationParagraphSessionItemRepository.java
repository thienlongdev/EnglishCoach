package com.englishcoach.writing.translation.paragraph.repository;

import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphSessionItemEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationParagraphSessionItemRepository extends JpaRepository<TranslationParagraphSessionItemEntity, UUID> {

    Optional<TranslationParagraphSessionItemEntity> findBySessionIdAndOrdinal(UUID sessionId, Integer ordinal);

    List<TranslationParagraphSessionItemEntity> findBySessionIdOrderByOrdinalAsc(UUID sessionId);
}
