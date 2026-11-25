package com.englishcoach.writing.service;

import com.englishcoach.writing.config.WritingProperties;
import com.englishcoach.writing.exception.WritingDisabledException;
import com.englishcoach.writing.exception.WritingNotFoundException;
import com.englishcoach.writing.exception.WritingValidationException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.*;

import java.util.regex.Pattern;

/**
 * Free practice submission of a Writing Coach draft: no AI, no Premium quota. The server takes the session's own saved
 * text (never text sent with the request), checks that it is a real attempt at the task — enough English words for the
 * task's minimum, not a repetition of a few words, not a copy of the prompt — and records it once per session in
 * {@code writing_practice_submission}. This is participation evidence only: it never produces a score, a band or a level.
 * AI feedback stays optional on the existing Premium path and does not read or write this row.
 */
@Service
public class WritingPracticeSubmissionService {

    public record Result(long id, String sessionId, String taskId, int wordCount, int minWords, Instant submittedAt,
                         boolean alreadySubmitted) {}

    /** Bounds of a task's word minimum used for a practice submission. */
    static final int MIN_WORDS_FLOOR = 15, MIN_WORDS_CAP = 400, DEFAULT_MIN_WORDS = 80;
    private static final Pattern WORD = Pattern.compile("[A-Za-z]+(?:['’-][A-Za-z]+)*");

    private final NamedParameterJdbcTemplate jdbc;
    private final WritingProperties properties;
    private final ObjectMapper mapper;

    public WritingPracticeSubmissionService(NamedParameterJdbcTemplate jdbc, WritingProperties properties, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.properties = properties;
        this.mapper = mapper;
    }

