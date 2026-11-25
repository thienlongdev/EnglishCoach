package com.englishcoach.exams.practice;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;

import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Exams Phase 6 — the canonical practice scope kinds. A scope is always ONE canonical part of a form (a TOEIC part,
 * an IELTS listening section, reading passage, writing task or Speaking Part), resolved by the server from the
 * stored part code; the client only ever names a {@code scopeCode} such as {@code TOEIC_PART_5}.
 */
public enum ExamPracticeScopeType {
    TOEIC_PART,
    IELTS_LISTENING_SECTION,
    IELTS_READING_PASSAGE,
    IELTS_WRITING_TASK,
    IELTS_SPEAKING_PART;

    /** Trailing printed part number of a stored part code (LISTENING_PART_3, READING_PASSAGE_2, WRITING_TASK_1, PART_5). */
    private static final Pattern PART_NUMBER = Pattern.compile("(\\d+)\\D*$");

    public record Resolved(ExamPracticeScopeType type, int number, String scopeCode) {}

    /** Maps a stored (family, section skill, part code) onto a scope; empty when the part is not a practice scope. */
    public static Optional<Resolved> resolve(ExamFamily family, SkillType skill, String partCode) {
        int n = partNumber(partCode);
        if (family == null || skill == null || n < 1) return Optional.empty();
        if (family == ExamFamily.TOEIC) {
            boolean listening = skill == SkillType.LISTENING && n <= 4;
            boolean reading = skill == SkillType.READING && n >= 5 && n <= 7;
            return listening || reading ? Optional.of(new Resolved(TOEIC_PART, n, "TOEIC_PART_" + n)) : Optional.empty();
        }
        return switch (skill) {
            case LISTENING -> n <= 4 ? Optional.of(new Resolved(IELTS_LISTENING_SECTION, n, "IELTS_LISTENING_SECTION_" + n))
                    : Optional.empty();
            case READING -> n <= 5 ? Optional.of(new Resolved(IELTS_READING_PASSAGE, n, "IELTS_READING_PASSAGE_" + n))
                    : Optional.empty();
            case WRITING -> n <= 2 ? Optional.of(new Resolved(IELTS_WRITING_TASK, n, "IELTS_WRITING_TASK_" + n))
                    : Optional.empty();
            case SPEAKING -> n <= 3 ? Optional.of(new Resolved(IELTS_SPEAKING_PART, n, "IELTS_SPEAKING_PART_" + n))
                    : Optional.empty();
        };
    }

    public boolean objective() {
        return this != IELTS_WRITING_TASK && this != IELTS_SPEAKING_PART;
    }

    static int partNumber(String partCode) {
        if (partCode == null) return -1;
        Matcher m = PART_NUMBER.matcher(partCode.trim());
        return m.find() ? Integer.parseInt(m.group(1)) : -1;
    }
}
