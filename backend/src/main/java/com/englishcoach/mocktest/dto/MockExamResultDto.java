package com.englishcoach.mocktest.dto;

import com.englishcoach.mocktest.entity.ExamResult;

import java.time.LocalDateTime;

public record MockExamResultDto(
        Long id,
        MockExamDto exam,
        int score,
        String feedback,
        LocalDateTime completedAt
) {
    public static MockExamResultDto fromEntity(ExamResult result) {
        return new MockExamResultDto(
                result.getId(),
                MockExamDto.fromEntity(result.getExam()),
                result.getScore(),
                result.getFeedback(),
                result.getCompletedAt()
        );
    }
}
