package com.englishcoach.writing.service;

import com.englishcoach.writing.client.WritingAiClient;
import com.englishcoach.writing.config.WritingProperties;
import com.englishcoach.writing.dto.*;
import com.englishcoach.writing.entity.WritingAssessmentEntity;
import com.englishcoach.writing.entity.WritingFeedbackIssueEntity;
import com.englishcoach.writing.entity.WritingSubmissionEntity;
import com.englishcoach.writing.enums.*;
import com.englishcoach.writing.exception.WritingConflictException;
import com.englishcoach.writing.exception.WritingDisabledException;
import com.englishcoach.writing.exception.WritingForbiddenException;
import com.englishcoach.writing.exception.WritingNotFoundException;
import com.englishcoach.writing.repository.WritingAssessmentRepository;
import com.englishcoach.writing.repository.WritingFeedbackIssueRepository;
import com.englishcoach.writing.repository.WritingSubmissionRepository;
import com.englishcoach.writing.service.cache.SentenceCheckAnalysisCache;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.persistence.EntityManager;
import jakarta.persistence.LockModeType;
import jakarta.persistence.PersistenceContext;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

@Slf4j
@Service
@RequiredArgsConstructor
public class WritingAssessmentServiceImpl implements WritingAssessmentService {

    private final WritingProperties writingProperties;
    private final WritingSubmissionRepository submissionRepository;
    private final WritingAssessmentRepository assessmentRepository;
    private final WritingFeedbackIssueRepository issueRepository;
    private final WritingAiClient writingAiClient;
    private final WritingErrorMemoryService errorMemoryService;
    private final WritingCatalogService catalogService;
    private final DeterministicGrammarValidator deterministicGrammarValidator;
    private final SentenceCheckAnalysisCache sentenceCheckCache;
    private final ObjectMapper objectMapper;

    private final ConcurrentHashMap<String, CompletableFuture<SentenceCheckAnalysisCache.CanonicalSentenceAnalysis>> inFlightExecutions = new ConcurrentHashMap<>();

    @Autowired(required = false)
    private PlatformTransactionManager transactionManager;

    @PersistenceContext
    private EntityManager entityManager;

    private <T> T inTx(java.util.function.Supplier<T> work) {
        if (transactionManager == null) return work.get();
        return new TransactionTemplate(transactionManager).execute(s -> work.get());
    }

    private <T> T inReadTx(java.util.function.Supplier<T> work) {
        if (transactionManager == null) return work.get();
        TransactionTemplate tpl = new TransactionTemplate(transactionManager);
        tpl.setReadOnly(true);
        return tpl.execute(s -> work.get());
    }

    private WritingAssessmentEntity lockAssessmentById(String assessmentId) {
        if (entityManager != null) {
            WritingAssessmentEntity locked = entityManager.find(WritingAssessmentEntity.class, assessmentId, LockModeType.PESSIMISTIC_WRITE);
            if (locked == null) {
                throw new WritingNotFoundException("Assessment not found: " + assessmentId);
            }
            return locked;
        }
        return assessmentRepository.findById(assessmentId)
                .orElseThrow(() -> new WritingNotFoundException("Assessment not found: " + assessmentId));
    }

    private record RetryPhase1(SentenceCheckResultDto readyDto, String content, String leaseToken) {}

    private Optional<SentenceCheckResultDto> findIdempotentResult(Long userId, String clientMutationId) {
        if (clientMutationId == null || clientMutationId.isBlank()) {
            return Optional.empty();
        }
        Optional<WritingSubmissionEntity> existingSub = submissionRepository.findByUserIdAndIdempotencyKey(userId, clientMutationId);
        if (existingSub.isPresent()) {
            Optional<WritingAssessmentEntity> existingAssessment = assessmentRepository.findBySubmissionId(existingSub.get().getId());
            if (existingAssessment.isPresent()) {
                return Optional.of(buildResultDto(existingSub.get(), existingAssessment.get()));
            }
        }
        return Optional.empty();
    }

