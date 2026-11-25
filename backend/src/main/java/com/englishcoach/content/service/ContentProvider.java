package com.englishcoach.content.service;

import com.englishcoach.content.dto.NormalizedArticleItem;
import com.englishcoach.content.dto.NormalizedListeningItem;
import com.englishcoach.content.dto.NormalizedVideoItem;

import java.util.List;

public interface ContentProvider {
    String providerKey();
    List<NormalizedArticleItem> fetchArticles();
    List<NormalizedVideoItem> fetchVideos();
    List<NormalizedListeningItem> fetchListeningItems();
}
