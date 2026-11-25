package com.englishcoach.cosmos;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Service;

import java.text.Normalizer;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Echo Neural Cosmos — source passage retrieval for "Hỏi vũ trụ" (GraphRAG evidence). Deterministic: no AI, no model, no network.
 *
 * <p>Given sources the learner may see and one or two groups of word forms (each group = the forms of ONE concept, chosen by the
 * client from the verified lexicon), it returns the sentences of those sources in which the forms occur, with exact character
 * spans and a locator (sentence index, or the Listening transcript segment and its start time). Two groups ⇒ only sentences that
 * contain BOTH. A returned sentence is evidence that the words occur there, nothing more: it never creates a relation, a sense
 * or a mastery claim, and its text is data (instructions inside a source are never followed).
 *
 * <p>Isolation (AGENTS §21): every source is read through its live row and the SAME visibility rule as the overlay — Reading
 * completed by the caller (SYSTEM or own), Listening with an ended session of the caller (SYSTEM or own), Writing and Speaking
 * only the caller's own (non-mocked). A foreign, quarantined, deleted or not-yet-completed source simply yields nothing.
 * One statement (one round trip) for every requested source together.
 */
@Service
public class CosmosPassageService {
    static final int MAX_REFS = 12;
    static final int MAX_FORMS = 32;
    static final int MAX_PER_SOURCE = 4;
    static final int MAX_TOTAL = 24;
    static final int MAX_SENTENCE = 420;
    private static final Pattern WORD = Pattern.compile("[a-z]+(?:['\\-][a-z]+)*");
    private static final Pattern FORM = Pattern.compile("[a-z]+(?:['\\-][a-z]+)*(?: [a-z]+(?:['\\-][a-z]+)*){0,3}");
    /** Sentence ends: . ! ? (with closing quotes) followed by space, or a line break. Decimal points and abbreviations without a following space stay inside. */
    private static final Pattern SENTENCE_END = Pattern.compile("(?<=[.!?][\"”’')\\]]{0,2})\\s+|\\n\\s*");
    private static final Set<String> KINDS = Set.of("READING", "LISTENING", "WRITING", "SPEAKING");

    private final NamedParameterJdbcTemplate named;

    public CosmosPassageService(JdbcTemplate jdbc) {
        this.named = new NamedParameterJdbcTemplate(jdbc);
    }

