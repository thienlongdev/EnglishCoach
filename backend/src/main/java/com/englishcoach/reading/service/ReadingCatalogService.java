package com.englishcoach.reading.service;

import com.englishcoach.common.cache.BoundedTtlCache;
import com.englishcoach.reading.dto.ReadingCatalogResponse;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.*;

/** Catalog queries never select content_text or join per-user progress. */
@Service
public class ReadingCatalogService {
    private static final ObjectMapper DEFAULT_MAPPER = new ObjectMapper();
    private static final String SYSTEM_SNAPSHOT_KEY = "system-reading-catalog";
    private static final int SYSTEM_SNAPSHOT_MAX_ROWS = 2_000;
    private static final long SYSTEM_CACHE_TTL_MS = Duration.ofMinutes(10).toMillis();

    private record SystemRow(ReadingCatalogResponse.Card card, Integer rawWordCount, Instant createdAt) {}
    private record SystemSnapshot(List<SystemRow> rows, boolean truncated) {}

    private final NamedParameterJdbcTemplate jdbc;
    private final Map<String, JsonNode> metadata = new HashMap<>();
    private final List<String> cachedTopics;
    // Bounded 10-min cache strictly for SYSTEM (is_system=true AND owner_user_id IS NULL) metadata snapshot;
    // NEVER caches USER library and NEVER keys by unbounded raw search strings.
    private final BoundedTtlCache<String, SystemSnapshot> systemCatalogCache =
            new BoundedTtlCache<>(32, SYSTEM_CACHE_TTL_MS);

    @Autowired(required = false)
    private ObjectMapper objectMapper = DEFAULT_MAPPER;

    private ObjectMapper mapper() {
        return objectMapper != null ? objectMapper : DEFAULT_MAPPER;
    }

    @Autowired
    public ReadingCatalogService(NamedParameterJdbcTemplate jdbc) {
        this.jdbc = jdbc;
        // Small metadata sidecar only; corpus bodies are read solely by the explicit importer.
        var resource = new ClassPathResource("data/reading/metadata.json");
        if (resource.exists()) {
            try (var input = resource.getInputStream()) {
                byte[] bytes = input.readNBytes(500001);
                if (bytes.length > 500000) throw new IllegalStateException("Reading metadata exceeds bound");
                var items = DEFAULT_MAPPER.readTree(bytes);
                if (!items.isArray() || items.size() > 250) throw new IllegalStateException("Invalid reading metadata shape");
                for (JsonNode item : items) {
                    if (item.size() != 5 || !List.of("sourceUrl","topic","description","licenseCode","attribution").stream().allMatch(k -> item.path(k).isTextual() && item.path(k).asText().length() < 2000)
                            || !item.path("sourceUrl").asText().startsWith("https://")
                            || metadata.put(item.path("sourceUrl").asText(),item) != null) throw new IllegalStateException("Invalid reading metadata item");
                }
            } catch (java.io.IOException e) { throw new IllegalStateException("Invalid reading metadata", e); }
        }
        this.cachedTopics = metadata.values().stream()
                .map(n -> n.path("topic").asText())
                .filter(s -> !s.isBlank())
                .distinct()
                .sorted()
                .toList();
    }

