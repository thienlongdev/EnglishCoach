package com.englishcoach.writing.translation.paragraph.service;

import com.englishcoach.writing.translation.paragraph.dto.ParagraphFeedbackDto;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collections;

@Service
public class ParagraphDeterministicGrader {

    public static final String GRADER_VERSION = "paragraph-det-v1.0";
    public static final String PROMPT_VERSION = "paragraph-prompt-v1.0";

    public String normalize(String text) {
        if (text == null) {
            return "";
        }
        // Normalize whitespace, lowercase, remove trailing punctuation, collapse spaces
        return text.trim()
                .toLowerCase()
                .replaceAll("\\s+", " ")
                .replaceAll("[.,;:!?]+$", "");
    }

    public String sha256(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder hexString = new StringBuilder();
            for (byte b : hash) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) hexString.append('0');
                hexString.append(hex);
            }
            return hexString.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 algorithm not found", e);
        }
    }

    public boolean isExactOrVariantMatch(String submittedText, String referenceEn) {
        String normSubmitted = normalize(submittedText);
        String normReference = normalize(referenceEn);
        if (normSubmitted.isEmpty() || normReference.isEmpty()) {
            return false;
        }
        return normSubmitted.equals(normReference);
    }

    public ParagraphFeedbackDto buildExactMatchFeedback(String referenceEn) {
        return ParagraphFeedbackDto.builder()
                .accepted(true)
                .evaluationStatus("ACCEPTED")
                .overallSummary("Bản dịch xuất sắc! Khớp hoàn toàn với bản dịch chuẩn tham khảo.")
                .meaningVerdict("PASS")
                .meaningScore(100)
                .grammarVerdict("PASS")
                .grammarScore(100)
                .naturalnessVerdict("PASS")
                .naturalnessScore(100)
                .vocabularyVerdict("PASS")
                .vocabularyScore(100)
                .cohesionVerdict("PASS")
                .cohesionScore(100)
                .issues(Collections.emptyList())
                .suggestedCorrection(referenceEn)
                .naturalAlternative(referenceEn)
                .referenceEn(referenceEn)
                .modelId("deterministic/exact-match")
                .generationCount(0)
                .cached(false)
                .latencyMs(0L)
                .build();
    }
}
