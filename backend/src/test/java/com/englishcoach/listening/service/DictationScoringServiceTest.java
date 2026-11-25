package com.englishcoach.listening.service;

import com.englishcoach.listening.entity.enums.ErrorCategory;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class DictationScoringServiceTest {

    private DictationScoringService scoringService;

    @BeforeEach
    void setUp() {
        scoringService = new DictationScoringService();
    }

    @Test
    @DisplayName("Should award 100% and EXACT_MATCH when punctuation matches or differs harmlessly")
    void testScoreDictation_ExactMatchWithPunctuation() {
        DictationScoringService.ScoringResult result = scoringService.scoreDictation(
                "This morning a machine screamed at you",
                "This morning, a machine screamed at you."
        );

        assertThat(result.isCorrect).isTrue();
        assertThat(result.accuracyPercentage).isEqualTo(100.0);
        assertThat(result.primaryErrorCategory).isEqualTo(ErrorCategory.EXACT_MATCH);
    }

    @Test
    @DisplayName("Should prevent 100% score when a word is missing")
    void testScoreDictation_MissingWordCannotBe100() {
        DictationScoringService.ScoringResult result = scoringService.scoreDictation(
                "This morning a machine at you",
                "This morning, a machine screamed at you."
        );

        assertThat(result.isCorrect).isFalse();
        assertThat(result.accuracyPercentage).isLessThan(100.0);
        assertThat(result.primaryErrorCategory).isEqualTo(ErrorCategory.MISSING_WORD);
    }

    @Test
    @DisplayName("Should prevent 100% score when a word is wrong")
    void testScoreDictation_WrongWordCannotBe100() {
        DictationScoringService.ScoringResult result = scoringService.scoreDictation(
                "This morning a car screamed at you",
                "This morning, a machine screamed at you."
        );

        assertThat(result.isCorrect).isFalse();
        assertThat(result.accuracyPercentage).isLessThan(100.0);
        assertThat(result.primaryErrorCategory).isEqualTo(ErrorCategory.WRONG_WORD);
    }

    @Test
    @DisplayName("Deterministic WER alignment should pinpoint exact missed word")
    void testScoreDictation_ExactWordAlignmentMissingWord() {
        DictationScoringService.ScoringResult result = scoringService.scoreDictation(
                "I really know",
                "I don't really know"
        );

        assertThat(result.isCorrect).isFalse();
        assertThat(result.primaryErrorCategory).isEqualTo(ErrorCategory.MISSING_WORD);
        assertThat(result.deletionCount).isEqualTo(1);
        assertThat(result.alignedWords).hasSize(4);

        // Word 0: I -> MATCH
        assertThat(result.alignedWords.get(0).op).isEqualTo(DictationScoringService.AlignmentOp.MATCH);
        assertThat(result.alignedWords.get(0).referenceWord).isEqualTo("i");

        // Word 1: don't -> DELETION (MISSING_WORD)
        assertThat(result.alignedWords.get(1).op).isEqualTo(DictationScoringService.AlignmentOp.DELETION);
        assertThat(result.alignedWords.get(1).referenceWord).isEqualTo("don't");
        assertThat(result.alignedWords.get(1).errorCategory).isEqualTo(ErrorCategory.MISSING_WORD);

        // Word 2: really -> MATCH
        assertThat(result.alignedWords.get(2).op).isEqualTo(DictationScoringService.AlignmentOp.MATCH);
        assertThat(result.alignedWords.get(2).referenceWord).isEqualTo("really");

        // Word 3: know -> MATCH
        assertThat(result.alignedWords.get(3).op).isEqualTo(DictationScoringService.AlignmentOp.MATCH);
        assertThat(result.alignedWords.get(3).referenceWord).isEqualTo("know");

        // Accuracy: 3/4 correct = 75.0%
        assertThat(result.accuracyPercentage).isEqualTo(75.0);
    }

    @Test
    @DisplayName("Should detect MINOR_SPELLING substitution for close typos")
    void testScoreDictation_MinorSpelling() {
        DictationScoringService.ScoringResult result = scoringService.scoreDictation(
                "I recieve the letter",
                "I receive the letter"
        );

        assertThat(result.isCorrect).isFalse();
        assertThat(result.primaryErrorCategory).isEqualTo(ErrorCategory.MINOR_SPELLING);
        assertThat(result.minorSpellingCount).isEqualTo(1);
        // 4 words, 0.5 error penalty -> (1 - 0.5/4) * 100 = 87.5%
        assertThat(result.accuracyPercentage).isEqualTo(87.5);
    }

    @Test
    @DisplayName("Should detect EXTRA_WORD insertion")
    void testScoreDictation_ExtraWord() {
        DictationScoringService.ScoringResult result = scoringService.scoreDictation(
                "I really really know",
                "I really know"
        );

        assertThat(result.isCorrect).isFalse();
        assertThat(result.primaryErrorCategory).isEqualTo(ErrorCategory.EXTRA_WORD);
        assertThat(result.insertionCount).isEqualTo(1);
    }
}
