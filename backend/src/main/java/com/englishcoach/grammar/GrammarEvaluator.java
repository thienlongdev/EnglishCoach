package com.englishcoach.grammar;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.text.Normalizer;
import java.util.*;

/**
 * Judges one answer against one curated exercise. Pure and deterministic: no AI, no network, no database.
 *
 * Wrong feedback teaches wrong grammar, so the evaluator is allowed not to know. An open answer (a sentence transformation,
 * a blank that is not a closed class) that matches neither the accepted list nor a known wrong form is UNRECOGNIZED: the
 * learner sees the model and judges, and the item never counts against them.
 *
 * Normalisation removes only what carries no grammar: Unicode form, curly quotes, runs of spaces, trailing . ! ? and case.
 * Contractions must be authored as accepted alternatives: expanding them can erase the very distinction being taught.
 */
public final class GrammarEvaluator {

    public static final String CORRECT = "CORRECT";
    public static final String ACCEPTABLE = "ACCEPTABLE";
    public static final String PARTIAL = "PARTIAL";
    public static final String WRONG = "WRONG";
    public static final String UNRECOGNIZED = "UNRECOGNIZED";
    public static final String SELF_REVIEW = "SELF_REVIEW";

    /** {@code score} is null when the item must not count: UNRECOGNIZED and SELF_REVIEW. */
    public record Verdict(String outcome, Double score, String explain, ObjectNode reveal, List<String> tags, String answerText) {}

    private final ObjectMapper mapper;

