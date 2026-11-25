package com.englishcoach.writing.translation.repository;

import com.englishcoach.writing.translation.entity.TranslationImportBatchEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationImportBatchRepository extends JpaRepository<TranslationImportBatchEntity, UUID> {
    Optional<TranslationImportBatchEntity> findByBatchKey(String batchKey);
}
