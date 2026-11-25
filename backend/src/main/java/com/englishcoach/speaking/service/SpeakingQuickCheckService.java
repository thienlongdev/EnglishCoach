package com.englishcoach.speaking.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.speaking.dto.*;
import com.englishcoach.speaking.entity.SpeakingQuickCheck;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.repository.SpeakingQuickCheckRepository;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.persistence.EntityManager;
import jakarta.persistence.LockModeType;
import jakarta.persistence.PersistenceContext;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.*;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.time.LocalDateTime;
import java.util.*;
import java.util.regex.Pattern;

@Service
@RequiredArgsConstructor
@Slf4j
public class SpeakingQuickCheckService {

    private static final Pattern CLIENT_ATTEMPT_ID_PATTERN = Pattern.compile("^[a-zA-Z0-9_-]{1,100}$");

    private final SpeakingService speakingService;
    private final SpeakingAudioStorageService speakingAudioStorageService;
    private final SpeakingQuickCheckRepository speakingQuickCheckRepository;
    private final SpeakingSessionRepository speakingSessionRepository;
    private final UserRepository userRepository;
    private final ObjectMapper objectMapper;

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

    private record RecheckPhase1(Long id, String clientAttemptId, String whisperTranscript) {}

    @Value("${ai.base-url:http://localhost:8000}")
    private String aiBaseUrl;

    @Value("${ai.timeout.connect:10000}")
    private int connectTimeoutMs;

    @Value("${ai.timeout.read:45000}")
    private int readTimeoutMs;

    private RestTemplate createRestTemplateWithTimeout() {
        SimpleClientHttpRequestFactory factory = new com.englishcoach.common.ai.AiServiceRequestFactory();
        factory.setConnectTimeout(connectTimeoutMs);
        factory.setReadTimeout(readTimeoutMs);
        return new RestTemplate(factory);
    }