    public GrammarEvaluator(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    public Verdict evaluate(JsonNode ex, JsonNode answer) {
        if (answer == null || !answer.isObject()) throw new GrammarException(400, "INVALID_ANSWER");
        return switch (ex.path("type").asText()) {
            case "choice" -> choice(ex, answer);
            case "multi" -> multi(ex, answer);
            case "cloze" -> cloze(ex, answer);
            case "order" -> order(ex, answer);
            case "transform" -> transform(ex, answer);
            case "error" -> error(ex, answer);
            case "match" -> match(ex, answer);
            case "classify" -> classify(ex, answer);
            case "open" -> open(ex, answer);
            default -> throw new GrammarException(400, "INVALID_ANSWER");
        };
    }

    private Verdict choice(JsonNode ex, JsonNode answer) {
        JsonNode options = ex.path("options");
        int picked = index(answer.path("choice"), options.size());
        JsonNode option = options.get(picked);
        boolean ok = option.path("ok").asBoolean(false);
        return verdict(ex, ok ? CORRECT : WRONG, ok ? 1.0 : 0.0, optionReveal(options), ok ? List.of() : tagsOf(option), option.path("t").asText(""));
    }

    private Verdict multi(JsonNode ex, JsonNode answer) {
        JsonNode options = ex.path("options");
        Set<Integer> picked = new TreeSet<>();
        JsonNode list = answer.path("choices");
        if (!list.isArray()) throw new GrammarException(400, "INVALID_ANSWER");
        for (JsonNode n : list) picked.add(index(n, options.size()));
        int right = 0, extra = 0, total = 0;
        List<String> tags = new ArrayList<>();
        StringJoiner text = new StringJoiner(" | ");
        for (int i = 0; i < options.size(); i++) {
            JsonNode option = options.get(i);
            boolean ok = option.path("ok").asBoolean(false);
            boolean on = picked.contains(i);
            if (ok) total++;
            if (ok && on) right++;
            if (!ok && on) { extra++; tags.addAll(tagsOf(option)); }
            if (on) text.add(option.path("t").asText(""));
        }
        double score = Math.max(0, right - extra) / (double) Math.max(1, total);
        String outcome = score >= 1 && extra == 0 ? CORRECT : score > 0 ? PARTIAL : WRONG;
        return verdict(ex, outcome, score, optionReveal(options), tags, text.toString());
    }

    private ObjectNode optionReveal(JsonNode options) {
        ArrayNode out = mapper.createArrayNode();
        for (int i = 0; i < options.size(); i++) {
            JsonNode o = options.get(i);
            out.add(mapper.createObjectNode().put("i", i).put("ok", o.path("ok").asBoolean(false)).put("note", o.path("note").asText("")));
        }
        ObjectNode reveal = mapper.createObjectNode();
        reveal.set("options", out);
        return reveal;
    }

    /** One judged open form: the accepted list, the authored known forms, then closed (wrong) or not known (unrecognized). */
    private record Judged(String outcome, double score, String note, List<String> tags) {}

    private Judged judgeForm(String given, JsonNode accept, JsonNode known, boolean closed, boolean caseMatters, boolean terminalPunctuationMatters) {
        String g = norm(given, caseMatters, terminalPunctuationMatters);
        if (g.isEmpty()) return new Judged(WRONG, 0, null, List.of());
        for (JsonNode a : accept) if (same(g, a.asText(), caseMatters, terminalPunctuationMatters)) return new Judged(CORRECT, 1, null, List.of());
        for (JsonNode k : known) {
            if (!same(g, k.path("t").asText(), caseMatters, terminalPunctuationMatters)) continue;
            String v = k.path("verdict").asText();
            String note = k.path("note").asText(null);
            return switch (v) {
                case "acceptable" -> new Judged(ACCEPTABLE, 1, note, List.of());
                case "awkward" -> new Judged(ACCEPTABLE, 1, note, List.of());
                default -> new Judged(WRONG, 0, note, tagsOf(k));
            };
        }
        return closed ? new Judged(WRONG, 0, null, List.of()) : new Judged(UNRECOGNIZED, 0, null, List.of());
    }

    private Verdict cloze(JsonNode ex, JsonNode answer) {
        JsonNode blanks = ex.path("blanks");
        JsonNode given = answer.path("blanks");
        if (!given.isObject()) throw new GrammarException(400, "INVALID_ANSWER");
        given.fieldNames().forEachRemaining(k -> { if (!blanks.has(k)) throw new GrammarException(400, "INVALID_ANSWER"); });
        ArrayNode parts = mapper.createArrayNode();
        List<String> tags = new ArrayList<>();
        StringJoiner text = new StringJoiner(" | ");
        double sum = 0;
        int scored = 0, unknown = 0, variants = 0;
        boolean caseMatters = ex.path("caseMatters").asBoolean(false);
        for (Iterator<Map.Entry<String, JsonNode>> it = blanks.fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> b = it.next();
            String typed = text(given.path(b.getKey()));
            text.add(typed);
            Judged j = judgeForm(typed, b.getValue().path("accept"), b.getValue().path("known"),
                    b.getValue().path("closed").asBoolean(ex.path("closed").asBoolean(false)), caseMatters, ex.path("terminalPunctuationMatters").asBoolean(false));
            ObjectNode part = mapper.createObjectNode().put("key", b.getKey()).put("outcome", j.outcome());
            if (j.note() != null) part.put("note", j.note());
            part.set("expected", b.getValue().path("accept"));
            parts.add(part);
            tags.addAll(j.tags());
            if (UNRECOGNIZED.equals(j.outcome())) { unknown++; continue; }
            if (ACCEPTABLE.equals(j.outcome())) variants++;
            sum += j.score();
            scored++;
        }
        ObjectNode reveal = mapper.createObjectNode();
        reveal.set("parts", parts);
        if (scored == 0) return verdict(ex, UNRECOGNIZED, null, reveal, tags, text.toString());
        double score = sum / scored;
        if (unknown > 0) return verdict(ex, UNRECOGNIZED, null, reveal, tags, text.toString());
        String outcome = score >= 1 ? (variants > 0 ? ACCEPTABLE : CORRECT) : score > 0 ? PARTIAL : WRONG;
        return verdict(ex, outcome, score, reveal, tags, text.toString());
    }

    private Verdict order(JsonNode ex, JsonNode answer) {
        JsonNode seq = answer.path("seq");
        if (!seq.isArray()) throw new GrammarException(400, "INVALID_ANSWER");
        List<String> given = new ArrayList<>();
        for (JsonNode n : seq) given.add(text(n));
        List<String> tokens = new ArrayList<>();
        for (JsonNode n : ex.path("tokens")) tokens.add(n.asText());
        List<String> a = new ArrayList<>(given), b = new ArrayList<>(tokens);
        Collections.sort(a); Collections.sort(b);
        if (!a.equals(b)) throw new GrammarException(400, "INVALID_ANSWER");
        ObjectNode reveal = mapper.createObjectNode();
        reveal.set("accept", ex.path("accept"));
        String text = String.join(" ", given);
        for (JsonNode ok : ex.path("accept")) if (sameSeq(given, ok)) return verdict(ex, CORRECT, 1.0, reveal, List.of(), text);
        for (JsonNode k : ex.path("known")) {
            if (!sameSeq(given, k.path("seq"))) continue;
            reveal.put("note", k.path("note").asText(""));
            String v = k.path("verdict").asText();
            if ("acceptable".equals(v)) return verdict(ex, ACCEPTABLE, 1.0, reveal, List.of(), text);
            if ("awkward".equals(v)) return verdict(ex, ACCEPTABLE, 1.0, reveal, List.of(), text);
            return verdict(ex, WRONG, 0.0, reveal, tagsOf(k), text);
        }
        return verdict(ex, WRONG, 0.0, reveal, List.of(), text);
    }

    private static boolean sameSeq(List<String> given, JsonNode seq) {
        if (!seq.isArray() || seq.size() != given.size()) return false;
        for (int i = 0; i < given.size(); i++) if (!given.get(i).equals(seq.get(i).asText())) return false;
        return true;
    }

    private Verdict transform(JsonNode ex, JsonNode answer) {
        String typed = text(answer.path("text"));
        Judged j = judgeForm(typed, ex.path("accept"), ex.path("known"), false, ex.path("caseMatters").asBoolean(false), ex.path("terminalPunctuationMatters").asBoolean(false));
        ObjectNode reveal = mapper.createObjectNode().put("model", ex.path("model").asText(""));
        reveal.set("accept", ex.path("accept"));
        if (j.note() != null) reveal.put("note", j.note());
        return switch (j.outcome()) {
            case UNRECOGNIZED -> verdict(ex, UNRECOGNIZED, null, reveal, List.of(), typed);
            case ACCEPTABLE -> verdict(ex, j.score() >= 1 ? ACCEPTABLE : PARTIAL, j.score(), reveal, List.of(), typed);
            case CORRECT -> verdict(ex, CORRECT, 1.0, reveal, List.of(), typed);
            default -> verdict(ex, WRONG, 0.0, reveal, j.tags(), typed);
        };
    }

    private Verdict error(JsonNode ex, JsonNode answer) {
        JsonNode segments = ex.path("segments");
        if (answer.has("none") && !answer.path("none").isBoolean()) throw new GrammarException(400, "INVALID_ANSWER");
        if (answer.has("picked") && !answer.path("picked").isArray()) throw new GrammarException(400, "INVALID_ANSWER");
        boolean none = answer.path("none").asBoolean(false);
        Set<Integer> picked = new TreeSet<>();
        if (answer.path("picked").isArray()) for (JsonNode n : answer.path("picked")) picked.add(index(n, segments.size()));
        if (none && !picked.isEmpty()) throw new GrammarException(400, "INVALID_ANSWER");
        ArrayNode segs = mapper.createArrayNode();
        int bad = 0, hits = 0, falsePicks = 0;
        List<String> tags = new ArrayList<>();
        StringJoiner text = new StringJoiner(" | ");
        for (int i = 0; i < segments.size(); i++) {
            JsonNode s = segments.get(i);
            boolean style = s.path("style").asBoolean(false);
            boolean isBad = s.path("bad").asBoolean(false) && !style;
            boolean on = picked.contains(i);
            if (on) text.add(s.path("t").asText(""));
            if (isBad) { bad++; if (on) hits++; else tags.addAll(tagsOf(s)); }
            else if (on && !style) falsePicks++;
            ObjectNode seg = mapper.createObjectNode().put("i", i).put("bad", isBad);
            if (style) seg.put("style", true);
            if (s.has("note")) seg.put("note", s.path("note").asText());
            if (s.has("fix")) seg.set("fix", s.path("fix"));
            segs.add(seg);
        }
        ObjectNode reveal = mapper.createObjectNode().put("noError", bad == 0);
        reveal.set("segments", segs);
        if (bad == 0) {
            boolean right = none || (picked.isEmpty() ? false : falsePicks == 0);
            return verdict(ex, right ? CORRECT : WRONG, right ? 1.0 : 0.0, reveal, List.of(), none ? "(no error)" : text.toString());
        }
        if (none) return verdict(ex, WRONG, 0.0, reveal, tags, "(no error)");
        double score = Math.max(0, hits - falsePicks) / (double) bad;
        String outcome = score >= 1 && falsePicks == 0 ? CORRECT : score > 0 ? PARTIAL : WRONG;
        return verdict(ex, outcome, score, reveal, tags, text.toString());
    }

    private Verdict match(JsonNode ex, JsonNode answer) {
        JsonNode pairs = ex.path("pairs");
        JsonNode given = answer.path("pairs");
        if (!given.isObject()) throw new GrammarException(400, "INVALID_ANSWER");
        validatePositions(given, pairs.size());
        int right = 0;
        ArrayNode out = mapper.createArrayNode();
        for (int i = 0; i < pairs.size(); i++) {
            boolean ok = pairs.get(i).path("b").asText().equals(text(given.path(String.valueOf(i))));
            if (ok) right++;
            out.add(mapper.createObjectNode().put("i", i).put("ok", ok).put("b", pairs.get(i).path("b").asText()));
        }
        ObjectNode reveal = mapper.createObjectNode();
        reveal.set("pairs", out);
        return fraction(ex, right, pairs.size(), reveal);
    }

    private Verdict classify(JsonNode ex, JsonNode answer) {
        JsonNode items = ex.path("items");
        JsonNode given = answer.path("cats");
        if (!given.isObject()) throw new GrammarException(400, "INVALID_ANSWER");
        validatePositions(given, items.size());
        int right = 0;
        ArrayNode out = mapper.createArrayNode();
        for (int i = 0; i < items.size(); i++) {
            boolean ok = items.get(i).path("cat").asText().equals(text(given.path(String.valueOf(i))));
            if (ok) right++;
            out.add(mapper.createObjectNode().put("i", i).put("ok", ok).put("cat", items.get(i).path("cat").asText()));
        }
        ObjectNode reveal = mapper.createObjectNode();
        reveal.set("items", out);
        return fraction(ex, right, items.size(), reveal);
    }

    private Verdict fraction(JsonNode ex, int right, int total, ObjectNode reveal) {
        double score = right / (double) Math.max(1, total);
        return verdict(ex, score >= 1 ? CORRECT : score > 0 ? PARTIAL : WRONG, score, reveal, List.of(), null);
    }

    private Verdict open(JsonNode ex, JsonNode answer) {
        ObjectNode reveal = mapper.createObjectNode();
        reveal.set("model", ex.path("model"));
        reveal.set("checklist", ex.path("checklist"));
        return verdict(ex, SELF_REVIEW, null, reveal, List.of(), text(answer.path("text")));
    }

    private static Verdict verdict(JsonNode ex, String outcome, Double score, ObjectNode reveal, List<String> tags, String text) {
        return new Verdict(outcome, score, ex.path("explain").asText(""), reveal, tags, text);
    }

    private static List<String> tagsOf(JsonNode node) {
        String t = node.path("tag").asText("");
        return t.isEmpty() ? List.of() : List.of(t);
    }

    private static int index(JsonNode n, int size) {
        if (!n.isIntegralNumber() || !n.canConvertToInt() || n.asInt() < 0 || n.asInt() >= size) throw new GrammarException(400, "INVALID_ANSWER");
        return n.asInt();
    }

    private static String bounded(String s) {
        if (s.length() > 400) throw new GrammarException(400, "INVALID_ANSWER");
        return s;
    }

    private static String text(JsonNode n) {
        if (n.isMissingNode()) return "";
        if (!n.isTextual()) throw new GrammarException(400, "INVALID_ANSWER");
        return bounded(n.asText());
    }

    private static void validatePositions(JsonNode given, int size) {
        Set<String> keys = new HashSet<>();
        for (int i = 0; i < size; i++) keys.add(String.valueOf(i));
        given.fieldNames().forEachRemaining(k -> { if (!keys.contains(k)) throw new GrammarException(400, "INVALID_ANSWER"); });
    }

    static String norm(String s, boolean caseMatters) {
        return norm(s, caseMatters, false);
    }

    static String norm(String s, boolean caseMatters, boolean terminalPunctuationMatters) {
        String n = Normalizer.normalize(s == null ? "" : s, Normalizer.Form.NFC)
                .replace('‘', '\'').replace('’', '\'').replace('“', '"').replace('”', '"')
                .replaceAll("(?U)\\s+", " ").trim();
        if (!terminalPunctuationMatters) n = n.replaceAll("[.!?]+$", "").trim();
        return caseMatters ? n : n.toLowerCase(Locale.ROOT);
    }

    private static boolean same(String normalisedGiven, String candidate, boolean caseMatters, boolean terminalPunctuationMatters) {
        return normalisedGiven.equals(norm(candidate, caseMatters, terminalPunctuationMatters));
    }
}
