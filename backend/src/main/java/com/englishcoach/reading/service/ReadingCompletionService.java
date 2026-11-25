package com.englishcoach.reading.service;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * Server record of a learner's Reading session and completion ({@code user_reading_progress}). The client never sends a
 * percentage or a "completed" flag: opening the reader records the session start (server time), and "Hoàn thành bài
 * đọc" is accepted only after a minimum reading time measured by the database clock since that start. Completion is
 * written once and is idempotent. Only a material visible to the learner (SYSTEM or their own) is accepted; anything
 * else answers 404.
 */
@Service
public class ReadingCompletionService {

    /** Generous skim speed: finishing faster than this many words per minute is not reading the text. */
    static final int FAST_WORDS_PER_MINUTE = 400;
    static final int MIN_SECONDS = 15;
    static final int MAX_SECONDS = 300;

    public record State(long materialId, boolean completed, OffsetDateTime completedAt, int minSeconds) {}

    /** Outcome of a completion request: the state, or the seconds still needed when it came too early. */
    public record Completion(State state, int retryAfterSeconds) {
        public boolean accepted() { return state.completed(); }
    }

    private final NamedParameterJdbcTemplate jdbc;

    public ReadingCompletionService(NamedParameterJdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    static int minSeconds(int words) {
        int s = (int) Math.ceil(Math.max(0, words) * 60.0 / FAST_WORDS_PER_MINUTE);
        return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, s));
    }

    /** Records the start of a reading session (a session older than 12 hours restarts) and returns the state. */
    @Transactional
    public State open(long userId, long materialId) {
        int min = minSeconds(visibleWords(userId, materialId));
        jdbc.update("""
                INSERT INTO public.user_reading_progress (user_id, reading_material_id, scroll_percentage, last_read_at, opened_at)
                VALUES (:u, :m, 0, LOCALTIMESTAMP, now())
                ON CONFLICT (user_id, reading_material_id) DO UPDATE SET
                    opened_at = CASE WHEN user_reading_progress.opened_at IS NULL
                        OR user_reading_progress.opened_at < now() - interval '12 hours' THEN now()
                        ELSE user_reading_progress.opened_at END,
                    last_read_at = LOCALTIMESTAMP
                WHERE user_reading_progress.completed_at IS NULL""", params(userId, materialId));
        return state(userId, materialId, min);
    }

    /** Marks the material read. Refused (not written) before the minimum reading time; repeating it changes nothing. */
    @Transactional
    public Completion complete(long userId, long materialId) {
        int min = minSeconds(visibleWords(userId, materialId));
        jdbc.update("""
                UPDATE public.user_reading_progress SET completed_at = now(), scroll_percentage = 100, last_read_at = LOCALTIMESTAMP
                WHERE user_id = :u AND reading_material_id = :m AND completed_at IS NULL
                  AND opened_at IS NOT NULL AND opened_at <= now() - make_interval(secs => :min)""",
                params(userId, materialId).addValue("min", min));
        State s = state(userId, materialId, min);
        if (s.completed()) return new Completion(s, 0);
        Integer elapsed = jdbc.query("""
                SELECT floor(extract(epoch FROM now() - opened_at))::int FROM public.user_reading_progress
                WHERE user_id = :u AND reading_material_id = :m AND opened_at IS NOT NULL""",
                params(userId, materialId), rs -> rs.next() ? rs.getInt(1) : null);
        return new Completion(s, elapsed == null ? min : Math.max(1, min - elapsed));
    }

    private State state(long userId, long materialId, int min) {
        List<OffsetDateTime> done = jdbc.query("""
                SELECT completed_at FROM public.user_reading_progress
                WHERE user_id = :u AND reading_material_id = :m AND completed_at IS NOT NULL""",
                params(userId, materialId), (rs, i) -> rs.getObject(1, OffsetDateTime.class));
        return new State(materialId, !done.isEmpty(), done.isEmpty() ? null : done.get(0), min);
    }

    /** Word count of a material the learner may read (SYSTEM or own); 404 otherwise, quarantined rows included. */
    private int visibleWords(long userId, long materialId) {
        List<Integer> words = jdbc.query("""
                SELECT COALESCE(word_count, 0) FROM public.reading_materials WHERE id = :m
                  AND ((is_system = true AND owner_user_id IS NULL) OR (is_system = false AND owner_user_id = :u))""",
                params(userId, materialId), (rs, i) -> rs.getInt(1));
        if (words.isEmpty()) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Reading material not found");
        return words.get(0);
    }

    private static MapSqlParameterSource params(long userId, long materialId) {
        return new MapSqlParameterSource("u", userId).addValue("m", materialId);
    }
}
