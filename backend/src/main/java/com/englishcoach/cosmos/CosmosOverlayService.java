package com.englishcoach.cosmos;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * Echo Neural Cosmos — reads the learner's OWN learning evidence for the knowledge universe. Read-only on learning data; its one
 * write is the derived extraction cache ({@code cosmos_source_tokens}). No AI, no network, no scheduler, no mastery decision:
 * the client joins this with the shared verified lexicon and shows only what the evidence says.
 *
 * <p>Isolation (AGENTS §21): every query is scoped by the principal's id; a source is read only through its live row and its
 * visibility rule (SYSTEM = {@code is_system AND owner_user_id IS NULL}, else the caller's own); quarantined rows never appear.
 *
 * <p>Round trips: the production database is ~90 ms away per exchange (10 §R), so the whole overlay (cards, ratings, grammar
 * and the four visibility-scoped source listings joined with the cache) is ONE statement returning one JSON document. Only a
 * source whose content changed since it was last tokenized costs more: one text read and one batched upsert for its kind.
 */
@Service
public class CosmosOverlayService {
    static final int MAX_WORDS = 5_000;
    static final int MAX_REVIEWS = 20_000;
    static final int MAX_SOURCES_PER_KIND = 150;
    private static final ObjectMapper JSON = new ObjectMapper();

    private final JdbcTemplate jdbc;
    private final NamedParameterJdbcTemplate named;

    public CosmosOverlayService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.named = new NamedParameterJdbcTemplate(jdbc);
    }

    /** The four kinds of source, each with ONE visibility-scoped listing and ONE text query by the listed ids. */
    enum Kind {
        READING("""
                SELECT m.id, m.title, (extract(epoch FROM p.completed_at) * 1000)::bigint AS at,
                       (m.is_system AND m.owner_user_id IS NULL) AS sys, m.owner_user_id,
                       encode(sha256(convert_to(COALESCE(m.content_text, ''), 'UTF8')), 'hex') AS hash
                  FROM public.user_reading_progress p
                  JOIN public.reading_materials m ON m.id = p.reading_material_id
                 WHERE p.user_id = :u AND p.completed_at IS NOT NULL
                   AND ((m.is_system = true AND m.owner_user_id IS NULL) OR m.owner_user_id = :u)
                 ORDER BY p.completed_at DESC LIMIT :n""",
                "SELECT m.id, COALESCE(m.content_text, '') FROM public.reading_materials m WHERE m.id IN (:ids)"),
        LISTENING("""
                SELECT m.id, m.title, (extract(epoch FROM (s.last_end AT TIME ZONE :jz)) * 1000)::bigint AS at,
                       (m.is_system AND m.owner_user_id IS NULL) AS sys, m.owner_user_id,
                       (SELECT encode(sha256(convert_to(COALESCE(string_agg(t.text, ' ' ORDER BY t.start_time_ms, t.id), ''), 'UTF8')), 'hex')
                          FROM public.transcript_segments t WHERE t.listening_material_id = m.id) AS hash
                  FROM (SELECT listening_material_id, max(ended_at) AS last_end FROM public.listening_sessions
                         WHERE user_id = :u AND ended_at IS NOT NULL GROUP BY listening_material_id) s
                  JOIN public.listening_materials m ON m.id = s.listening_material_id
                 WHERE (m.is_system = true AND m.owner_user_id IS NULL) OR m.owner_user_id = :u
                 ORDER BY s.last_end DESC LIMIT :n""",
                """
                SELECT t.listening_material_id, COALESCE(string_agg(t.text, ' ' ORDER BY t.start_time_ms, t.id), '')
                  FROM public.transcript_segments t WHERE t.listening_material_id IN (:ids) GROUP BY t.listening_material_id"""),
        WRITING("""
                SELECT w.id, 'Writing' AS title, (extract(epoch FROM w.created_at) * 1000)::bigint AS at, false AS sys,
                       w.user_id AS owner_user_id, encode(sha256(convert_to(w.content, 'UTF8')), 'hex') AS hash
                  FROM public.writing_practice_submission w WHERE w.user_id = :u ORDER BY w.created_at DESC LIMIT :n""",
                "SELECT w.id, w.content FROM public.writing_practice_submission w WHERE w.id IN (:ids) AND w.user_id = :u"),
        SPEAKING("""
                SELECT q.id, 'Speaking' AS title, (extract(epoch FROM (q.created_at AT TIME ZONE :jz)) * 1000)::bigint AS at, false AS sys,
                       q.user_id AS owner_user_id, encode(sha256(convert_to(q.whisper_transcript, 'UTF8')), 'hex') AS hash
                  FROM exams.speaking_quick_checks q
                 WHERE q.user_id = :u AND COALESCE(q.is_mocked, false) = false AND NULLIF(btrim(q.whisper_transcript), '') IS NOT NULL
                 ORDER BY q.created_at DESC LIMIT :n""",
                "SELECT q.id, q.whisper_transcript FROM exams.speaking_quick_checks q WHERE q.id IN (:ids) AND q.user_id = :u");

        final String list;
        final String text;

        Kind(String list, String text) {
            this.list = list;
            this.text = text;
        }
    }

    /** The whole overlay in one statement: every list is a json_agg of its own owner-scoped query. */
    static final String OVERLAY_SQL = """
            WITH w AS (
                SELECT f.id, lower(btrim(d.word)) AS word, f.status, f.created_at,
                       (extract(epoch FROM (f.created_at AT TIME ZONE :jz)) * 1000)::bigint AS created_ms,
                       COALESCE(NULLIF(btrim(f.custom_meaning), ''), NULLIF(btrim(dde.meaning_vi), ''), NULLIF(btrim(d.general_translation_vi), '')) AS meaning,
                       COALESCE(NULLIF(btrim(f.custom_part_of_speech), ''), NULLIF(btrim(dde.part_of_speech), '')) AS pos,
                       NULLIF(btrim(f.custom_definition), '') AS definition,
                       vd.slug, vd.title, vd.category, f.review_count,
                       (extract(epoch FROM (f.next_review_date AT TIME ZONE :jz)) * 1000)::bigint AS due_ms
                  FROM public.flashcards f
                  JOIN public.dictionary_entries d ON d.id = f.dictionary_entry_id
                  LEFT JOIN public.vocab_decks vd ON vd.id = f.deck_id
                  LEFT JOIN public.deck_dictionary_entries dde ON dde.deck_id = f.deck_id AND dde.dictionary_entry_id = f.dictionary_entry_id
                 WHERE f.user_id = :u AND f.state = 0
                   AND (d.owner_user_id IS NULL OR d.owner_user_id = f.user_id)
                 ORDER BY f.created_at DESC, f.id DESC
                 LIMIT :wl
            ), r AS (
                SELECT l.id, l.flashcard_id, l.quality, l.reviewed_at, (extract(epoch FROM l.reviewed_at) * 1000)::bigint AS at_ms
                  FROM public.flashcard_review_log l
                  JOIN public.flashcards f ON f.id = l.flashcard_id AND f.user_id = l.user_id AND f.state = 0
                 WHERE l.user_id = :u
                 ORDER BY l.reviewed_at DESC, l.id DESC
                 LIMIT :rl
            ), g AS (
                SELECT topic_slug, first_opened_at, (extract(epoch FROM first_opened_at) * 1000)::bigint AS opened_ms,
                       (extract(epoch FROM studied_at) * 1000)::bigint AS studied_ms, best_check_pct,
                       (extract(epoch FROM mastered_at) * 1000)::bigint AS mastered_ms, needs_review
                  FROM public.grammar_topic_state WHERE user_id = :u
            ), l_reading AS (%s), l_listening AS (%s), l_writing AS (%s), l_speaking AS (%s)
            SELECT json_build_object(
              'w', COALESCE((SELECT json_agg(json_build_array(id, word, status, created_ms, meaning, pos, definition, slug, title, category, review_count, due_ms)
                                             ORDER BY created_at DESC, id DESC) FROM w), '[]'::json),
              'r', COALESCE((SELECT json_agg(json_build_array(flashcard_id, quality, at_ms) ORDER BY reviewed_at DESC, id DESC) FROM r), '[]'::json),
              'g', COALESCE((SELECT json_agg(json_build_array(topic_slug, opened_ms, studied_ms, best_check_pct, mastered_ms, needs_review)
                                             ORDER BY first_opened_at) FROM g), '[]'::json),
              'READING', %s, 'LISTENING', %s, 'WRITING', %s, 'SPEAKING', %s)::text"""
            .formatted(Kind.READING.list, Kind.LISTENING.list, Kind.WRITING.list, Kind.SPEAKING.list,
                    cached("l_reading", "READING"), cached("l_listening", "LISTENING"), cached("l_writing", "WRITING"), cached("l_speaking", "SPEAKING"));

    /** A listing joined with THIS exact content version's cached tokens (owner-checked), as a JSON array of arrays. */
    private static String cached(String cte, String kind) {
        return """
                COALESCE((SELECT json_agg(json_build_array(l.id, l.title, l.at, l.sys, l.owner_user_id, l.hash, c.tokens) ORDER BY l.at DESC, l.id DESC)
                  FROM %s l LEFT JOIN public.cosmos_source_tokens c
                    ON c.source_kind = '%s' AND c.source_id = l.id AND c.extractor_version = :v AND c.content_sha256 = l.hash
                   AND (c.owner_user_id IS NULL OR c.owner_user_id = :u)), '[]'::json)""".formatted(cte, kind);
    }

    /**
     * Zone of the zone-less columns this service reads (flashcards.created_at, listening_sessions.ended_at,
     * exams.speaking_quick_checks.created_at): the application writes them as JVM-local LocalDateTime and PgJDBC sets the
     * session zone to the JVM zone, so they are read back in that zone. Reading them as UTC moved every such moment by the
     * zone offset (7 h on a Vietnamese-time JVM: freshly saved cards were "in the future").
     */
    static String naiveZone() { return java.time.ZoneId.systemDefault().getId(); }

    public CosmosDtos.Overlay overlay(long userId) {
        MapSqlParameterSource p = new MapSqlParameterSource("u", userId).addValue("wl", MAX_WORDS + 1).addValue("rl", MAX_REVIEWS + 1)
                .addValue("n", MAX_SOURCES_PER_KIND).addValue("v", CosmosTokenizer.VERSION).addValue("jz", naiveZone());
        JsonNode doc;
        try {
            doc = JSON.readTree(named.queryForObject(OVERLAY_SQL, p, String.class));
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IllegalStateException("cosmos overlay document", e);
        }

        List<CosmosDtos.Word> words = new ArrayList<>();
        for (JsonNode a : doc.get("w")) {
            words.add(new CosmosDtos.Word(a.get(0).asLong(), text(a.get(1)), text(a.get(2)), a.get(3).asLong(), text(a.get(4)), text(a.get(5)),
                    text(a.get(6)), text(a.get(7)), text(a.get(8)), text(a.get(9)), a.get(10).asInt(),
                    a.size() > 11 && !a.get(11).isNull() ? a.get(11).asLong() : null));
        }
        boolean wordsTruncated = words.size() > MAX_WORDS;
        if (wordsTruncated) words = words.subList(0, MAX_WORDS);

        List<CosmosDtos.Review> reviews = new ArrayList<>();
        for (JsonNode a : doc.get("r")) reviews.add(new CosmosDtos.Review(a.get(0).asLong(), text(a.get(1)), a.get(2).asLong()));
        boolean reviewsTruncated = reviews.size() > MAX_REVIEWS;
        if (reviewsTruncated) reviews = new ArrayList<>(reviews.subList(0, MAX_REVIEWS));
        Collections.reverse(reviews); // oldest first

        List<CosmosDtos.Grammar> grammar = new ArrayList<>();
        for (JsonNode a : doc.get("g")) {
            grammar.add(new CosmosDtos.Grammar(text(a.get(0)), a.get(1).asLong(), longOrNull(a.get(2)), a.get(3).isNull() ? null : a.get(3).asInt(),
                    longOrNull(a.get(4)), a.get(5).asBoolean()));
        }

        List<CosmosDtos.Source> sources = new ArrayList<>();
        for (Kind kind : Kind.values()) sources.addAll(sources(userId, kind, doc.get(kind.name())));
        return new CosmosDtos.Overlay(CosmosTokenizer.VERSION, System.currentTimeMillis(), words, wordsTruncated, reviews,
                reviewsTruncated, grammar, sources);
    }

    private record Listed(long id, String title, long at, boolean system, Long owner, String hash, String tokens) {}

    /** One kind's listing (already read with the overlay): fresh tokens only for a source whose content changed. */
    private List<CosmosDtos.Source> sources(long userId, Kind kind, JsonNode rows) {
        List<Listed> listed = new ArrayList<>();
        for (JsonNode a : rows) {
            listed.add(new Listed(a.get(0).asLong(), text(a.get(1)), a.get(2).asLong(), a.get(3).asBoolean(), longOrNull(a.get(4)), text(a.get(5)), text(a.get(6))));
        }
        if (listed.isEmpty()) return List.of();
        List<Long> missing = listed.stream().filter(l -> l.tokens() == null).map(Listed::id).toList();
        Map<Long, String> fresh = new HashMap<>();
        if (!missing.isEmpty()) {
            Map<Long, String> texts = new HashMap<>();
            named.query(kind.text, new MapSqlParameterSource("ids", missing).addValue("u", userId),
                    rs -> { texts.put(rs.getLong(1), rs.getString(2)); });
            List<Object[]> upserts = new ArrayList<>();
            for (Listed l : listed) {
                if (l.tokens() != null) continue;
                CosmosTokenizer.Result r = CosmosTokenizer.tokenize(texts.getOrDefault(l.id(), ""));
                fresh.put(l.id(), r.tokens());
                // A SYSTEM source's tokens are shared (owner NULL); a personal one keeps its owner.
                Long owner = l.system() ? null : (l.owner() != null ? l.owner() : userId);
                upserts.add(new Object[]{kind.name(), l.id(), owner, l.hash(), CosmosTokenizer.VERSION, r.count(), r.tokens()});
            }
            // one batch (pgjdbc pipelines it)
            jdbc.batchUpdate("""
                    INSERT INTO public.cosmos_source_tokens (source_kind, source_id, owner_user_id, content_sha256, extractor_version, token_count, tokens)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (source_kind, source_id, extractor_version)
                    DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id, content_sha256 = EXCLUDED.content_sha256,
                                  token_count = EXCLUDED.token_count, tokens = EXCLUDED.tokens, created_at = now()""", upserts);
        }
        List<CosmosDtos.Source> out = new ArrayList<>(listed.size());
        for (Listed l : listed) {
            out.add(new CosmosDtos.Source(kind.name(), l.id(), l.title(), l.at(), l.system(), l.tokens() != null ? l.tokens() : fresh.get(l.id())));
        }
        return out;
    }

    private static String text(JsonNode n) { return n == null || n.isNull() ? null : n.asText(); }
    private static Long longOrNull(JsonNode n) { return n == null || n.isNull() ? null : n.asLong(); }
}