    public CosmosDtos.Passages passages(long userId, CosmosDtos.PassageQuery q) {
        if (q == null || q.groups() == null || q.groups().isEmpty() || q.groups().size() > 2 || q.refs() == null) return new CosmosDtos.Passages(List.of(), false);
        List<Set<String>> groups = new ArrayList<>();
        for (List<String> g : q.groups()) {
            Set<String> forms = new LinkedHashSet<>();
            if (g != null) for (String f : g) {
                String n = CosmosTokenizer.normalize(f).trim().replaceAll("\\s+", " ");
                if (forms.size() < MAX_FORMS && n.length() <= 60 && FORM.matcher(n).matches()) forms.add(n);
            }
            if (forms.isEmpty()) return new CosmosDtos.Passages(List.of(), false);
            groups.add(forms);
        }
        Map<String, List<Long>> ids = new LinkedHashMap<>();
        List<String> order = new ArrayList<>();
        for (String ref : q.refs()) {
            if (order.size() >= MAX_REFS || ref == null) break;
            int c = ref.indexOf(':');
            if (c < 0) continue;
            String kind = ref.substring(0, c);
            if (!KINDS.contains(kind)) continue;
            long id;
            try { id = Long.parseLong(ref.substring(c + 1)); } catch (NumberFormatException e) { continue; }
            if (order.contains(kind + ":" + id)) continue;
            order.add(kind + ":" + id);
            ids.computeIfAbsent(kind, k -> new ArrayList<>()).add(id);
        }
        if (order.isEmpty()) return new CosmosDtos.Passages(List.of(), false);
        int perSource = Math.max(1, Math.min(MAX_PER_SOURCE, q.limit() == null ? 3 : q.limit()));

        MapSqlParameterSource p = new MapSqlParameterSource("u", userId).addValue("jz", CosmosOverlayService.naiveZone());
        for (String k : KINDS) p.addValue(k, ids.getOrDefault(k, List.of(-1L)));
        Map<String, Src> sources = new LinkedHashMap<>();
        named.query("""
                SELECT 'READING' AS kind, m.id, m.title, (extract(epoch FROM (SELECT max(p.completed_at) FROM public.user_reading_progress p
                         WHERE p.user_id = :u AND p.reading_material_id = m.id)) * 1000)::bigint AS at,
                       (m.is_system AND m.owner_user_id IS NULL) AS sys, 0::bigint AS seg, NULL::integer AS start_ms, COALESCE(m.content_text, '') AS body
                  FROM public.reading_materials m
                 WHERE m.id IN (:READING)
                   AND ((m.is_system = true AND m.owner_user_id IS NULL) OR m.owner_user_id = :u)
                   AND EXISTS (SELECT 1 FROM public.user_reading_progress p WHERE p.user_id = :u AND p.reading_material_id = m.id AND p.completed_at IS NOT NULL)
                UNION ALL
                SELECT 'LISTENING', m.id, m.title, (extract(epoch FROM (s.last_end AT TIME ZONE :jz)) * 1000)::bigint, (m.is_system AND m.owner_user_id IS NULL),
                       t.id, t.start_time_ms, COALESCE(t.text, '')
                  FROM (SELECT listening_material_id, max(ended_at) AS last_end FROM public.listening_sessions
                         WHERE user_id = :u AND ended_at IS NOT NULL AND listening_material_id IN (:LISTENING) GROUP BY listening_material_id) s
                  JOIN public.listening_materials m ON m.id = s.listening_material_id
                  JOIN public.transcript_segments t ON t.listening_material_id = m.id
                 WHERE (m.is_system = true AND m.owner_user_id IS NULL) OR m.owner_user_id = :u
                UNION ALL
                SELECT 'WRITING', w.id, 'Writing', (extract(epoch FROM w.created_at) * 1000)::bigint, false, 0, NULL, w.content
                  FROM public.writing_practice_submission w WHERE w.user_id = :u AND w.id IN (:WRITING)
                UNION ALL
                SELECT 'SPEAKING', q.id, 'Speaking', (extract(epoch FROM (q.created_at AT TIME ZONE :jz)) * 1000)::bigint, false, 0, NULL, q.whisper_transcript
                  FROM exams.speaking_quick_checks q
                 WHERE q.user_id = :u AND q.id IN (:SPEAKING) AND COALESCE(q.is_mocked, false) = false AND NULLIF(btrim(q.whisper_transcript), '') IS NOT NULL
                 ORDER BY 1, 2, 7 NULLS FIRST, 6""", p, rs -> {
            String key = rs.getString(1) + ":" + rs.getLong(2);
            Src s = sources.computeIfAbsent(key, k -> {
                try { return new Src(rs.getString(1), rs.getLong(2), rs.getString(3), rs.getLong(4), rs.getBoolean(5)); }
                catch (java.sql.SQLException e) { throw new IllegalStateException(e); }
            });
            s.parts.add(new Part(rs.getLong(6), (Integer) rs.getObject(7, Integer.class), nfc(rs.getString(8))));
        });

        List<CosmosDtos.Passage> out = new ArrayList<>();
        boolean more = false;
        for (String key : order) {
            Src s = sources.get(key);
            if (s == null) continue;
            int found = 0, index = 0;
            outer:
            for (Part part : s.parts) {
                List<int[]> sentences = s.kind.equals("LISTENING") ? List.of(new int[]{0, part.body.length()}) : sentences(part.body);
                for (int[] range : sentences) {
                    int i = index++;
                    String sentence = part.body.substring(range[0], range[1]);
                    List<int[]> spans = spans(sentence, groups);
                    if (spans == null) continue;
                    if (found >= perSource || out.size() >= MAX_TOTAL) { more = true; break outer; }
                    out.add(clip(s, part, i, sentence, spans));
                    found++;
                }
            }
        }
        return new CosmosDtos.Passages(out, more);
    }

