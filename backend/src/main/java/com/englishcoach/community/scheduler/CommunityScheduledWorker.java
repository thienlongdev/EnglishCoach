package com.englishcoach.community.scheduler;

import com.englishcoach.community.entity.CommunityPost;
import com.englishcoach.community.entity.PostStatus;
import com.englishcoach.community.repository.CommunityPostRepository;
import com.englishcoach.community.service.CommunityDailyVocabularyService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

@Component
@RequiredArgsConstructor
@Slf4j
public class CommunityScheduledWorker {

    private final CommunityDailyVocabularyService dailyVocabularyService;
    private final CommunityPostRepository postRepository;

    /**
     * On application startup, ensure today's official daily post exists so learners immediately see fresh content.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void onStartup() {
        try {
            LocalDate today = LocalDate.now(CommunityDailyVocabularyService.VN_ZONE);
            dailyVocabularyService.ensureDailyVocabularyPost(today);
        } catch (Exception e) {
            log.warn("Could not ensure daily vocabulary post on startup: {}", e.getMessage());
        }
    }

    /**
     * Publishes daily vocabulary post at midnight 00:00 Asia/Ho_Chi_Minh.
     */
    @Scheduled(cron = "0 0 0 * * *", zone = "Asia/Ho_Chi_Minh")
    public void scheduledDailyVocabulary() {
        log.info("Running scheduled Daily Vocabulary post generation for Asia/Ho_Chi_Minh midnight...");
        try {
            LocalDate today = LocalDate.now(CommunityDailyVocabularyService.VN_ZONE);
            dailyVocabularyService.ensureDailyVocabularyPost(today);
        } catch (Exception e) {
            log.error("Failed to run scheduled Daily Vocabulary generation: {}", e.getMessage(), e);
        }
    }

    /**
     * Periodically sweeps scheduled posts whose publication time has arrived.
     */
    @Scheduled(fixedDelay = 60000)
    @Transactional
    public void sweepScheduledPosts() {
        Instant now = Instant.now();
        List<CommunityPost> duePosts = postRepository.findScheduledPostsReadyToPublish(now);
        for (CommunityPost post : duePosts) {
            post.setStatus(PostStatus.PUBLISHED);
            post.setPublishedAt(now);
            postRepository.save(post);
            log.info("Promoted scheduled post {} to PUBLISHED at {}", post.getId(), now);
        }
    }
}
