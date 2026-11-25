package com.englishcoach.writing.dto;

import com.englishcoach.writing.enums.PracticeMode;
import lombok.*;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PracticeEpisodeDto {
    private String id;
    private PracticeMode mode;
    private String exerciseId;
    private String title;
    private String prompt;
    private String originalContext;
    private String targetPatternCode;

    @Builder.Default
    private List<String> constraints = new ArrayList<>();

    private Integer currentAttemptOrdinal;
    private Integer maxAttempts;

    @Builder.Default
    private List<String> revealedHints = new ArrayList<>();

    private Boolean isCompleted;
    private Boolean isSuccess;
    private Boolean modelAnswerRevealed;
    private Instant createdAt;
}