    @Override
    public SentenceCheckResultDto submitSentenceCheck(Long userId, SentenceCheckSubmissionRequest request) {
        if (!writingProperties.isEnabled() || !writingProperties.isMutationsEnabled()) {
            throw new WritingDisabledException("Writing feature or mutations are currently disabled.");
        }

        String cleanText = request.getText() != null ? request.getText().trim() : "";
        if (cleanText.isEmpty()) {
            throw new IllegalArgumentException("Sentence text cannot be empty.");
        }
        if (cleanText.length() > writingProperties.getMaxSentenceChars()) {
            throw new IllegalArgumentException("Sentence exceeds maximum allowed length of " + writingProperties.getMaxSentenceChars() + " characters.");
        }

        String clientMutationId = request.getClientMutationId();

        // Phase 1 (short read TX): idempotency check if clientMutationId supplied
        if (clientMutationId != null && !clientMutationId.isBlank()) {
            Optional<SentenceCheckResultDto> existing = inReadTx(() -> findIdempotentResult(userId, clientMutationId));
            if (existing.isPresent()) {
                return existing.get();
            }
        }

        String normalizedText = SentenceCheckAnalysisCache.normalizeSentence(cleanText);
        String targetRegister = SentenceCheckAnalysisCache.normalizeRegister(request.getTargetRegister());
        String trimmedContextNote = request.getContextNote() != null ? request.getContextNote().trim() : "";
        boolean hasContextNote = !trimmedContextNote.isEmpty();
        String cacheKey = SentenceCheckAnalysisCache.computeKey(normalizedText, targetRegister);
        String inputHash = SentenceCheckAnalysisCache.computeInputHash(normalizedText);

        // EC-SEC-2026-029: Requests with a caller-supplied contextNote must bypass the shared cache on both read and write
        // so user-specific or adversarial context notes can never pollute canonical results for other learners.
        SentenceCheckAnalysisCache.CacheLookupResult cacheResult = hasContextNote
                ? SentenceCheckAnalysisCache.CacheLookupResult.miss(cacheKey, inputHash)
                : sentenceCheckCache.lookup(cleanText, targetRegister);

        // =========================================================================
        // PATH A: VALID EXACT CACHE HIT -> Replay canonical analysis without AI call
        // =========================================================================
        if (cacheResult.getStatus() == SentenceCheckAnalysisCache.CacheStatus.CACHE_HIT && cacheResult.getAnalysis() != null) {
            SentenceCheckAnalysisCache.CanonicalSentenceAnalysis cached = cacheResult.getAnalysis();
            String verdictsJson = "[]";
            try {
                verdictsJson = objectMapper.writeValueAsString(cached.getDimensionVerdicts() != null ? cached.getDimensionVerdicts() : Collections.emptyList());
            } catch (Exception e) {
                log.warn("Failed to serialize cached dimension verdicts: {}", e.getMessage());
            }
            final String finalVerdictsJson = verdictsJson;

            return inTx(() -> {
                Optional<SentenceCheckResultDto> concurrent = findIdempotentResult(userId, clientMutationId);
                if (concurrent.isPresent()) {
                    return concurrent.get();
                }

                int wordCount = cleanText.split("\\s+").length;
                WritingSubmissionEntity submission = WritingSubmissionEntity.builder()
                        .id(UUID.randomUUID().toString())
                        .userId(userId)
                        .kind(SubmissionKind.SENTENCE_CHECK)
                        .content(cleanText)
                        .wordCount(wordCount)
                        .characterCount(cleanText.length())
                        .idempotencyKey(clientMutationId)
                        .build();
                submission = submissionRepository.save(submission);

                WritingAssessmentEntity assessment = WritingAssessmentEntity.builder()
                        .id(UUID.randomUUID().toString())
                        .submissionId(submission.getId())
                        .operation(AssessmentOperation.SENTENCE_CHECK)
                        .status(AssessmentStatus.READY)
                        .grammaticallyCorrect(cached.getGrammaticallyCorrect())
                        .coverageSummary(cached.getCoverageSummary())
                        .dimensionVerdicts(finalVerdictsJson)
                        .completedAt(Instant.now())
                        .build();
                assessment = assessmentRepository.save(assessment);

                List<WritingFeedbackIssueEntity> savedIssues = new ArrayList<>();
                int rank = 1;
                int errorCount = 0;
                int improvementCount = 0;
                int styleCount = 0;

                if (cached.getIssues() != null) {
                    for (FeedbackIssueDto issueDto : cached.getIssues()) {
                        WritingFeedbackIssueEntity issueEntity = WritingFeedbackIssueEntity.builder()
                                .id(UUID.randomUUID().toString())
                                .assessmentId(assessment.getId())
                                .kind(issueDto.getKind() != null ? issueDto.getKind() : IssueKind.IMPROVEMENT)
                                .severity(issueDto.getSeverity() != null ? issueDto.getSeverity() : IssueSeverity.MINOR)
                                .category(issueDto.getCategory() != null ? issueDto.getCategory() : "Grammar")
                                .patternCode(issueDto.getPatternCode())
                                .title(issueDto.getTitle() != null ? issueDto.getTitle() : "Issue")
                                .explanation(issueDto.getExplanation() != null ? issueDto.getExplanation() : "")
                                .sourceQuote(issueDto.getSourceQuote())
                                .startOffset(issueDto.getStartOffset())
                                .endOffset(issueDto.getEndOffset())
                                .replacement(issueDto.getReplacement())
                                .teachingRule(issueDto.getTeachingRule())
                                .suggestedPracticeMode(issueDto.getSuggestedPracticeMode())
                                .disposition(IssueDisposition.ACTIVE)
                                .priorityRank(rank++)
                                .build();

                        WritingFeedbackIssueEntity savedIssue = issueRepository.save(issueEntity);
                        if (savedIssue == null) {
                            savedIssue = issueEntity;
                        }
                        savedIssues.add(savedIssue);

                        if (savedIssue.getKind() == IssueKind.ERROR) {
                            errorCount++;
                        } else if (savedIssue.getKind() == IssueKind.IMPROVEMENT) {
                            improvementCount++;
                        }
                        if ("Style".equalsIgnoreCase(savedIssue.getCategory()) || savedIssue.getSeverity() == IssueSeverity.SUGGESTION) {
                            styleCount++;
                        }
                        // CRITICAL: Cache hits must NOT generate duplicate learning events
                    }
                }

                String primaryModel = (writingAiClient.getSentenceLabModel() != null && !writingAiClient.getSentenceLabModel().isBlank())
                        ? writingAiClient.getSentenceLabModel()
                        : "openai/gpt-5.6-luna";
                String fallbackModel = (writingAiClient.getSentenceLabFallbackModel() != null && !writingAiClient.getSentenceLabFallbackModel().isBlank())
                        ? writingAiClient.getSentenceLabFallbackModel()
                        : "deepseek/deepseek-v3.2";

                log.info("[SENTENCE_LAB] requestId={} fingerprint={} cache=HIT singleFlight=NONE primaryModel={} primaryCalls=0 fallbackModel={} fallbackCalls=0 resultSource=CACHE validatedErrorCount={} improvementCount={} styleSuggestionCount={}",
                        submission.getId(),
                        inputHash,
                        primaryModel,
                        fallbackModel,
                        errorCount,
                        improvementCount,
                        styleCount);

                return buildResultDto(submission, assessment, savedIssues, cached.getSuggestedImprovement(), cached.getExplanation());
            });
        }

        // =========================================================================
        // PATH B: CACHE MISS (or contextNote bypass) -> Single-Flight OUTSIDE TX
        // =========================================================================
        SentenceCheckAnalysisCache.CanonicalSentenceAnalysis canonical;
        String singleFlightStatus;
        int primaryCalls = 0;
        int fallbackCalls = 0;
        String resultSource;

        if (hasContextNote) {
            // Never join or publish into shared single-flight / cache when contextNote is present
            singleFlightStatus = "BYPASSED";
            canonical = executeCanonicalPipeline(cleanText, targetRegister, trimmedContextNote);
            resultSource = canonical.getResultSource() != null ? canonical.getResultSource() : "PRIMARY";
            primaryCalls = 1;
            fallbackCalls = "FALLBACK".equalsIgnoreCase(resultSource) ? 1 : 0;
        } else {
            CompletableFuture<SentenceCheckAnalysisCache.CanonicalSentenceAnalysis> newFuture = new CompletableFuture<>();
            CompletableFuture<SentenceCheckAnalysisCache.CanonicalSentenceAnalysis> existingFuture = inFlightExecutions.putIfAbsent(cacheKey, newFuture);

            if (existingFuture != null) {
                singleFlightStatus = "JOINED";
                try {
                    canonical = existingFuture.get(60, TimeUnit.SECONDS);
                    primaryCalls = 0;
                    fallbackCalls = 0;
                    resultSource = "CACHE";
                } catch (Exception e) {
                    log.warn("Timed out or error waiting for in-flight sentence analysis for hash {}: {}", inputHash, e.getMessage());
                    canonical = executeCanonicalPipeline(cleanText, targetRegister, null);
                    resultSource = canonical.getResultSource() != null ? canonical.getResultSource() : "PRIMARY";
                    primaryCalls = 1;
                    fallbackCalls = "FALLBACK".equalsIgnoreCase(resultSource) ? 1 : 0;
                }
            } else {
                singleFlightStatus = "OWNER";
                try {
                    canonical = executeCanonicalPipeline(cleanText, targetRegister, null);
                    sentenceCheckCache.put(cleanText, targetRegister, canonical);
                    newFuture.complete(canonical);
                    resultSource = canonical.getResultSource() != null ? canonical.getResultSource() : "PRIMARY";
                    primaryCalls = 1;
                    fallbackCalls = "FALLBACK".equalsIgnoreCase(resultSource) ? 1 : 0;
                } catch (Throwable t) {
                    newFuture.completeExceptionally(t);
                    inFlightExecutions.remove(cacheKey);
                    throw t;
                } finally {
                    inFlightExecutions.remove(cacheKey);
                }
            }
        }

        String verdictsJson = "[]";
        try {
            verdictsJson = objectMapper.writeValueAsString(canonical.getDimensionVerdicts() != null ? canonical.getDimensionVerdicts() : Collections.emptyList());
        } catch (Exception e) {
            log.warn("Failed to serialize dimension verdicts: {}", e.getMessage());
        }

        final SentenceCheckAnalysisCache.CanonicalSentenceAnalysis finalCanonical = canonical;
        final String finalVerdictsJson = verdictsJson;
        final String finalSingleFlightStatus = singleFlightStatus;
        final int finalPrimaryCalls = primaryCalls;
        final int finalFallbackCalls = fallbackCalls;
        final String finalResultSource = resultSource;

        // Phase 2 (short atomic commit TX): re-check idempotencyKey, persist submission + assessment + issues + error memory, build DTO inside TX
        return inTx(() -> {
            Optional<SentenceCheckResultDto> concurrent = findIdempotentResult(userId, clientMutationId);
            if (concurrent.isPresent()) {
                return concurrent.get();
            }

            int wordCount = cleanText.split("\\s+").length;
            WritingSubmissionEntity submission = WritingSubmissionEntity.builder()
                    .id(UUID.randomUUID().toString())
                    .userId(userId)
                    .kind(SubmissionKind.SENTENCE_CHECK)
                    .content(cleanText)
                    .wordCount(wordCount)
                    .characterCount(cleanText.length())
                    .idempotencyKey(clientMutationId)
                    .build();
            submission = submissionRepository.save(submission);

            WritingAssessmentEntity assessment = WritingAssessmentEntity.builder()
                    .id(UUID.randomUUID().toString())
                    .submissionId(submission.getId())
                    .operation(AssessmentOperation.SENTENCE_CHECK)
                    .status(AssessmentStatus.READY)
                    .grammaticallyCorrect(finalCanonical.getGrammaticallyCorrect())
                    .coverageSummary(finalCanonical.getCoverageSummary())
                    .dimensionVerdicts(finalVerdictsJson)
                    .completedAt(Instant.now())
                    .build();
            assessment = assessmentRepository.save(assessment);

            List<WritingFeedbackIssueEntity> savedIssues = new ArrayList<>();
            int rank = 1;
            int errorCount = 0;
            int improvementCount = 0;
            int styleCount = 0;

            boolean isUnavailableOrInconclusive = finalCanonical.getAnalysisStatus() != null &&
                    ("ANALYSIS_UNAVAILABLE".equalsIgnoreCase(finalCanonical.getAnalysisStatus()) ||
                     "INCONCLUSIVE".equalsIgnoreCase(finalCanonical.getAnalysisStatus()));

            if (finalCanonical.getIssues() != null) {
                for (FeedbackIssueDto issueDto : finalCanonical.getIssues()) {
                    WritingFeedbackIssueEntity issueEntity = WritingFeedbackIssueEntity.builder()
                            .id(UUID.randomUUID().toString())
                            .assessmentId(assessment.getId())
                            .kind(issueDto.getKind() != null ? issueDto.getKind() : IssueKind.IMPROVEMENT)
                            .severity(issueDto.getSeverity() != null ? issueDto.getSeverity() : IssueSeverity.MINOR)
                            .category(issueDto.getCategory() != null ? issueDto.getCategory() : "Grammar")
                            .patternCode(issueDto.getPatternCode())
                            .title(issueDto.getTitle() != null ? issueDto.getTitle() : "Issue")
                            .explanation(issueDto.getExplanation() != null ? issueDto.getExplanation() : "")
                            .sourceQuote(issueDto.getSourceQuote())
                            .startOffset(issueDto.getStartOffset())
                            .endOffset(issueDto.getEndOffset())
                            .replacement(issueDto.getReplacement())
                            .teachingRule(issueDto.getTeachingRule())
                            .suggestedPracticeMode(issueDto.getSuggestedPracticeMode())
                            .disposition(IssueDisposition.ACTIVE)
                            .priorityRank(rank++)
                            .build();

                    WritingFeedbackIssueEntity savedIssue = issueRepository.save(issueEntity);
                    if (savedIssue == null) {
                        savedIssue = issueEntity;
                    }
                    savedIssues.add(savedIssue);

                    if (savedIssue.getKind() == IssueKind.ERROR) {
                        errorCount++;
                        if (!isUnavailableOrInconclusive) {
                            String patternCode = savedIssue.getPatternCode();
                            if (patternCode == null || patternCode.isBlank()) {
                                patternCode = "GENERAL_GRAMMAR_ACCURACY";
                            }
                            try {
                                errorMemoryService.recordMistakeObservation(
                                        userId,
                                        assessment.getId(),
                                        savedIssue.getId(),
                                        patternCode,
                                        submission.getId()
                                );
                            } catch (Exception e) {
                                log.warn("Failed to record mistake observation for pattern {}: {}", patternCode, e.getMessage());
                            }
                        }
                    } else if (savedIssue.getKind() == IssueKind.IMPROVEMENT) {
                        improvementCount++;
                    }
                    if ("Style".equalsIgnoreCase(savedIssue.getCategory()) || savedIssue.getSeverity() == IssueSeverity.SUGGESTION) {
                        styleCount++;
                    }
                }
            }

            String primaryModel = (writingAiClient.getSentenceLabModel() != null && !writingAiClient.getSentenceLabModel().isBlank())
                    ? writingAiClient.getSentenceLabModel()
                    : "openai/gpt-5.6-luna";
            String fallbackModel = (writingAiClient.getSentenceLabFallbackModel() != null && !writingAiClient.getSentenceLabFallbackModel().isBlank())
                    ? writingAiClient.getSentenceLabFallbackModel()
                    : "deepseek/deepseek-v3.2";

            log.info("[SENTENCE_LAB] requestId={} fingerprint={} cache=MISS singleFlight={} primaryModel={} primaryCalls={} fallbackModel={} fallbackCalls={} resultSource={} validatedErrorCount={} improvementCount={} styleSuggestionCount={}",
                    submission.getId(),
                    inputHash,
                    finalSingleFlightStatus,
                    primaryModel,
                    finalPrimaryCalls,
                    fallbackModel,
                    finalFallbackCalls,
                    finalResultSource,
                    errorCount,
                    improvementCount,
                    styleCount);

            return buildResultDto(submission, assessment, savedIssues, finalCanonical.getSuggestedImprovement(), finalCanonical.getExplanation());
        });
    }

