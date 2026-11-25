package com.englishcoach.exams.content;

import com.englishcoach.exams.model.ExamTypes.LifecycleState;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Collection;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Owner's 2026-11-16 Practice decision for the pinned original closures of the bank. */
public final class ExamBankOriginalPractice {
    public record Edition(String packageId, String hash) {}
    private static final Map<UUID, Edition> EDITIONS = loadEditions();
    private ExamBankOriginalPractice() {}

    private static Map<UUID, Edition> loadEditions() {
        Map<UUID, Edition> editions = new HashMap<>();
        try (var lines = new BufferedReader(new InputStreamReader(
                ExamBankOriginalPractice.class.getResourceAsStream("/exams/bank-original-practice.tsv"),
                StandardCharsets.UTF_8))) {
            for (String line; (line = lines.readLine()) != null;) {
                if (line.startsWith("#") || line.isBlank()) continue;
                String[] fields = line.split("\t");
                if (fields.length != 4 || !fields[1].startsWith("BANK_") || !fields[2].matches("[0-9a-f]{64}")
                        || editions.putIfAbsent(UUID.fromString(fields[0]), new Edition(fields[1], fields[2])) != null)
                    throw new IllegalStateException("INVALID_ORIGINAL_PRACTICE_INDEX");
            }
        } catch (java.io.IOException e) {
            throw new java.io.UncheckedIOException(e);
        }
        return Map.copyOf(editions);
    }

    public static Edition require(UUID formId) {
        var edition = EDITIONS.get(formId);
        if (edition == null) throw new IllegalArgumentException("BANK_PRACTICE_EDITION_NOT_COVERED");
        return edition;
    }

    public static boolean practiceOnly(UUID id, LifecycleState state) {
        return state == LifecycleState.PILOT && EDITIONS.containsKey(id)
                || state == LifecycleState.PUBLISHED && (ToeicPracticePublication.forForm(id) != null
                        || ToeicPackagePublication.practiceOnly(id));
    }

    public static boolean practiceOnly(UUID id, LifecycleState state, String logicalKey, String scope) {
        return practiceOnly(id,state) || (state==LifecycleState.PUBLISHED && logicalKey!=null
                && logicalKey.startsWith("BANK_TOEIC_") && !"FULL".equals(scope));
    }

    /** The pinned bank contains single-skill editions. Partial editions can launch only a ready named scope. */
    public static boolean wholePracticeReady(ExamFamily family, String scope, Collection<String> readyCodes) {
        if (readyCodes == null || scope == null) return false;
        if (family == ExamFamily.TOEIC)
            return "READING".equals(scope) && readyCodes.containsAll(Set.of("TOEIC_PART_5", "TOEIC_PART_6", "TOEIC_PART_7"));
        if (family != ExamFamily.IELTS) return false;
        return switch (scope) {
            case "WRITING" -> readyCodes.containsAll(Set.of("IELTS_WRITING_TASK_1", "IELTS_WRITING_TASK_2"));
            case "READING" -> readyCodes.containsAll(Set.of("IELTS_READING_PASSAGE_1", "IELTS_READING_PASSAGE_2", "IELTS_READING_PASSAGE_3"));
            case "SPEAKING" -> readyCodes.containsAll(Set.of("IELTS_SPEAKING_PART_1", "IELTS_SPEAKING_PART_2", "IELTS_SPEAKING_PART_3"));
            default -> false;
        };
    }
}