    public String metadata(String url, String field, String fallback) {
        var node = metadata.get(url);
        return node == null ? fallback : node.path(field).asText(fallback);
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

    private SystemSnapshot loadSystemSnapshot() {
        return systemCatalogCache.get(SYSTEM_SNAPSHOT_KEY, ignored -> {
            List<SystemRow> rows = jdbc.query(
                    "SELECT id,title,source_url,source_name,material_type,word_count,difficulty_level,is_system,created_at "
                            + "FROM public.reading_materials "
                            + "WHERE is_system = true AND owner_user_id IS NULL "
                            + "ORDER BY created_at DESC NULLS LAST, id DESC "
                            + "LIMIT :maxRows",
                    Map.of("maxRows", SYSTEM_SNAPSHOT_MAX_ROWS + 1),
                    (rs, row) -> {
                        String url = rs.getString("source_url");
                        Integer rawWords = rs.getObject("word_count", Integer.class);
                        int words = rawWords != null ? rawWords : 0;
                        Timestamp ts = rs.getTimestamp("created_at");
                        Instant createdAt = ts != null ? ts.toInstant() : null;
                        ReadingCatalogResponse.Card card = new ReadingCatalogResponse.Card(
                                rs.getLong("id"), rs.getString("title"), url,
                                rs.getString("source_name"), rs.getString("material_type"), words,
                                rs.getString("difficulty_level"), rs.getBoolean("is_system"),
                                metadata(url, "topic", "Other"), Math.max(1, (words + 199) / 200),
                                metadata(url, "description", ""), metadata(url, "licenseCode", ""),
                                metadata(url, "attribution", ""));
                        return new SystemRow(card, rawWords, createdAt);
                    });
            if (rows.size() > SYSTEM_SNAPSHOT_MAX_ROWS) {
                return new SystemSnapshot(List.of(), true);
            }
            return new SystemSnapshot(List.copyOf(rows), false);
        });
    }

    @Transactional(readOnly = true, timeout = 15)
    public ReadingCatalogResponse catalog(Long userId, String library, int page, int size, String search, String topic, String level, String sort) {
        if (!Set.of("SYSTEM", "USER").contains(library) || page < 0 || page > 100000 || size < 1 || size > 24)
            throw new IllegalArgumentException("Invalid reading catalog query");
        if (userId == null) throw new org.springframework.security.access.AccessDeniedException("Authentication required");
        if (search.length() > 160 || topic.length() > 80 || level.length() > 20) throw new IllegalArgumentException("Filter too long");

        if ("SYSTEM".equals(library)) {
            SystemSnapshot snapshot = loadSystemSnapshot();
            if (snapshot != null && !snapshot.truncated()) {
                return filterSystemSnapshot(snapshot.rows(), page, size, search, topic, level, sort);
            }
        }
        return queryCatalogFromDb(userId, library, page, size, search, topic, level, sort);
    }

    private ReadingCatalogResponse filterSystemSnapshot(
            List<SystemRow> allRows, int page, int size, String search, String topic, String level, String sort) {
        String searchLower = !search.isBlank() ? search.toLowerCase(Locale.ROOT) : null;
        Set<String> topicUrls = null;
        if (!topic.isBlank()) {
            topicUrls = new HashSet<>();
            for (Map.Entry<String, JsonNode> e : metadata.entrySet()) {
                if (e.getValue().path("topic").asText().equals(topic)) {
                    topicUrls.add(e.getKey());
                }
            }
            if (topicUrls.isEmpty()) {
                return buildCatalogResponse(0L, page, size, List.of());
            }
        }

        List<SystemRow> filtered = new ArrayList<>(allRows.size());
        for (SystemRow row : allRows) {
            ReadingCatalogResponse.Card card = row.card();
            if (!level.isBlank() && !level.equals(card.difficultyLevel())) {
                continue;
            }
            if (topicUrls != null && (card.sourceUrl() == null || !topicUrls.contains(card.sourceUrl()))) {
                continue;
            }
            if (searchLower != null) {
                boolean titleMatch = card.title() != null && card.title().toLowerCase(Locale.ROOT).contains(searchLower);
                boolean sourceMatch = card.sourceName() != null && card.sourceName().toLowerCase(Locale.ROOT).contains(searchLower);
                if (!titleMatch && !sourceMatch) {
                    continue;
                }
            }
            filtered.add(row);
        }

        if ("length".equals(sort)) {
            filtered.sort(Comparator.comparing(SystemRow::rawWordCount, Comparator.nullsLast(Comparator.naturalOrder()))
                    .thenComparing(r -> r.card().id(), Comparator.reverseOrder()));
        } else if ("cefr".equals(sort)) {
            filtered.sort(Comparator.comparing((SystemRow r) -> r.card().difficultyLevel(), Comparator.nullsLast(Comparator.naturalOrder()))
                    .thenComparing(r -> r.card().id(), Comparator.reverseOrder()));
        }
        // Default "recent" is already ordered by created_at DESC NULLS LAST, id DESC in snapshot.

        long total = filtered.size();
        long offsetLong = (long) page * size;
        List<ReadingCatalogResponse.Card> pageCards;
        if (offsetLong >= total) {
            pageCards = List.of();
        } else {
            int from = (int) offsetLong;
            int to = (int) Math.min(total, offsetLong + size);
            pageCards = new ArrayList<>(to - from);
            for (int i = from; i < to; i++) {
                pageCards.add(filtered.get(i).card());
            }
        }
        return buildCatalogResponse(total, page, size, pageCards);
    }

    private ReadingCatalogResponse queryCatalogFromDb(
            Long userId, String library, int page, int size, String search, String topic, String level, String sort) {
        Map<String, Object> params = new HashMap<>();
        params.put("user", userId); params.put("limit", size); params.put("offset", (long) page * size);
        String where = library.equals("SYSTEM") ? "is_system = true AND owner_user_id IS NULL" : "is_system = false AND owner_user_id = :user";
        if (!search.isBlank()) {
            where += " AND (title ILIKE :search ESCAPE '\\' OR source_name ILIKE :search ESCAPE '\\')";
            params.put("search", "%" + search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%");
        }
        if (!level.isBlank()) { where += " AND difficulty_level = :level"; params.put("level", level); }
        if (!topic.isBlank()) {
            var urls = metadata.entrySet().stream().filter(e -> e.getValue().path("topic").asText().equals(topic)).map(Map.Entry::getKey).toList();
            if (urls.isEmpty()) where += " AND false";
            else { where += " AND source_url IN (:urls)"; params.put("urls", urls); }
        }
        String order = switch (sort) { case "length" -> "word_count ASC NULLS LAST, id DESC"; case "cefr" -> "difficulty_level ASC NULLS LAST, id DESC"; default -> "created_at DESC NULLS LAST, id DESC"; };
        // The page and the filtered total in ONE statement (performance release 2026-11-16, PERF-18 / PERF-01): one remote
        // round trip instead of a count and a page. Only a page past the end needs the separate count.
        long[] windowTotal = {-1};
        var cards = jdbc.query("SELECT id,title,source_url,source_name,material_type,word_count,difficulty_level,is_system, count(*) OVER () AS total_count FROM public.reading_materials WHERE " + where + " ORDER BY " + order + " LIMIT :limit OFFSET :offset", params,
            (rs, row) -> {
                if (row == 0) windowTotal[0] = rs.getLong("total_count");
                String url = rs.getString("source_url"); int words = rs.getInt("word_count");
                return new ReadingCatalogResponse.Card(rs.getLong("id"), rs.getString("title"), url,
                    rs.getString("source_name"), rs.getString("material_type"), words, rs.getString("difficulty_level"), rs.getBoolean("is_system"),
                    metadata(url, "topic", "Other"), Math.max(1, (words + 199) / 200), metadata(url, "description", ""),
                    metadata(url, "licenseCode", ""), metadata(url, "attribution", ""));
            });
        long total = windowTotal[0] >= 0 ? windowTotal[0]
                : (page == 0 ? 0L : jdbc.queryForObject("SELECT count(*) FROM public.reading_materials WHERE " + where, params, Long.class));
        return buildCatalogResponse(total, page, size, cards);
    }

    private ReadingCatalogResponse buildCatalogResponse(long total, int page, int size, List<ReadingCatalogResponse.Card> cards) {
        try {
            String revision = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                .digest(mapper().writeValueAsBytes(List.of(total, cards, cachedTopics))));
            return new ReadingCatalogResponse(revision, total, page, size, (int) ((total + size - 1) / size), cachedTopics, cards);
        } catch (Exception e) { throw new IllegalStateException("Cannot encode reading catalog", e); }
    }

    @Transactional(readOnly = true, timeout = 15)
    public List<ReadingCatalogResponse.Progress> progress(Long userId) {
        if (userId == null) throw new org.springframework.security.access.AccessDeniedException("Authentication required");
        return jdbc.query("SELECT r.id,r.title,r.source_url,r.source_name,r.material_type,r.word_count,r.difficulty_level,r.is_system,p.percent,p.last_read FROM public.reading_materials r JOIN (SELECT reading_material_id,MAX(scroll_percentage) percent,MAX(last_read_at) last_read FROM public.user_reading_progress WHERE user_id=:user GROUP BY reading_material_id) p ON r.id=p.reading_material_id WHERE ((r.is_system=true AND r.owner_user_id IS NULL) OR (r.is_system=false AND r.owner_user_id=:user)) ORDER BY p.last_read DESC NULLS LAST,r.id DESC LIMIT 12",
            Map.of("user", userId), (rs, n) -> {
                String url = rs.getString("source_url"); int words = rs.getInt("word_count");
                var card = new ReadingCatalogResponse.Card(rs.getLong("id"),rs.getString("title"),url,rs.getString("source_name"),rs.getString("material_type"),words,rs.getString("difficulty_level"),rs.getBoolean("is_system"),metadata(url,"topic","Other"),Math.max(1,(words+199)/200),metadata(url,"description",""),metadata(url,"licenseCode",""),metadata(url,"attribution",""));
                return new ReadingCatalogResponse.Progress(rs.getLong("id"), Math.max(0,Math.min(100,rs.getInt("percent"))),rs.getString("last_read"),card);
            });
    }
}
