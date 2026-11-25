package com.englishcoach.content.service;

import com.englishcoach.content.dto.NormalizedArticleItem;
import com.englishcoach.content.dto.NormalizedListeningItem;
import com.englishcoach.content.dto.NormalizedVideoItem;

public interface ContentIngestionService {
    int ingestFromProvider(ContentProvider provider);
    boolean ingestArticle(NormalizedArticleItem item);
    boolean ingestVideo(NormalizedVideoItem item);
    boolean ingestListening(NormalizedListeningItem item);
    int pruneOldFeedArticles();
    void evictCaches();
}
