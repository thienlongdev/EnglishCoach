package com.englishcoach.exams.validation;

import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.UUID;

/**
 * One structured validation finding. Identifiers and counts only: never question, passage or option text,
 * so reports and logs never copy protected exam content.
 *
 * @param occurrences how many items/groups produced the same finding in the same section/part (aggregated)
 * @param sampleItemId first affected item (admin drill-down), null for section/part/group findings
 * @param detail      short machine-readable detail such as {@code expected=3 actual=39}
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ExamValidationDiagnostic(
        ExamValidationCode code,
        ExamValidationSeverity severity,
        UUID sectionId,
        SkillType skill,
        String partCode,
        Integer partNumber,
        UUID groupId,
        UUID sampleItemId,
        int occurrences,
        String detail
) {

    /** e.g. TOEIC_GROUP_SIZE on Part 3 → {@code TOEIC_PART_3_GROUP_SIZE}; other codes unchanged. */
    @JsonProperty("qualifiedCode")
    public String qualifiedCode() {
        String name = code.name();
        if (partNumber == null || partNumber < 1 || !name.startsWith("TOEIC_")) return name;
        String suffix = name.substring("TOEIC_".length());
        if (suffix.startsWith("PART_")) suffix = suffix.substring("PART_".length());
        return "TOEIC_PART_" + partNumber + "_" + suffix;
    }
}
