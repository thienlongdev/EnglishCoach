package com.englishcoach.exams.service;

import java.util.*;

/** Printed corpus turns are read only from the immutable attempt snapshot. */
public final class ExamPinnedSpeakingPrompts {
    private ExamPinnedSpeakingPrompts() {}

    public static boolean corpusItems(List<? extends Map<?, ?>> items) {
        return !items.isEmpty() && items.stream().allMatch(i -> i.get("optionDefinitions") instanceof Map<?, ?> o
                && "PINNED_CORPUS_SOURCE".equals(o.get("speakingPromptBasis"))
                && i.get("prompt") instanceof String p && !p.isBlank());
    }

    public static int requiredTurns(Map<String, Object> snapshot, int part, int legacyCount) {
        if (snapshot == null || !(snapshot.get("sections") instanceof List<?> sections)) return legacyCount;
        for (Object section : sections) {
            if (!(section instanceof Map<?, ?> s) || !"SPEAKING".equals(s.get("skill"))
                    || !(s.get("parts") instanceof List<?> parts)) continue;
            for (Object value : parts) {
                if (!(value instanceof Map<?, ?> p) || !("SPEAKING_PART_" + part).equals(p.get("partCode"))
                        || !(p.get("groups") instanceof List<?> groups)) continue;
                List<Map<?, ?>> items = new ArrayList<>();
                for (Object group : groups) if (group instanceof Map<?, ?> g && g.get("items") instanceof List<?> rows)
                    for (Object row : rows) if (row instanceof Map<?, ?> item) items.add(item);
                if (corpusItems(items)) return items.size();
            }
        }
        return legacyCount;
    }
}
