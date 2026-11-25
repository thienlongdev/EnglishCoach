package com.englishcoach.content.repository;

import com.englishcoach.content.entity.ReadingContent;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface ReadingContentRepository extends JpaRepository<ReadingContent, Long> {
    Optional<ReadingContent> findBySourceArticleId(Long sourceArticleId);
}
