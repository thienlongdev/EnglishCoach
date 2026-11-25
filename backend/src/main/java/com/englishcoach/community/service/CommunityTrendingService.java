package com.englishcoach.community.service;

import com.englishcoach.community.dto.TrendingTopicDto;
import com.englishcoach.community.entity.CommunityPost;
import com.englishcoach.community.repository.CommunityPostRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
@RequiredArgsConstructor
@Slf4j
public class CommunityTrendingService {

    private static final Pattern HASHTAG_PATTERN = Pattern.compile("#([a-zA-Z0-9_\\u00C0-\\u024F\\u1EA0-\\u1EF9]+)");
    private static final long CACHE_TTL_MS = 60 * 1000; // 60 seconds short-lived cache

    private final CommunityPostRepository postRepository;

    private volatile List<TrendingTopicDto> cachedTopics = null;
    private volatile long lastCacheTime = 0L;
    private final java.util.concurrent.atomic.AtomicBoolean refreshing = new java.util.concurrent.atomic.AtomicBoolean(false);

    /** Present in the application; a test that builds this service by hand computes without a template. */
    private org.springframework.transaction.PlatformTransactionManager transactionManager;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setTransactionManager(org.springframework.transaction.PlatformTransactionManager transactionManager) {
        this.transactionManager = transactionManager;
    }

    /**
     * Public trending tags, recomputed at most once a minute. Performance release 2026-11-16 (PERF-21): a fresh answer is
     * returned with no transaction at all (it used to check out a pooled connection for every call); once the minute has
     * passed ONE caller recomputes while the others keep the previous answer for that moment instead of queueing behind
     * the lock. Only the very first computation is waited for.
     */
    public List<TrendingTopicDto> getTrendingTopics() {
        long now = System.currentTimeMillis();
        List<TrendingTopicDto> currentCache = cachedTopics;
        if (currentCache != null && (now - lastCacheTime) < CACHE_TTL_MS) {
            return currentCache;
        }
        if (currentCache != null) {
            if (!refreshing.compareAndSet(false, true)) {
                return currentCache;
            }
            try {
                List<TrendingTopicDto> calculated = computeInReadTransaction();
                cachedTopics = calculated;
                lastCacheTime = System.currentTimeMillis();
                return calculated;
            } finally {
                refreshing.set(false);
            }
        }

        synchronized (this) {
            if (cachedTopics != null && (System.currentTimeMillis() - lastCacheTime) < CACHE_TTL_MS) {
                return cachedTopics;
            }

            List<TrendingTopicDto> calculated = computeInReadTransaction();
            cachedTopics = calculated;
            lastCacheTime = System.currentTimeMillis();
            return calculated;
        }
    }

    private List<TrendingTopicDto> computeInReadTransaction() {
        if (transactionManager == null) return computeTrendingTopics();
        org.springframework.transaction.support.TransactionTemplate tx =
                new org.springframework.transaction.support.TransactionTemplate(transactionManager);
        tx.setReadOnly(true);
        return tx.execute(status -> computeTrendingTopics());
    }

    private List<TrendingTopicDto> computeTrendingTopics() {
        Instant since = Instant.now().minus(7, ChronoUnit.DAYS);
        List<CommunityPost> recentPosts = postRepository.findRecentPublishedPostsForTrending(since);

        // If very low activity in last 7 days, extend window to 30 days to keep community lively
        if (recentPosts.size() < 5) {
            since = Instant.now().minus(30, ChronoUnit.DAYS);
            recentPosts = postRepository.findRecentPublishedPostsForTrending(since);
        }

        if (recentPosts.isEmpty()) {
            return Collections.emptyList();
        }

        Map<String, TopicStats> statsMap = new HashMap<>();

        for (CommunityPost post : recentPosts) {
            String content = post.getContent();
            if (content == null || !content.contains("#")) {
                continue;
            }

            Matcher matcher = HASHTAG_PATTERN.matcher(content);
            Set<String> seenInThisPost = new HashSet<>();

            while (matcher.find()) {
                String rawTag = matcher.group(1);
                String normalized = rawTag.toLowerCase(Locale.ROOT);

                if (!seenInThisPost.add(normalized)) {
                    continue; // count each tag once per post
                }

                TopicStats stats = statsMap.computeIfAbsent(normalized, k -> new TopicStats(rawTag));
                stats.postCount += 1;
                stats.reactionCount += post.getLikeCount();
                stats.commentCount += post.getCommentCount();

                if (post.getAuthor() != null && post.getAuthor().getId() != null) {
                    stats.authorIds.add(post.getAuthor().getId());
                }

                Instant postTime = post.getPublishedAt() != null ? post.getPublishedAt() : post.getCreatedAt();
                if (postTime != null && (stats.latestTime == null || postTime.isAfter(stats.latestTime))) {
                    stats.latestTime = postTime;
                }
            }
        }

        if (statsMap.isEmpty()) {
            return Collections.emptyList();
        }

        Instant nowInstant = Instant.now();
        List<TrendingTopicDto> result = new ArrayList<>();

        for (TopicStats stats : statsMap.values()) {
            double hoursSinceLatest = 24.0;
            if (stats.latestTime != null) {
                hoursSinceLatest = Math.max(0, ChronoUnit.MINUTES.between(stats.latestTime, nowInstant) / 60.0);
            }

            // Deterministic score: recency + engagement + breadth
            double score = (stats.postCount * 3.0)
                    + (stats.commentCount * 2.0)
                    + (stats.reactionCount * 1.0)
                    + (stats.authorIds.size() * 2.0)
                    - (hoursSinceLatest * 0.05);

            String label;
            if (hoursSinceLatest < 24 && stats.postCount >= 2) {
                label = "Hôm nay";
            } else if (stats.postCount >= 5 || stats.commentCount >= 5) {
                label = "Sôi nổi";
            } else if (stats.commentCount >= 3) {
                label = "Thảo luận";
            } else if (stats.postCount > 1) {
                label = stats.postCount + " bài viết";
            } else if (stats.reactionCount + stats.commentCount > 0) {
                label = (stats.reactionCount + stats.commentCount) + " tương tác";
            } else {
                label = "Mới";
            }

            result.add(TrendingTopicDto.builder()
                    .tag(stats.displayTag)
                    .label(label)
                    .postCount(stats.postCount)
                    .reactionCount(stats.reactionCount)
                    .commentCount(stats.commentCount)
                    .score(score)
                    .build());
        }

        // Sort descending by score
        result.sort((a, b) -> Double.compare(b.getScore(), a.getScore()));

        // Return top 10
        return result.size() > 10 ? result.subList(0, 10) : result;
    }

    private static class TopicStats {
        final String displayTag;
        int postCount = 0;
        int reactionCount = 0;
        int commentCount = 0;
        final Set<Long> authorIds = new HashSet<>();
        Instant latestTime = null;

        TopicStats(String displayTag) {
            this.displayTag = displayTag;
        }
    }
}
