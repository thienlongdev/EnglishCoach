package com.englishcoach.speaking.service;

import com.englishcoach.speaking.dto.*;
import com.englishcoach.speaking.entity.SpeakingScenario;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.speaking.entity.SpeakingTurnFeedback;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingTurnFeedbackRepository;
import com.englishcoach.speaking.repository.SpeakingTurnRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import jakarta.persistence.EntityManager;
import jakarta.persistence.LockModeType;
import jakarta.persistence.PersistenceContext;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

@Service
@RequiredArgsConstructor
@Slf4j
public class SpeakingRoleplayService {

    private static final long MAX_AUDIO_BYTES = 25 * 1024 * 1024L;
    private static final Pattern CLIENT_TURN_ID_PATTERN = Pattern.compile("^[a-zA-Z0-9_-]{1,90}$");
    private static final long AI_DIALOGUE_TIMEOUT_SECONDS = 30L;
    private static final long PRONUNCIATION_TOTAL_BUDGET_MS = 20_000L;
    private static final long PRONUNCIATION_POST_DIALOGUE_GRACE_MS = 4_000L;
    private static final AtomicInteger WORKER_SEQ = new AtomicInteger(0);

    private final ExecutorService roleplayExecutor = new ThreadPoolExecutor(
            4,
            4,
            60L,
            TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(64),
            runnable -> {
                Thread t = new Thread(runnable, "roleplay-ai-worker-" + WORKER_SEQ.incrementAndGet());
                t.setDaemon(true);
                return t;
            },
            new ThreadPoolExecutor.CallerRunsPolicy()
    );

