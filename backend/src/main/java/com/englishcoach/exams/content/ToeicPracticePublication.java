package com.englishcoach.exams.content;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.practice.ExamPracticeReadiness.ScopeReadiness;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Owner-authorized TOEIC Reading editions. Publication is still an explicit MFA-protected admin action. */
public record ToeicPracticePublication(String packageId, String packageHash, String formHash, String fingerprint) {
    private static final Map<UUID, ToeicPracticePublication> EDITIONS = readEditions();
    private static final Map<String, Integer> READING = Map.of("TOEIC_PART_5", 30, "TOEIC_PART_6", 16, "TOEIC_PART_7", 54);

    private static Map<UUID, ToeicPracticePublication> readEditions() {
        Map<UUID, ToeicPracticePublication> rows = new HashMap<>();
        try (var reader = new BufferedReader(new InputStreamReader(ToeicPracticePublication.class
                .getResourceAsStream("/exams/toeic-published-reading.tsv"), StandardCharsets.UTF_8))) {
            for (String line; (line = reader.readLine()) != null;) {
                if (line.isBlank() || line.startsWith("#")) continue;
                String[] f = line.split("\\t", -1);
                if (f.length != 5 || !f[1].startsWith("BANK_TOEIC_")
                        || !List.of(f[2], f[3], f[4]).stream().allMatch(h -> h.matches("[0-9a-f]{64}")))
                    throw new IllegalStateException("Invalid TOEIC publication registry record");
                if (rows.putIfAbsent(UUID.fromString(f[0]), new ToeicPracticePublication(f[1], f[2], f[3], f[4])) != null)
                    throw new IllegalStateException("Duplicate TOEIC publication identity");
            }
        } catch (java.io.IOException e) {
            throw new java.io.UncheckedIOException(e);
        }
        return Map.copyOf(rows);
    }

    public static ToeicPracticePublication forForm(UUID id) {
        return EDITIONS.get(id);
    }

    public boolean matchesScopes(List<ScopeReadiness> scopes) {
        Map<String, Integer> counts = new HashMap<>();
        for (var readiness : scopes) {
            var scope = readiness.scope();
            if (!readiness.ready() || scope.family() != ExamFamily.TOEIC || !scope.objectiveScoring()
                    || scope.itemCount() != scope.objectiveItemCount() || !scope.mediaAssetIds().isEmpty()
                    || counts.putIfAbsent(scope.scopeCode(), scope.itemCount()) != null) return false;
        }
        return READING.equals(counts);
    }
}
