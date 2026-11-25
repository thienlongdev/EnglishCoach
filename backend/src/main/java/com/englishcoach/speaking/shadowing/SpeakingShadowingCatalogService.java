package com.englishcoach.speaking.shadowing;

import com.englishcoach.content.service.ContentServiceImpl;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Server-side paginated Shadowing catalog service.
 *
 * <p>Enforces {@code AGENTS.md §21} P0 user data isolation:
 * <ul>
 *   <li>System shared content: {@code is_system = true AND owner_user_id IS NULL}</li>
 *   <li>Learner private content: {@code is_system = false AND owner_user_id = :userId}</li>
 *   <li>Quarantined legacy rows ({@code is_system = false AND owner_user_id IS NULL}) are NEVER returned.</li>
 *   <li>Document listening materials ({@code source_type = 'DOCUMENT'}) are excluded from Shadowing.</li>
 * </ul>
 * Selects only lightweight card columns with single-RTT {@code COUNT(*) OVER ()} window pagination
 * (zero {@code transcript_segments}, zero {@code words_json}, zero N+1 queries).
 */
@Service
public class SpeakingShadowingCatalogService {

    public static final int DEFAULT_PAGE_SIZE = 12;
    public static final int MIN_PAGE_SIZE = 1;
    public static final int MAX_PAGE_SIZE = 24;
    private static final int MAX_PAGE_NUMBER = 100_000;
    private static final int MAX_SEARCH_LENGTH = 160;
    private static final int MAX_CEFR_LENGTH = 20;
    private static final int MAX_ACCENT_LENGTH = 60;
    private static final Set<String> VALID_SOURCES = Set.of("ALL", "SYSTEM", "USER");

    private static final String CARD_COLUMNS =
            "m.id, m.title, m.topic, m.channel, m.youtube_video_id, m.thumbnail, "
            + "m.audio_url, m.duration_seconds, m.cefr_level, m.accent, m.is_system, m.source_type";

    private final NamedParameterJdbcTemplate jdbc;

    public SpeakingShadowingCatalogService(NamedParameterJdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional(readOnly = true, timeout = 15)
    public ShadowingCatalogPageDto getCatalog(
            Long userId,
            int page,
            int size,
            String cefr,
            String accent,
            String source,
            String q
    ) {
        if (userId == null) {
            throw new AccessDeniedException("Authentication required");
        }

        int safePage = Math.max(0, Math.min(MAX_PAGE_NUMBER, page));
        int safeSize = Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, size));
        String normalizedSource = normalizeSource(source);
        String normalizedCefr = normalizeFilter(cefr, MAX_CEFR_LENGTH, true);
        String normalizedAccent = normalizeFilter(accent, MAX_ACCENT_LENGTH, false);
        String escapedSearchPattern = normalizeSearchPattern(q);

        Map<String, Object> params = new HashMap<>(8);
        params.put("userId", userId);
        params.put("limit", safeSize);
        params.put("offset", (long) safePage * safeSize);

        StringBuilder where = new StringBuilder("(m.source_type IS NULL OR m.source_type <> 'DOCUMENT') ");
        switch (normalizedSource) {
            case "SYSTEM" -> where.append("AND (m.is_system = TRUE AND m.owner_user_id IS NULL) ");
            case "USER" -> where.append("AND (m.is_system = FALSE AND m.owner_user_id IS NOT NULL AND m.owner_user_id = :userId) ");
            default -> where.append("AND ((m.is_system = TRUE AND m.owner_user_id IS NULL) ")
                    .append("OR (m.is_system = FALSE AND m.owner_user_id IS NOT NULL AND m.owner_user_id = :userId)) ");
        }

        if (normalizedCefr != null) {
            where.append("AND UPPER(m.cefr_level) = :cefr ");
            params.put("cefr", normalizedCefr);
        }
        if (normalizedAccent != null) {
            where.append("AND LOWER(m.accent) = :accent ");
            params.put("accent", normalizedAccent);
        }
        if (escapedSearchPattern != null) {
            where.append("AND (LOWER(m.title) LIKE :q ESCAPE '\\' ")
                    .append("OR LOWER(COALESCE(m.topic, '')) LIKE :q ESCAPE '\\' ")
                    .append("OR LOWER(COALESCE(m.channel, '')) LIKE :q ESCAPE '\\') ");
            params.put("q", escapedSearchPattern);
        }

        String selectSql = "SELECT " + CARD_COLUMNS + ", COUNT(*) OVER () AS total_count "
                + "FROM public.listening_materials m "
                + "WHERE " + where
                + "ORDER BY m.id DESC "
                + "LIMIT :limit OFFSET :offset";

