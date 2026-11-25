package com.englishcoach.writing.service;

import com.englishcoach.writing.dto.DraftDiffChunkDto;

import java.util.ArrayList;
import java.util.List;

public final class WritingDiffUtil {

    private WritingDiffUtil() {}

    public static List<DraftDiffChunkDto> computeDiff(String text1, String text2) {
        if (text1 == null) text1 = "";
        if (text2 == null) text2 = "";

        if (text1.equals(text2)) {
            return List.of(DraftDiffChunkDto.builder().type("EQUAL").text(text1).build());
        }

        String[] tokens1 = tokenize(text1);
        String[] tokens2 = tokenize(text2);

        int n = tokens1.length;
        int m = tokens2.length;

        // Longest Common Subsequence DP table
        // For very large texts, protect against excessive memory
        if ((long) n * m > 10_000_000L) {
            // Line-by-line fallback
            return lineDiff(text1, text2);
        }

        int[][] dp = new int[n + 1][m + 1];
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < m; j++) {
                if (tokens1[i].equals(tokens2[j])) {
                    dp[i + 1][j + 1] = dp[i][j] + 1;
                } else {
                    dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
                }
            }
        }

        // Backtrack to build chunks
        List<DraftDiffChunkDto> rawChunks = new ArrayList<>();
        int i = n, j = m;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && tokens1[i - 1].equals(tokens2[j - 1])) {
                rawChunks.add(0, DraftDiffChunkDto.builder().type("EQUAL").text(tokens1[i - 1]).build());
                i--;
                j--;
            } else if (j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                rawChunks.add(0, DraftDiffChunkDto.builder().type("INSERT").text(tokens2[j - 1]).build());
                j--;
            } else if (i > 0 && (j == 0 || dp[i][j - 1] < dp[i - 1][j])) {
                rawChunks.add(0, DraftDiffChunkDto.builder().type("DELETE").text(tokens1[i - 1]).build());
                i--;
            }
        }

        // Merge adjacent chunks of same type
        List<DraftDiffChunkDto> merged = new ArrayList<>();
        for (DraftDiffChunkDto chunk : rawChunks) {
            if (merged.isEmpty()) {
                merged.add(new DraftDiffChunkDto(chunk.getType(), chunk.getText()));
            } else {
                DraftDiffChunkDto last = merged.get(merged.size() - 1);
                if (last.getType().equals(chunk.getType())) {
                    last.setText(last.getText() + chunk.getText());
                } else {
                    merged.add(new DraftDiffChunkDto(chunk.getType(), chunk.getText()));
                }
            }
        }

        return merged;
    }

    private static String[] tokenize(String text) {
        if (text.isEmpty()) return new String[0];
        // Split on whitespace boundaries while preserving delimiters
        return text.split("(?<=\\s)|(?=\\s)");
    }

    private static List<DraftDiffChunkDto> lineDiff(String text1, String text2) {
        List<DraftDiffChunkDto> chunks = new ArrayList<>();
        chunks.add(DraftDiffChunkDto.builder().type("DELETE").text(text1).build());
        chunks.add(DraftDiffChunkDto.builder().type("INSERT").text(text2).build());
        return chunks;
    }
}
