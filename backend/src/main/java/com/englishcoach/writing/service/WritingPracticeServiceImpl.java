package com.englishcoach.writing.service;

import com.englishcoach.writing.client.WritingAiClient;
import com.englishcoach.writing.config.WritingProperties;
import com.englishcoach.writing.dto.*;
import com.englishcoach.writing.entity.WritingPracticeEntity;
import com.englishcoach.writing.entity.WritingSubmissionEntity;
import com.englishcoach.writing.enums.DimensionStatus;
import com.englishcoach.writing.enums.IssueKind;
import com.englishcoach.writing.enums.PracticeEvaluationStatus;
import com.englishcoach.writing.enums.PracticeMode;
import com.englishcoach.writing.enums.SubmissionKind;
import com.englishcoach.writing.exception.WritingConflictException;
import com.englishcoach.writing.exception.WritingDisabledException;
import com.englishcoach.writing.exception.WritingNotFoundException;
import com.englishcoach.writing.repository.WritingPracticeRepository;
import com.englishcoach.writing.repository.WritingSubmissionRepository;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class WritingPracticeServiceImpl implements WritingPracticeService {

    private final WritingProperties writingProperties;
    private final WritingPracticeRepository practiceRepository;
    private final WritingSubmissionRepository submissionRepository;
    private final WritingCatalogService catalogService;
    private final WritingErrorMemoryService errorMemoryService;
    private final WritingAiClient writingAiClient;
    private final ObjectMapper objectMapper;

    @Override
    @Transactional
    public PracticeEpisodeDto startPractice(Long userId, PracticeStartRequest request) {
        if (!writingProperties.isEnabled() || !writingProperties.isMutationsEnabled()) {
            throw new WritingDisabledException("Writing features are currently disabled.");
        }

        // 1. Select matching exercise from catalog
        Map<String, Object> exercise = null;
        if (request.getExerciseId() != null) {
            exercise = catalogService.getExerciseById(request.getExerciseId()).orElse(null);
        }
        if (exercise == null && request.getTargetPatternCode() != null) {
            List<Map<String, Object>> byPattern = catalogService.getExercisesByPatternCode(request.getTargetPatternCode());
            if (!byPattern.isEmpty()) {
                exercise = byPattern.get(0);
            }
        }
        if (exercise == null && request.getMode() != null) {
            List<Map<String, Object>> byMode = catalogService.getExercisesByMode(request.getMode().name());
            if (!byMode.isEmpty()) {
                exercise = byMode.get(0);
            }
        }
        if (exercise == null && !catalogService.getExercises().isEmpty()) {
            exercise = catalogService.getExercises().get(0);
        }

        if (exercise == null) {
            throw new WritingNotFoundException("No practice exercises available for the requested parameters.");
        }

        PracticeMode mode = PracticeMode.valueOf((String) exercise.getOrDefault("mode", "REPAIR"));
        String patternCode = (String) exercise.get("pattern_code");

        // 2. Build practice entity with immutable snapshot
        String snapshotJson;
        try {
            snapshotJson = objectMapper.writeValueAsString(exercise);
        } catch (Exception e) {
            log.error("Failed to serialize exercise snapshot: {}", e.getMessage());
            snapshotJson = "{}";
        }

        WritingPracticeEntity practice = WritingPracticeEntity.builder()
                .id(UUID.randomUUID().toString())
                .userId(userId)
                .mode(mode)
                .exerciseSnapshot(snapshotJson)
                .targetPatternCode(patternCode)
                .sourceIssueId(request.getSourceIssueId())
                .sourceSessionId(request.getSourceSessionId())
                .currentAttemptOrdinal(0)
                .maxAttempts(3)
                .revealedHints("[]")
                .isCompleted(false)
                .isSuccess(false)
                .modelAnswerRevealed(false)
                .build();

        practice = practiceRepository.save(practice);
        log.info("Created practice episode {} (mode={}) for user {}", practice.getId(), mode, userId);

        return mapToDto(practice, exercise);
    }

    @Override
    @Transactional(readOnly = true)
    public PracticeEpisodeDto getPractice(Long userId, String practiceId) {
        WritingPracticeEntity practice = practiceRepository.findByIdAndUserId(practiceId, userId)
                .orElseThrow(() -> new WritingNotFoundException("Practice episode not found: " + practiceId));

        Map<String, Object> exercise = parseExerciseSnapshot(practice.getExerciseSnapshot());
        return mapToDto(practice, exercise);
    }

    @Override
    @Transactional
    public PracticeEpisodeDto requestNextHint(Long userId, String practiceId) {
        WritingPracticeEntity practice = practiceRepository.findByIdAndUserId(practiceId, userId)
                .orElseThrow(() -> new WritingNotFoundException("Practice episode not found: " + practiceId));

        if (practice.getIsCompleted()) {
            throw new WritingConflictException("Practice episode is already completed.");
        }

        Map<String, Object> exercise = parseExerciseSnapshot(practice.getExerciseSnapshot());
        List<Map<String, Object>> hintsList = (List<Map<String, Object>>) exercise.getOrDefault("hints", Collections.emptyList());

        List<String> revealed = new ArrayList<>();
        try {
            revealed = objectMapper.readValue(practice.getRevealedHints(), new TypeReference<List<String>>() {});
        } catch (Exception e) {
            log.warn("Failed to parse revealed hints: {}", e.getMessage());
        }

        if (revealed.size() < hintsList.size()) {
            Map<String, Object> nextHintObj = hintsList.get(revealed.size());
            String hintText = (String) nextHintObj.get("text");
            revealed.add(hintText);

            if (revealed.size() >= 3 || nextHintObj.get("level") != null && ((Number) nextHintObj.get("level")).intValue() >= 3) {
                practice.setModelAnswerRevealed(true);
            }

            try {
                practice.setRevealedHints(objectMapper.writeValueAsString(revealed));
            } catch (Exception e) {
                log.error("Failed to serialize revealed hints: {}", e.getMessage());
            }

            practiceRepository.save(practice);
        }

        return mapToDto(practice, exercise);
    }

    @Override
    @Transactional
    public PracticeAttemptResultDto submitAttempt(Long userId, String practiceId, PracticeAttemptRequest request) {
        WritingPracticeEntity practice = practiceRepository.findByIdAndUserId(practiceId, userId)
                .orElseThrow(() -> new WritingNotFoundException("Practice episode not found: " + practiceId));

        if (practice.getIsCompleted()) {
            throw new WritingConflictException("Practice episode is already completed.");
        }

        String answer = request.getAnswer() != null ? request.getAnswer().trim() : "";
        if (answer.isEmpty()) {
            throw new IllegalArgumentException("Answer cannot be empty.");
        }

        int newOrdinal = practice.getCurrentAttemptOrdinal() + 1;
        practice.setCurrentAttemptOrdinal(newOrdinal);

        // Record submission attempt
        WritingSubmissionEntity submission = WritingSubmissionEntity.builder()
                .id(UUID.randomUUID().toString())
                .userId(userId)
                .practiceId(practice.getId())
                .kind(SubmissionKind.PRACTICE_ATTEMPT)
                .ordinal(newOrdinal)
                .content(answer)
                .wordCount(answer.split("\\s+").length)
                .characterCount(answer.length())
                .idempotencyKey(request.getClientMutationId())
                .build();
        submissionRepository.save(submission);

        Map<String, Object> exercise = parseExerciseSnapshot(practice.getExerciseSnapshot());
        PracticeEvaluationStatus evalStatus = evaluateAnswer(answer, exercise, practice.getMode());
        boolean isSuccess = (evalStatus == PracticeEvaluationStatus.VALID);

        String feedback;
        String unlockedHint = null;

        List<String> currentRevealed = new ArrayList<>();
        try {
            currentRevealed = objectMapper.readValue(practice.getRevealedHints(), new TypeReference<>() {});
        } catch (Exception ignored) {}

        boolean assisted = !currentRevealed.isEmpty();

        if (isSuccess) {
            practice.setIsSuccess(true);
            practice.setIsCompleted(true);
            feedback = "Excellent! Your answer is grammatically sound and successfully fulfills the exercise requirements.";

            // Record outcome in Error Memory
            if (practice.getTargetPatternCode() != null) {
                errorMemoryService.recordPracticeOutcome(
                        userId,
                        practice.getId(),
                        practice.getTargetPatternCode(),
                        true,
                        assisted,
                        practice.getId()
                );
            }
        } else {
            if (newOrdinal >= practice.getMaxAttempts()) {
                practice.setIsCompleted(true);
                practice.setModelAnswerRevealed(true);
                feedback = "Attempt limit reached. Study the model answer below to understand the target formulation.";

                if (practice.getTargetPatternCode() != null) {
                    errorMemoryService.recordPracticeOutcome(
                            userId,
                            practice.getId(),
                            practice.getTargetPatternCode(),
                            false,
                            false,
                            practice.getId()
                    );
                }
            } else if (evalStatus == PracticeEvaluationStatus.PARTIALLY_VALID) {
                feedback = "Good attempt! Your answer conveys the idea, but needs minor refinement in phrasing or grammar.";
            } else if (evalStatus == PracticeEvaluationStatus.UNCERTAIN) {
                feedback = "Answer recorded. Evaluation service is temporarily inconclusive; you may retry or unlock a hint.";
            } else {
                feedback = "Not quite right yet. Review the constraints and try again, or unlock a hint.";
            }
        }

        practiceRepository.save(practice);

        // Get updated mastery for feedback
        Integer updatedMastery = null;
        if (practice.getTargetPatternCode() != null) {
            updatedMastery = errorMemoryService.findMistakeByPattern(userId, practice.getTargetPatternCode())
                    .map(ErrorMemoryDto::getEstimatedMastery)
                    .orElse(null);
        }

        return PracticeAttemptResultDto.builder()
                .practiceId(practice.getId())
                .attemptOrdinal(newOrdinal)
                .isSuccess(isSuccess)
                .evaluationStatus(evalStatus)
                .learnerAnswer(answer)
                .feedback(feedback)
                .unlockedHint(unlockedHint)
                .isCompleted(practice.getIsCompleted())
                .masteryUpdated(isSuccess || practice.getIsCompleted())
                .newEstimatedMastery(updatedMastery)
                .build();
    }

    private PracticeEvaluationStatus evaluateAnswer(String answer, Map<String, Object> exercise, PracticeMode mode) {
        String cleanLearner = normalize(answer);
        if (cleanLearner.isBlank()) {
            return PracticeEvaluationStatus.INVALID;
        }

        // 1. Exact / catalog variant matching (deterministic fast-path)
        String target = (String) exercise.get("target_sentence");
        if (target != null && cleanLearner.equalsIgnoreCase(normalize(target))) {
            return PracticeEvaluationStatus.VALID;
        }

        String solution = (String) exercise.get("solution");
        if (solution != null && cleanLearner.equalsIgnoreCase(normalize(solution))) {
            return PracticeEvaluationStatus.VALID;
        }

        List<String> accepted = (List<String>) exercise.get("accepted_answers");
        if (accepted != null) {
            for (String acc : accepted) {
                if (cleanLearner.equalsIgnoreCase(normalize(acc))) {
                    return PracticeEvaluationStatus.VALID;
                }
            }
        }

        // 2. Constrained evaluation for REPAIR mode
        if (mode == PracticeMode.REPAIR) {
            if (writingAiClient != null) {
                try {
                    SentenceAnalysisAiResponse aiRes = writingAiClient.analyzeSentence(answer, "general", "REPAIR check");
                    if (Boolean.TRUE.equals(aiRes.getGrammaticallyCorrect()) &&
                            (aiRes.getIssues() == null || aiRes.getIssues().stream().noneMatch(i -> i.getKind() == IssueKind.ERROR))) {
                        return PracticeEvaluationStatus.VALID;
                    } else {
                        return PracticeEvaluationStatus.INVALID;
                    }
                } catch (Exception e) {
                    log.warn("AI analysis failed during REPAIR evaluation: {}", e.getMessage());
                    return PracticeEvaluationStatus.UNCERTAIN;
                }
            }
            return PracticeEvaluationStatus.INVALID;
        }

        // 3. Open-ended modes: COMBINE, EXPAND, REWRITE_NATURALLY, PARAPHRASE, CHANGE_REGISTER, IMPROVE_COHESION
        String targetSentence = (String) exercise.get("target_sentence");
        String origContext = (String) exercise.get("original_context");
        String refCombined = ((targetSentence != null ? targetSentence : "") + " " + (origContext != null ? origContext : "")).toLowerCase();

        Set<String> stopWords = Set.of(
                "the", "a", "an", "is", "are", "was", "were", "this", "that", "these", "those",
                "it", "its", "in", "on", "at", "to", "for", "of", "with", "and", "or", "but",
                "so", "if", "as", "by", "from", "be", "been", "have", "has", "had", "can", "will"
        );

        Set<String> refKeywords = Arrays.stream(refCombined.replaceAll("[^a-zA-Z0-9 ]", " ").split("\\s+"))
                .filter(w -> w.length() >= 3 && !stopWords.contains(w))
                .collect(java.util.stream.Collectors.toSet());
        Set<String> ansKeywords = Arrays.stream(answer.toLowerCase().replaceAll("[^a-zA-Z0-9 ]", " ").split("\\s+"))
                .filter(w -> w.length() >= 3 && !stopWords.contains(w))
                .collect(java.util.stream.Collectors.toSet());

        if (!refKeywords.isEmpty() && mode != PracticeMode.REWRITE_NATURALLY && mode != PracticeMode.PARAPHRASE) {
            boolean hasOverlap = ansKeywords.stream().anyMatch(refKeywords::contains);
            if (!hasOverlap) {
                return PracticeEvaluationStatus.INVALID;
            }
        }

        if (writingAiClient != null) {
            try {
                String promptText = (String) exercise.get("prompt");
                SentenceAnalysisAiResponse aiRes = writingAiClient.analyzeSentence(
                        answer,
                        mode == PracticeMode.CHANGE_REGISTER ? "formal" : "general",
                        "Mode: " + mode + "; Prompt: " + promptText
                );

                if (aiRes == null || aiRes.getDimensionVerdicts() == null) {
                    return PracticeEvaluationStatus.UNCERTAIN;
                }

                boolean hasGrammarError = aiRes.getIssues() != null &&
                        aiRes.getIssues().stream().anyMatch(i -> i.getKind() == IssueKind.ERROR);
                boolean hasImprovement = aiRes.getIssues() != null &&
                        aiRes.getIssues().stream().anyMatch(i -> i.getKind() == IssueKind.IMPROVEMENT);

                if (hasGrammarError) {
                    return PracticeEvaluationStatus.INVALID;
                }

                boolean isUnavailableOrInconclusive = aiRes.getDimensionVerdicts().stream()
                        .anyMatch(v -> v.getStatus() == DimensionStatus.UNAVAILABLE || v.getStatus() == DimensionStatus.UNCERTAIN);

                if (isUnavailableOrInconclusive || (!Boolean.TRUE.equals(aiRes.getGrammaticallyCorrect()) && !hasImprovement)) {
                    return PracticeEvaluationStatus.UNCERTAIN;
                }

                // Mode-specific constraint checks
                if (mode == PracticeMode.EXPAND) {
                    int promptWordCount = promptText != null ? promptText.split("\\s+").length : 0;
                    int answerWordCount = answer.split("\\s+").length;
                    if (answerWordCount <= promptWordCount) {
                        return PracticeEvaluationStatus.PARTIALLY_VALID;
                    }
                }

                if (mode == PracticeMode.COMBINE) {
                    int answerWordCount = answer.split("\\s+").length;
                    if (answerWordCount < 5) {
                        return PracticeEvaluationStatus.PARTIALLY_VALID;
                    }
                }

                if (Boolean.TRUE.equals(aiRes.getGrammaticallyCorrect())) {
                    if (hasImprovement) {
                        return PracticeEvaluationStatus.PARTIALLY_VALID;
                    }
                    return PracticeEvaluationStatus.VALID;
                }

                return PracticeEvaluationStatus.UNCERTAIN;
            } catch (Exception e) {
                log.warn("AI sentence check failed for open-ended practice mode {}: {}", mode, e.getMessage());
                return PracticeEvaluationStatus.UNCERTAIN;
            }
        }

        return PracticeEvaluationStatus.UNCERTAIN;
    }

    private String normalize(String s) {
        if (s == null) return "";
        return s.trim().replaceAll("[\\p{Punct}&&[^']]", "").replaceAll("\\s+", " ");
    }

    private Map<String, Object> parseExerciseSnapshot(String snapshotJson) {
        try {
            return objectMapper.readValue(snapshotJson, new TypeReference<>() {});
        } catch (Exception e) {
            log.error("Failed to parse exercise snapshot: {}", e.getMessage());
            return Collections.emptyMap();
        }
    }

    private PracticeEpisodeDto mapToDto(WritingPracticeEntity entity, Map<String, Object> exercise) {
        List<String> constraints = (List<String>) exercise.getOrDefault("constraints", Collections.emptyList());

        List<String> revealed = new ArrayList<>();
        try {
            revealed = objectMapper.readValue(entity.getRevealedHints(), new TypeReference<List<String>>() {});
        } catch (Exception ignored) {}

        return PracticeEpisodeDto.builder()
                .id(entity.getId())
                .mode(entity.getMode())
                .exerciseId((String) exercise.get("id"))
                .title((String) exercise.getOrDefault("title", "Practice Exercise"))
                .prompt((String) exercise.getOrDefault("prompt", ""))
                .originalContext((String) exercise.get("original_context"))
                .targetPatternCode(entity.getTargetPatternCode())
                .constraints(constraints)
                .currentAttemptOrdinal(entity.getCurrentAttemptOrdinal())
                .maxAttempts(entity.getMaxAttempts())
                .revealedHints(revealed)
                .isCompleted(entity.getIsCompleted())
                .isSuccess(entity.getIsSuccess())
                .modelAnswerRevealed(entity.getModelAnswerRevealed())
                .createdAt(entity.getCreatedAt())
                .build();
    }
}
