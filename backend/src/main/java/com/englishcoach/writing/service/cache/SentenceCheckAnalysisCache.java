package com.englishcoach.writing.service.cache;

import com.englishcoach.writing.dto.DimensionVerdictDto;
import com.englishcoach.writing.dto.FeedbackIssueDto;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Sentence Lab Canonical Analysis Cache.
 * 
 * Keyed by SHA-256(normalizedSentence + language + pipelineVersion + promptVersion + deterministicValidatorVersion + languageToolVersion + modelRouteVersion).
 * Contains ONLY canonical grammatical analysis (issues, verdicts, explanation, corrected sentence).
 * Reusable across learners because it contains NO user identity or UI state.
 * Supports both error and correct sentences with bounded TTL and maximum size.
 */
@Slf4j
@Component
public class SentenceCheckAnalysisCache {

    public static final String PIPELINE_VERSION = "sentence_lab_v5";
    public static final String PROMPT_VERSION = "prompt_v2";
    public static final String DETERMINISTIC_VALIDATOR_VERSION = "rules_v3";
    public static final String LANGUAGE_TOOL_VERSION = "lt_6.4";
    public static final String MODEL_ROUTE_VERSION = "gpt_5.6_luna_v1";
    public static final String LANGUAGE = "en";

    public static final String CURRENT_CACHE_VERSION = String.join(":",
            PIPELINE_VERSION, PROMPT_VERSION, DETERMINISTIC_VALIDATOR_VERSION, LANGUAGE_TOOL_VERSION, MODEL_ROUTE_VERSION);

    public static final long DEFAULT_TTL_MILLIS = 24 * 60 * 60 * 1000L; // 24 hours
    public static final int MAX_CACHE_ENTRIES = 2_000;

    public enum CacheStatus {
        CACHE_HIT,
        CACHE_MISS,
        CACHE_STALE_VERSION,
        CACHE_INVALID_SCHEMA
    }

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class CanonicalSentenceAnalysis {
        private String cacheKey;
        private String cacheVersion;
        private String normalizedSentence;
        private Boolean grammaticallyCorrect;
        private String analysisStatus;
        private String coverageSummary;
        private String explanation;
        private String suggestedImprovement;
        private String correctedSentence;
        private List<DimensionVerdictDto> dimensionVerdicts;
        private List<FeedbackIssueDto> issues;
        private String modelUsed;
        private String resultSource;
        private Integer primaryCalls;
        private Integer fallbackCalls;
        private Instant cachedAt;
        private long expiresAtMillis;
    }

    @Data
    @Builder
    public static class CacheLookupResult {
        private CacheStatus status;
        private String key;
        private String normalizedHash;
        private CanonicalSentenceAnalysis analysis;

        public static CacheLookupResult hit(String key, String hash, CanonicalSentenceAnalysis analysis) {
            return CacheLookupResult.builder()
                    .status(CacheStatus.CACHE_HIT)
                    .key(key)
                    .normalizedHash(hash)
                    .analysis(analysis)
                    .build();
        }

        public static CacheLookupResult miss(String key, String hash) {
            return CacheLookupResult.builder()
                    .status(CacheStatus.CACHE_MISS)
                    .key(key)
                    .normalizedHash(hash)
                    .build();
        }

        public static CacheLookupResult staleVersion(String key, String hash) {
            return CacheLookupResult.builder()
                    .status(CacheStatus.CACHE_STALE_VERSION)
                    .key(key)
                    .normalizedHash(hash)
                    .build();
        }

        public static CacheLookupResult invalidSchema(String key, String hash) {
            return CacheLookupResult.builder()
                    .status(CacheStatus.CACHE_INVALID_SCHEMA)
                    .key(key)
                    .normalizedHash(hash)
                    .build();
        }
    }

    private static class CacheEntry {
        final CanonicalSentenceAnalysis analysis;
        final long expiresAtMillis;
        final String version;

        CacheEntry(CanonicalSentenceAnalysis analysis, long expiresAtMillis, String version) {
            this.analysis = analysis;
            this.expiresAtMillis = expiresAtMillis;
            this.version = version;
        }

        boolean isExpired() {
            return System.currentTimeMillis() > expiresAtMillis;
        }
    }

    private final Map<String, CacheEntry> cacheStore = new ConcurrentHashMap<>(256);

    /**
     * Normalizes sentence safely:
     * - Unicode normalization (NFC)
     * - Normalize line endings (\r\n and \r -> \n)
     * - Normalize internal repeated whitespace (\s+ -> " ")
     * - Trim outer whitespace
     * NOTE: Does NOT lowercase, does NOT remove punctuation or articles, does NOT lemmatize words.
     */
    public static String normalizeSentence(String rawText) {
        if (rawText == null) return "";
        String normalized = Normalizer.normalize(rawText, Normalizer.Form.NFC);
        normalized = normalized.replaceAll("\r\n|\r", "\n");
        normalized = normalized.replaceAll("[ \\t\\x0B\\f]+", " ");
        return normalized.trim();
    }

