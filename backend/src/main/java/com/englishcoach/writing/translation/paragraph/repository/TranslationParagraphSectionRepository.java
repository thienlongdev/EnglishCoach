package com.englishcoach.writing.translation.paragraph.repository;

import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphSectionEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationParagraphSectionRepository extends JpaRepository<TranslationParagraphSectionEntity, UUID> {
    Optional<TranslationParagraphSectionEntity> findByDocumentIdAndExternalSectionId(UUID documentId, String externalSectionId);
}
