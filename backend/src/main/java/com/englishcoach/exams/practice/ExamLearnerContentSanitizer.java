package com.englishcoach.exams.practice;

import java.util.*;

/**
 * Exams Phase 6 — allowlist of the content fields a learner needs to read a stimulus / question in a Practice runner
 * or a Review. Exams Phase 9B: the SAME allowlist serves every learner manifest (Simulation and legacy catalog paths too)
 * — the one learner-facing sanitization policy; internal / admin APIs keep the stored content unchanged. Everything else the extractor or importer keeps for internal use (source pages, rendering method,
 * mapping confidence, source role, QA notes, transcript flags, question ranges, playback internals) is dropped, so a
 * practice payload never carries source paths, OCR / QA diagnostics or provenance objects. Audio stimuli carry no
 * body at all (no hidden transcript is ever disclosed); their assets are still delivered by playback grant.
 */
public final class ExamLearnerContentSanitizer {

    private ExamLearnerContentSanitizer() {}

    private static final Set<String> STIMULUS_KEYS = Set.of(
            "text", "content", "title", "paragraphs", "documents", "documentBoundaries", "altText", "promptContext", "prompt");
    /**
     * Exams Phase 9B: legacy rendering references the runner resolves as web paths (pilot images). Kept only when the value
     * is a learner-safe relative reference — never a machine path, a parent traversal or a file URL.
     */
    private static final Set<String> REFERENCE_KEYS = Set.of("imageUrl", "imageUri", "svgAsset");
    private static final java.util.regex.Pattern MACHINE_PATH = java.util.regex.Pattern.compile(
            "(?i)(^[a-z]:[\\\\/])|\\\\|(^file:)|(\\.\\./)|(^/(home|mnt|app|tmp|var|users|root|etc)/)|localhost|127\\.0\\.0\\.1");
    private static final Set<String> DOCUMENT_KEYS = Set.of("declaredType", "title", "text", "paragraphs");
    private static final Set<String> OPTION_DEFINITION_KEYS = Set.of(
            "options", "choices", "questionNumber", "group", "selection", "responseMode", "minimumWords", "recommendedMinutes");
    private static final Set<String> GROUP_KEYS = Set.of("kind", "questions", "instructions", "stem", "layout", "wordLimitRule");
    private static final Set<String> OPTION_KEYS = Set.of("id", "key", "code", "letter", "text", "label", "content", "value", "body");
    private static final Set<String> SELECTION_KEYS = Set.of("count", "questions");

    /** Learner-safe stimulus body; AUDIO ⇒ empty (never a transcript). */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> stimulusBody(String kind, Map<String, Object> body) {
        if (body == null || "AUDIO".equalsIgnoreCase(kind == null ? "" : kind.trim())) return Map.of();
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : body.entrySet()) {
            if (REFERENCE_KEYS.contains(e.getKey()) && e.getValue() instanceof String ref && learnerSafeReference(ref)) {
                out.put(e.getKey(), ref);
                continue;
            }
            if (!STIMULUS_KEYS.contains(e.getKey()) || e.getValue() == null) continue;
            if ("documents".equals(e.getKey()) && e.getValue() instanceof List<?> docs) {
                List<Object> cleaned = new ArrayList<>();
                for (Object d : docs) cleaned.add(d instanceof Map<?, ?> m ? pick((Map<String, Object>) m, DOCUMENT_KEYS) : d);
                out.put("documents", cleaned);
            } else {
                out.put(e.getKey(), e.getValue());
            }
        }
        return out;
    }

    /** Learner-safe option definitions (option ids + texts, printed group presentation, selection size, writing targets). */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> optionDefinitions(Map<String, Object> defs) {
        if (defs == null) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : defs.entrySet()) {
            String k = e.getKey();
            Object v = e.getValue();
            if ("audioCueMs".equals(k) && v instanceof Integer ms && ms >= 0) out.put(k, ms);
            if (!OPTION_DEFINITION_KEYS.contains(k) || v == null) continue;
            if (("options".equals(k) || "choices".equals(k)) && v instanceof List<?> opts) {
                List<Object> cleaned = new ArrayList<>();
                for (Object o : opts) cleaned.add(o instanceof Map<?, ?> m ? pick((Map<String, Object>) m, OPTION_KEYS) : o);
                out.put(k, cleaned);
            } else if ("group".equals(k) && v instanceof Map<?, ?> g) {
                out.put(k, pick((Map<String, Object>) g, GROUP_KEYS));
            } else if ("selection".equals(k) && v instanceof Map<?, ?> s) {
                out.put(k, pick((Map<String, Object>) s, SELECTION_KEYS));
            } else {
                out.put(k, v);
            }
        }
        return out;
    }

    /** True for a relative web reference / file name a learner may receive (no machine path, traversal, host or URL scheme). */
    public static boolean learnerSafeReference(String ref) {
        return ref != null && !ref.isBlank() && ref.length() <= 512 && !MACHINE_PATH.matcher(ref).find();
    }

    private static Map<String, Object> pick(Map<String, Object> source, Set<String> keys) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : source.entrySet()) {
            if (keys.contains(e.getKey()) && e.getValue() != null) out.put(e.getKey(), e.getValue());
        }
        return out;
    }
}