    private SentenceCheckAnalysisCache.CanonicalSentenceAnalysis executeCanonicalPipeline(
            String cleanText,
            String targetRegister,
            String contextNote
    ) {
        SentenceAnalysisAiResponse aiResponse = null;
        try {
            aiResponse = writingAiClient.analyzeSentence(
                    cleanText,
                    targetRegister,
                    contextNote
            );
        } catch (Exception e) {
            log.warn("[SentenceCheck] AI analysis failed or timed out: {}", e.getMessage());
        }

        List<FeedbackIssueDto> rawAiIssues = (aiResponse != null && aiResponse.getIssues() != null)
                ? aiResponse.getIssues()
                : Collections.emptyList();
        Boolean aiGrammaticallyCorrect = (aiResponse != null) ? aiResponse.getGrammaticallyCorrect() : null;

        DeterministicGrammarValidator.ValidationResult validationResult = deterministicGrammarValidator.validateAndFilterIssues(
                cleanText,
                rawAiIssues,
                aiGrammaticallyCorrect
        );

        List<FeedbackIssueDto> canonicalDtoIssues = new ArrayList<>();
        int rank = 1;
        for (FeedbackIssueDto issueDto : validationResult.getValidatedIssues()) {
            int start = issueDto.getStartOffset() != null ? issueDto.getStartOffset() : 0;
            int end = issueDto.getEndOffset() != null ? issueDto.getEndOffset() : 0;
            String quote = issueDto.getSourceQuote() != null ? issueDto.getSourceQuote().trim() : "";

            if (!quote.isEmpty() && (start < 0 || end > cleanText.length() || !cleanText.substring(Math.max(0, start), Math.min(cleanText.length(), end)).equals(quote))) {
                int foundPos = cleanText.indexOf(quote);
                if (foundPos != -1) {
                    start = foundPos;
                    end = foundPos + quote.length();
                } else {
                    start = 0;
                    end = cleanText.length();
                    quote = cleanText;
                }
            }

            String issueCat = issueDto.getCategory() != null ? issueDto.getCategory() : "Grammar";
            if ("Punctuation".equalsIgnoreCase(issueCat) && (
                    (issueDto.getPatternCode() != null && issueDto.getPatternCode().toUpperCase().contains("CAPITALIZATION")) ||
                    (issueDto.getTitle() != null && (issueDto.getTitle().toLowerCase().contains("viết hoa") || issueDto.getTitle().toLowerCase().contains("capitalization")))
            )) {
                issueCat = "Capitalization";
            }

            FeedbackIssueDto alignedDto = FeedbackIssueDto.builder()
                    .id(issueDto.getId() != null ? issueDto.getId() : UUID.randomUUID().toString())
                    .kind(issueDto.getKind() != null ? issueDto.getKind() : IssueKind.IMPROVEMENT)
                    .severity(issueDto.getSeverity() != null ? issueDto.getSeverity() : IssueSeverity.MINOR)
                    .category(issueCat)
                    .patternCode(issueDto.getPatternCode())
                    .title(issueDto.getTitle() != null ? issueDto.getTitle() : "Issue")
                    .explanation(issueDto.getExplanation() != null ? issueDto.getExplanation() : "")
                    .sourceQuote(quote)
                    .startOffset(start)
                    .endOffset(end)
                    .replacement(issueDto.getReplacement())
                    .teachingRule(issueDto.getTeachingRule())
                    .suggestedPracticeMode(issueDto.getSuggestedPracticeMode())
                    .disposition(IssueDisposition.ACTIVE)
                    .priorityRank(rank++)
                    .build();
            canonicalDtoIssues.add(alignedDto);
        }

        Boolean isCorrect;
        if (aiResponse != null && aiResponse.getGrammaticallyCorrect() == null &&
                ("ANALYSIS_UNAVAILABLE".equalsIgnoreCase(aiResponse.getAnalysisStatus()) ||
                 "INCONCLUSIVE".equalsIgnoreCase(aiResponse.getAnalysisStatus()))) {
            isCorrect = null;
        } else if (validationResult.hasConfirmedGrammarError()) {
            isCorrect = false;
        } else {
            isCorrect = validationResult.isGrammaticallyCorrect();
        }

        String finalExplanation = (aiResponse != null) ? aiResponse.getExplanation() : null;
        if (Boolean.TRUE.equals(isCorrect)) {
            finalExplanation = "Ngữ pháp câu chuẩn xác. Không phát hiện lỗi cấu trúc hay sự hòa hợp ngữ pháp.";
        } else if (Boolean.FALSE.equals(isCorrect) && (finalExplanation == null || finalExplanation.isBlank() || finalExplanation.toLowerCase().contains("inconclusive"))) {
            finalExplanation = String.format("Phát hiện %d điểm ngữ pháp cần điều chỉnh để chuẩn xác.", canonicalDtoIssues.size());
        }

        List<DimensionVerdictDto> dimensionVerdicts = (aiResponse != null && aiResponse.getDimensionVerdicts() != null)
                ? aiResponse.getDimensionVerdicts()
                : Collections.emptyList();

        String analysisStatus = "COMPLETED";
        if (isCorrect == null) {
            analysisStatus = "ANALYSIS_UNAVAILABLE";
        }

        String correctedSentence = buildCoherentCorrectedSentenceFromDtos(cleanText, canonicalDtoIssues);
        String suggestedImprovement = (aiResponse != null) ? aiResponse.getSuggestedImprovement() : null;
        String modelUsed = (aiResponse != null && aiResponse.getModelUsed() != null) ? aiResponse.getModelUsed() : writingAiClient.getSentenceLabModel();
        String resultSource = (aiResponse != null && aiResponse.getResultSource() != null) ? aiResponse.getResultSource() : "PRIMARY";

        return SentenceCheckAnalysisCache.CanonicalSentenceAnalysis.builder()
                .grammaticallyCorrect(isCorrect)
                .analysisStatus(analysisStatus)
                .coverageSummary(finalExplanation)
                .explanation(finalExplanation)
                .suggestedImprovement(suggestedImprovement)
                .correctedSentence(correctedSentence)
                .dimensionVerdicts(dimensionVerdicts)
                .issues(canonicalDtoIssues)
                .modelUsed(modelUsed)
                .resultSource(resultSource)
                .build();
    }

