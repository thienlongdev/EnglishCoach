package com.englishcoach.writing.translation.repository;

import com.englishcoach.writing.translation.entity.TranslationGradeCacheEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationGradeCacheRepository extends JpaRepository<TranslationGradeCacheEntity, UUID> {
    Optional<TranslationGradeCacheEntity> findByUserIdAndFingerprintHash(Long userId, String fingerprintHash);
}
