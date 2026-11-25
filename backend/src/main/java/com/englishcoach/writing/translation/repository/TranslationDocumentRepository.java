package com.englishcoach.writing.translation.repository;

import com.englishcoach.writing.translation.entity.TranslationDocumentEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationDocumentRepository extends JpaRepository<TranslationDocumentEntity, UUID> {
    Optional<TranslationDocumentEntity> findBySourceIdAndSourceDocumentIdAndContentVersion(
            UUID sourceId, String sourceDocumentId, Integer contentVersion
    );
    long countByActiveTrue();
}
