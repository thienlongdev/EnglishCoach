package com.englishcoach.content.repository;

import com.englishcoach.content.entity.YoutubeFeed;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface YoutubeFeedRepository extends JpaRepository<YoutubeFeed, Long> {
    boolean existsByVideoId(String videoId);
    Optional<YoutubeFeed> findByVideoId(String videoId);
}