    @PreDestroy
    public void shutdownExecutor() {
        roleplayExecutor.shutdown();
        try {
            if (!roleplayExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                roleplayExecutor.shutdownNow();
            }
        } catch (InterruptedException e) {
            roleplayExecutor.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    private final SpeakingSessionRepository speakingSessionRepository;
    private final SpeakingTurnRepository speakingTurnRepository;
    private final SpeakingTurnFeedbackRepository speakingTurnFeedbackRepository;
    private final SpeakingService speakingService;
    private final SpeakingContextService speakingContextService;
    private final SpeakingAudioStorageService speakingAudioStorageService;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private ObjectMapper objectMapper = new ObjectMapper();

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.context.ApplicationEventPublisher eventPublisher;

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

    private SpeakingSession lockSessionById(Long sessionId) {
        if (entityManager != null) {
            SpeakingSession locked = entityManager.find(SpeakingSession.class, sessionId, LockModeType.PESSIMISTIC_WRITE);
            if (locked == null) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking session not found: " + sessionId);
            }
            return locked;
        }
        return speakingSessionRepository.findById(sessionId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking session not found: " + sessionId));
    }

    private record RoleplayContext(
            String scenarioTitle,
            String cefrLevel,
            String aiRole,
            String learnerRole,
            String learnerGoal,
            List<String> targetVocabulary,
            List<String> targetGrammar,
            List<String> optionalHints,
            List<String> successCriteria,
            String completionConditions,
            String evaluationRubric,
            List<Map<String, String>> historyList
    ) {}

    private record RoleplayPhase1(
            RoleplayTurnResponseDto replayResponse,
            RoleplayContext context
    ) {}

    @Value("${ai.base-url:http://localhost:8000}")
    private String aiBaseUrl;

    @Value("${ai.timeout.connect:10000}")
    private int connectTimeoutMs;

    @Value("${ai.timeout.read:45000}")
    private int readTimeoutMs;

    private record AiRoleplayResult(
            String assistantText,
            List<String> detectedVocab,
            boolean isTaskCompleted,
            boolean isDialogueMocked,
            String positiveFeedback,
            String summary,
            String correctionsJson
    ) {}

    private RestTemplate createRestTemplateWithTimeout() {
        SimpleClientHttpRequestFactory factory = new com.englishcoach.common.ai.AiServiceRequestFactory();
        factory.setConnectTimeout(connectTimeoutMs);
        factory.setReadTimeout(readTimeoutMs);
        return new RestTemplate(factory);
    }

    public List<SpeakingTurnDto> getSessionTurns(Long userId, Long sessionId) {
        try {
            return inTx(() -> loadOrInitSessionTurns(userId, sessionId, true));
        } catch (DataIntegrityViolationException dive) {
            // Concurrent initial-turn insert raced and rolled back cleanly; re-read in a fresh read TX (zero 25P02).
            log.warn("Concurrent initial turn insert for session {}: {}", sessionId, dive.getMessage());
            return inReadTx(() -> loadOrInitSessionTurns(userId, sessionId, false));
        }
    }

    private List<SpeakingTurnDto> loadOrInitSessionTurns(Long userId, Long sessionId, boolean allowInit) {
        SpeakingSession session = speakingSessionRepository.findById(sessionId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking session not found: " + sessionId));

        if (!session.getUser().getId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Unauthorized access to speaking session");
        }

        List<SpeakingTurn> turns = speakingTurnRepository.findBySessionIdOrderBySequenceNumberAsc(sessionId);
        if (allowInit && turns.isEmpty() && "ROLEPLAY".equalsIgnoreCase(session.getMode()) && session.getScenario() != null) {
            // Serialize concurrent initial-turn creation under a PESSIMISTIC_WRITE row lock before inserting.
            SpeakingSession lockedSession = lockSessionById(sessionId);
            turns = speakingTurnRepository.findBySessionIdOrderBySequenceNumberAsc(sessionId);
            if (turns.isEmpty() && lockedSession.getScenario() != null) {
                SpeakingScenario scenario = lockedSession.getScenario();
                String initialText = scenario.getInitialAiMessage();
                if (initialText == null || initialText.isBlank()) {
                    initialText = "Hello, welcome! How can I assist you with your " + scenario.getTitle() + " today?";
                }
                String voiceId = SpeakingTtsService.sanitizeVoiceId(lockedSession.getVoiceId());
                String hash = SpeakingTtsService.computeCacheKey(voiceId, initialText);
                String cachedRef = null;
                if (speakingAudioStorageService.ttsAudioExists(voiceId, hash)) {
                    cachedRef = "tts/" + voiceId + "/" + hash + ".wav";
                }
                SpeakingTurn initialTurn = SpeakingTurn.builder()
                        .session(lockedSession)
                        .clientTurnId("initial-" + lockedSession.getId())
                        .sequenceNumber(1)
                        .speaker("ASSISTANT")
                        .text(initialText)
                        .detectedVocabulary(new ArrayList<>())
                        .isMocked(false)
                        .durationSeconds(5)
                        .synthesizedAudioRef(cachedRef)
                        .build();
                SpeakingTurn saved = speakingTurnRepository.save(initialTurn);
                turns = List.of(saved);
            }
        }

        return turns.stream().map(turn -> {
            SpeakingTurnFeedbackDto fb = null;
            if ("LEARNER".equalsIgnoreCase(turn.getSpeaker())) {
                fb = speakingTurnFeedbackRepository.findByTurnId(turn.getId())
                        .map(SpeakingTurnFeedbackDto::fromEntity)
                        .orElse(null);
            }
            return SpeakingTurnDto.fromEntity(turn, fb);
        }).toList();
    }

    @Transactional(readOnly = true)
    public PronunciationV2ResponseDto getTurnPronunciation(Long userId, Long sessionId, Long turnId) {
        SpeakingSession session = speakingSessionRepository.findById(sessionId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking session not found: " + sessionId));

        if (!session.getUser().getId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Unauthorized access to speaking session");
        }

        SpeakingTurn turn = speakingTurnRepository.findById(turnId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking turn not found: " + turnId));

        if (!turn.getSession().getId().equals(sessionId)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Turn does not belong to session: " + sessionId);
        }

        if (turn.getPronunciationResultJson() != null && !turn.getPronunciationResultJson().isBlank()) {
            try {
                return objectMapper.readValue(turn.getPronunciationResultJson(), PronunciationV2ResponseDto.class).useMeasuredStress();
            } catch (Exception e) {
                log.warn("Failed to deserialize pronunciationResultJson for turn {}: {}", turnId, e.getMessage());
            }
        }

        throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No pronunciation metrics available for turn: " + turnId);
    }

    @Transactional(readOnly = true)
    public SpeakingTurnFeedbackDto getTurnFeedback(Long userId, Long sessionId, Long turnId) {
        if (speakingSessionRepository == null || speakingTurnFeedbackRepository == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Feedback not yet generated for turn: " + turnId);
        }
        SpeakingSession session = speakingSessionRepository.findById(sessionId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking session not found: " + sessionId));
        if (session.getUser() == null || !session.getUser().getId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Unauthorized access to speaking session");
        }
        SpeakingTurn turn = speakingTurnRepository.findById(turnId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking turn not found: " + turnId));
        if (turn.getSession() == null || !turn.getSession().getId().equals(sessionId)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Turn does not belong to session: " + sessionId);
        }
        return speakingTurnFeedbackRepository.findByTurnId(turnId)
                .map(SpeakingTurnFeedbackDto::fromEntity)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Feedback not yet generated for turn: " + turnId));
    }

    public RoleplayTurnResponseDto processTurn(Long userId, Long sessionId, MultipartFile file, String clientTurnId) {
        final String normalizedClientTurnId;
        if (clientTurnId != null && !clientTurnId.isBlank()) {
            String trimmed = clientTurnId.trim();
            if (!CLIENT_TURN_ID_PATTERN.matcher(trimmed).matches()
                    || trimmed.toLowerCase(Locale.ROOT).startsWith("initial-")) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid clientTurnId format");
            }
            normalizedClientTurnId = trimmed;
        } else {
            normalizedClientTurnId = null;
        }

        // Phase 1 (short read TX): validate owner/mode/status, check idempotent replay,
        // and copy ALL lazy scenario collections + turn history into an immutable detached record.
        RoleplayPhase1 phase1 = inReadTx(() -> {
            SpeakingSession session = speakingSessionRepository.findById(sessionId)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking session not found: " + sessionId));

            if (!session.getUser().getId().equals(userId)) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Unauthorized access to speaking session");
            }

            if (!"ROLEPLAY".equalsIgnoreCase(session.getMode())) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Session is not in ROLEPLAY mode: " + session.getMode());
            }

            if (!"ACTIVE".equalsIgnoreCase(session.getStatus())) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot submit turns to a " + session.getStatus() + " session");
            }

            // Pre-Check Idempotency: If clientTurnId already completed, return existing turns without calling AI
            if (normalizedClientTurnId != null) {
                Optional<SpeakingTurn> existingTurnOpt = speakingTurnRepository.findBySessionIdAndClientTurnId(sessionId, normalizedClientTurnId);
                if (existingTurnOpt.isPresent()) {
                    log.info("Idempotent replay detected for sessionId={} clientTurnId={}", sessionId, normalizedClientTurnId);
                    return new RoleplayPhase1(buildIdempotentReplayResponse(sessionId, existingTurnOpt.get()), null);
                }
            }

            SpeakingScenario scenario = session.getScenario();
            String scenarioTitle = (scenario != null) ? scenario.getTitle() : "Real-life Conversation Practice";
            String cefrLevel = (scenario != null && scenario.getCefrLevel() != null) ? scenario.getCefrLevel().name() : "B1";
            String aiRole = (scenario != null && scenario.getAiRole() != null) ? scenario.getAiRole() : "Conversation Partner";
            String learnerRole = (scenario != null && scenario.getLearnerRole() != null) ? scenario.getLearnerRole() : "Learner";
            String learnerGoal = (scenario != null && scenario.getLearnerGoal() != null) ? scenario.getLearnerGoal() : "Achieve task communication";

            Set<String> targetVocabSet = new LinkedHashSet<>();
            if (scenario != null && scenario.getTargetVocabulary() != null) {
                scenario.getTargetVocabulary().stream().filter(Objects::nonNull).forEach(targetVocabSet::add);
            }

            if (session.getSourceType() != null && session.getSourceId() != null) {
                try {
                    SpeakingContextDto inheritedContext = speakingContextService.resolveContext(
                            session.getSourceType(),
                            session.getSourceId(),
                            userId
                    );
                    if (inheritedContext.targetVocabulary() != null) {
                        inheritedContext.targetVocabulary().stream().filter(Objects::nonNull).forEach(targetVocabSet::add);
                    }
                } catch (Exception e) {
                    log.warn("Failed to resolve inherited lesson context for session {}: {}", sessionId, e.getMessage());
                }
            }

            List<String> targetGrammar = (scenario != null && scenario.getTargetGrammar() != null)
                    ? scenario.getTargetGrammar().stream().filter(Objects::nonNull).toList() : List.of();
            List<String> optionalHints = (scenario != null && scenario.getOptionalHints() != null)
                    ? scenario.getOptionalHints().stream().filter(Objects::nonNull).toList() : List.of();
            List<String> successCriteria = (scenario != null && scenario.getSuccessCriteria() != null)
                    ? scenario.getSuccessCriteria().stream().filter(Objects::nonNull).toList() : List.of();
            String completionConditions = scenario != null ? scenario.getCompletionConditions() : null;
            String evaluationRubric = scenario != null ? scenario.getEvaluationRubric() : null;

            List<SpeakingTurn> existingTurns = speakingTurnRepository.findBySessionIdOrderBySequenceNumberAsc(sessionId);

            // Limit history to last 10 turns (copied to immutable maps inside TX)
            List<Map<String, String>> historyList = existingTurns.stream()
                    .skip(Math.max(0, existingTurns.size() - 10))
                    .map(t -> Map.of("speaker", t.getSpeaker(), "text", t.getText()))
                    .toList();

            RoleplayContext ctx = new RoleplayContext(
                    scenarioTitle,
                    cefrLevel,
                    aiRole,
                    learnerRole,
                    learnerGoal,
                    List.copyOf(targetVocabSet),
                    targetGrammar,
                    optionalHints,
                    successCriteria,
                    completionConditions,
                    evaluationRubric,
                    historyList
            );
            return new RoleplayPhase1(null, ctx);
        });

        if (phase1.replayResponse() != null) {
            return phase1.replayResponse();
        }
        RoleplayContext ctx = phase1.context();

        // Read Audio Bytes Upfront for Concurrent Safety (NEVER pass MultipartFile into async threads!)
        if (file == null || file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio file payload is empty");
        }
        if (file.getSize() > MAX_AUDIO_BYTES) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio file exceeds maximum size limit of 25MB");
        }
        byte[] audioBytes;
        String originalFilename;
        String declaredContentType;
        try {
            audioBytes = file.getBytes();
            originalFilename = file.getOriginalFilename();
            if (originalFilename == null || originalFilename.isBlank()) {
                originalFilename = "turn.wav";
            }
            declaredContentType = file.getContentType();
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Failed to read audio file bytes: " + e.getMessage());
        }
        if (audioBytes == null || audioBytes.length == 0 || !SpeakingService.isSupportedAudioHeader(audioBytes)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported or invalid audio file format");
        }
        final String detectedMime = SpeakingService.detectAudioMime(audioBytes, originalFilename, declaredContentType);

        // Single ASR Pass using copied bytes (OUTSIDE any DB transaction)
        Map<String, Object> asrResult = speakingService.forwardAudioForAnalysis(audioBytes, originalFilename, detectedMime, null);
        String learnerTranscript = "";
        boolean isAsrMocked = false;

        if (asrResult != null && asrResult.get("transcription") != null) {
            learnerTranscript = String.valueOf(asrResult.get("transcription")).trim();
        } else if (asrResult != null && asrResult.get("transcript") instanceof Map transcriptMap && transcriptMap.get("text") != null) {
            learnerTranscript = String.valueOf(transcriptMap.get("text")).trim();
        }

        if (asrResult == null || Boolean.TRUE.equals(asrResult.get("isMocked"))) {
            isAsrMocked = true;
        }

        if (isAsrMocked) {
            log.error("Roleplay ASR returned mocked/unavailable response for sessionId={}; failing closed", sessionId);
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "AI_DIALOGUE_UNAVAILABLE");
        }

        if (learnerTranscript.isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "COULD_NOT_HEAR_SPEECH");
        }

        // Parallel Execution on dedicated bounded executor (OUTSIDE any DB transaction):
        // Branch A (Conversation Brain + Feedback) + Branch B (Pronunciation V2/V3 Acoustic Brain)
        String targetUrl = aiBaseUrl + "/api/v1/speaking/roleplay/turn";
        Map<String, Object> requestPayload = Map.of(
                "scenario_title", ctx.scenarioTitle(),
                "cefr_level", ctx.cefrLevel(),
                "ai_role", ctx.aiRole(),
                "learner_role", ctx.learnerRole(),
                "learner_goal", ctx.learnerGoal(),
                "target_vocabulary", ctx.targetVocabulary(),
                "target_grammar", ctx.targetGrammar(),
                "learner_transcript", learnerTranscript,
                "history", ctx.historyList()
        );

        final long parallelStartNanos = System.nanoTime();
        CompletableFuture<AiRoleplayResult> aiFuture = CompletableFuture.supplyAsync(() -> {
            RestTemplate restTemplate = createRestTemplateWithTimeout();
            ResponseEntity<Map> aiResponse = restTemplate.postForEntity(targetUrl, requestPayload, Map.class);
            Map responseBody = aiResponse.getBody();
            if (responseBody == null) {
                throw new IllegalStateException("Empty AI roleplay turn response");
            }
            String assistantText = responseBody.get("assistant_text") != null
                    ? String.valueOf(responseBody.get("assistant_text")).trim() : "";
            boolean isDialogueMocked = Boolean.TRUE.equals(responseBody.get("is_mocked"));
            if (isDialogueMocked || assistantText.isBlank()) {
                throw new IllegalStateException("AI roleplay turn returned mocked or empty reply");
            }
            List<String> detectedVocab = new ArrayList<>();
            if (responseBody.get("target_vocabulary_detected") instanceof List list) {
                for (Object item : list) {
                    if (item != null) detectedVocab.add(String.valueOf(item));
                }
            }
            boolean isTaskCompleted = Boolean.TRUE.equals(responseBody.get("task_completed"));
            String positiveFeedback = responseBody.get("positive_feedback") != null ? String.valueOf(responseBody.get("positive_feedback")) : null;
            String summary = responseBody.get("summary") != null ? String.valueOf(responseBody.get("summary")) : null;
            String correctionsJson = "[]";
            if (responseBody.get("corrections") != null) {
                try {
                    correctionsJson = objectMapper.writeValueAsString(responseBody.get("corrections"));
                } catch (Exception ignored) {}
            }
            return new AiRoleplayResult(assistantText, detectedVocab, isTaskCompleted, false, positiveFeedback, summary, correctionsJson);
        }, roleplayExecutor);

        final String finalTranscript = learnerTranscript;
        final byte[] audioBytesCopy = audioBytes;
        final String safeFilename = originalFilename;
        CompletableFuture<PronunciationV2ResponseDto> pronFuture = CompletableFuture.supplyAsync(() -> {
            try {
                return speakingService.analyzePronunciationV2(
                        audioBytesCopy,
                        safeFilename,
                        detectedMime,
                        finalTranscript,
                        finalTranscript,
                        String.valueOf(sessionId),
                        normalizedClientTurnId,
                        null
                );
            } catch (Exception e) {
                log.warn("Pronunciation acoustic analysis skipped or failed for sessionId={}, clientTurnId={}: {}",
                        sessionId, normalizedClientTurnId, e.getMessage());
                return null;
            }
        }, roleplayExecutor);

        // Decoupled futures: Dialogue has its own 30s timeout and fails closed on LLM failure/mock.
        // Pronunciation timeout NEVER blocks or mocks the learner's dialogue reply.
        AiRoleplayResult aiResult;
        try {
            aiResult = aiFuture.get(AI_DIALOGUE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            aiFuture.cancel(true);
            pronFuture.cancel(true);
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "AI_DIALOGUE_UNAVAILABLE");
        } catch (Exception e) {
            log.error("AI service roleplay turn failed or timed out at {}: {}", targetUrl, e.getMessage());
            aiFuture.cancel(true);
            pronFuture.cancel(true);
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "AI_DIALOGUE_UNAVAILABLE");
        }
        if (aiResult == null || aiResult.isDialogueMocked()
                || aiResult.assistantText() == null || aiResult.assistantText().isBlank()) {
            pronFuture.cancel(true);
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "AI_DIALOGUE_UNAVAILABLE");
        }

        PronunciationV2ResponseDto pronFeedback = null;
        try {
            if (pronFuture.isDone()) {
                pronFeedback = pronFuture.getNow(null);
            } else {
                long elapsedMs = (System.nanoTime() - parallelStartNanos) / 1_000_000L;
                long remainingPronBudgetMs = Math.max(0L, PRONUNCIATION_TOTAL_BUDGET_MS - elapsedMs);
                long graceWaitMs = Math.min(remainingPronBudgetMs, PRONUNCIATION_POST_DIALOGUE_GRACE_MS);
                if (graceWaitMs > 0L) {
                    pronFeedback = pronFuture.get(graceWaitMs, TimeUnit.MILLISECONDS);
                } else {
                    pronFuture.cancel(true);
                }
            }
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            pronFuture.cancel(true);
        } catch (Exception e) {
            log.warn("Pronunciation future exceeded grace window for sessionId={}, clientTurnId={}; continuing with dialogue reply",
                    sessionId, normalizedClientTurnId);
            pronFuture.cancel(true);
        }

        // Persist audio to durable local audio storage only after dialogue succeeds (OUTSIDE any DB transaction)
        String audioRef = null;
        boolean newlySavedAudio = false;
        if (normalizedClientTurnId != null && audioBytes.length > 0) {
            try {
                boolean existedBefore = speakingAudioStorageService.getAudioRefIfExists(userId, normalizedClientTurnId) != null;
                audioRef = speakingAudioStorageService.saveAttemptAudio(userId, normalizedClientTurnId, audioBytes, originalFilename);
                newlySavedAudio = !existedBefore && audioRef != null;
            } catch (Exception e) {
                log.warn("Failed to persist attempt audio for sessionId={} clientTurnId={}: {}", sessionId, normalizedClientTurnId, e.getMessage());
            }
        }

        final AiRoleplayResult finalAiResult = aiResult;
        final PronunciationV2ResponseDto finalPronFeedback = pronFeedback;
        final String assistantText = finalAiResult.assistantText();
        final List<String> detectedVocab = finalAiResult.detectedVocab() != null
                ? finalAiResult.detectedVocab().stream().filter(Objects::nonNull).toList() : List.of();
        final boolean isTaskCompleted = finalAiResult.isTaskCompleted();
        final boolean isDialogueMocked = false;

        // Extract Acoustic Metrics & real server-measured audio duration
        Integer pronScore = null;
        Integer fluencyScore = null;
        Integer stressScore = null;
        Integer intonationScore = null;
        Integer rhythmScore = null;
        Integer segmentalScore = null;
        String pronResultJson = null;

        if (finalPronFeedback != null && "COMPLETED".equals(finalPronFeedback.getStatus()) && finalPronFeedback.getOverall() != null) {
            pronScore = finalPronFeedback.getOverall().getOverallScore();
            fluencyScore = finalPronFeedback.getOverall().getFluencyScore();
            stressScore = finalPronFeedback.getOverall().getStressScore();
            intonationScore = finalPronFeedback.getOverall().getIntonationScore();
            rhythmScore = finalPronFeedback.getOverall().getRhythmScore();
            segmentalScore = finalPronFeedback.getOverall().getSegmentalScore();
        }
        if (finalPronFeedback != null) {
            try {
                pronResultJson = objectMapper.writeValueAsString(finalPronFeedback);
            } catch (Exception e) {
                log.warn("Failed to serialize pronFeedback for turn: {}", e.getMessage());
            }
        }

        final int learnerDurationSeconds = resolveMeasuredDurationSeconds(finalPronFeedback);
        final String resolvedEngineVersion = resolvePronEngineVersion(finalPronFeedback);

        final Integer finalPronScore = pronScore;
        final Integer finalFluencyScore = fluencyScore;
        final Integer finalStressScore = stressScore;
        final Integer finalIntonationScore = intonationScore;
        final Integer finalRhythmScore = rhythmScore;
        final Integer finalSegmentalScore = segmentalScore;
        final String finalPronResultJson = pronResultJson;
        final String finalAudioRef = audioRef;

        // Phase 2 (short atomic commit TX): acquire PESSIMISTIC_WRITE lock on SpeakingSession,
        // re-verify owner + mode + ACTIVE + clientTurnId, compute maxSeq under lock, save all rows atomically,
        // publish RoleplayTurnRecordedEvent inside TX, and build full RoleplayTurnResponseDto inside TX.
        boolean committed = false;
        try {
            RoleplayTurnResponseDto response = inTx(() -> {
                SpeakingSession session = lockSessionById(sessionId);

                if (!session.getUser().getId().equals(userId)) {
                    throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Unauthorized access to speaking session");
                }
                if (!"ROLEPLAY".equalsIgnoreCase(session.getMode())) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Session is not in ROLEPLAY mode: " + session.getMode());
                }
                if (!"ACTIVE".equalsIgnoreCase(session.getStatus())) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot submit turns to a " + session.getStatus() + " session");
                }

                if (normalizedClientTurnId != null) {
                    Optional<SpeakingTurn> existingUnderLock = speakingTurnRepository.findBySessionIdAndClientTurnId(sessionId, normalizedClientTurnId);
                    if (existingUnderLock.isPresent()) {
                        log.info("Idempotent replay detected under lock for sessionId={} clientTurnId={}", sessionId, normalizedClientTurnId);
                        return buildIdempotentReplayResponse(sessionId, existingUnderLock.get());
                    }
                }

                int currentMaxSeq = speakingTurnRepository.findMaxSequenceNumberBySessionId(sessionId);

                SpeakingTurn learnerTurn = SpeakingTurn.builder()
                        .session(session)
                        .clientTurnId(normalizedClientTurnId)
                        .sequenceNumber(currentMaxSeq + 1)
                        .speaker("LEARNER")
                        .text(finalTranscript)
                        .detectedVocabulary(new ArrayList<>(detectedVocab))
                        .isMocked(false)
                        .durationSeconds(learnerDurationSeconds)
                        .pronunciationScore(finalPronScore)
                        .fluencyScore(finalFluencyScore)
                        .stressScore(finalStressScore)
                        .intonationScore(finalIntonationScore)
                        .rhythmScore(finalRhythmScore)
                        .segmentalScore(finalSegmentalScore)
                        .audioRef(finalAudioRef)
                        .engineVersion(resolvedEngineVersion)
                        .pronunciationResultJson(finalPronResultJson)
                        .build();
                SpeakingTurn savedLearnerTurn = speakingTurnRepository.save(learnerTurn);

                // Persist structured feedback atomically inside TX (no caught SQL exception hazard / zero 25P02)
                SpeakingTurnFeedback feedback = SpeakingTurnFeedback.builder()
                        .turn(savedLearnerTurn)
                        .summary(finalAiResult.summary() != null && !finalAiResult.summary().isBlank() ? finalAiResult.summary() : "Giao tiếp rõ ràng và đúng ngữ cảnh.")
                        .positiveFeedback(finalAiResult.positiveFeedback() != null && !finalAiResult.positiveFeedback().isBlank() ? finalAiResult.positiveFeedback() : "Phát huy tốt sự tự tin khi nói.")
                        .correctionsJson(finalAiResult.correctionsJson() != null ? finalAiResult.correctionsJson() : "[]")
                        .isMocked(isDialogueMocked)
                        .build();
                SpeakingTurnFeedback savedFeedback = speakingTurnFeedbackRepository.save(feedback);

                String voiceId = SpeakingTtsService.sanitizeVoiceId(session.getVoiceId());
                String hash = SpeakingTtsService.computeCacheKey(voiceId, assistantText);
                String cachedRef = null;
                if (speakingAudioStorageService.ttsAudioExists(voiceId, hash)) {
                    cachedRef = "tts/" + voiceId + "/" + hash + ".wav";
                }

                SpeakingTurn assistantTurn = SpeakingTurn.builder()
                        .session(session)
                        .clientTurnId(normalizedClientTurnId != null ? normalizedClientTurnId + "-ai" : UUID.randomUUID().toString())
                        .sequenceNumber(currentMaxSeq + 2)
                        .speaker("ASSISTANT")
                        .text(assistantText)
                        .detectedVocabulary(new ArrayList<>())
                        .isMocked(isDialogueMocked)
                        .durationSeconds(0)
                        .synthesizedAudioRef(cachedRef)
                        .build();
                SpeakingTurn savedAssistantTurn = speakingTurnRepository.save(assistantTurn);

                // Safe Completion Gate: Do NOT mutate session.status to COMPLETED based on LLM boolean alone
                session.setDurationSeconds((session.getDurationSeconds() != null ? session.getDurationSeconds() : 0) + learnerDurationSeconds);
                speakingSessionRepository.save(session);
                if (eventPublisher != null) {
                    eventPublisher.publishEvent(new com.englishcoach.common.event.RoleplayTurnRecordedEvent(
                            userId, sessionId, savedLearnerTurn.getId(),
                            session.getScenario() != null ? session.getScenario().getId() : null,
                            session.getScenario() != null && session.getScenario().getCefrLevel() != null ? session.getScenario().getCefrLevel().name() : null,
                            finalPronScore, finalFluencyScore, false, java.time.Instant.now()));
                }

                // Aggregate all detected vocabulary inside TX
                List<SpeakingTurn> allTurnsAfterSave = speakingTurnRepository.findBySessionIdOrderBySequenceNumberAsc(sessionId);
                List<String> allDetectedVocab = getAllDetectedVocabularyInSession(allTurnsAfterSave);

                SpeakingTurnFeedbackDto fbDto = savedFeedback != null ? SpeakingTurnFeedbackDto.fromEntity(savedFeedback) : null;

                return new RoleplayTurnResponseDto(
                        sessionId,
                        SpeakingTurnDto.fromEntity(savedLearnerTurn, fbDto),
                        SpeakingTurnDto.fromEntity(savedAssistantTurn),
                        detectedVocab,
                        allDetectedVocab,
                        isTaskCompleted,
                        false,
                        isDialogueMocked,
                        finalPronFeedback
                );
            });
            committed = true;
            return response;
        } catch (DataIntegrityViolationException dive) {
            // Phase 2 TX has cleanly rolled back; perform replay lookup in a fresh read TX (zero 25P02).
            log.warn("Concurrent duplicate submission detected for sessionId={} clientTurnId={}: {}", sessionId, normalizedClientTurnId, dive.getMessage());
            if (normalizedClientTurnId != null) {
                RoleplayTurnResponseDto replay = inReadTx(() -> speakingTurnRepository
                        .findBySessionIdAndClientTurnId(sessionId, normalizedClientTurnId)
                        .map(existing -> buildIdempotentReplayResponse(sessionId, existing))
                        .orElse(null));
                if (replay != null) {
                    committed = true;
                    return replay;
                }
            }
            throw dive;
        } finally {
            if (!committed && newlySavedAudio && finalAudioRef != null) {
                speakingAudioStorageService.deleteAttemptAudioByRef(finalAudioRef);
            }
        }
    }

    private static int resolveMeasuredDurationSeconds(PronunciationV2ResponseDto pronFeedback) {
        if (pronFeedback != null && pronFeedback.getAudioQuality() != null
                && pronFeedback.getAudioQuality().getDurationSec() != null) {
            double sec = pronFeedback.getAudioQuality().getDurationSec();
            if (Double.isFinite(sec) && sec > 0.0) {
                return (int) Math.max(1L, Math.min(180L, Math.round(sec)));
            }
        }
        return 5;
    }

    private static String resolvePronEngineVersion(PronunciationV2ResponseDto pronFeedback) {
        if (pronFeedback == null) {
            return null;
        }
        String raw = pronFeedback.getEngineVersion();
        if (raw == null || raw.isBlank()) {
            return "pronunciation-v2.2";
        }
        String trimmed = raw.trim();
        return trimmed.length() > 50 ? trimmed.substring(0, 50) : trimmed;
    }

    private RoleplayTurnResponseDto buildIdempotentReplayResponse(Long sessionId, SpeakingTurn existingLearnerTurn) {
        List<SpeakingTurn> allTurns = speakingTurnRepository.findBySessionIdOrderBySequenceNumberAsc(sessionId);

        SpeakingTurn matchingAssistantTurn = allTurns.stream()
                .filter(t -> t.getSequenceNumber() == existingLearnerTurn.getSequenceNumber() + 1 && "ASSISTANT".equalsIgnoreCase(t.getSpeaker()))
                .findFirst()
                .orElse(null);

        List<String> allDetected = getAllDetectedVocabularyInSession(allTurns);

        PronunciationV2ResponseDto cachedPron = null;
        if (existingLearnerTurn.getPronunciationResultJson() != null && !existingLearnerTurn.getPronunciationResultJson().isBlank()) {
            try {
                cachedPron = objectMapper.readValue(existingLearnerTurn.getPronunciationResultJson(), PronunciationV2ResponseDto.class)
                        .useMeasuredStress();
            } catch (Exception e) {
                log.warn("Failed to deserialize existing turn pronunciation json: {}", e.getMessage());
            }
        }

        SpeakingTurnFeedbackDto fbDto = speakingTurnFeedbackRepository.findByTurnId(existingLearnerTurn.getId())
                .map(SpeakingTurnFeedbackDto::fromEntity)
                .orElse(null);

        return new RoleplayTurnResponseDto(
                sessionId,
                SpeakingTurnDto.fromEntity(existingLearnerTurn, fbDto),
                SpeakingTurnDto.fromEntity(matchingAssistantTurn),
                existingLearnerTurn.getDetectedVocabulary() != null
                        ? existingLearnerTurn.getDetectedVocabulary().stream().filter(Objects::nonNull).toList() : List.of(),
                allDetected,
                false,
                true,
                Boolean.TRUE.equals(existingLearnerTurn.getIsMocked()),
                cachedPron
        );
    }

    private List<String> getAllDetectedVocabularyInSession(List<SpeakingTurn> turns) {
        return turns.stream()
                .filter(t -> t.getDetectedVocabulary() != null)
                .flatMap(t -> t.getDetectedVocabulary().stream())
                .distinct()
                .toList();
    }
}
