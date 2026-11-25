package com.englishcoach.content.service;

import com.englishcoach.content.config.RssProperties.RssSourceConfig;
import com.englishcoach.content.dto.NormalizedArticleItem;
import com.englishcoach.content.dto.NormalizedListeningItem;
import com.englishcoach.content.dto.NormalizedVideoItem;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

import java.util.List;

/**
 * Implementation of ContentProvider for RSS feeds.
 * Reuses Phase 1 provider contracts.
 */
@Slf4j
@RequiredArgsConstructor
public class RssContentProvider implements ContentProvider {

    private final RssSourceConfig config;
    private final RssFeedFetcher fetcher;
    private final RssFeedParser parser;

    @Override
    public String providerKey() {
        return config != null ? config.getKey() : "rss";
    }

    @Override
    public List<NormalizedArticleItem> fetchArticles() {
        if (config == null || !config.isEnabled() || config.getUrl() == null) {
            return List.of();
        }
        try {
            String xml = fetcher.fetchFeed(config.getUrl());
            return parser.parse(xml, config);
        } catch (Exception e) {
            log.warn("Failed to fetch RSS articles for source '{}': {}", config.getKey(), e.getMessage());
            log.debug("Stack trace for RSS source failure '{}':", config.getKey(), e);
            return List.of();
        }
    }

    @Override
    public List<NormalizedVideoItem> fetchVideos() {
        return List.of();
    }

    @Override
    public List<NormalizedListeningItem> fetchListeningItems() {
        return List.of();
    }
}
