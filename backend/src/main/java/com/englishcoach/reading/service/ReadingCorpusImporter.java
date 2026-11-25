package com.englishcoach.reading.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.*;
import java.nio.charset.StandardCharsets;

/** Explicit administration only. No runner, scheduler, startup ingestion or network fetch. */
@Service
public class ReadingCorpusImporter {
    private final NamedParameterJdbcTemplate jdbc;
    private final boolean enabled;
    public record Result(String manifestSha256, boolean applied, int total, int inserted, int updated, int skipped) {}
    public ReadingCorpusImporter(NamedParameterJdbcTemplate jdbc,
            @Value("${APP_READING_CORPUS_IMPORT_ENABLED:false}") boolean enabled) { this.jdbc = jdbc; this.enabled = enabled; }
    @Transactional(timeout = 60)
    public Result run(boolean apply, boolean allowUpdates, String confirmation) {
        if (apply && !enabled) throw new IllegalStateException("Reading corpus application is disabled");
        try {
            byte[] bytes;
            JsonNode registry;
            var mapper = new ObjectMapper();
            try (var in = new ClassPathResource("data/reading/corpus.json").getInputStream()) { bytes = in.readNBytes(4000001); }
            if (bytes.length > 4000000) throw new IllegalArgumentException("Corpus too large");
            try (var in = new ClassPathResource("data/reading/sources.json").getInputStream()) { registry = mapper.readTree(in); }
            JsonNode corpus = mapper.readTree(bytes);
            ReadingCorpusValidator.validate(registry, corpus);
            try (var in = new ClassPathResource("data/reading/metadata.json").getInputStream()) {
                ReadingCorpusValidator.validateMetadata(corpus, mapper.readTree(in));
            }
            String digest = ReadingCorpusValidator.hash(new String(bytes, StandardCharsets.UTF_8));
            if (apply && !digest.equals(confirmation)) throw new IllegalArgumentException("Confirm the exact dry-run manifest digest");
            // Transaction-scoped, shared by every app instance; releases on success, crash or rollback.
            if (apply) {
                jdbc.getJdbcTemplate().execute("SET LOCAL lock_timeout = '5s'");
                jdbc.getJdbcTemplate().execute("SET LOCAL statement_timeout = '15s'");
                jdbc.getJdbcTemplate().execute("SELECT pg_advisory_xact_lock(74193261)");
            }
            int inserted = 0, updated = 0, skipped = 0;
            for (var item : corpus) {
                Map<String,Object> p = new HashMap<>();
                for (String field : List.of("title","sourceUrl","contentText","sourceName","difficultyLevel","contentVariant")) p.put(field, item.path(field).asText());
                p.put("wordCount", item.path("wordCount").asInt());
                var existing = jdbc.queryForList("SELECT id,title,content_text,source_name,difficulty_level,word_count,content_mode FROM public.reading_materials WHERE is_system=true AND owner_user_id IS NULL AND source_url=:sourceUrl", p);
                if (existing.size() > 1) throw new IllegalStateException("Existing duplicate SYSTEM source URL");
                if (existing.isEmpty()) {
                    inserted++;
                    if (apply) jdbc.update("INSERT INTO public.reading_materials (title,source_url,content_text,source_name,difficulty_level,word_count,material_type,content_mode,is_system,owner_user_id,created_at) VALUES (:title,:sourceUrl,:contentText,:sourceName,:difficultyLevel,:wordCount,'ARTICLE',:contentVariant,true,NULL,CURRENT_TIMESTAMP)", p);
                } else {
                    var row = existing.get(0);
                    boolean equal = Objects.equals(row.get("title"),p.get("title")) && Objects.equals(row.get("content_text"),p.get("contentText"))
                        && Objects.equals(row.get("source_name"),p.get("sourceName")) && Objects.equals(row.get("difficulty_level"),p.get("difficultyLevel"))
                        && Objects.equals(row.get("content_mode"),p.get("contentVariant"))
                        && Objects.equals(row.get("word_count"),p.get("wordCount"));
                    if (equal) skipped++;
                    else {
                        updated++;
                        if (apply && !allowUpdates) throw new IllegalStateException("Existing SYSTEM text changed; explicit update approval required");
                        p.put("id",row.get("id"));
                        if (apply) jdbc.update("UPDATE public.reading_materials SET title=:title,content_text=:contentText,source_name=:sourceName,difficulty_level=:difficultyLevel,word_count=:wordCount,content_mode=:contentVariant WHERE id=:id AND is_system=true AND owner_user_id IS NULL",p);
                    }
                }
            }
            return new Result(digest,apply,corpus.size(),inserted,updated,skipped);
        } catch (java.io.IOException e) { throw new IllegalStateException("Reading corpus unavailable",e); }
    }
}