    public static String normalizeRegister(String targetRegister) {
        if (targetRegister == null || targetRegister.isBlank()) {
            return "formal";
        }
        return targetRegister.trim().toLowerCase(Locale.ROOT);
    }

    /**
     * Computes the versioned cache key (default register {@code formal}):
     * SHA-256(normalizedSentence + targetRegister + language + pipelineVersion + promptVersion + deterministicValidatorVersion + languageToolVersion + modelRouteVersion)
     */
    public static String computeKey(String normalizedSentence) {
        return computeKey(normalizedSentence, "formal");
    }

    /**
     * Computes the register-scoped versioned cache key (EC-SEC-2026-029).
     */
    public static String computeKey(String normalizedSentence, String targetRegister) {
        String compositePayload = normalizedSentence
                + "|" + normalizeRegister(targetRegister)
                + "|" + LANGUAGE
                + "|" + PIPELINE_VERSION
                + "|" + PROMPT_VERSION
                + "|" + DETERMINISTIC_VALIDATOR_VERSION
                + "|" + LANGUAGE_TOOL_VERSION
                + "|" + MODEL_ROUTE_VERSION;
        return sha256Hex(compositePayload);
    }

    /**
     * Computes safe input hash for observability logging (without sensitive sentence text).
     */
    public static String computeInputHash(String normalizedSentence) {
        String fullHex = sha256Hex(normalizedSentence);
        return fullHex.length() >= 16 ? fullHex.substring(0, 16) : fullHex;
    }

    private static String sha256Hex(String input) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder hexString = new StringBuilder();
            for (byte b : hash) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) hexString.append('0');
                hexString.append(hex);
            }
            return hexString.toString();
        } catch (Exception e) {
            return Integer.toHexString(input.hashCode());
        }
    }

    public CacheLookupResult lookup(String rawText) {
        return lookup(rawText, "formal");
    }

    public CacheLookupResult lookup(String rawText, String targetRegister) {
        String normalized = normalizeSentence(rawText);
        if (normalized.isEmpty()) {
            return CacheLookupResult.miss("", "");
        }
        String key = computeKey(normalized, targetRegister);
        String inputHash = computeInputHash(normalized);

        CacheEntry entry = cacheStore.get(key);
        if (entry == null) {
            return CacheLookupResult.miss(key, inputHash);
        }

        if (entry.isExpired()) {
            cacheStore.remove(key);
            return CacheLookupResult.miss(key, inputHash);
        }

        if (!CURRENT_CACHE_VERSION.equals(entry.version)) {
            cacheStore.remove(key);
            return CacheLookupResult.staleVersion(key, inputHash);
        }

        CanonicalSentenceAnalysis analysis = entry.analysis;
        if (analysis == null || analysis.getIssues() == null) {
            cacheStore.remove(key);
            return CacheLookupResult.invalidSchema(key, inputHash);
        }

        return CacheLookupResult.hit(key, inputHash, analysis);
    }

    public void put(String rawText, CanonicalSentenceAnalysis analysis) {
        put(rawText, "formal", analysis);
    }

    public void put(String rawText, String targetRegister, CanonicalSentenceAnalysis analysis) {
        if (rawText == null || analysis == null) return;
        String normalized = normalizeSentence(rawText);
        if (normalized.isEmpty()) return;

        String key = computeKey(normalized, targetRegister);
        long now = System.currentTimeMillis();
        long expiresAt = now + DEFAULT_TTL_MILLIS;

        analysis.setCacheKey(key);
        analysis.setCacheVersion(CURRENT_CACHE_VERSION);
        analysis.setNormalizedSentence(normalized);
        analysis.setCachedAt(Instant.ofEpochMilli(now));
        analysis.setExpiresAtMillis(expiresAt);

        // Bounded capacity check
        if (cacheStore.size() >= MAX_CACHE_ENTRIES) {
            evictExpiredOrOldest();
        }

        cacheStore.put(key, new CacheEntry(analysis, expiresAt, CURRENT_CACHE_VERSION));
    }

    private synchronized void evictExpiredOrOldest() {
        cacheStore.entrySet().removeIf(e -> e.getValue().isExpired());
        if (cacheStore.size() >= MAX_CACHE_ENTRIES) {
            int toRemove = MAX_CACHE_ENTRIES / 10;
            Iterator<String> it = cacheStore.keySet().iterator();
            while (it.hasNext() && toRemove-- > 0) {
                it.next();
                it.remove();
            }
        }
    }

    public int size() {
        return cacheStore.size();
    }

    public void clear() {
        cacheStore.clear();
    }
}