        long[] windowTotal = {-1L};
        List<ShadowingMaterialCardDto> items = jdbc.query(selectSql, params, (rs, rowNum) -> {
            if (rowNum == 0) {
                windowTotal[0] = rs.getLong("total_count");
            }
            return mapCardRow(rs);
        });

        long totalElements;
        if (windowTotal[0] >= 0L) {
            totalElements = windowTotal[0];
        } else if (safePage == 0) {
            totalElements = 0L;
        } else {
            Long counted = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM public.listening_materials m WHERE " + where,
                    params,
                    Long.class
            );
            totalElements = counted != null ? counted : 0L;
        }

        int totalPages = totalElements == 0L ? 0 : (int) ((totalElements + safeSize - 1L) / safeSize);
        boolean hasNext = safePage + 1 < totalPages;
        boolean hasPrevious = safePage > 0 && totalPages > 0;

        return new ShadowingCatalogPageDto(
                List.copyOf(items),
                safePage,
                safeSize,
                totalElements,
                totalPages,
                hasNext,
                hasPrevious
        );
    }

    @Transactional(readOnly = true, timeout = 10)
    public ShadowingMaterialCardDto findVisibleCardById(Long userId, Long materialId) {
        if (userId == null) {
            throw new AccessDeniedException("Authentication required");
        }
        if (materialId == null || materialId <= 0L) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Shadowing material not found");
        }

        String sql = "SELECT " + CARD_COLUMNS + " "
                + "FROM public.listening_materials m "
                + "WHERE m.id = :id "
                + "AND (m.source_type IS NULL OR m.source_type <> 'DOCUMENT') "
                + "AND ((m.is_system = TRUE AND m.owner_user_id IS NULL) "
                + "OR (m.is_system = FALSE AND m.owner_user_id IS NOT NULL AND m.owner_user_id = :userId))";

        List<ShadowingMaterialCardDto> rows = jdbc.query(
                sql,
                Map.of("id", materialId, "userId", userId),
                (rs, rowNum) -> mapCardRow(rs)
        );
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Shadowing material not found");
        }
        return rows.get(0);
    }

    private static ShadowingMaterialCardDto mapCardRow(ResultSet rs) throws SQLException {
        String rawVideoId = rs.getString("youtube_video_id");
        String videoId = (rawVideoId != null && !rawVideoId.isBlank())
                ? rawVideoId.trim()
                : ContentServiceImpl.extractYouTubeVideoId(rs.getString("audio_url"));

        String rawThumb = rs.getString("thumbnail");
        String thumbnail = (rawThumb != null && !rawThumb.isBlank())
                ? rawThumb.trim()
                : (videoId != null ? "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg" : null);

        Integer rawDuration = rs.getObject("duration_seconds", Integer.class);
        int durationSeconds = rawDuration != null ? Math.max(0, rawDuration) : 0;

        String rawSourceType = rs.getString("source_type");
        String sourceType = (rawSourceType != null && !rawSourceType.isBlank()) ? rawSourceType.trim() : "VIDEO";

        return new ShadowingMaterialCardDto(
                rs.getLong("id"),
                rs.getString("title"),
                rs.getString("topic"),
                rs.getString("channel"),
                videoId,
                thumbnail,
                durationSeconds,
                rs.getString("cefr_level"),
                rs.getString("accent"),
                rs.getBoolean("is_system"),
                sourceType
        );
    }

    private static String normalizeSource(String source) {
        if (source == null || source.isBlank()) {
            return "ALL";
        }
        String normalized = source.trim().toUpperCase(Locale.ROOT);
        if (!VALID_SOURCES.contains(normalized)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid source filter: must be ALL, SYSTEM, or USER");
        }
        return normalized;
    }

    private static String normalizeFilter(String raw, int maxLen, boolean upper) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String trimmed = raw.trim();
        if (trimmed.length() > maxLen) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Filter parameter exceeds maximum length");
        }
        if ("ALL".equalsIgnoreCase(trimmed)) {
            return null;
        }
        return upper ? trimmed.toUpperCase(Locale.ROOT) : trimmed.toLowerCase(Locale.ROOT);
    }

    static String normalizeSearchPattern(String rawQuery) {
        if (rawQuery == null || rawQuery.isBlank()) {
            return null;
        }
        String trimmed = rawQuery.trim();
        if (trimmed.length() > MAX_SEARCH_LENGTH) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Search query exceeds maximum length");
        }
        String escaped = trimmed.toLowerCase(Locale.ROOT)
                .replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_");
        return "%" + escaped + "%";
    }
}
