package com.englishcoach.writing.repository;

import com.englishcoach.writing.entity.WritingReferenceAnswerCacheEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface WritingReferenceAnswerCacheRepository extends JpaRepository<WritingReferenceAnswerCacheEntity, String> {
    Optional<WritingReferenceAnswerCacheEntity> findByCacheKey(String cacheKey);
}
