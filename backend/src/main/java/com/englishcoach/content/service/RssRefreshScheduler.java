package com.englishcoach.content.service;

import com.englishcoach.content.config.RssProperties;
import com.englishcoach.content.config.RssProperties.RssSourceConfig;
import com.englishcoach.content.dto.NormalizedArticleItem;
import com.englishcoach.content.dto.RssRefreshResultDto;
import com.englishcoach.content.dto.RssRefreshResultDto.SourceRefreshResult;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Scheduled and event-driven RSS refresh coordinator.
 * Prevents overlapping runs, ensures per-source error isolation, and manages pruning and cache eviction.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class RssRefreshScheduler {

    private final RssProperties rssProperties;
    private final RssFeedFetcher feedFetcher;
    private final RssFeedParser feedParser;
    private final ContentIngestionService ingestionService;

    private final AtomicBoolean isRefreshing = new AtomicBoolean(false);

    @EventListener(ApplicationReadyEvent.class)
    public void onStartup() {
        if (!rssProperties.isEnabled()) {
            log.info("RSS ingestion is disabled by configuration");
            return;
        }
        // Async, error-isolated refresh on fresh deploy
        CompletableFuture.runAsync(() -> {
            try {
                // Short wait to ensure DB connection pool and startup stabilize
                Thread.sleep(1500);
                log.info("Starting initial async RSS content refresh on application ready...");
                refreshFeeds();
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            } catch (Exception e) {
                log.warn("Initial RSS refresh encountered error: {}", e.getMessage());
            }
        });
    }

    // Remote feed fetches run on the slow-jobs scheduler (PERF-10), not on the default one that drives game ticks.
    @Scheduled(cron = "${content.rss.cron:0 0 */3 * * *}",
            scheduler = com.englishcoach.common.scheduling.SlowJobsSchedulerConfig.SCHEDULER_BEAN)
    public void scheduledRefresh() {
        if (!rssProperties.isEnabled()) {
            return;
        }
        log.info("Triggering scheduled RSS content refresh...");
        refreshFeeds();
    }

    /**
     * Executes feed refresh across all configured sources with strict error isolation and concurrency guard.
     */
    public RssRefreshResultDto refreshFeeds() {
        if (!isRefreshing.compareAndSet(false, true)) {
            log.warn("RSS refresh is already in progress. Skipping overlapping run.");
            return RssRefreshResultDto.builder()
                    .success(false)
                    .totalSources(0)
                    .totalInserted(0)
                    .build();
        }

        try {
            List<RssSourceConfig> sources = rssProperties.getSources();
            if (sources == null || sources.isEmpty()) {
                log.info("No RSS sources configured for ingestion.");
                return RssRefreshResultDto.builder().success(true).build();
            }

            int totalInserted = 0;
            List<SourceRefreshResult> sourceResults = new ArrayList<>();

            for (RssSourceConfig source : sources) {
                SourceRefreshResult sRes = refreshSingleSource(source);
                sourceResults.add(sRes);
                totalInserted += sRes.getInserted();
            }

            // Pruning old rows beyond newest 50
            ingestionService.pruneOldFeedArticles();

            if (totalInserted > 0) {
                ingestionService.evictCaches();
            }

            return RssRefreshResultDto.builder()
                    .success(true)
                    .totalSources(sources.size())
                    .totalInserted(totalInserted)
                    .sources(sourceResults)
                    .build();
        } finally {
            isRefreshing.set(false);
        }
    }

    private SourceRefreshResult refreshSingleSource(RssSourceConfig source) {
        String key = source.getKey();
        String name = source.getName();

        if (!source.isEnabled()) {
            log.info("RSS source '{}' is disabled, skipping.", key);
            return SourceRefreshResult.builder()
                    .key(key)
                    .name(name)
                    .fetched(0)
                    .inserted(0)
                    .skipped(0)
                    .failed(0)
                    .build();
        }

        int fetched = 0;
        int inserted = 0;
        int skipped = 0;
        int failed = 0;
        String errorMsg = null;

        try {
            String xml = feedFetcher.fetchFeed(source.getUrl());
            List<NormalizedArticleItem> items = feedParser.parse(xml, source);
            fetched = items != null ? items.size() : 0;

            if (items != null && !items.isEmpty()) {
                // Keep only newest max-items-per-source per run
                int maxItems = rssProperties.getMaxItemsPerSource() > 0 ? rssProperties.getMaxItemsPerSource() : 10;
                List<NormalizedArticleItem> toProcess = items.stream()
                        .sorted(Comparator.comparing(NormalizedArticleItem::getPublishedAt, Comparator.nullsLast(Comparator.reverseOrder())))
                        .limit(maxItems)
                        .toList();

                for (NormalizedArticleItem item : toProcess) {
                    try {
                        boolean ok = ingestionService.ingestArticle(item);
                        if (ok) {
                            inserted++;
                        } else {
                            skipped++;
                        }
                    } catch (Exception e) {
                        failed++;
                        log.debug("Failed to ingest item '{}': {}", item.getUrl(), e.getMessage());
                    }
                }
            }

            log.info("RSS source '{}' finished: fetched={}, inserted={}, skipped={}, failed={}",
                    key, fetched, inserted, skipped, failed);

        } catch (Exception e) {
            failed++;
            errorMsg = e.getMessage();
            log.warn("RSS source '{}' fetch/parse failed: {}", key, e.getMessage());
            log.debug("Stack trace for source '{}':", key, e);
        }

        return SourceRefreshResult.builder()
                .key(key)
                .name(name)
                .fetched(fetched)
                .inserted(inserted)
                .skipped(skipped)
                .failed(failed)
                .error(errorMsg)
                .build();
    }
}
