package com.englishcoach.listening.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import java.util.List;
import java.util.Map;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ErrorDNADto {
    private Double overallAccuracy;
    private Integer totalAttempts;
    private Map<String, Double> errorBreakdownPercentage;

    // Detailed Actionable Diagnostic DNA
    private List<WordErrorItemDto> topMissingWords;
    private List<WordErrorItemDto> topExtraWords;
    private List<WordSubstitutionItemDto> topSubstitutions;
    private List<WordSubstitutionItemDto> topSpellingErrors;
    private List<RepresentativeErrorDto> representativeErrors;
    private List<String> practicePriorities;

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class WordErrorItemDto {
        private String word;
        private int count;
    }

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class WordSubstitutionItemDto {
        private String expectedWord;
        private String userWord;
        private int count;
    }

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class RepresentativeErrorDto {
        private Long exerciseId;
        private String expectedSentence;
        private String rawUserAnswer;
        private List<AlignedDiffDto> alignedDiffs;
    }

    @Data
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class AlignedDiffDto {
        private String expectedWord;
        private String userWord;
        private String type; // MISSING, EXTRA, SUBSTITUTION, SPELLING, MATCH
        private String label; // BỎ SÓT, VIẾT THỪA, NGHE NHẦM, LỖI CHÍNH TẢ
    }
}
