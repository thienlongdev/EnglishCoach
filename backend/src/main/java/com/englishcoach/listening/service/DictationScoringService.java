package com.englishcoach.listening.service;

import com.englishcoach.listening.entity.enums.ErrorCategory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

@Service
public class DictationScoringService {

    public enum AlignmentOp {
        MATCH,
        SUBSTITUTION,
        DELETION,
        INSERTION
    }

    public static class AlignedWord {
        public String referenceWord;
        public String userWord;
        public AlignmentOp op;
        public ErrorCategory errorCategory;

        public AlignedWord(String referenceWord, String userWord, AlignmentOp op, ErrorCategory errorCategory) {
            this.referenceWord = referenceWord;
            this.userWord = userWord;
            this.op = op;
            this.errorCategory = errorCategory;
        }

        @Override
        public String toString() {
            return String.format("%s [ref=%s, user=%s, cat=%s]", op, referenceWord, userWord, errorCategory);
        }
    }

    public ScoringResult scoreDictation(String rawUserAnswer, String expectedAnswer) {
        List<String> userWords = tokenize(rawUserAnswer);
        List<String> expectedWords = tokenize(expectedAnswer);

        // Edge case 1: both empty
        if (expectedWords.isEmpty() && userWords.isEmpty()) {
            return new ScoringResult(100.0, ErrorCategory.EXACT_MATCH, true, Collections.emptyList());
        }

        // Edge case 2: user typed nothing but reference expected words
        if (userWords.isEmpty()) {
            List<AlignedWord> aligned = expectedWords.stream()
                    .map(w -> new AlignedWord(w, null, AlignmentOp.DELETION, ErrorCategory.MISSING_WORD))
                    .toList();
            return new ScoringResult(0.0, ErrorCategory.MISSING_WORD, false, aligned);
        }

        // Edge case 3: reference is empty but user typed words
        if (expectedWords.isEmpty()) {
            List<AlignedWord> aligned = userWords.stream()
                    .map(w -> new AlignedWord(null, w, AlignmentOp.INSERTION, ErrorCategory.EXTRA_WORD))
                    .toList();
            return new ScoringResult(0.0, ErrorCategory.EXTRA_WORD, false, aligned);
        }

        // Edge case 4: exact token match
        if (userWords.equals(expectedWords)) {
            List<AlignedWord> aligned = expectedWords.stream()
                    .map(w -> new AlignedWord(w, w, AlignmentOp.MATCH, ErrorCategory.EXACT_MATCH))
                    .toList();
            return new ScoringResult(100.0, ErrorCategory.EXACT_MATCH, true, aligned);
        }

        // Deterministic WER sequence alignment via Dynamic Programming
        List<AlignedWord> alignedWords = alignWords(expectedWords, userWords);

        int matchCount = 0;
        int missingCount = 0;
        int extraCount = 0;
        int minorSpellingCount = 0;
        int wrongWordCount = 0;

        for (AlignedWord aw : alignedWords) {
            switch (aw.errorCategory) {
                case EXACT_MATCH -> matchCount++;
                case MISSING_WORD -> missingCount++;
                case EXTRA_WORD -> extraCount++;
                case MINOR_SPELLING -> minorSpellingCount++;
                case WRONG_WORD -> wrongWordCount++;
                default -> {}
            }
        }

        int totalErrors = missingCount + extraCount + minorSpellingCount + wrongWordCount;
        if (totalErrors == 0) {
            return new ScoringResult(100.0, ErrorCategory.EXACT_MATCH, true, alignedWords);
        }

        // Determine primary error category by highest frequency among error categories
        ErrorCategory primaryCategory = pickPrimaryErrorCategory(missingCount, extraCount, minorSpellingCount, wrongWordCount);

        // Calculate bounded WER-based accuracy score relative to reference word count
        int refCount = expectedWords.size();
        double errorScore = (wrongWordCount * 1.0) + (missingCount * 1.0) + (extraCount * 1.0) + (minorSpellingCount * 0.5);
        double rawAccuracy = (1.0 - (errorScore / (double) Math.max(1, refCount))) * 100.0;
        double roundedAccuracy = Math.round(rawAccuracy * 10.0) / 10.0;
        double boundedAccuracy = Math.max(0.0, Math.min(99.0, roundedAccuracy));

        ScoringResult result = new ScoringResult(boundedAccuracy, primaryCategory, false, alignedWords);
        result.matchCount = matchCount;
        result.deletionCount = missingCount;
        result.insertionCount = extraCount;
        result.minorSpellingCount = minorSpellingCount;
        result.wrongWordCount = wrongWordCount;
        result.substitutionCount = minorSpellingCount + wrongWordCount;
        return result;
    }

