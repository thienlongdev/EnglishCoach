package com.englishcoach.mocktest.dto;

import com.englishcoach.mocktest.entity.Exam;

public record MockExamDto(
        Long id,
        String title,
        int durationMinutes,
        String examDataJson
) {
    public static MockExamDto fromEntity(Exam exam) {
        if (exam == null) {
            return null;
        }
        return new MockExamDto(
                exam.getId(),
                exam.getTitle(),
                exam.getDurationMinutes(),
                exam.getExamDataJson()
        );
    }
}