    @Override
    @Transactional(readOnly = true)
    public SentenceCheckResultDto getAssessment(Long userId, String assessmentId) {
        WritingAssessmentEntity assessment = assessmentRepository.findById(assessmentId)
                .orElseThrow(() -> new WritingNotFoundException("Assessment not found: " + assessmentId));

        WritingSubmissionEntity submission = submissionRepository.findById(assessment.getSubmissionId())
                .orElseThrow(() -> new WritingNotFoundException("Submission not found for assessment: " + assessmentId));

        if (!submission.getUserId().equals(userId)) {
            throw new WritingNotFoundException("Assessment not found: " + assessmentId);
        }

        return buildResultDto(submission, assessment);
    }

    @Override
    public SentenceCheckResultDto retryAssessment(Long userId, String assessmentId) {
        // Phase 1 (short TX under PESSIMISTIC_WRITE row lock): verify owner + status + retry cap + active lease, claim lease & commit
        RetryPhase1 phase1 = inTx(() -> {
            WritingAssessmentEntity assessment = lockAssessmentById(assessmentId);

            WritingSubmissionEntity submission = submissionRepository.findById(assessment.getSubmissionId())
                    .orElseThrow(() -> new WritingNotFoundException("Submission not found for assessment: " + assessmentId));

            if (!submission.getUserId().equals(userId)) {
                throw new WritingNotFoundException("Assessment not found: " + assessmentId);
            }

            if (assessment.getStatus() == AssessmentStatus.READY) {
                return new RetryPhase1(buildResultDto(submission, assessment), null, null);
            }

            if (assessment.getStatus() == AssessmentStatus.RUNNING
                    && assessment.getLeaseExpiresAt() != null
                    && assessment.getLeaseExpiresAt().isAfter(Instant.now())) {
                throw new WritingConflictException("Assessment retry already in progress: " + assessmentId);
            }

            if (assessment.getRetryCount() >= assessment.getMaxRetries()) {
                throw new WritingConflictException("Maximum retries (" + assessment.getMaxRetries() + ") reached for assessment: " + assessmentId);
            }

            String leaseToken = UUID.randomUUID().toString();
            assessment.setRetryCount(assessment.getRetryCount() + 1);
            assessment.setStatus(AssessmentStatus.RUNNING);
            assessment.setLeaseToken(leaseToken);
            assessment.setLeaseExpiresAt(Instant.now().plusSeconds(60));
            assessmentRepository.save(assessment);

            return new RetryPhase1(null, submission.getContent(), leaseToken);
        });

        if (phase1.readyDto() != null) {
            return phase1.readyDto();
        }

        // External AI HTTP call completely OUTSIDE any DB transaction
        SentenceAnalysisAiResponse aiResponse;
        try {
            aiResponse = writingAiClient.analyzeSentence(
                    phase1.content(),
                    "formal",
                    null
            );
        } catch (RuntimeException ex) {
            // Release our lease cleanly in a short TX before propagating failure
            try {
                inTx(() -> {
                    WritingAssessmentEntity assessment = lockAssessmentById(assessmentId);
                    if (phase1.leaseToken().equals(assessment.getLeaseToken()) && assessment.getStatus() != AssessmentStatus.READY) {
                        assessment.setStatus(AssessmentStatus.FAILED_RETRYABLE);
                        assessment.setLeaseToken(null);
                        assessment.setLeaseExpiresAt(null);
                        assessmentRepository.save(assessment);
                    }
                    return null;
                });
            } catch (Exception cleanupEx) {
                log.warn("Failed to release retry lease for assessment {}: {}", assessmentId, cleanupEx.getMessage());
            }
            throw ex;
        }

        // Phase 2 (short atomic commit TX): lock row (PESSIMISTIC_WRITE), re-verify owner + status != READY + lease token, persist & build DTO
        final SentenceAnalysisAiResponse finalAiResponse = aiResponse;
        return inTx(() -> {
            WritingAssessmentEntity assessment = lockAssessmentById(assessmentId);

            WritingSubmissionEntity submission = submissionRepository.findById(assessment.getSubmissionId())
                    .orElseThrow(() -> new WritingNotFoundException("Submission not found for assessment: " + assessmentId));

            if (!submission.getUserId().equals(userId)) {
                throw new WritingNotFoundException("Assessment not found: " + assessmentId);
            }

            if (assessment.getStatus() == AssessmentStatus.READY) {
                return buildResultDto(submission, assessment);
            }

            if (!phase1.leaseToken().equals(assessment.getLeaseToken())) {
                throw new WritingConflictException("Assessment retry lease was superseded: " + assessmentId);
            }

            assessment.setStatus(AssessmentStatus.READY);
            assessment.setGrammaticallyCorrect(finalAiResponse.getGrammaticallyCorrect());
            assessment.setCoverageSummary(finalAiResponse.getExplanation());
            assessment.setCompletedAt(Instant.now());
            assessment.setLeaseToken(null);
            assessment.setLeaseExpiresAt(null);
            assessmentRepository.save(assessment);

            return buildResultDto(submission, assessment);
        });
    }

