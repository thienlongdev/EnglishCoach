package com.englishcoach.reading.service;

import com.englishcoach.common.cache.BoundedTtlCache;
import com.englishcoach.reading.dto.BilingualReadingCatalogResponse;
import com.englishcoach.reading.dto.BilingualReadingDetailResponse;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.security.MessageDigest;
import java.time.Duration;
import java.util.*;

@Service
public class BilingualReadingService {
    private static final ObjectMapper DEFAULT_MAPPER = new ObjectMapper();
    private static final String SYSTEM_SNAPSHOT_KEY = "bilingual-system-all";
    private static final long SYSTEM_CACHE_TTL_MS = Duration.ofMinutes(10).toMillis();

    private record BilingualSystemSnapshot(
            List<BilingualReadingCatalogResponse.Card> allCards,
            long articleCount,
            long storyCount
    ) {}

    private final NamedParameterJdbcTemplate jdbc;
    // Bounded 10-min cache strictly for SYSTEM (is_system=TRUE AND owner_user_id IS NULL) catalog lists.
    private final BoundedTtlCache<String, BilingualSystemSnapshot> systemCatalogCache =
            new BoundedTtlCache<>(32, SYSTEM_CACHE_TTL_MS);

    @Autowired(required = false)
    private ObjectMapper objectMapper = DEFAULT_MAPPER;

    private ObjectMapper mapper() {
        return objectMapper != null ? objectMapper : DEFAULT_MAPPER;
    }

    @Autowired
    public BilingualReadingService(NamedParameterJdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public void evictSystemCatalog() {
        systemCatalogCache.clear();
    }

    public void evictSystemCatalogAfterCommit() {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    systemCatalogCache.clear();
                }
            });
        } else {
            systemCatalogCache.clear();
        }
    }

    private BilingualSystemSnapshot loadSystemSnapshot() {
        return systemCatalogCache.get(SYSTEM_SNAPSHOT_KEY, ignored -> {
            List<BilingualReadingCatalogResponse.Card> cards = jdbc.query(
                    "SELECT id,content_type,title_en,title_vi,difficulty_level,word_count,estimated_minutes "
                            + "FROM public.bilingual_reading_materials "
                            + "WHERE is_system = TRUE AND owner_user_id IS NULL "
                            + "ORDER BY logical_position ASC,id ASC",
                    Map.of(),
                    (rs, row) -> new BilingualReadingCatalogResponse.Card(
                            rs.getLong("id"), rs.getString("content_type"), rs.getString("title_en"),
                            rs.getString("title_vi"), rs.getString("difficulty_level"),
                            rs.getInt("word_count"), rs.getInt("estimated_minutes")));
            long articles = 0L;
            long stories = 0L;
            for (BilingualReadingCatalogResponse.Card c : cards) {
                if ("ARTICLE".equals(c.contentType())) articles++;
                else if ("STORY".equals(c.contentType())) stories++;
            }
            return new BilingualSystemSnapshot(List.copyOf(cards), articles, stories);
        });
    }

    @Transactional(readOnly = true, timeout = 15)
    public BilingualReadingCatalogResponse catalog(String contentType) {
        String filterType = null;
        if (contentType != null && !contentType.isBlank()) {
            if (!Set.of("ARTICLE", "STORY").contains(contentType)) {
                throw new IllegalArgumentException("Invalid bilingual content type");
            }
            filterType = contentType;
        }
        BilingualSystemSnapshot snapshot = loadSystemSnapshot();
        List<BilingualReadingCatalogResponse.Card> cards;
        if (filterType == null) {
            cards = snapshot.allCards();
        } else {
            final String target = filterType;
            cards = snapshot.allCards().stream()
                    .filter(c -> target.equals(c.contentType()))
                    .toList();
        }
        try {
            String revision = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(mapper().writeValueAsBytes(cards)));
            return new BilingualReadingCatalogResponse(revision, cards.size(), snapshot.articleCount(), snapshot.storyCount(), cards);
        } catch (Exception e) {
            throw new IllegalStateException("Cannot encode bilingual catalog", e);
        }
    }

    @Transactional(readOnly = true, timeout = 15)
    public BilingualReadingDetailResponse detail(Long id) {
        var material = jdbc.query(
                "SELECT id,content_type,title_en,title_vi,difficulty_level,word_count,estimated_minutes "
                        + "FROM public.bilingual_reading_materials "
                        + "WHERE id=:id AND is_system=TRUE AND owner_user_id IS NULL",
                Map.of("id", id),
                (rs, row) -> new Object[]{
                        rs.getLong("id"), rs.getString("content_type"), rs.getString("title_en"),
                        rs.getString("title_vi"), rs.getString("difficulty_level"),
                        rs.getInt("word_count"), rs.getInt("estimated_minutes")
                });
        if (material.isEmpty()) {
            throw new org.springframework.web.server.ResponseStatusException(
                    org.springframework.http.HttpStatus.NOT_FOUND, "Bilingual reading material not found");
        }
        Object[] m = material.get(0);
        var segments = jdbc.query(
                "SELECT position,text_en,text_vi,source_reference FROM public.bilingual_reading_segments WHERE material_id=:id ORDER BY position",
                Map.of("id", id),
                (rs, row) -> new BilingualReadingDetailResponse.Segment(
                        rs.getInt("position"), rs.getString("text_en"),
                        rs.getString("text_vi"), rs.getString("source_reference")));
        return new BilingualReadingDetailResponse(
                (Long) m[0], (String) m[1], (String) m[2], (String) m[3],
                (String) m[4], (Integer) m[5], (Integer) m[6], segments);
    }
}
