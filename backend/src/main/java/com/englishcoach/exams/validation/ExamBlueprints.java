package com.englishcoach.exams.validation;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;

import java.util.*;

/**
 * Family-specific structural blueprints (Exams Recovery Phase 2). They encode only the PUBLIC FORMAT of the
 * official tests (sections, parts, set sizes, item counts) — never any test content — and are the single place
 * where exam-family business rules live (no frontend or importer copies).
 */
public final class ExamBlueprints {

    private ExamBlueprints() {}

    // ─── Expected skills per family / variant / scope ──────────────────────────────────────

    /** Skills a complete form of this family/variant/scope must contain; empty when the scope is unknown. */
    public static Set<SkillType> expectedSkills(ExamFamily family, String variant, String scope) {
        String v = norm(variant);
        String s = norm(scope);
        if (family == ExamFamily.IELTS) {
            return switch (s) {
                case "FULL" -> EnumSet.allOf(SkillType.class);
                case "LISTENING" -> EnumSet.of(SkillType.LISTENING);
                case "READING" -> EnumSet.of(SkillType.READING);
                case "WRITING" -> EnumSet.of(SkillType.WRITING);
                case "SPEAKING" -> EnumSet.of(SkillType.SPEAKING);
                default -> EnumSet.noneOf(SkillType.class);
            };
        }
        if (family == ExamFamily.TOEIC) {
            if ("SUITE".equals(v) || "SUITE".equals(s)) return EnumSet.allOf(SkillType.class);
            if ("SPEAKING".equals(v) || "SPEAKING".equals(s)) return EnumSet.of(SkillType.SPEAKING);
            if ("WRITING".equals(v) || "WRITING".equals(s)) return EnumSet.of(SkillType.WRITING);
            if ("LISTENING".equals(s)) return EnumSet.of(SkillType.LISTENING);
            if ("READING".equals(s)) return EnumSet.of(SkillType.READING);
            if (Set.of("FULL", "LR", "PARTS_1_7").contains(s)) return EnumSet.of(SkillType.LISTENING, SkillType.READING);
            return EnumSet.noneOf(SkillType.class);
        }
        return EnumSet.noneOf(SkillType.class);
    }

    // ─── TOEIC Listening & Reading ─────────────────────────────────────────────────────────

    /**
     * One TOEIC L&R part. {@code exactGroups}/{@code minGroupSize}/{@code maxGroupSize} null = unconstrained.
     * {@code fiveItemSets} = expected number of 5-question multi-passage sets (Part 7 only).
     */
    public record ToeicPartSpec(int part, SkillType skill, int items, Integer exactGroups, Integer minGroupSize,
                                Integer maxGroupSize, int options, boolean imageRequired, boolean passageRequired,
                                boolean optionTextRequired, Integer fiveItemSets) {}

    public enum ToeicFormat {
        /** Current format (2016+): Listening 6/25/39/30, Reading 30/16/54. */
        TOEIC_LR_2016(List.of(
                new ToeicPartSpec(1, SkillType.LISTENING, 6, 6, 1, 1, 4, true, false, false, null),
                new ToeicPartSpec(2, SkillType.LISTENING, 25, null, null, null, 3, false, false, false, null),
                new ToeicPartSpec(3, SkillType.LISTENING, 39, 13, 3, 3, 4, false, false, true, null),
                new ToeicPartSpec(4, SkillType.LISTENING, 30, 10, 3, 3, 4, false, false, true, null),
                new ToeicPartSpec(5, SkillType.READING, 30, null, null, null, 4, false, false, true, null),
                new ToeicPartSpec(6, SkillType.READING, 16, 4, 4, 4, 4, false, true, true, null),
                new ToeicPartSpec(7, SkillType.READING, 54, null, 2, 5, 4, false, true, true, 5))),
        /** Legacy format (pre-2016): Listening 10/30/30/30, Reading 40/12/48. */
        TOEIC_LR_PRE_2016(List.of(
                new ToeicPartSpec(1, SkillType.LISTENING, 10, 10, 1, 1, 4, true, false, false, null),
                new ToeicPartSpec(2, SkillType.LISTENING, 30, null, null, null, 3, false, false, false, null),
                new ToeicPartSpec(3, SkillType.LISTENING, 30, 10, 3, 3, 4, false, false, true, null),
                new ToeicPartSpec(4, SkillType.LISTENING, 30, 10, 3, 3, 4, false, false, true, null),
                new ToeicPartSpec(5, SkillType.READING, 40, null, null, null, 4, false, false, true, null),
                new ToeicPartSpec(6, SkillType.READING, 12, 4, 3, 3, 4, false, true, true, null),
                new ToeicPartSpec(7, SkillType.READING, 48, null, 2, 5, 4, false, true, true, 4)));