    @Transactional
    public Result submit(long userId, String sessionId) {
        if (!properties.isEnabled() || !properties.isMutationsEnabled())
            throw new WritingDisabledException("Writing practice is currently paused.");
        MapSqlParameterSource p = new MapSqlParameterSource("u", userId).addValue("s", sessionId);
        // the owner's session only (a foreign or unknown id is indistinguishable: 404); row lock against double submits
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT task_id, CAST(task_snapshot AS text) AS snapshot, working_text, current_revision
                FROM public.writing_sessions WHERE id = :s AND user_id = :u FOR UPDATE""", p);
        if (rows.isEmpty()) throw new WritingNotFoundException("Writing session not found.");
        Map<String, Object> s = rows.get(0);
        Optional<Result> existing = existing(userId, sessionId);
        if (existing.isPresent()) return existing.get();

        String taskId = String.valueOf(s.get("task_id"));
        JsonNode task = parse((String) s.get("snapshot"));
        int minWords = minWords(task);
        String text = Objects.toString(s.get("working_text"), "").strip();
        if (text.length() > properties.getMaxDraftChars())
            throw new WritingValidationException("Bài viết quá dài.", Map.of("reason", "TOO_LONG"));
        String reason = substanceProblem(text, minWords, promptText(task));
        if (reason != null) throw new WritingValidationException(message(reason, minWords), Map.of("reason", reason));

        int words = countWords(text);
        Long id = jdbc.queryForObject("""
                INSERT INTO public.writing_practice_submission (user_id, session_id, task_id, content, word_count, revision)
                VALUES (:u, :s, :task, :content, :words, :rev)
                ON CONFLICT (user_id, session_id) DO NOTHING RETURNING id""",
                p.addValue("task", taskId).addValue("content", text).addValue("words", words)
                        .addValue("rev", ((Number) s.get("current_revision")).longValue()), Long.class);
        if (id == null) return existing(userId, sessionId).orElseThrow();
        return new Result(id, sessionId, taskId, words, minWords, Instant.now(), false);
    }

    private Optional<Result> existing(long userId, String sessionId) {
        return jdbc.query("""
                SELECT id, task_id, word_count, created_at FROM public.writing_practice_submission
                WHERE user_id = :u AND session_id = :s""", new MapSqlParameterSource("u", userId).addValue("s", sessionId),
                (rs, i) -> new Result(rs.getLong("id"), sessionId, rs.getString("task_id"), rs.getInt("word_count"), 0,
                        rs.getObject("created_at", OffsetDateTime.class).toInstant(), true)).stream().findFirst();
    }

    // ── substance checks (pure, deterministic) ───────────────────────────────────────────────────

    /** The task's own minimum (targetWordCountMin), bounded; a task without one uses 80. */
    static int minWords(JsonNode task) {
        int min = task == null ? 0 : task.path("targetWordCountMin").asInt(0);
        if (min <= 0) return DEFAULT_MIN_WORDS;
        return Math.max(MIN_WORDS_FLOOR, Math.min(MIN_WORDS_CAP, min));
    }

    /** English words: whitespace tokens that are, apart from surrounding punctuation, one English word ("isn't", "well-known"). */
    static List<String> englishWords(String text) {
        List<String> out = new ArrayList<>();
        if (text == null || text.isBlank()) return out;
        for (String token : text.strip().split("\\s+")) {
            String core = EDGE.matcher(token).replaceAll("");
            if (WORD.matcher(core).matches()) out.add(core.toLowerCase(Locale.ROOT));
        }
        return out;
    }

    private static final Pattern EDGE = Pattern.compile("^[\\p{Punct}“”‘’…]+|[\\p{Punct}“”‘’…]+$");

    static int countWords(String text) {
        return englishWords(text).size();
    }

    /**
     * Null when the text is a real attempt; otherwise the reason code: TOO_SHORT (fewer English words than the task's
     * minimum), NOT_ENGLISH (under 80 % of the written tokens are English words), REPETITIVE (fewer than 35 % distinct
     * words, or one word over 20 % of the text), COPIED_PROMPT (half or more of its three-word sequences come from the
     * task's own wording). These decide participation only, never quality.
     */
    static String substanceProblem(String text, int minWords, String prompt) {
        List<String> words = englishWords(text);
        if (words.size() < minWords) return "TOO_SHORT";
        int tokens = text.strip().split("\\s+").length;
        if (words.size() < 0.8 * tokens) return "NOT_ENGLISH";
        Map<String, Integer> freq = new HashMap<>();
        for (String w : words) freq.merge(w, 1, Integer::sum);
        int top = freq.values().stream().mapToInt(Integer::intValue).max().orElse(0);
        if (freq.size() < 0.35 * words.size() || top > 0.2 * words.size()) return "REPETITIVE";
        Set<String> promptGrams = trigrams(prompt);
        List<String> grams = new ArrayList<>(trigrams(text));
        if (!promptGrams.isEmpty() && !grams.isEmpty()) {
            long copied = grams.stream().filter(promptGrams::contains).count();
            if (copied * 2 >= grams.size()) return "COPIED_PROMPT";
        }
        return null;
    }

    private static Set<String> trigrams(String text) {
        List<String> w = englishWords(text);
        Set<String> out = new LinkedHashSet<>();
        for (int i = 0; i + 2 < w.size(); i++) out.add(w.get(i) + ' ' + w.get(i + 1) + ' ' + w.get(i + 2));
        return out;
    }

    private static String promptText(JsonNode task) {
        if (task == null) return "";
        StringBuilder b = new StringBuilder();
        for (String f : List.of("title", "prompt", "guidance")) b.append(task.path(f).asText("")).append(' ');
        for (JsonNode r : task.path("requirements")) b.append(r.asText("")).append(' ');
        return b.toString();
    }

    private JsonNode parse(String json) {
        try {
            return json == null ? null : mapper.readTree(json);
        } catch (Exception e) {
            return null;
        }
    }

    private static String message(String reason, int minWords) {
        return switch (reason) {
            case "TOO_SHORT" -> "Bài luyện tập cần ít nhất " + minWords + " từ tiếng Anh.";
            case "NOT_ENGLISH" -> "Bài luyện tập cần được viết bằng tiếng Anh.";
            case "REPETITIVE" -> "Bài viết lặp lại quá nhiều. Hãy viết thành câu có nội dung.";
            case "COPIED_PROMPT" -> "Bài viết đang chép lại đề bài. Hãy viết bằng câu của bạn.";
            default -> "Chưa ghi nhận được bài luyện tập.";
        };
    }
}
