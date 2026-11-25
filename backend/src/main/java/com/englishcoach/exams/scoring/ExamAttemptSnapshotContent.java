package com.englishcoach.exams.scoring;

import com.englishcoach.exams.model.ExamContentRecords.AnswerSpecRecord;
import com.englishcoach.exams.model.ExamTypes.SkillType;

import java.util.*;

/**
 * Read-only view of the content an attempt pinned when it was created ({@code attempts.manifest_snapshot}, written by
 * {@code ExamManifestService#serializeFormSnapshot}). Exams Phase 4C.5 (EXAM-AUD-024): objective scoring and review
 * of a SNAPSHOTTED attempt use THIS content — items, answer specs, printed question numbers — never the live tables,
 * so editing or re-importing content after the attempt started cannot change its score.
 *
 * <p>Parsing is total: a malformed snapshot yields {@link Optional#empty()} and the caller falls back to its legacy
 * (unsnapshotted) path explicitly; it never mixes snapshot and live rows.
 */
public record ExamAttemptSnapshotContent(List<SnapshotSection> sections) {

    public record SnapshotItem(UUID itemId, UUID groupId, String logicalItemKey, int version, String prompt,
                               String interactionType, Map<String, Object> optionDefinitions, String construct,
                               Integer ordinal, Integer questionNumber, AnswerSpecRecord answerSpec) {

        /** The printed word-limit rule allows a number in addition to the words ("ONE WORD AND/OR A NUMBER"). */
        public boolean numbersExempt() {
            return wordLimitAllowsNumber(optionDefinitions);
        }
    }

    public record SnapshotSection(UUID sectionId, SkillType skill, List<SnapshotItem> items) {}

    public ExamAttemptSnapshotContent {
        sections = sections == null ? List.of() : List.copyOf(sections);
    }

    public Optional<SnapshotSection> section(UUID sectionId) {
        return sections.stream().filter(s -> s.sectionId().equals(sectionId)).findFirst();
    }

    public List<SnapshotItem> allItems() {
        List<SnapshotItem> all = new ArrayList<>();
        for (SnapshotSection s : sections) all.addAll(s.items());
        return all;
    }

    @SuppressWarnings("unchecked")
    public static Optional<ExamAttemptSnapshotContent> parse(Map<String, Object> snapshot) {
        if (snapshot == null || !(snapshot.get("sections") instanceof List<?> rawSections)) return Optional.empty();
        try {
            List<SnapshotSection> sections = new ArrayList<>();
            for (Object so : rawSections) {
                Map<String, Object> secMap = (Map<String, Object>) so;
                UUID sectionId = UUID.fromString((String) secMap.get("id"));
                SkillType skill = SkillType.valueOf((String) secMap.get("skill"));
                List<SnapshotItem> items = new ArrayList<>();
                for (Map<String, Object> partMap : list(secMap.get("parts"))) {
                    for (Map<String, Object> grpMap : list(partMap.get("groups"))) {
                        UUID groupId = UUID.fromString((String) grpMap.get("id"));
                        for (Map<String, Object> itemMap : list(grpMap.get("items"))) {
                            items.add(item(itemMap, groupId));
                        }
                    }
                }
                sections.add(new SnapshotSection(sectionId, skill, items));
            }
            return Optional.of(new ExamAttemptSnapshotContent(sections));
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }

    @SuppressWarnings("unchecked")
    private static SnapshotItem item(Map<String, Object> itemMap, UUID groupId) {
        UUID itemId = UUID.fromString((String) itemMap.get("id"));
        Map<String, Object> optionDefs = itemMap.get("optionDefinitions") instanceof Map<?, ?> m
                ? (Map<String, Object>) m : null;
        Integer ordinal = intOrNull(itemMap.get("ordinal"));
        Integer questionNumber = optionDefs != null ? intOrNull(optionDefs.get("questionNumber")) : null;
        AnswerSpecRecord spec = null;
        if (itemMap.get("answerSpec") instanceof Map<?, ?> a) {
            Map<String, Object> ansMap = (Map<String, Object>) a;
            spec = new AnswerSpecRecord(
                    ansMap.get("id") != null ? UUID.fromString((String) ansMap.get("id")) : null,
                    itemId,
                    (Map<String, Object>) ansMap.get("acceptedAnswers"),
                    (Map<String, Object>) ansMap.get("normalizationPolicy"),
                    ansMap.get("cardinality") != null ? ((Number) ansMap.get("cardinality")).intValue() : 1,
                    intOrNull(ansMap.get("wordLimit")),
                    ansMap.get("creditUnits") != null ? ((Number) ansMap.get("creditUnits")).doubleValue() : 1.0,
                    (String) ansMap.get("explanation"),
                    ansMap.get("rubricId") != null ? UUID.fromString((String) ansMap.get("rubricId")) : null,
                    null);
        }
        return new SnapshotItem(itemId, groupId, (String) itemMap.get("logicalItemKey"),
                itemMap.get("version") != null ? ((Number) itemMap.get("version")).intValue() : 1,
                (String) itemMap.get("prompt"), (String) itemMap.get("interactionType"), optionDefs,
                (String) itemMap.get("construct"), ordinal, questionNumber != null ? questionNumber : ordinal, spec);
    }

    /** True when the item's printed group rule / instructions allow a number besides the words. */
    @SuppressWarnings("unchecked")
    public static boolean wordLimitAllowsNumber(Map<String, Object> optionDefinitions) {
        if (optionDefinitions == null || !(optionDefinitions.get("group") instanceof Map<?, ?> g)) return false;
        Map<String, Object> group = (Map<String, Object>) g;
        StringBuilder text = new StringBuilder();
        if (group.get("wordLimitRule") != null) text.append(group.get("wordLimitRule")).append(' ');
        if (group.get("instructions") instanceof List<?> l) for (Object o : l) text.append(o).append(' ');
        String upper = text.toString().toUpperCase(Locale.ROOT);
        return upper.contains("NUMBER") || upper.contains("AND/OR");
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Object o) {
        if (!(o instanceof List<?> l)) return List.of();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object e : l) if (e instanceof Map<?, ?> m) out.add((Map<String, Object>) m);
        return out;
    }

    private static Integer intOrNull(Object o) {
        return o instanceof Number n ? n.intValue() : null;
    }
}
