package com.englishcoach.reading.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

@Service
public class BilingualReadingImporter {
    private final NamedParameterJdbcTemplate jdbc;
    private final boolean enabled;
    private final ObjectMapper mapper = new ObjectMapper();
    public record Result(String manifestSha256, boolean applied, int total, int inserted, int updated, int skipped) {}
    public BilingualReadingImporter(NamedParameterJdbcTemplate jdbc, @Value("${APP_BILINGUAL_READING_IMPORT_ENABLED:false}") boolean enabled) { this.jdbc = jdbc; this.enabled = enabled; }

    @Transactional(timeout = 120)
    public Result run(boolean apply, boolean allowUpdates, String confirmation) {
        if (apply && !enabled) throw new IllegalStateException("Bilingual Reading import is disabled");
        try {
            byte[] bytes;
            try (var in = new ClassPathResource("data/reading/bilingual-corpus.json").getInputStream()) { bytes = in.readAllBytes(); }
            if (bytes.length > 8_000_000) throw new IllegalArgumentException("Bilingual corpus exceeds bound");
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            if (apply && !digest.equals(confirmation)) throw new IllegalArgumentException("Confirm the exact bilingual dry-run manifest digest");
            JsonNode root = mapper.readTree(bytes), items = root.path("items");
            if (!"bilingual-reading.v1".equals(root.path("schemaVersion").asText()) || !root.path("sourceFiles").isArray()) {
                throw new IllegalArgumentException("Unsupported bilingual corpus manifest");
            }
            Set<String> manifestSourceHashes = new HashSet<>();
            for (JsonNode source : root.path("sourceFiles")) {
                if (!source.path("sha256").asText().matches("[0-9a-f]{64}") || source.path("path").asText().isBlank()) {
                    throw new IllegalArgumentException("Invalid bilingual source manifest");
                }
                manifestSourceHashes.add(source.path("sha256").asText());
            }
            if (!items.isArray() || items.size() != 194) throw new IllegalArgumentException("Expected 194 bilingual items");
            int articles = 0, stories = 0;
            Set<String> fingerprints = new HashSet<>();
            for (JsonNode item : items) {
                String type = item.path("contentType").asText();
                if ("ARTICLE".equals(type)) articles++;
                else if ("STORY".equals(type)) stories++;
                else throw new IllegalArgumentException("Invalid bilingual content type");
                String fp = item.path("itemFingerprint").asText();
                if (!fp.matches("[0-9a-f]{64}") || !fingerprints.add(fp)) {
                    throw new IllegalArgumentException("Duplicate or invalid bilingual fingerprint");
                }
                if (!item.path("titleEn").isTextual() || item.path("titleEn").asText().isBlank()
                        || !item.path("segments").isArray() || item.path("segments").isEmpty()) {
                    throw new IllegalArgumentException("Bilingual item is missing title or paired segments");
                }
                if (!item.path("sourceHash").asText().matches("[0-9a-f]{64}") || item.path("sourceFile").asText().isBlank()) {
                    throw new IllegalArgumentException("Bilingual item is missing source provenance");
                }
                if (!manifestSourceHashes.contains(item.path("sourceHash").asText())) {
                    throw new IllegalArgumentException("Bilingual item source hash is not pinned by the manifest");
                }
                for (int i = 0; i < item.path("segments").size(); i++) {
                    JsonNode segment = item.path("segments").get(i);
                    if (segment.path("position").asInt() != i + 1
                            || segment.path("en").asText().isBlank()
                            || segment.path("vi").asText().isBlank()) {
                        throw new IllegalArgumentException("Bilingual segments must be ordered and paired");
                    }
                }
            }
            if (articles != 112 || stories != 82) throw new IllegalArgumentException("Expected 112 articles and 82 stories");
            if (apply) jdbc.getJdbcTemplate().execute("SELECT pg_advisory_xact_lock(74193262)");
            int inserted = 0, updated = 0, skipped = 0;
            for (JsonNode item : items) {
                String fp = item.path("itemFingerprint").asText();
                MapSqlParameterSource p = new MapSqlParameterSource()
                        .addValue("fp", fp).addValue("type", item.path("contentType").asText())
                        .addValue("en", item.path("titleEn").asText()).addValue("vi", item.path("titleVi").isNull() ? null : item.path("titleVi").asText())
                        .addValue("level", item.path("level").isNull() ? null : item.path("level").asText()).addValue("words", item.path("wordCount").asInt()).addValue("minutes", item.path("estimatedMinutes").asInt())
                        .addValue("sourceFile", item.path("sourceFile").asText()).addValue("sourceHash", item.path("sourceHash").asText()).addValue("position", item.path("logicalPosition").asInt());
                var existing = jdbc.queryForList("SELECT id,content_type,title_en,title_vi,difficulty_level,word_count,estimated_minutes,source_file,source_hash,logical_position FROM public.bilingual_reading_materials WHERE item_fingerprint=:fp", p);
                if (existing.size() > 1) throw new IllegalStateException("Duplicate bilingual fingerprint: " + fp);
                long id;
                if (existing.isEmpty()) {
                    inserted++;
                    if (!apply) continue;
                    id = jdbc.queryForObject("INSERT INTO public.bilingual_reading_materials(content_type,title_en,title_vi,difficulty_level,word_count,estimated_minutes,source_file,source_hash,logical_position,item_fingerprint) VALUES (:type,:en,:vi,:level,:words,:minutes,:sourceFile,:sourceHash,:position,:fp) RETURNING id", p, Long.class);
                } else {
                    id = ((Number) existing.get(0).get("id")).longValue();
                    boolean equal = Objects.equals(existing.get(0).get("content_type"), p.getValue("type"))
                            && Objects.equals(existing.get(0).get("title_en"), p.getValue("en"))
                            && Objects.equals(existing.get(0).get("title_vi"), p.getValue("vi"))
                            && Objects.equals(existing.get(0).get("difficulty_level"), p.getValue("level"))
                            && Objects.equals(existing.get(0).get("word_count"), p.getValue("words"))
                            && Objects.equals(existing.get(0).get("estimated_minutes"), p.getValue("minutes"))
                            && Objects.equals(existing.get(0).get("source_file"), p.getValue("sourceFile"))
                            && Objects.equals(existing.get(0).get("source_hash"), p.getValue("sourceHash"))
                            && Objects.equals(existing.get(0).get("logical_position"), p.getValue("position"));
                    boolean segmentsEqual = jdbc.query("SELECT position,text_en,text_vi,source_reference FROM public.bilingual_reading_segments WHERE material_id=:id ORDER BY position", Map.of("id", id), (rs, row) -> List.of(rs.getInt("position"), rs.getString("text_en"), rs.getString("text_vi"), rs.getString("source_reference"))).equals(
                            java.util.stream.StreamSupport.stream(item.path("segments").spliterator(), false).map(segment -> List.of(segment.path("position").asInt(), segment.path("en").asText(), segment.path("vi").asText(), segment.path("sourceReference").asText())).toList());
                    if (equal && segmentsEqual) { skipped++; continue; }
                    updated++;
                    if (apply && !allowUpdates) throw new IllegalStateException("Existing bilingual source changed; explicit update approval required");
                    if (apply) jdbc.update("UPDATE public.bilingual_reading_materials SET content_type=:type,title_en=:en,title_vi=:vi,difficulty_level=:level,word_count=:words,estimated_minutes=:minutes,source_file=:sourceFile,source_hash=:sourceHash,logical_position=:position WHERE id=:id", p.addValue("id", id));
                }
                if (apply) {
                    jdbc.update("DELETE FROM public.bilingual_reading_segments WHERE material_id=:id", Map.of("id", id));
                    for (JsonNode segment : item.path("segments")) {
                        jdbc.update("INSERT INTO public.bilingual_reading_segments(material_id,position,text_en,text_vi,source_reference) VALUES (:id,:position,:en,:vi,:ref)", new MapSqlParameterSource().addValue("id", id).addValue("position", segment.path("position").asInt()).addValue("en", segment.path("en").asText()).addValue("vi", segment.path("vi").asText()).addValue("ref", segment.path("sourceReference").asText()));
                    }
                }
            }
            return new Result(digest, apply, items.size(), inserted, updated, skipped);
        } catch (java.io.IOException | java.security.NoSuchAlgorithmException e) { throw new IllegalStateException("Bilingual corpus unavailable", e); }
    }
}