    private SentenceCheckResultDto buildResultDto(WritingSubmissionEntity submission, WritingAssessmentEntity assessment) {
        List<WritingFeedbackIssueEntity> issueEntities = issueRepository.findByAssessmentIdOrderByPriorityRankAsc(assessment.getId());
        return buildResultDto(submission, assessment, issueEntities, null, assessment.getCoverageSummary());
    }

    private SentenceCheckResultDto buildResultDto(
            WritingSubmissionEntity submission,
            WritingAssessmentEntity assessment,
            List<WritingFeedbackIssueEntity> issueEntities,
            String suggestedImprovement,
            String explanation
    ) {
        List<DimensionVerdictDto> verdicts = new ArrayList<>();
        try {
            verdicts = objectMapper.readValue(
                    assessment.getDimensionVerdicts(),
                    new TypeReference<List<DimensionVerdictDto>>() {}
            );
        } catch (Exception e) {
            log.warn("Failed to deserialize dimension verdicts: {}", e.getMessage());
        }

        List<FeedbackIssueDto> issueDtos = new ArrayList<>();
        for (WritingFeedbackIssueEntity entity : issueEntities) {
            issueDtos.add(FeedbackIssueDto.builder()
                    .id(entity.getId())
                    .kind(entity.getKind())
                    .severity(entity.getSeverity())
                    .category(entity.getCategory())
                    .patternCode(entity.getPatternCode())
                    .title(entity.getTitle())
                    .explanation(entity.getExplanation())
                    .sourceQuote(entity.getSourceQuote())
                    .startOffset(entity.getStartOffset())
                    .endOffset(entity.getEndOffset())
                    .replacement(entity.getReplacement())
                    .teachingRule(entity.getTeachingRule())
                    .suggestedPracticeMode(entity.getSuggestedPracticeMode())
                    .disposition(entity.getDisposition())
                    .priorityRank(entity.getPriorityRank())
                    .build());
        }

        String analysisStatus = "COMPLETED";
        if (assessment.getGrammaticallyCorrect() == null) {
            analysisStatus = "ANALYSIS_UNAVAILABLE";
        }

        String correctedSentence = buildCoherentCorrectedSentence(submission.getContent(), issueEntities);

        return SentenceCheckResultDto.builder()
                .assessmentId(assessment.getId())
                .submissionId(submission.getId())
                .status(assessment.getStatus())
                .grammaticallyCorrect(assessment.getGrammaticallyCorrect())
                .analysisStatus(analysisStatus)
                .coverageSummary(assessment.getCoverageSummary())
                .dimensionVerdicts(verdicts)
                .issues(issueDtos)
                .suggestedImprovement(suggestedImprovement)
                .explanation(explanation != null ? explanation : assessment.getCoverageSummary())
                .createdAt(assessment.getCreatedAt())
                .originalText(submission.getContent())
                .correctedSentence(correctedSentence)
                .build();
    }

