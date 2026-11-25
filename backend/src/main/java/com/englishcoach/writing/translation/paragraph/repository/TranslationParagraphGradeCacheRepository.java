package com.englishcoach.writing.translation.paragraph.repository;

import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphGradeCacheEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationParagraphGradeCacheRepository extends JpaRepository<TranslationParagraphGradeCacheEntity, UUID> {

    Optional<TranslationParagraphGradeCacheEntity> findByUserIdAndCacheFingerprint(Long userId, String cacheFingerprint);

    void deleteByUserIdAndCacheFingerprint(Long userId, String cacheFingerprint);
}