    private List<String> tokenize(String input) {
        if (input == null) return Collections.emptyList();
        String normalized = input.toLowerCase()
                .replace('’', '\'')
                .replace('‘', '\'')
                .replaceAll("[^a-z0-9\\s']", " ")
                .replace("gonna", "going to")
                .replace("wanna", "want to")
                .replace("could've", "could have")
                .replace("should've", "should have")
                .replace("would've", "would have")
                .replaceAll("\\s+", " ")
                .trim();

        if (normalized.isEmpty()) return Collections.emptyList();

        return Arrays.stream(normalized.split("\\s+"))
                .map(w -> w.replaceAll("^'+|'+$", "")) // strip dangling apostrophes
                .filter(w -> !w.isBlank())
                .toList();
    }

    private List<AlignedWord> alignWords(List<String> refWords, List<String> userWords) {
        int n = refWords.size();
        int m = userWords.size();
        double[][] dp = new double[n + 1][m + 1];

        dp[0][0] = 0.0;
        for (int i = 1; i <= n; i++) {
            dp[i][0] = dp[i - 1][0] + 1.0; // deletion
        }
        for (int j = 1; j <= m; j++) {
            dp[0][j] = dp[0][j - 1] + 1.0; // insertion
        }

        for (int i = 1; i <= n; i++) {
            String rW = refWords.get(i - 1);
            for (int j = 1; j <= m; j++) {
                String uW = userWords.get(j - 1);
                if (rW.equals(uW)) {
                    dp[i][j] = dp[i - 1][j - 1]; // MATCH (cost 0)
                } else {
                    double subCost = getSubstitutionCost(rW, uW);
                    double sub = dp[i - 1][j - 1] + subCost;
                    double del = dp[i - 1][j] + 1.0;
                    double ins = dp[i][j - 1] + 1.0;
                    dp[i][j] = Math.min(sub, Math.min(del, ins));
                }
            }
        }

        // Backtrack to find optimal alignment
        List<AlignedWord> aligned = new ArrayList<>();
        int i = n;
        int j = m;

        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && refWords.get(i - 1).equals(userWords.get(j - 1))
                    && Math.abs(dp[i][j] - dp[i - 1][j - 1]) < 1e-6) {
                aligned.add(new AlignedWord(refWords.get(i - 1), userWords.get(j - 1), AlignmentOp.MATCH, ErrorCategory.EXACT_MATCH));
                i--;
                j--;
            } else {
                double current = dp[i][j];
                boolean stepped = false;

                // Priority 1: Substitution
                if (i > 0 && j > 0) {
                    double subCost = getSubstitutionCost(refWords.get(i - 1), userWords.get(j - 1));
                    if (Math.abs(current - (dp[i - 1][j - 1] + subCost)) < 1e-6) {
                        String rW = refWords.get(i - 1);
                        String uW = userWords.get(j - 1);
                        ErrorCategory cat = classifySubstitution(rW, uW);
                        aligned.add(new AlignedWord(rW, uW, AlignmentOp.SUBSTITUTION, cat));
                        i--;
                        j--;
                        stepped = true;
                    }
                }

                // Priority 2: Deletion (word in reference was omitted)
                if (!stepped && i > 0 && Math.abs(current - (dp[i - 1][j] + 1.0)) < 1e-6) {
                    aligned.add(new AlignedWord(refWords.get(i - 1), null, AlignmentOp.DELETION, ErrorCategory.MISSING_WORD));
                    i--;
                    stepped = true;
                }

                // Priority 3: Insertion (extra word typed by user)
                if (!stepped && j > 0 && Math.abs(current - (dp[i][j - 1] + 1.0)) < 1e-6) {
                    aligned.add(new AlignedWord(null, userWords.get(j - 1), AlignmentOp.INSERTION, ErrorCategory.EXTRA_WORD));
                    j--;
                    stepped = true;
                }

                // Safety fallback if float imprecision
                if (!stepped) {
                    if (i > 0 && j > 0) {
                        String rW = refWords.get(i - 1);
                        String uW = userWords.get(j - 1);
                        aligned.add(new AlignedWord(rW, uW, AlignmentOp.SUBSTITUTION, classifySubstitution(rW, uW)));
                        i--;
                        j--;
                    } else if (i > 0) {
                        aligned.add(new AlignedWord(refWords.get(i - 1), null, AlignmentOp.DELETION, ErrorCategory.MISSING_WORD));
                        i--;
                    } else {
                        aligned.add(new AlignedWord(null, userWords.get(j - 1), AlignmentOp.INSERTION, ErrorCategory.EXTRA_WORD));
                        j--;
                    }
                }
            }
        }

        Collections.reverse(aligned);
        return aligned;
    }

    private double getSubstitutionCost(String rW, String uW) {
        if (rW.equals(uW)) return 0.0;
        int dist = calculateLevenshteinDistance(rW, uW);
        int maxLen = Math.max(rW.length(), uW.length());
        if (dist <= 2 && ((double) dist / (double) Math.max(1, maxLen)) <= 0.35) {
            return 0.99; // slight discount for spelling typo over delete+insert
        }
        return 1.0;
    }

    private ErrorCategory classifySubstitution(String rW, String uW) {
        int dist = calculateLevenshteinDistance(rW, uW);
        int maxLen = Math.max(rW.length(), uW.length());
        if (dist <= 2 && ((double) dist / (double) Math.max(1, maxLen)) <= 0.35) {
            return ErrorCategory.MINOR_SPELLING;
        }
        return ErrorCategory.WRONG_WORD;
    }

    private ErrorCategory pickPrimaryErrorCategory(int missing, int extra, int minorSpelling, int wrongWord) {
        int max = Math.max(Math.max(wrongWord, missing), Math.max(extra, minorSpelling));
        if (wrongWord == max && wrongWord > 0) return ErrorCategory.WRONG_WORD;
        if (missing == max && missing > 0) return ErrorCategory.MISSING_WORD;
        if (extra == max && extra > 0) return ErrorCategory.EXTRA_WORD;
        if (minorSpelling == max && minorSpelling > 0) return ErrorCategory.MINOR_SPELLING;
        return ErrorCategory.WRONG_WORD;
    }

    private int calculateLevenshteinDistance(String a, String b) {
        int[][] dp = new int[a.length() + 1][b.length() + 1];
        for (int i = 0; i <= a.length(); i++) dp[i][0] = i;
        for (int j = 0; j <= b.length(); j++) dp[0][j] = j;

        for (int i = 1; i <= a.length(); i++) {
            for (int j = 1; j <= b.length(); j++) {
                if (a.charAt(i - 1) == b.charAt(j - 1)) {
                    dp[i][j] = dp[i - 1][j - 1];
                } else {
                    dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], Math.min(dp[i - 1][j], dp[i][j - 1]));
                }
            }
        }
        return dp[a.length()][b.length()];
    }

    public static class ScoringResult {
        public double accuracyPercentage;
        public ErrorCategory primaryErrorCategory;
        public boolean isCorrect;
        public List<AlignedWord> alignedWords = new ArrayList<>();
        public int matchCount;
        public int substitutionCount;
        public int deletionCount;
        public int insertionCount;
        public int minorSpellingCount;
        public int wrongWordCount;

        public ScoringResult(double accuracyPercentage, ErrorCategory primaryErrorCategory, boolean isCorrect) {
            this.accuracyPercentage = accuracyPercentage;
            this.primaryErrorCategory = primaryErrorCategory;
            this.isCorrect = isCorrect;
        }

        public ScoringResult(double accuracyPercentage, ErrorCategory primaryErrorCategory, boolean isCorrect, List<AlignedWord> alignedWords) {
            this.accuracyPercentage = accuracyPercentage;
            this.primaryErrorCategory = primaryErrorCategory;
            this.isCorrect = isCorrect;
            this.alignedWords = alignedWords;
        }
    }
}