    private record TrimmedEdit(int start, int end, String replacement, int priorityRank) {}

    private TrimmedEdit trimEdit(int start, int end, String quote, String replacement, int priorityRank) {
        if (quote == null) quote = "";
        if (replacement == null) replacement = "";

        int qLen = quote.length();
        int rLen = replacement.length();

        // Find common prefix
        int p = 0;
        while (p < qLen && p < rLen && quote.charAt(p) == replacement.charAt(p)) {
            p++;
        }

        // Find common suffix without overlapping prefix
        int s = 0;
        while (s < (qLen - p) && s < (rLen - p) && quote.charAt(qLen - 1 - s) == replacement.charAt(rLen - 1 - s)) {
            s++;
        }

        int trimmedStart = start + p;
        int trimmedEnd = end - s;
        String trimmedRep = replacement.substring(p, rLen - s);

        return new TrimmedEdit(trimmedStart, trimmedEnd, trimmedRep, priorityRank);
    }

    private String buildCoherentCorrectedSentence(String originalText, List<WritingFeedbackIssueEntity> issues) {
        if (originalText == null || originalText.isBlank()) {
            return originalText;
        }

        String currentText = originalText;

        // 1. Compose initial candidate edits from validated ERROR issues
        if (issues != null && !issues.isEmpty()) {
            List<TrimmedEdit> candidateEdits = new ArrayList<>();
            for (WritingFeedbackIssueEntity issue : issues) {
                if (issue.getKind() != IssueKind.ERROR) continue;
                if (issue.getReplacement() == null) continue;
                if (issue.getStartOffset() == null || issue.getEndOffset() == null) continue;
                int start = issue.getStartOffset();
                int end = issue.getEndOffset();
                if (start < 0 || end > currentText.length() || start > end) continue;

                String quote = issue.getSourceQuote() != null ? issue.getSourceQuote() : currentText.substring(start, end);
                int rank = issue.getPriorityRank() != null ? issue.getPriorityRank() : 99;

                TrimmedEdit trimmed = trimEdit(start, end, quote, issue.getReplacement(), rank);
                if (trimmed.start() < trimmed.end() || !trimmed.replacement().isEmpty()) {
                    candidateEdits.add(trimmed);
                }
            }

            currentText = applyNonOverlappingEdits(currentText, candidateEdits);
        }

        // 2. Post-edit grammar sanity pass: Validate locally with deterministic rules (up to 2 iterations)
        if (deterministicGrammarValidator != null) {
            for (int iter = 0; iter < 2; iter++) {
                List<FeedbackIssueDto> sanityIssues = deterministicGrammarValidator.checkDeterministicRules(currentText);
                List<TrimmedEdit> sanityEdits = new ArrayList<>();
                for (FeedbackIssueDto issue : sanityIssues) {
                    if (issue.getKind() != IssueKind.ERROR) continue;
                    if (issue.getReplacement() == null) continue;
                    if (issue.getStartOffset() == null || issue.getEndOffset() == null) continue;
                    int start = issue.getStartOffset();
                    int end = issue.getEndOffset();
                    if (start < 0 || end > currentText.length() || start > end) continue;

                    String quote = issue.getSourceQuote() != null ? issue.getSourceQuote() : currentText.substring(start, end);
                    int rank = issue.getPriorityRank() != null ? issue.getPriorityRank() : 99;
                    TrimmedEdit trimmed = trimEdit(start, end, quote, issue.getReplacement(), rank);
                    if (trimmed.start() < trimmed.end() || !trimmed.replacement().isEmpty()) {
                        sanityEdits.add(trimmed);
                    }
                }

                if (sanityEdits.isEmpty()) {
                    break;
                }

                String updated = applyNonOverlappingEdits(currentText, sanityEdits);
                if (updated.equals(currentText)) {
                    break;
                }
                currentText = updated;
            }
        }

        return currentText;
    }

