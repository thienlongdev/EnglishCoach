package com.englishcoach.vocabulary.dto;

import com.englishcoach.vocabulary.entity.VocabularyCourse;

public record VocabularyCourseDto(
        Long id,
        String title,
        String description,
        String cefrLevel
) {
    public static VocabularyCourseDto fromEntity(VocabularyCourse course) {
        return new VocabularyCourseDto(
                course.getId(),
                course.getTitle(),
                course.getDescription(),
                course.getCefrLevel()
        );
    }
}
