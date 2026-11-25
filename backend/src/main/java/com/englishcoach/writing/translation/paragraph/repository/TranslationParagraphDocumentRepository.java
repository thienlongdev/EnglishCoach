package com.englishcoach.writing.translation.paragraph.repository;

import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphDocumentEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationParagraphDocumentRepository extends JpaRepository<TranslationParagraphDocumentEntity, UUID> {
    Optional<TranslationParagraphDocumentEntity> findBySourceIdAndExternalDocumentId(UUID sourceId, String externalDocumentId);
}