    private String buildCoherentCorrectedSentenceFromDtos(String originalText, List<FeedbackIssueDto> issues) {
        if (originalText == null || originalText.isBlank()) {
            return originalText;
        }

        String currentText = originalText;

        if (issues != null && !issues.isEmpty()) {
            List<TrimmedEdit> candidateEdits = new ArrayList<>();
            for (FeedbackIssueDto issue : issues) {
                if (issue.getKind() != IssueKind.ERROR) continue;
                if (issue.getReplacement() == null) continue;
                if (issue.getStartOffset() == null || issue.getEndOffset() == null) continue;
                int start = issue.getStartOffset();
                int end = issue.getEndOffset();
                if (start < 0 || end > currentText.length() || start > end) continue;

                String quote = issue.getSourceQuote() != null ? issue.getSourceQuote() : currentText.substring(start, end);
                int rank = issue.getPriorityRank() != null ? issue.getPriorityRank() : 99;

                TrimmedEdit trimmed = trimEdit(start, end, quote, issue.getReplacement(), rank);
                if (trimmed.start() < trimmed.end() || !trimmed.replacement().isEmpty()) {
                    candidateEdits.add(trimmed);
                }
            }

            currentText = applyNonOverlappingEdits(currentText, candidateEdits);
        }

        if (deterministicGrammarValidator != null) {
            for (int iter = 0; iter < 2; iter++) {
                List<FeedbackIssueDto> sanityIssues = deterministicGrammarValidator.checkDeterministicRules(currentText);
                List<TrimmedEdit> sanityEdits = new ArrayList<>();
                for (FeedbackIssueDto issue : sanityIssues) {
                    if (issue.getKind() != IssueKind.ERROR) continue;
                    if (issue.getReplacement() == null) continue;
                    if (issue.getStartOffset() == null || issue.getEndOffset() == null) continue;
                    int start = issue.getStartOffset();
                    int end = issue.getEndOffset();
                    if (start < 0 || end > currentText.length() || start > end) continue;

                    String quote = issue.getSourceQuote() != null ? issue.getSourceQuote() : currentText.substring(start, end);
                    int rank = issue.getPriorityRank() != null ? issue.getPriorityRank() : 99;
                    TrimmedEdit trimmed = trimEdit(start, end, quote, issue.getReplacement(), rank);
                    if (trimmed.start() < trimmed.end() || !trimmed.replacement().isEmpty()) {
                        sanityEdits.add(trimmed);
                    }
                }

                if (sanityEdits.isEmpty()) {
                    break;
                }

                String updated = applyNonOverlappingEdits(currentText, sanityEdits);
                if (updated.equals(currentText)) {
                    break;
                }
                currentText = updated;
            }
        }

        return currentText;
    }