        private final List<ToeicPartSpec> parts;

        ToeicFormat(List<ToeicPartSpec> parts) {
            this.parts = parts;
        }

        public ToeicPartSpec part(int number) {
            return parts.stream().filter(p -> p.part() == number).findFirst().orElse(null);
        }

        public List<ToeicPartSpec> partsOf(SkillType skill) {
            return parts.stream().filter(p -> p.skill() == skill).toList();
        }
    }

    /**
     * Picks the TOEIC L&R format. An explicit {@code formatVersion} in the specification blueprint wins;
     * otherwise the legacy format is chosen only when the observed Part 1 and Part 5 counts match it exactly.
     * A wrong guess can only make validation stricter (counts fail ⇒ PRACTICE_ONLY), never more permissive
     * about broken content.
     */
    public static ToeicFormat toeicFormat(Map<String, Object> declaredBlueprint, Map<Integer, Integer> itemsByPart) {
        Object declared = declaredBlueprint == null ? null : declaredBlueprint.get("formatVersion");
        if (declared != null) {
            String d = norm(String.valueOf(declared));
            if (d.contains("PRE") || d.contains("LEGACY") || d.contains("2006")) return ToeicFormat.TOEIC_LR_PRE_2016;
            return ToeicFormat.TOEIC_LR_2016;
        }
        if (itemsByPart.getOrDefault(1, 0) == 10 && itemsByPart.getOrDefault(5, 0) == 40) {
            return ToeicFormat.TOEIC_LR_PRE_2016;
        }
        return ToeicFormat.TOEIC_LR_2016;
    }

    /** TOEIC Speaking / Writing task counts (public format). */
    public static final int TOEIC_SPEAKING_TASKS = 11;
    public static final int TOEIC_WRITING_TASKS = 8;

    // ─── IELTS ─────────────────────────────────────────────────────────────────────────────

    public static final int IELTS_LISTENING_PARTS = 4;
    public static final int IELTS_LISTENING_ITEMS = 40;
    public static final int IELTS_READING_ITEMS = 40;
    public static final int IELTS_ACADEMIC_READING_PASSAGES = 3;
    public static final int IELTS_WRITING_TASKS = 2;

    /** Visual stimulus kinds that can carry an IELTS Academic Writing Task 1 graphic. */
    public static final Set<String> VISUAL_KINDS = Set.of("IMAGE", "CHART", "MAP", "TABLE", "DIAGRAM", "GRAPH", "PROCESS", "PHOTO");
    /** Stimulus kinds that carry a reading passage. */
    public static final Set<String> PASSAGE_KINDS = Set.of("TEXT", "MULTI_DOC", "PASSAGE");

    /** Inclusive typical durations in seconds (WARNING only — never affects eligibility). */
    public static int[] typicalDurationSeconds(ExamFamily family, SkillType skill) {
        if (family == ExamFamily.TOEIC) {
            return switch (skill) {
                case LISTENING -> new int[]{2400, 3000};
                case READING -> new int[]{4500, 4500};
                default -> null;
            };
        }
        if (family == ExamFamily.IELTS) {
            return switch (skill) {
                case LISTENING -> new int[]{1800, 2400};
                case READING, WRITING -> new int[]{3600, 3600};
                case SPEAKING -> new int[]{660, 900};
            };
        }
        return null;
    }

    public static String blueprintId(ExamFamily family, String variant, String scope, ToeicFormat toeicFormat) {
        if (family == ExamFamily.TOEIC && toeicFormat != null) return toeicFormat.name();
        return (family == null ? "UNKNOWN" : family.name()) + "_" + norm(variant) + "_" + norm(scope);
    }

    static String norm(String value) {
        return value == null ? "" : value.trim().toUpperCase(Locale.ROOT).replace('-', '_').replace(' ', '_');
    }
}
