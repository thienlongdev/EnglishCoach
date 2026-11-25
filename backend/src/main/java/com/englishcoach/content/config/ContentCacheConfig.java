package com.englishcoach.content.config;

import com.englishcoach.common.cache.BoundedTtlCacheManager;
import com.englishcoach.common.cache.BoundedTtlCacheManager.CacheSpec;
import org.springframework.cache.CacheManager;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

@Configuration
@EnableCaching
public class ContentCacheConfig {

    public static final String CACHE_FEED = "contentFeed";
    public static final String CACHE_LISTENING_TODAY = "contentListeningToday";
    public static final String CACHE_DICTATION_TODAY = "contentDictationToday";
    public static final String CACHE_TRENDING_VOCAB = "contentTrendingVocab";
    public static final String CACHE_READING = "contentReading";

    @Bean
    public CacheManager contentCacheManager() {
        Map<String, CacheSpec> specs = new LinkedHashMap<>();
        specs.put(CACHE_FEED, CacheSpec.of(64, Duration.ofMinutes(5)));
        specs.put(CACHE_LISTENING_TODAY, CacheSpec.of(128, Duration.ofMinutes(10)));
        specs.put(CACHE_DICTATION_TODAY, CacheSpec.of(128, Duration.ofMinutes(10)));
        specs.put(CACHE_TRENDING_VOCAB, CacheSpec.of(128, Duration.ofMinutes(10)));
        specs.put(CACHE_READING, CacheSpec.of(256, Duration.ofMinutes(10)));
        return new BoundedTtlCacheManager(specs);
    }

    @Bean
    @org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean(java.time.Clock.class)
    public java.time.Clock contentClock() {
        return java.time.Clock.system(java.time.ZoneId.of("Asia/Ho_Chi_Minh"));
    }
}
