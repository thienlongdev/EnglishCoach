package com.englishcoach.content.repository;

import com.englishcoach.content.entity.FeedArticle;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public interface FeedArticleRepository extends JpaRepository<FeedArticle, Long> {
    List<FeedArticle> findTop4ByOrderByPublishedAtDesc();
    List<FeedArticle> findTop40ByOrderByPublishedAtDesc();
    boolean existsByUrl(String url);
    Optional<FeedArticle> findByUrl(String url);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = "DELETE FROM feed_articles WHERE published_at < :cutoff AND (provider_key IS NULL OR provider_key != 'seed')", nativeQuery = true)
    int pruneOldArticles(@Param("cutoff") Instant cutoff);
}