    private String applyNonOverlappingEdits(String text, List<TrimmedEdit> edits) {
        if (edits == null || edits.isEmpty() || text == null) {
            return text;
        }

        // Sort by priority rank first (ascending: rank 1 is highest priority), then earlier start
        List<TrimmedEdit> sortedByPriority = new ArrayList<>(edits);
        sortedByPriority.sort(Comparator.comparingInt(TrimmedEdit::priorityRank)
                .thenComparingInt(TrimmedEdit::start));

        List<TrimmedEdit> acceptedEdits = new ArrayList<>();
        for (TrimmedEdit edit : sortedByPriority) {
            boolean overlaps = false;
            for (TrimmedEdit accepted : acceptedEdits) {
                // If both are zero-length insertions at the same position, or spans overlap
                if (edit.start() == edit.end() && accepted.start() == accepted.end() && edit.start() == accepted.start()) {
                    overlaps = true;
                    break;
                }
                if (Math.max(edit.start(), accepted.start()) < Math.min(edit.end(), accepted.end())) {
                    overlaps = true;
                    break;
                }
            }
            if (!overlaps) {
                acceptedEdits.add(edit);
            }
        }

        // Sort accepted edits by start position DESCENDING so replacements from right to left don't invalidate left offsets
        acceptedEdits.sort(Comparator.comparingInt(TrimmedEdit::start).reversed());

        StringBuilder sb = new StringBuilder(text);
        for (TrimmedEdit edit : acceptedEdits) {
            if (edit.start() <= sb.length() && edit.end() <= sb.length()) {
                sb.replace(edit.start(), edit.end(), edit.replacement());
            }
        }

        return sb.toString();
    }

    private boolean isGrammarIssue(WritingFeedbackIssueEntity issue) {
        if (issue.getCategory() != null && !issue.getCategory().isBlank()) {
            String cat = issue.getCategory();
            return "Grammar".equalsIgnoreCase(cat) || "Capitalization".equalsIgnoreCase(cat) || "Orthography".equalsIgnoreCase(cat) || "Spelling".equalsIgnoreCase(cat);
        }
        if (issue.getPatternCode() != null) {
            Map<String, Object> meta = catalogService.getErrorPatternByCode(issue.getPatternCode()).orElse(Collections.emptyMap());
            String cat = (String) meta.get("category");
            return cat == null || "Grammar".equalsIgnoreCase(cat) || "Capitalization".equalsIgnoreCase(cat) || "Orthography".equalsIgnoreCase(cat) || "Spelling".equalsIgnoreCase(cat);
        }
        return true;
    }
}
