package com.englishcoach.speaking.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class SpeakingPronunciationMetricsDto {
    private Double averagePronunciationScore; // V2.2 overall score average
    private Double averageContentMatchScore;  // Whisper accuracyScore average
    private Double averagePhonemeScore;       // V2.2 segmentalScore average
    private Double averageStressScore;        // V2.2 lexical stress average
    private Double averagePitchScore;         // V2.2 intonationScore average
    private Double averageRhythmScore;        // V2.2 rhythmScore average
    private Double averageFluencyScore;       // V2.2 fluencyScore average
    private Long scoredAttemptsCount;         // Number of attempts with real V2.2 scores
    private Long totalAttemptsCount;          // Total attempts in 30d window
    private Long abstainedAttemptsCount;      // Attempts where V2.2 explicitly abstained
    private Long sttOnlyAttemptsCount;        // Attempts with STT/dialogue only (no V2.2 acoustic score)
    private Long lexicalStressMatchedWords;   // Numerator of V2.2 ASSESSED lexical stress words
    private Long lexicalStressAssessedWords;  // Denominator of V2.2 ASSESSED lexical stress words
    private Long lexicalStressAssessmentsCount; // Number of attempts with ASSESSED lexical stress
    private Long contentMatchAttemptsCount;   // Attempts with Whisper content match score
    private Long shadowingScoredCount;
    private Long quickCheckScoredCount;
    private Long roleplayScoredCount;

    public SpeakingPronunciationMetricsDto(
            Double averagePronunciationScore,
            Double averageContentMatchScore,
            Double averagePhonemeScore,
            Double averageStressScore,
            Double averagePitchScore,
            Double averageRhythmScore,
            Double averageFluencyScore,
            Long scoredAttemptsCount,
            Long totalAttemptsCount
    ) {
        this(
                averagePronunciationScore,
                averageContentMatchScore,
                averagePhonemeScore,
                averageStressScore,
                averagePitchScore,
                averageRhythmScore,
                averageFluencyScore,
                scoredAttemptsCount,
                totalAttemptsCount,
                0L,
                0L,
                0L,
                0L,
                0L,
                0L,
                0L,
                0L,
                0L
        );
    }
}
