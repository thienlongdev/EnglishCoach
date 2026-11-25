package com.englishcoach.writing.service;

import com.englishcoach.writing.entity.WritingReferenceAnswerCacheEntity;
import com.englishcoach.writing.repository.WritingReferenceAnswerCacheRepository;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

@Slf4j
@Service
@RequiredArgsConstructor
public class WritingReferenceAnswerCacheService {

    public static final String PROMPT_VERSION = "prompt_v2";
    public static final String SCHEMA_VERSION = "schema_v1";
    public static final String MODEL_VERSION = "gpt_5.6_luna";

    public static final int MAX_MEMORY_CACHE_ENTRIES = 500;

    private final WritingReferenceAnswerCacheRepository cacheRepository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    // Bounded sub-millisecond in-memory LRU cache (EC-SEC-2026-029)
    private final Map<String, SharedReferenceAnswer> memoryCache = Collections.synchronizedMap(
            new LinkedHashMap<String, SharedReferenceAnswer>(128, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, SharedReferenceAnswer> eldest) {
                    return size() > MAX_MEMORY_CACHE_ENTRIES;
                }
            }
    );

    // Single-flight coordination to guarantee exactly one AI generation per task/version
    private final Map<String, CompletableFuture<SharedReferenceAnswer>> inFlightMap = new ConcurrentHashMap<>();

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class SharedReferenceAnswer {
        private String cacheKey;
        private String taskId;
        private String taskContentVersion;
        private String exemplarModelAnswer;
        private String calibratedLevel;
        private List<String> structuralObservations;
        private List<String> lexicalAlternatives;
        private Instant cachedAt;
        private boolean fromMemory;
    }

    public static String computeContentVersion(String promptText, Object visualData, String targetRegister) {
        return computeContentVersion(promptText, visualData, targetRegister, null);
    }

    public static String computeContentVersion(String promptText, Object visualData, String targetRegister, String targetLevel) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            String normalizedLevel = (targetLevel == null || targetLevel.isBlank())
                    ? "default"
                    : targetLevel.trim().toUpperCase(Locale.ROOT);
            String raw = (promptText == null ? "" : promptText.trim().toLowerCase(Locale.ROOT))
                    + "|" + (visualData == null ? "" : visualData.toString().trim())
                    + "|" + (targetRegister == null ? "formal" : targetRegister.trim().toLowerCase(Locale.ROOT))
                    + "|" + normalizedLevel;
            byte[] digest = md.digest(raw.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) {
                sb.append(String.format("%02x", b));
            }
            return sb.substring(0, 16);
        } catch (Exception e) {
            return "v1";
        }
    }

    public String buildCacheKey(String taskId, String taskContentVersion) {
        String cleanTaskId = (taskId == null || taskId.isBlank()) ? "generic" : taskId.trim();
        String cleanVersion = (taskContentVersion == null || taskContentVersion.isBlank()) ? "v1" : taskContentVersion.trim();
        return cleanTaskId + ":" + cleanVersion + ":" + PROMPT_VERSION + ":" + SCHEMA_VERSION + ":" + MODEL_VERSION;
    }

    public SharedReferenceAnswer getOrGenerate(
            String taskId,
            String taskContentVersion,
            Supplier<SharedReferenceAnswer> generator
    ) {
        String cacheKey = buildCacheKey(taskId, taskContentVersion);

        // 1. Fast path: Memory Cache Hit (0ms)
        SharedReferenceAnswer inMem = memoryCache.get(cacheKey);
        if (inMem != null) {
            log.info("Shared reference answer memory cache HIT for key: {}", cacheKey);
            return inMem;
        }

        // 2. Persistent Database Cache Hit
        Optional<WritingReferenceAnswerCacheEntity> dbEntityOpt = cacheRepository.findByCacheKey(cacheKey);
        if (dbEntityOpt.isPresent()) {
            WritingReferenceAnswerCacheEntity entity = dbEntityOpt.get();
            SharedReferenceAnswer answer = fromEntity(entity);
            memoryCache.put(cacheKey, answer);
            log.info("Shared reference answer database cache HIT for key: {}", cacheKey);
            return answer;
        }

        // 3. Cache Miss with Single-Flight Coordination
        log.info("Shared reference answer cache MISS for key: {}. Acquiring single-flight execution...", cacheKey);
        CompletableFuture<SharedReferenceAnswer> future = inFlightMap.computeIfAbsent(cacheKey, key -> {
            CompletableFuture<SharedReferenceAnswer> callFuture = new CompletableFuture<>();
            CompletableFuture.runAsync(() -> {
                try {
                    log.info("Executing ONE shared reference generation for key: {}", key);
                    SharedReferenceAnswer generated = generator.get();
                    if (generated != null && generated.getExemplarModelAnswer() != null && !generated.getExemplarModelAnswer().isBlank()) {
                        generated.setCacheKey(key);
                        generated.setTaskId(taskId);
                        generated.setTaskContentVersion(taskContentVersion);
                        generated.setCachedAt(Instant.now());

                        // Persist to database
                        try {
                            WritingReferenceAnswerCacheEntity entity = WritingReferenceAnswerCacheEntity.builder()
                                    .id(UUID.randomUUID().toString())
                                    .cacheKey(key)
                                    .taskId(taskId)
                                    .taskContentVersion(taskContentVersion)
                                    .promptVersion(PROMPT_VERSION)
                                    .schemaVersion(SCHEMA_VERSION)
                                    .modelVersion(MODEL_VERSION)
                                    .exemplarModelAnswer(generated.getExemplarModelAnswer())
                                    .calibratedLevel(generated.getCalibratedLevel())
                                    .structuralObservations(objectMapper.writeValueAsString(
                                            generated.getStructuralObservations() != null ? generated.getStructuralObservations() : Collections.emptyList()
                                    ))
                                    .lexicalAlternatives(objectMapper.writeValueAsString(
                                            generated.getLexicalAlternatives() != null ? generated.getLexicalAlternatives() : Collections.emptyList()
                                    ))
                                    .build();
                            cacheRepository.save(entity);
                            log.info("Persisted shared reference answer to database for key: {}", key);
                        } catch (Exception dbErr) {
                            log.warn("Failed to persist shared reference answer to DB (proceeding with memory cache): {}", dbErr.getMessage());
                        }

                        memoryCache.put(key, generated);
                        callFuture.complete(generated);
                    } else {
                        callFuture.completeExceptionally(new IllegalStateException("Generated reference answer was empty"));
                    }
                } catch (Throwable t) {
                    callFuture.completeExceptionally(t);
                } finally {
                    inFlightMap.remove(key);
                }
            });
            return callFuture;
        });

        try {
            return future.join();
        } catch (Exception ex) {
            Throwable cause = ex.getCause() != null ? ex.getCause() : ex;
            log.error("Failed to generate shared reference answer for key {}: {}", cacheKey, cause.getMessage());
            if (cause instanceof RuntimeException runtimeException) {
                throw runtimeException;
            }
            throw new RuntimeException("Failed to generate reference answer", cause);
        }
    }

    private SharedReferenceAnswer fromEntity(WritingReferenceAnswerCacheEntity entity) {
        List<String> struct = Collections.emptyList();
        List<String> lex = Collections.emptyList();
        try {
            if (entity.getStructuralObservations() != null) {
                struct = objectMapper.readValue(entity.getStructuralObservations(), new TypeReference<>() {});
            }
            if (entity.getLexicalAlternatives() != null) {
                lex = objectMapper.readValue(entity.getLexicalAlternatives(), new TypeReference<>() {});
            }
        } catch (Exception e) {
            log.warn("Failed to deserialize reference answer lists: {}", e.getMessage());
        }

        return SharedReferenceAnswer.builder()
                .cacheKey(entity.getCacheKey())
                .taskId(entity.getTaskId())
                .taskContentVersion(entity.getTaskContentVersion())
                .exemplarModelAnswer(entity.getExemplarModelAnswer())
                .calibratedLevel(entity.getCalibratedLevel())
                .structuralObservations(struct)
                .lexicalAlternatives(lex)
                .cachedAt(entity.getCreatedAt())
                .fromMemory(false)
                .build();
    }
}
