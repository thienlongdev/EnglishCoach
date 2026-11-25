package com.englishcoach.flashcard.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class VocabDeckSummaryResponse {
    private Long id;
    private String slug;
    private String title;
    private String description;
    private String category;
    private String themeColor;
    private String icon;
    private int totalWords;
    private boolean isSystem;
    private int sortOrder;

    // User-specific progress
    private long masteredCount;
    private long reviewedCount;
    private long learningCount;
    private long dueCount;
    private int progressPercentage;
    private boolean isEnrolled;
}
