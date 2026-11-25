package com.englishcoach.writing.translation.service;

import com.englishcoach.writing.translation.dto.TranslationFeedbackDto;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.text.Normalizer;
import java.util.*;

@Slf4j
@Component
public class TranslationDeterministicGrader {

    private final ObjectMapper objectMapper = new ObjectMapper();

    public Optional<TranslationFeedbackDto> evaluateExact(
            String submittedText,
            String referenceEn,
            String acceptedVariantsJson
    ) {
        if (submittedText == null || referenceEn == null) {
            return Optional.empty();
        }

        List<String> submittedTokens = tokenizeWords(submittedText);
        List<String> referenceTokens = tokenizeWords(referenceEn);

        if (submittedTokens.isEmpty() || referenceTokens.isEmpty()) {
            return Optional.empty();
        }

        boolean isExactMatch = submittedTokens.equals(referenceTokens);

        if (!isExactMatch && acceptedVariantsJson != null && !acceptedVariantsJson.isBlank() && !acceptedVariantsJson.equals("[]")) {
            try {
                List<String> variants = objectMapper.readValue(acceptedVariantsJson, new TypeReference<List<String>>() {});
                for (String v : variants) {
                    List<String> variantTokens = tokenizeWords(v);
                    if (!variantTokens.isEmpty() && submittedTokens.equals(variantTokens)) {
                        isExactMatch = true;
                        break;
                    }
                }
            } catch (Exception ex) {
                log.warn("Failed to parse acceptedVariantsJson: {}", ex.getMessage());
            }
        }

        if (isExactMatch) {
            return Optional.of(TranslationFeedbackDto.builder()
                    .meaningVerdict("ACCURATE")
                    .grammarVerdict("ACCURATE")
                    .naturalnessVerdict("NATURAL")
                    .overallStatus("ACCEPTED")
                    .headlineSummary("Bản dịch hoàn toàn chính xác và chuẩn xác!")
                    .naturalSuggestion(referenceEn)
                    .issues(Collections.emptyList())
                    .build());
        }

        return Optional.empty();
    }

    /**
     * Canonical word tokenization:
     * 1. Unicode NFKC normalization
     * 2. Lowercase (Locale.ROOT)
     * 3. Normalize smart quotes and apostrophes (‘, ’, `, ‚ -> ', “, ”, „ -> ")
     * 4. Remove punctuation while preserving alphanumeric tokens and internal contractions/possessives
     * 5. Collapse repeated whitespace and split into ordered token sequence
     */
    public static List<String> tokenizeWords(String text) {
        if (text == null || text.isBlank()) {
            return Collections.emptyList();
        }

        // 1. Unicode NFKC
        String normalized = Normalizer.normalize(text, Normalizer.Form.NFKC);

        // 2. Lowercase
        normalized = normalized.toLowerCase(Locale.ROOT);

        // 3. Smart quotes and apostrophes
        normalized = normalized.replace('‘', '\'')
                               .replace('’', '\'')
                               .replace('‚', '\'')
                               .replace('`', '\'')
                               .replace('“', '"')
                               .replace('”', '"')
                               .replace('„', '"');

        // 4. Strip punctuation, preserving word-internal apostrophes (e.g. people's, don't)
        StringBuilder sb = new StringBuilder(normalized.length());
        for (int i = 0; i < normalized.length(); i++) {
            char c = normalized.charAt(i);
            if (Character.isLetterOrDigit(c)) {
                sb.append(c);
            } else if (c == '\'') {
                boolean beforeIsAlpha = (i > 0 && Character.isLetterOrDigit(normalized.charAt(i - 1)));
                boolean afterIsAlpha = (i < normalized.length() - 1 && Character.isLetterOrDigit(normalized.charAt(i + 1)));
                if (beforeIsAlpha && afterIsAlpha) {
                    sb.append('\'');
                } else {
                    sb.append(' ');
                }
            } else {
                sb.append(' ');
            }
        }

        // 5. Split into word sequence
        String cleaned = sb.toString().trim();
        if (cleaned.isEmpty()) {
            return Collections.emptyList();
        }

        String[] parts = cleaned.split("\\s+");
        return Arrays.asList(parts);
    }

    /**
     * Produces a canonical single-spaced token string for consistent cache key generation.
     */
    public static String canonicalTokenString(String text) {
        List<String> tokens = tokenizeWords(text);
        if (tokens.isEmpty()) {
            return "";
        }
        return String.join(" ", tokens);
    }

    /**
     * Backward-compatible alias for existing callers.
     */
    public static String normalizeMatching(String text) {
        return canonicalTokenString(text);
    }
}