    private static final class Src {
        final String kind; final long id; final String title; final long at; final boolean system;
        final List<Part> parts = new ArrayList<>();
        Src(String kind, long id, String title, long at, boolean system) { this.kind = kind; this.id = id; this.title = title; this.at = at; this.system = system; }
    }
    private record Part(long segment, Integer startMs, String body) {}

    /** Sentence ranges [start, end) over the NFC text, trimmed; empty pieces dropped. */
    static List<int[]> sentences(String body) {
        List<int[]> out = new ArrayList<>();
        Matcher m = SENTENCE_END.matcher(body);
        int start = 0;
        while (m.find()) { add(out, body, start, m.start()); start = m.end(); }
        add(out, body, start, body.length());
        return out;
    }
    private static void add(List<int[]> out, String body, int a, int b) {
        while (a < b && Character.isWhitespace(body.charAt(a))) a++;
        while (b > a && Character.isWhitespace(body.charAt(b - 1))) b--;
        if (b > a) out.add(new int[]{a, b});
    }

    /**
     * Spans [start, end, group] of the forms in one sentence, or null if a group is missing. Word boundaries follow
     * {@link CosmosTokenizer}: a form is a whole word (or consecutive words); "bank" never matches inside "river-banks",
     * "bank's" counts as "bank".
     */
    static List<int[]> spans(String sentence, List<Set<String>> groups) {
        String low = CosmosTokenizer.normalize(sentence);
        if (low.length() != sentence.length()) return null; // offsets would not line up (rare non-ASCII case): no claim
        List<int[]> words = new ArrayList<>();
        Matcher m = WORD.matcher(low);
        while (m.find()) {
            int end = m.end();
            if (low.startsWith("'s", end - 2) && end - 2 > m.start()) end -= 2;
            words.add(new int[]{m.start(), end});
        }
        List<int[]> spans = new ArrayList<>();
        boolean[] hit = new boolean[groups.size()];
        for (int i = 0; i < words.size(); i++) {
            for (int g = 0; g < groups.size(); g++) {
                for (String form : groups.get(g)) {
                    String[] parts = form.split(" ");
                    if (i + parts.length > words.size()) continue;
                    boolean ok = true;
                    for (int k = 0; k < parts.length && ok; k++) {
                        int[] w = words.get(i + k);
                        ok = low.substring(w[0], w[1]).equals(parts[k])
                                && (k == 0 || low.substring(words.get(i + k - 1)[1], w[0]).isBlank()); // adjacent, no punctuation between
                    }
                    if (ok) { spans.add(new int[]{words.get(i)[0], words.get(i + parts.length - 1)[1], g}); hit[g] = true; break; }
                }
            }
        }
        for (boolean h : hit) if (!h) return null;
        return spans;
    }

    /** A sentence longer than the limit is cut around its first span (ellipses mark the cut); spans move with it. */
    private static CosmosDtos.Passage clip(Src s, Part part, int index, String sentence, List<int[]> spans) {
        String text = sentence;
        int shift = 0;
        if (text.length() > MAX_SENTENCE) {
            int first = spans.get(0)[0];
            int from = Math.max(0, Math.min(first - MAX_SENTENCE / 3, text.length() - MAX_SENTENCE));
            int to = Math.min(text.length(), from + MAX_SENTENCE);
            text = (from > 0 ? "…" : "") + text.substring(from, to) + (to < sentence.length() ? "…" : "");
            shift = from - (from > 0 ? 1 : 0);
        }
        List<int[]> moved = new ArrayList<>();
        for (int[] sp : spans) {
            int a = sp[0] - shift, b = sp[1] - shift;
            if (a >= 0 && b <= text.length()) moved.add(new int[]{a, b, sp[2]});
        }
        return new CosmosDtos.Passage(s.kind, s.id, s.title, s.at, s.system, part.segment, part.startMs, index, text, moved);
    }

    static String nfc(String s) { return s == null ? "" : Normalizer.normalize(s, Normalizer.Form.NFC); }
}
