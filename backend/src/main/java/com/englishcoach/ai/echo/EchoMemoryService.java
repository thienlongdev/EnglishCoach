package com.englishcoach.ai.echo;

import com.englishcoach.ai.service.EchoPolicy;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;

/**
 * Memory layer 3: what the learner explicitly asked Echo to remember (V128 {@code echo_learner_memory}).
 * - Written only through the {@code remember_learner_note} tool AND only when the learner's own latest words carry an
 *   explicit memory cue ({@link EchoRouter#memoryCue}); a retrieved article or a model alone can never write it.
 * - Enumerated kinds, bounded text, at most {@link #MAX_ROWS} rows; one row per single-valued kind (upsert).
 * - Never learning evidence: no level, score or mastery is ever derived from it. Listable and deletable by the learner.
 */
@Service
public class EchoMemoryService {
    public static final int MAX_ROWS = 12, MAX_VALUE = 200;
    public static final List<String> KINDS = List.of("EXPLANATION_LANGUAGE", "ANSWER_STYLE", "LEVEL_PREFERENCE", "FOCUS_SKILL",
            "STATED_GOAL", "COACHING_MODE", "INTEREST", "NOTE");
    private static final Set<String> MULTI = Set.of("INTEREST", "NOTE");

    public record Item(long id, String kind, String value, Instant updatedAt) {}

    private final JdbcTemplate jdbc;

    public EchoMemoryService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    public List<Item> list(long userId) {
        return jdbc.query("SELECT id, kind, value, updated_at FROM public.echo_learner_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?",
                (rs, i) -> new Item(rs.getLong(1), rs.getString(2), rs.getString(3), rs.getTimestamp(4).toInstant()), userId, MAX_ROWS);
    }

    /** Stores one learner-stated note. Returns the cleaned value, or empty when refused (no cue, bad kind, unsafe text). */
    public Optional<String> remember(long userId, String learnerWords, String kind, String rawValue) {
        if (!EchoRouter.memoryCue(learnerWords)) return Optional.empty();
        if (kind == null || !KINDS.contains(kind)) return Optional.empty();
        String value = clean(rawValue);
        if (value == null) return Optional.empty();
        if (MULTI.contains(kind)) {
            Integer same = jdbc.queryForObject("SELECT count(*) FROM public.echo_learner_memory WHERE user_id = ? AND kind = ? AND lower(value) = lower(?)",
                    Integer.class, userId, kind, value);
            if (same != null && same > 0) return Optional.of(value);
            Integer rows = jdbc.queryForObject("SELECT count(*) FROM public.echo_learner_memory WHERE user_id = ?", Integer.class, userId);
            if (rows != null && rows >= MAX_ROWS) // forget the oldest multi-valued note first; single-valued kinds are kept
                jdbc.update("DELETE FROM public.echo_learner_memory WHERE id = (SELECT id FROM public.echo_learner_memory WHERE user_id = ? AND kind IN ('INTEREST','NOTE') ORDER BY updated_at LIMIT 1)", userId);
            jdbc.update("INSERT INTO public.echo_learner_memory(user_id, kind, value) VALUES (?, ?, ?)", userId, kind, value);
        } else {
            int updated = jdbc.update("UPDATE public.echo_learner_memory SET value = ?, updated_at = now() WHERE user_id = ? AND kind = ?", value, userId, kind);
            if (updated == 0) jdbc.update("INSERT INTO public.echo_learner_memory(user_id, kind, value) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", userId, kind, value);
        }
        return Optional.of(value);
    }

    /**
     * Persists a verified {@code COACHING_MODE} preference when the learner's own unquoted, non-hypothetical,
     * non-metalinguistic utterance explicitly states a persistent mode shift (including {@code FREE_CHAT} via
     * {@code "Don't correct my grammar from now on"} / {@code "Từ giờ đừng sửa lỗi ngữ pháp cho mình"}).
     */
    public Optional<String> rememberCoachingMode(long userId, String learnerWords, EchoPolicy.CoachingMode mode) {
        if (mode == null) return Optional.empty();
        Optional<EchoPolicy.CoachingMode> verified = EchoPolicy.detectPersistentCoachingMode(learnerWords);
        if (verified.isEmpty() || verified.get() != mode) return Optional.empty();
        String value = mode.name();
        int updated = jdbc.update("UPDATE public.echo_learner_memory SET value = ?, updated_at = now() WHERE user_id = ? AND kind = ?",
                value, userId, "COACHING_MODE");
        if (updated == 0) {
            jdbc.update("INSERT INTO public.echo_learner_memory(user_id, kind, value) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                    userId, "COACHING_MODE", value);
        }
        return Optional.of(value);
    }

    public boolean delete(long userId, long id) {
        return jdbc.update("DELETE FROM public.echo_learner_memory WHERE id = ? AND user_id = ?", id, userId) > 0;
    }

    public int deleteAll(long userId) {
        return jdbc.update("DELETE FROM public.echo_learner_memory WHERE user_id = ?", userId);
    }

    /** Text the learner stated: one line, bounded, no links, no addresses, nothing that reads like an instruction to Echo. */
    static String clean(String raw) {
        if (raw == null) return null;
        String v = raw.replaceAll("[\\p{Cc}\\p{Cf}]", " ").replaceAll("\\s+", " ").strip();
        if (v.isEmpty() || v.length() > MAX_VALUE) return null;
        String lower = v.toLowerCase(Locale.ROOT);
        if (lower.matches(".*(https?://|www\\.|<|>|\\{|}|@[a-z0-9-]+\\.).*")) return null;
        if (EchoPolicy.extraction(v)) return null;
        if (lower.matches(".*\\b(ignore|bo qua|system|developer|instruction|chi dan|lenh)\\b.*")) return null;
        return v;
    }
}