    public QuickCheckResponseDto analyzeQuickCheck(
            Long userId,
            MultipartFile file,
            String clientAttemptId,
            String intendedText
    ) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User must be authenticated for Quick Check");
        }
        if (file == null || file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio recording is empty");
        }
        if (file.getSize() > 25 * 1024 * 1024L) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio recording exceeds 25MB limit");
        }
        if (intendedText != null && intendedText.trim().length() > 500) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "intendedText must not exceed 500 characters");
        }

        String safeAttemptId;
        if (clientAttemptId != null && !clientAttemptId.isBlank()) {
            safeAttemptId = clientAttemptId.trim();
            if (!CLIENT_ATTEMPT_ID_PATTERN.matcher(safeAttemptId).matches()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid clientAttemptId format");
            }
        } else {
            safeAttemptId = "qc_" + UUID.randomUUID().toString();
        }

        // Read & validate audio bytes (including magic header) BEFORE touching storage or AI
        byte[] audioBytes;
        try {
            audioBytes = file.getBytes();
        } catch (IOException e) {
            log.warn("Failed to read Quick Check audio bytes: {}", e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Failed to read audio recording");
        }
        if (audioBytes == null || audioBytes.length == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio recording is empty");
        }
        if (audioBytes.length > 25 * 1024 * 1024L) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio recording exceeds 25MB limit");
        }
        if (!SpeakingService.isSupportedAudioHeader(audioBytes)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported or invalid audio file format");
        }

        // Phase 1 (short read TX): verify user exists and check (userId, clientAttemptId) idempotency
        QuickCheckResponseDto replayDto = inReadTx(() -> {
            userRepository.findById(userId)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));

            Optional<SpeakingQuickCheck> existing = speakingQuickCheckRepository.findByUserIdAndClientAttemptId(userId, safeAttemptId);
            if (existing.isPresent()) {
                log.info("Idempotent lookup for Quick Check attempt {}", safeAttemptId);
                return mapEntityToDto(existing.get(), null, null);
            }
            return null;
        });
        if (replayDto != null) {
            return replayDto;
        }

        String filename = file.getOriginalFilename() != null ? file.getOriginalFilename() : "quick_check.webm";

        // Persist validated audio file to authenticated storage (outside DB TX)
        String audioRef = speakingAudioStorageService.saveAttemptAudio(userId, safeAttemptId, audioBytes, filename);
        boolean persisted = false;
        boolean keepAudioForBlankSpeech = false;
        try {
            // 1. Exactly ONE Whisper STT call (OUTSIDE any DB transaction)
            Map<String, Object> sttResult;
            try {
                sttResult = speakingService.forwardAudioForAnalysis(audioBytes, filename, null);
            } catch (ResponseStatusException rse) {
                if (rse.getStatusCode().value() == HttpStatus.UNPROCESSABLE_ENTITY.value()) {
                    sttResult = Map.of("transcription", "");
                } else if (rse.getStatusCode().is4xxClientError()) {
                    throw rse;
                } else {
                    log.error("Whisper STT failed for attempt {}: {}", safeAttemptId, rse.getMessage());
                    throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                            "Chưa thể phân tích lúc này. Vui lòng thử lại.");
                }
            } catch (Exception e) {
                log.error("Whisper STT failed for attempt {}: {}", safeAttemptId, e.getMessage());
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                        "Chưa thể phân tích lúc này. Vui lòng thử lại.");
            }
            if (sttResult == null || Boolean.TRUE.equals(sttResult.get("isMocked"))) {
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                        "Chưa thể phân tích lúc này. Vui lòng thử lại.");
            }

            String whisperTranscript = "";
            if (sttResult.get("transcription") != null) {
                whisperTranscript = String.valueOf(sttResult.get("transcription")).trim();
            } else if (sttResult.get("transcript") instanceof Map tMap && tMap.get("text") != null) {
                whisperTranscript = String.valueOf(tMap.get("text")).trim();
            }

            // If Whisper fails or transcript is blank: Truthful failure (no fake transcript, no downstream calls)
            if (whisperTranscript.isBlank()) {
                keepAudioForBlankSpeech = true;
                return QuickCheckResponseDto.builder()
                        .clientAttemptId(safeAttemptId)
                        .audioRef(audioRef)
                        .audioUrl("/api/v1/speaking/attempts/" + safeAttemptId + "/audio")
                        .whisperTranscript("")
                        .intendedTranscript(intendedText)
                        .sttStatus("FAILED")
                        .sttError("Chưa nhận diện được câu nói. Hãy thử nói lại rõ hơn.")
                        .pronunciationStatus("SKIPPED")
                        .languageStatus("SKIPPED")
                        .createdAt(LocalDateTime.now())
                        .build();
            }

            String targetText = (intendedText != null && !intendedText.isBlank())
                    ? intendedText.trim()
                    : whisperTranscript;

            // 2. Exactly ONE Pronunciation V2.2 acoustic analysis call (OUTSIDE any DB transaction)
            PronunciationV2ResponseDto pronData = null;
            String pronStatus = "SUCCESS";
            String pronError = null;
            Double overallScore = null;
            Double phonemeScore = null;
            Double stressScore = null;
            Double pitchScore = null;
            Double rhythmScore = null;
            Double fluencyScore = null;

            try {
                pronData = speakingService.analyzePronunciationV2(
                        audioBytes,
                        filename,
                        targetText,
                        whisperTranscript,
                        "session_qc_" + safeAttemptId,
                        safeAttemptId
                );
                if (pronData == null || !"COMPLETED".equals(pronData.getStatus()) || pronData.getOverall() == null) {
                    throw new IllegalStateException("Pronunciation returned no usable result");
                }
                if (pronData != null && pronData.getOverall() != null) {
                    overallScore = pronData.getOverall().getOverallScore() != null ? pronData.getOverall().getOverallScore().doubleValue() : null;
                    phonemeScore = pronData.getOverall().getSegmentalScore() != null ? pronData.getOverall().getSegmentalScore().doubleValue() : null;
                    stressScore = pronData.getOverall().getStressScore() != null ? pronData.getOverall().getStressScore().doubleValue() : null;
                    pitchScore = pronData.getOverall().getIntonationScore() != null ? pronData.getOverall().getIntonationScore().doubleValue() : null;
                    rhythmScore = pronData.getOverall().getRhythmScore() != null ? pronData.getOverall().getRhythmScore().doubleValue() : null;
                    fluencyScore = pronData.getOverall().getFluencyScore() != null ? pronData.getOverall().getFluencyScore().doubleValue() : null;
                }
            } catch (Exception e) {
                log.warn("Pronunciation V2.2 unavailable for quick check attempt {}: {}", safeAttemptId, e.getMessage());
                pronData = null;
                pronStatus = "UNAVAILABLE";
                pronError = "Đã nhận diện câu nói nhưng chưa thể phân tích phát âm.";
            }

            // 3. Exactly ONE Llama structured language check (OUTSIDE any DB transaction)
            QuickCheckLanguageFeedbackDto langFeedback = null;
            String langStatus = "SUCCESS";
            String langError = null;

            try {
                langFeedback = callLlamaLanguageCheck(targetText);
            } catch (Exception e) {
                log.warn("Llama language check unavailable for quick check attempt {}: {}", safeAttemptId, e.getMessage());
                langStatus = "UNAVAILABLE";
                langError = "Phát âm đã được phân tích nhưng phần góp ý câu nói tạm thời chưa khả dụng.";
            }

            // Fail closed with HTTP 503 (releasing AI quota and deleting unsaved audio) if BOTH models failed
            if (!"SUCCESS".equals(pronStatus) && !"SUCCESS".equals(langStatus)) {
                log.error("Both Pronunciation and Language Check unavailable for Quick Check attempt {}; failing closed", safeAttemptId);
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                        "Chưa thể phân tích phát âm và góp ý câu nói lúc này. Vui lòng thử lại.");
            }

            String pronJson = null;
            if (pronData != null) {
                try {
                    pronJson = objectMapper.writeValueAsString(pronData);
                } catch (Exception ignored) {}
            }

            String langJson = null;
            if (langFeedback != null) {
                try {
                    langJson = objectMapper.writeValueAsString(langFeedback);
                } catch (Exception ignored) {}
            }

            final String finalWhisperTranscript = whisperTranscript;
            final PronunciationV2ResponseDto finalPronData = pronData;
            final QuickCheckLanguageFeedbackDto finalLangFeedback = langFeedback;
            final String finalPronStatus = pronStatus;
            final String finalPronError = pronError;
            final String finalLangStatus = langStatus;
            final String finalLangError = langError;
            final Double finalOverallScore = overallScore;
            final Double finalPhonemeScore = phonemeScore;
            final Double finalStressScore = stressScore;
            final Double finalPitchScore = pitchScore;
            final Double finalRhythmScore = rhythmScore;
            final Double finalFluencyScore = fluencyScore;
            final String finalPronJson = pronJson;
            final String finalLangJson = langJson;
            final boolean finalIsMocked = Boolean.TRUE.equals(sttResult.get("isMocked"));

            // Phase 2 (short atomic commit TX): persist SpeakingSession + SpeakingQuickCheck atomically (zero orphan session)
            QuickCheckResponseDto committed;
            try {
                committed = inTx(() -> {
                    Optional<SpeakingQuickCheck> concurrent = speakingQuickCheckRepository.findByUserIdAndClientAttemptId(userId, safeAttemptId);
                    if (concurrent.isPresent()) {
                        return mapEntityToDto(concurrent.get(), null, null);
                    }

                    User user = userRepository.findById(userId)
                            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));

                    SpeakingSession session = SpeakingSession.builder()
                            .user(user)
                            .mode("QUICK_CHECK")
                            .status("SUCCESS".equals(finalPronStatus) && "SUCCESS".equals(finalLangStatus) ? "COMPLETED" : "FAILED")
                            .completedUnitsCount(1)
                            .totalUnitsCount(1)
                            .activeAttemptId(safeAttemptId)
                            .build();
                    session = speakingSessionRepository.save(session);

                    String pronEngineVersion = (finalPronData != null && finalPronData.getEngineVersion() != null && !finalPronData.getEngineVersion().isBlank())
                            ? finalPronData.getEngineVersion()
                            : "pronunciation-v3.0-hybrid";
                    String modelMetadataJson;
                    try {
                        modelMetadataJson = objectMapper.writeValueAsString(Map.of(
                                "stt", "whisper",
                                "pronunciation", pronEngineVersion,
                                "language", "meta-llama/llama-3.1-8b-instruct"
                        ));
                    } catch (Exception ignored) {
                        modelMetadataJson = "{\"stt\":\"whisper\",\"pronunciation\":\"pronunciation-v3.0-hybrid\",\"language\":\"meta-llama/llama-3.1-8b-instruct\"}";
                    }

                    SpeakingQuickCheck quickCheck = SpeakingQuickCheck.builder()
                            .user(user)
                            .session(session)
                            .clientAttemptId(safeAttemptId)
                            .audioRef(audioRef)
                            .whisperTranscript(finalWhisperTranscript)
                            .intendedTranscript(intendedText != null && !intendedText.isBlank() ? intendedText.trim() : null)
                            .overallScore(finalOverallScore)
                            .phonemeScore(finalPhonemeScore)
                            .stressScore(finalStressScore)
                            .pitchScore(finalPitchScore)
                            .rhythmScore(finalRhythmScore)
                            .fluencyScore(finalFluencyScore)
                            .pronunciationDiagnosticsJson(finalPronJson)
                            .languageFeedbackJson(finalLangJson)
                            .modelMetadataJson(modelMetadataJson)
                            .isMocked(finalIsMocked)
                            .build();

                    quickCheck = speakingQuickCheckRepository.save(quickCheck);

                    return QuickCheckResponseDto.builder()
                            .id(quickCheck.getId())
                            .clientAttemptId(safeAttemptId)
                            .sessionId(session.getId())
                            .audioRef(audioRef)
                            .audioUrl("/api/v1/speaking/attempts/" + safeAttemptId + "/audio")
                            .whisperTranscript(finalWhisperTranscript)
                            .intendedTranscript(quickCheck.getIntendedTranscript())
                            .overallScore(finalOverallScore)
                            .phonemeScore(finalPhonemeScore)
                            .stressScore(finalStressScore)
                            .pitchScore(finalPitchScore)
                            .rhythmScore(finalRhythmScore)
                            .fluencyScore(finalFluencyScore)
                            .pronunciation(finalPronData)
                            .languageFeedback(finalLangFeedback)
                            .sttStatus("SUCCESS")
                            .pronunciationStatus(finalPronStatus)
                            .languageStatus(finalLangStatus)
                            .pronunciationError(finalPronError)
                            .languageError(finalLangError)
                            .createdAt(quickCheck.getCreatedAt())
                            .build();
                });
            } catch (DataIntegrityViolationException dive) {
                QuickCheckResponseDto replay = inReadTx(() -> speakingQuickCheckRepository
                        .findByUserIdAndClientAttemptId(userId, safeAttemptId)
                        .map(existing -> mapEntityToDto(existing, null, null))
                        .orElse(null));
                if (replay != null) {
                    persisted = true;
                    return replay;
                }
                throw new ResponseStatusException(HttpStatus.CONFLICT, "Attempt identifier already in use");
            }
            persisted = true;
            return committed;
        } finally {
            if (!persisted && !keepAudioForBlankSpeech && audioRef != null) {
                speakingAudioStorageService.deleteAttemptAudioByRef(audioRef);
            }
        }
    }

    public QuickCheckResponseDto recheckQuickCheck(
            Long userId,
            String clientAttemptId,
            String correctedText
    ) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User must be authenticated");
        }
        if (clientAttemptId == null || clientAttemptId.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "clientAttemptId is required");
        }
        if (correctedText == null || correctedText.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "correctedText is required");
        }
        String cleanAttemptId = clientAttemptId.trim();
        if (!CLIENT_ATTEMPT_ID_PATTERN.matcher(cleanAttemptId).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid clientAttemptId format");
        }
        String cleanCorrected = correctedText.trim();
        if (cleanCorrected.length() > 500) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "intendedText must not exceed 500 characters");
        }

        // Phase 1 (short read TX): scope by (userId, clientAttemptId) returning uniform 404 (no cross-user oracle)
        RecheckPhase1 phase1 = inReadTx(() -> {
            SpeakingQuickCheck quickCheck = speakingQuickCheckRepository.findByUserIdAndClientAttemptId(userId, cleanAttemptId)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Quick Check attempt not found"));
            return new RecheckPhase1(quickCheck.getId(), quickCheck.getClientAttemptId(), quickCheck.getWhisperTranscript());
        });

        // Reuse SAME recorded audio (0 Whisper calls) — outside DB TX
        byte[] audioBytes = speakingAudioStorageService.loadAttemptAudioBytes(userId, cleanAttemptId);
        if (audioBytes == null || audioBytes.length == 0) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Original audio file not found on server");
        }

        String detectedMime = speakingAudioStorageService.detectAttemptAudioMime(userId, cleanAttemptId);
        String ext = extensionForMime(detectedMime);
        String filename = "recheck_" + cleanAttemptId + "." + ext;

        // 1. Re-run Pronunciation V2.2 with corrected text as expectedText (0 Whisper calls, OUTSIDE TX)
        PronunciationV2ResponseDto pronData = null;
        String pronStatus = "SUCCESS";
        String pronError = null;
        Double overallScore = null;
        Double phonemeScore = null;
        Double stressScore = null;
        Double pitchScore = null;
        Double rhythmScore = null;
        Double fluencyScore = null;

        try {
            pronData = speakingService.analyzePronunciationV2(
                    audioBytes,
                    filename,
                    cleanCorrected,
                    phase1.whisperTranscript(),
                    "session_qc_" + cleanAttemptId,
                    cleanAttemptId
            );
            if (pronData == null || !"COMPLETED".equals(pronData.getStatus()) || pronData.getOverall() == null) {
                throw new IllegalStateException("Pronunciation returned no usable result");
            }
            if (pronData != null && pronData.getOverall() != null) {
                overallScore = pronData.getOverall().getOverallScore() != null ? pronData.getOverall().getOverallScore().doubleValue() : null;
                phonemeScore = pronData.getOverall().getSegmentalScore() != null ? pronData.getOverall().getSegmentalScore().doubleValue() : null;
                stressScore = pronData.getOverall().getStressScore() != null ? pronData.getOverall().getStressScore().doubleValue() : null;
                pitchScore = pronData.getOverall().getIntonationScore() != null ? pronData.getOverall().getIntonationScore().doubleValue() : null;
                rhythmScore = pronData.getOverall().getRhythmScore() != null ? pronData.getOverall().getRhythmScore().doubleValue() : null;
                fluencyScore = pronData.getOverall().getFluencyScore() != null ? pronData.getOverall().getFluencyScore().doubleValue() : null;
            }
        } catch (Exception e) {
            log.warn("Pronunciation V2.2 recheck failed for attempt {}: {}", cleanAttemptId, e.getMessage());
            pronData = null;
            pronStatus = "UNAVAILABLE";
            pronError = "Đã cập nhật câu nói nhưng chưa thể phân tích lại phát âm.";
        }

        // 2. Re-run Llama language check on corrected sentence (OUTSIDE TX)
        QuickCheckLanguageFeedbackDto langFeedback = null;
        String langStatus = "SUCCESS";
        String langError = null;

        try {
            langFeedback = callLlamaLanguageCheck(cleanCorrected);
        } catch (Exception e) {
            log.warn("Llama language check recheck failed for attempt {}: {}", cleanAttemptId, e.getMessage());
            langStatus = "UNAVAILABLE";
            langError = "Phần góp ý câu nói tạm thời chưa khả dụng.";
        }

        if (!"SUCCESS".equals(pronStatus) && !"SUCCESS".equals(langStatus)) {
            log.error("Both Pronunciation and Language Check unavailable for Quick Check recheck {}; failing closed", cleanAttemptId);
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Chưa thể phân tích lại phát âm và góp ý câu nói lúc này. Vui lòng thử lại.");
        }

        String pronJson = null;
        if (pronData != null) {
            try {
                pronJson = objectMapper.writeValueAsString(pronData);
            } catch (Exception ignored) {}
        }
        String langJson = null;
        if (langFeedback != null) {
            try {
                langJson = objectMapper.writeValueAsString(langFeedback);
            } catch (Exception ignored) {}
        }

        final PronunciationV2ResponseDto finalPronData = pronData;
        final QuickCheckLanguageFeedbackDto finalLangFeedback = langFeedback;
        final String finalPronStatus = pronStatus;
        final String finalPronError = pronError;
        final String finalLangStatus = langStatus;
        final String finalLangError = langError;
        final Double finalOverallScore = overallScore;
        final Double finalPhonemeScore = phonemeScore;
        final Double finalStressScore = stressScore;
        final Double finalPitchScore = pitchScore;
        final Double finalRhythmScore = rhythmScore;
        final Double finalFluencyScore = fluencyScore;
        final String finalPronJson = pronJson;
        final String finalLangJson = langJson;

        // Phase 2 (short atomic commit TX): acquire PESSIMISTIC_WRITE row lock, re-verify owner, persist & update session status
        return inTx(() -> {
            SpeakingQuickCheck quickCheck = lockQuickCheck(phase1.id(), userId, cleanAttemptId);
            if (!quickCheck.getUser().getId().equals(userId)) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Quick Check attempt not found");
            }

            quickCheck.setIntendedTranscript(cleanCorrected);
            quickCheck.setOverallScore(finalOverallScore);
            quickCheck.setPhonemeScore(finalPhonemeScore);
            quickCheck.setStressScore(finalStressScore);
            quickCheck.setPitchScore(finalPitchScore);
            quickCheck.setRhythmScore(finalRhythmScore);
            quickCheck.setFluencyScore(finalFluencyScore);
            quickCheck.setPronunciationDiagnosticsJson(finalPronJson);
            quickCheck.setLanguageFeedbackJson(finalLangJson);

            quickCheck = speakingQuickCheckRepository.save(quickCheck);

            if (quickCheck.getSession() != null) {
                String updatedStatus = ("SUCCESS".equals(finalPronStatus) && "SUCCESS".equals(finalLangStatus))
                        ? "COMPLETED"
                        : "FAILED";
                quickCheck.getSession().setStatus(updatedStatus);
                speakingSessionRepository.save(quickCheck.getSession());
            }

            return QuickCheckResponseDto.builder()
                    .id(quickCheck.getId())
                    .clientAttemptId(quickCheck.getClientAttemptId())
                    .sessionId(quickCheck.getSession() != null ? quickCheck.getSession().getId() : null)
                    .audioRef(quickCheck.getAudioRef())
                    .audioUrl("/api/v1/speaking/attempts/" + quickCheck.getClientAttemptId() + "/audio")
                    .whisperTranscript(quickCheck.getWhisperTranscript())
                    .intendedTranscript(cleanCorrected)
                    .overallScore(finalOverallScore)
                    .phonemeScore(finalPhonemeScore)
                    .stressScore(finalStressScore)
                    .pitchScore(finalPitchScore)
                    .rhythmScore(finalRhythmScore)
                    .fluencyScore(finalFluencyScore)
                    .pronunciation(finalPronData)
                    .languageFeedback(finalLangFeedback)
                    .sttStatus("SUCCESS")
                    .pronunciationStatus(finalPronStatus)
                    .languageStatus(finalLangStatus)
                    .pronunciationError(finalPronError)
                    .languageError(finalLangError)
                    .createdAt(quickCheck.getCreatedAt())
                    .build();
        });
    }

    private SpeakingQuickCheck lockQuickCheck(Long id, Long userId, String clientAttemptId) {
        if (entityManager != null && id != null) {
            SpeakingQuickCheck locked = entityManager.find(SpeakingQuickCheck.class, id, LockModeType.PESSIMISTIC_WRITE);
            if (locked == null || locked.getUser() == null || !locked.getUser().getId().equals(userId)) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Quick Check attempt not found");
            }
            return locked;
        }
        return speakingQuickCheckRepository.findByUserIdAndClientAttemptId(userId, clientAttemptId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Quick Check attempt not found"));
    }

    @Transactional(readOnly = true)
    public QuickCheckResponseDto getQuickCheckDetail(Long userId, String clientAttemptId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User must be authenticated");
        }
        if (clientAttemptId == null || !CLIENT_ATTEMPT_ID_PATTERN.matcher(clientAttemptId.trim()).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid clientAttemptId format");
        }
        SpeakingQuickCheck quickCheck = speakingQuickCheckRepository.findByUserIdAndClientAttemptId(userId, clientAttemptId.trim())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Quick Check not found"));

        return mapEntityToDto(quickCheck, null, null);
    }

    private static String extensionForMime(String mime) {
        if (mime == null) return "webm";
        return switch (mime) {
            case "audio/wav" -> "wav";
            case "audio/ogg" -> "ogg";
            case "audio/mp4" -> "m4a";
            case "audio/mpeg" -> "mp3";
            case "audio/flac" -> "flac";
            default -> "webm";
        };
    }

    @Transactional(readOnly = true)
    public QuickCheckResponseDto getQuickCheckBySessionId(Long userId, Long sessionId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User must be authenticated");
        }
        SpeakingQuickCheck quickCheck = speakingQuickCheckRepository.findBySessionId(sessionId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Quick Check not found for session: " + sessionId));

        if (!quickCheck.getUser().getId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Access denied to Quick Check attempt");
        }

        return mapEntityToDto(quickCheck, null, null);
    }

    private QuickCheckLanguageFeedbackDto callLlamaLanguageCheck(String transcript) {
        String targetUrl = aiBaseUrl + "/api/v1/speaking/quick-check/language-check";
        Map<String, String> payload = Map.of("transcript", transcript);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);

        HttpEntity<Map<String, String>> requestEntity = new HttpEntity<>(payload, headers);
        RestTemplate restTemplate = createRestTemplateWithTimeout();

        ResponseEntity<QuickCheckLanguageFeedbackDto> response = restTemplate.postForEntity(
                targetUrl,
                requestEntity,
                QuickCheckLanguageFeedbackDto.class
        );
        QuickCheckLanguageFeedbackDto feedback = response.getBody();
        if (feedback == null || Boolean.TRUE.equals(feedback.getIsMocked())
                || !("CORRECT".equals(feedback.getStatus()) || "NEEDS_IMPROVEMENT".equals(feedback.getStatus()))) {
            throw new IllegalStateException("Llama language feedback unavailable");
        }
        return feedback;
    }

    public QuickCheckResponseDto mapEntityToDto(SpeakingQuickCheck entity, String pronError, String langError) {
        PronunciationV2ResponseDto pronDto = null;
        if (entity.getPronunciationDiagnosticsJson() != null && !entity.getPronunciationDiagnosticsJson().isBlank()) {
            try {
                pronDto = objectMapper.readValue(entity.getPronunciationDiagnosticsJson(), PronunciationV2ResponseDto.class).useMeasuredStress();
            } catch (Exception e) {
                log.debug("Could not deserialize pronunciationDiagnosticsJson: {}", e.getMessage());
            }
        }

        QuickCheckLanguageFeedbackDto langDto = null;
        if (entity.getLanguageFeedbackJson() != null && !entity.getLanguageFeedbackJson().isBlank()) {
            try {
                langDto = objectMapper.readValue(entity.getLanguageFeedbackJson(), QuickCheckLanguageFeedbackDto.class);
            } catch (Exception e) {
                log.debug("Could not deserialize languageFeedbackJson: {}", e.getMessage());
            }
        }

        return QuickCheckResponseDto.builder()
                .id(entity.getId())
                .clientAttemptId(entity.getClientAttemptId())
                .sessionId(entity.getSession() != null ? entity.getSession().getId() : null)
                .audioRef(entity.getAudioRef())
                .audioUrl("/api/v1/speaking/attempts/" + entity.getClientAttemptId() + "/audio")
                .whisperTranscript(entity.getWhisperTranscript())
                .intendedTranscript(entity.getIntendedTranscript())
                .overallScore(entity.getOverallScore())
                .phonemeScore(entity.getPhonemeScore())
                .stressScore(pronDto != null && pronDto.measuredStressScore() != null ? pronDto.measuredStressScore().doubleValue() : null)
                .pitchScore(entity.getPitchScore())
                .rhythmScore(entity.getRhythmScore())
                .fluencyScore(entity.getFluencyScore())
                .pronunciation(pronDto)
                .languageFeedback(langDto)
                .sttStatus("SUCCESS")
                .pronunciationStatus(pronDto != null ? "SUCCESS" : "UNAVAILABLE")
                .languageStatus(langDto != null && !Boolean.TRUE.equals(langDto.getIsMocked()) ? "SUCCESS" : "UNAVAILABLE")
                .pronunciationError(pronError)
                .languageError(langError)
                .createdAt(entity.getCreatedAt())
                .build();
    }
}
