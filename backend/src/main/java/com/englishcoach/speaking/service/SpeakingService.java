package com.englishcoach.speaking.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.listening.service.DictationScoringService;
import com.englishcoach.speaking.dto.PronunciationV2ResponseDto;
import com.englishcoach.speaking.dto.ShadowingAnalysisResponseDto;
import com.englishcoach.speaking.dto.SpeakingSessionRequest;
import com.englishcoach.speaking.dto.SpeakingSessionUpdateRequest;
import com.englishcoach.speaking.entity.SpeakingResult;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.repository.SpeakingResultRepository;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.http.HttpStatus;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;

@Service
@RequiredArgsConstructor
@Slf4j
public class SpeakingService {
    private static final long MAX_AUDIO_BYTES = 25 * 1024 * 1024L;
    private static final int MAX_TEXT_LENGTH = 1000;
    private static final int MAX_SESSION_DURATION_SECONDS = 7200;
    private static final int SESSION_DURATION_GRACE_SECONDS = 120;

    private final SpeakingResultRepository speakingResultRepository;
    private final SpeakingSessionRepository speakingSessionRepository;
    private final com.englishcoach.speaking.repository.SpeakingScenarioRepository speakingScenarioRepository;
    private final com.englishcoach.speaking.repository.SpeakingShadowingUnitRepository speakingShadowingUnitRepository;
    private final com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository speakingShadowingAttemptRepository;
    private final com.englishcoach.speaking.service.SpeakingShadowingService speakingShadowingService;
    private final com.fasterxml.jackson.databind.ObjectMapper objectMapper;
    private final UserRepository userRepository;
    private final DictationScoringService dictationScoringService;
    private final SpeakingAudioStorageService speakingAudioStorageService;
    @org.springframework.beans.factory.annotation.Autowired
    private ShadowingAnalysisReceipts analysisReceipts;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.englishcoach.listening.repository.ListeningMaterialRepository listeningMaterialRepository;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.englishcoach.reading.repository.ReadingMaterialRepository readingMaterialRepository;

    public void setListeningMaterialRepository(com.englishcoach.listening.repository.ListeningMaterialRepository listeningMaterialRepository) {
        this.listeningMaterialRepository = listeningMaterialRepository;
    }

    public void setReadingMaterialRepository(com.englishcoach.reading.repository.ReadingMaterialRepository readingMaterialRepository) {
        this.readingMaterialRepository = readingMaterialRepository;
    }

    public static boolean isSupportedAudioHeader(byte[] bytes) {
        if (bytes == null || bytes.length < 2) return false;
        // WebM / Matroska (EBML): 1A 45 DF A3
        if (bytes.length >= 4
                && (bytes[0] & 0xFF) == 0x1A
                && (bytes[1] & 0xFF) == 0x45
                && (bytes[2] & 0xFF) == 0xDF
                && (bytes[3] & 0xFF) == 0xA3) {
            return true;
        }
        // WAV: RIFF....WAVE
        if (bytes.length >= 12
                && bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F'
                && bytes[8] == 'W' && bytes[9] == 'A' && bytes[10] == 'V' && bytes[11] == 'E') {
            return true;
        }
        // OGG: OggS
        if (bytes.length >= 4
                && bytes[0] == 'O' && bytes[1] == 'g' && bytes[2] == 'g' && bytes[3] == 'S') {
            return true;
        }
        // MP4 / M4A (ISO BMFF): ....ftyp
        if (bytes.length >= 8
                && bytes[4] == 'f' && bytes[5] == 't' && bytes[6] == 'y' && bytes[7] == 'p') {
            return true;
        }
        // FLAC: fLaC
        if (bytes.length >= 4
                && bytes[0] == 'f' && bytes[1] == 'L' && bytes[2] == 'a' && bytes[3] == 'C') {
            return true;
        }
        // MP3 (ID3 tag)
        if (bytes.length >= 3 && bytes[0] == 'I' && bytes[1] == 'D' && bytes[2] == '3') {
            return true;
        }
        // MP3 / ADTS MPEG frame sync (11 set bits, excluding reserved MPEG version 01)
        return (bytes[0] & 0xFF) == 0xFF
                && (bytes[1] & 0xE0) == 0xE0
                && (bytes[1] & 0x18) != 0x08;
    }

    private void validateAudioPayload(byte[] audioBytes) {
        if (audioBytes == null || audioBytes.length == 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio payload is empty");
        }
        if (audioBytes.length > MAX_AUDIO_BYTES) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio file exceeds maximum size limit of 25MB");
        }
        if (!isSupportedAudioHeader(audioBytes)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported or invalid audio file format");
        }
    }

    private void validateTextLength(String text, String fieldName) {
        if (text != null && text.length() > MAX_TEXT_LENGTH) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST,
                    fieldName + " must not exceed " + MAX_TEXT_LENGTH + " characters"
            );
        }
    }

    public static String detectAudioMime(byte[] bytes, String filename, String declaredContentType) {
        if (bytes != null) {
            if (bytes.length >= 4
                    && (bytes[0] & 0xFF) == 0x1A
                    && (bytes[1] & 0xFF) == 0x45
                    && (bytes[2] & 0xFF) == 0xDF
                    && (bytes[3] & 0xFF) == 0xA3) {
                return "audio/webm";
            }
            if (bytes.length >= 12
                    && bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F'
                    && bytes[8] == 'W' && bytes[9] == 'A' && bytes[10] == 'V' && bytes[11] == 'E') {
                return "audio/wav";
            }
            if (bytes.length >= 4
                    && bytes[0] == 'O' && bytes[1] == 'g' && bytes[2] == 'g' && bytes[3] == 'S') {
                return "audio/ogg";
            }
            if (bytes.length >= 8
                    && bytes[4] == 'f' && bytes[5] == 't' && bytes[6] == 'y' && bytes[7] == 'p') {
                return "audio/mp4";
            }
            if (bytes.length >= 4
                    && bytes[0] == 'f' && bytes[1] == 'L' && bytes[2] == 'a' && bytes[3] == 'C') {
                return "audio/flac";
            }
            if ((bytes.length >= 3 && bytes[0] == 'I' && bytes[1] == 'D' && bytes[2] == '3')
                    || (bytes.length >= 2 && (bytes[0] & 0xFF) == 0xFF
                    && (bytes[1] & 0xE0) == 0xE0 && (bytes[1] & 0x18) != 0x08)) {
                return "audio/mpeg";
            }
        }
        if (declaredContentType != null && !declaredContentType.isBlank()) {
            String lower = declaredContentType.trim().toLowerCase(Locale.ROOT);
            if (lower.startsWith("audio/")) {
                return declaredContentType.trim();
            }
        }
        if (filename != null) {
            String lower = filename.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".wav")) return "audio/wav";
            if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
            if (lower.endsWith(".mp4") || lower.endsWith(".m4a")) return "audio/mp4";
            if (lower.endsWith(".mp3")) return "audio/mpeg";
            if (lower.endsWith(".flac")) return "audio/flac";
        }
        return "audio/webm";
    }

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

    public List<SpeakingResult> getUserResults(Long userId) {
        return speakingResultRepository.findByUserIdOrderByCreatedAtDesc(userId);
    }

    public Map<String, Object> forwardAudioForAnalysis(MultipartFile file, String referenceText) {
        if (file == null || file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio file payload is empty");
        }

        // Limit audio size to 25MB for speech recognition
        if (file.getSize() > MAX_AUDIO_BYTES) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio file exceeds maximum size limit of 25MB");
        }

        try {
            return forwardAudioForAnalysis(file.getBytes(), resolveAudioFilename(file), file.getContentType(), referenceText);
        } catch (IOException e) {
            log.warn("Failed to read uploaded audio file bytes: {}", e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Failed to read audio file");
        }
    }

    public Map<String, Object> forwardAudioForAnalysis(byte[] audioBytes, String filename, String referenceText) {
        return forwardAudioForAnalysis(audioBytes, filename, null, referenceText, false);
    }

    public Map<String, Object> forwardAudioForAnalysis(byte[] audioBytes, String filename, String contentType, String referenceText) {
        return forwardAudioForAnalysis(audioBytes, filename, contentType, referenceText, false);
    }

    /**
     * Send audio to the STT gateway. An unavailable provider cannot supply learner evidence.
     */
    private Map<String, Object> forwardAudioForAnalysis(
            byte[] audioBytes,
            String filename,
            String contentType,
            String referenceText,
            boolean requireRealTranscript
    ) {
        validateAudioPayload(audioBytes);
        validateTextLength(referenceText, "referenceText");

        String targetUrl = aiBaseUrl + "/api/v1/speaking/analyze";
        String resolvedFilename = filename != null ? filename : "recording.wav";
        String resolvedMime = detectAudioMime(audioBytes, resolvedFilename, contentType);
        log.info("Forwarding audio analysis request to AI service at {} (filename={}, mime={}, size={} bytes, timeouts: connect={}ms, read={}ms)",
                targetUrl, resolvedFilename, resolvedMime, audioBytes.length, connectTimeoutMs, readTimeoutMs);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);

        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("file", buildAudioPart(
                audioBytes,
                resolvedFilename,
                resolvedMime
        ));

        HttpEntity<MultiValueMap<String, Object>> requestEntity = new HttpEntity<>(body, headers);
        RestTemplate restTemplate = createRestTemplateWithTimeout();

        Map<String, Object> responseMap;
        try {
            ResponseEntity<Map> response = restTemplate.postForEntity(targetUrl, requestEntity, Map.class);
            responseMap = response.getBody() != null ? new HashMap<>(response.getBody()) : new HashMap<>();
        } catch (org.springframework.web.client.HttpClientErrorException.UnprocessableEntity e) {
            log.info("Speech-to-text returned 422 Unprocessable Entity (silent or undetectable speech)");
            throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "COULD_NOT_HEAR_SPEECH");
        } catch (Exception e) {
            log.warn("Speech-to-text unavailable ({})", e.getClass().getSimpleName());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Speech-to-Text transcription unavailable");
        }

        // Extract transcription text
        String recognizedText = "";
        if (responseMap.get("transcription") != null) {
            recognizedText = String.valueOf(responseMap.get("transcription"));
        } else if (responseMap.get("transcript") instanceof Map transcriptMap && transcriptMap.get("text") != null) {
            recognizedText = String.valueOf(transcriptMap.get("text"));
        }

        if (Boolean.TRUE.equals(responseMap.get("isMocked")) || (requireRealTranscript && recognizedText.isBlank())) {
            log.error("Speech-to-Text returned no real transcript for canonical Shadowing analysis");
            throw new ResponseStatusException(
                    HttpStatus.SERVICE_UNAVAILABLE,
                    "Speech-to-Text transcription unavailable"
            );
        }

        // If referenceText is provided, perform honest Levenshtein scoring and word alignment
        if (referenceText != null && !referenceText.isBlank()) {
            DictationScoringService.ScoringResult scoreResult = dictationScoringService.scoreDictation(recognizedText, referenceText);
            int accuracy = (int) Math.round(scoreResult.accuracyPercentage);

            List<Map<String, Object>> wordAlignment = computeWordAlignment(referenceText, recognizedText);

            boolean isPerfectMatch = wordAlignment.stream()
                    .allMatch(item -> "MATCH".equalsIgnoreCase(String.valueOf(item.get("status"))));

            if (!isPerfectMatch && accuracy >= 100) {
                accuracy = 98; // Ensure imperfect alignment cannot show 100%
            } else if (isPerfectMatch) {
                accuracy = 100;
            }

            responseMap.put("accuracyScore", accuracy);
            responseMap.put("wordAlignment", wordAlignment);
            responseMap.put("pronunciationScore", null);
            responseMap.put("fluencyScore", null);
            responseMap.put("feedback", buildAlignmentFeedback(accuracy, isPerfectMatch));
        }

        return responseMap;
    }

    List<Map<String, Object>> computeWordAlignment(String referenceText, String recognizedText) {
        String[] refWords = referenceText.trim().split("\\s+");
        String[] userWords = recognizedText.trim().isEmpty() ? new String[0] : recognizedText.trim().split("\\s+");

        int n = refWords.length;
        int m = userWords.length;

        String[] cleanRef = new String[n];
        for (int i = 0; i < n; i++) cleanRef[i] = cleanWordForComparison(refWords[i]);

        String[] cleanUser = new String[m];
        for (int j = 0; j < m; j++) cleanUser[j] = cleanWordForComparison(userWords[j]);

        int[][] dp = new int[n + 1][m + 1];

        for (int i = 0; i <= n; i++) dp[i][0] = i * 2;
        for (int j = 0; j <= m; j++) dp[0][j] = j * 2;

        for (int i = 1; i <= n; i++) {
            for (int j = 1; j <= m; j++) {
                int matchCost;
                if (cleanRef[i - 1].equalsIgnoreCase(cleanUser[j - 1])) {
                    matchCost = 0;
                } else if (isNearMatch(cleanRef[i - 1], cleanUser[j - 1])) {
                    matchCost = 1;
                } else {
                    matchCost = 2; // distinct words (substitution cost)
                }

                dp[i][j] = Math.min(
                        dp[i - 1][j - 1] + matchCost,
                        Math.min(dp[i - 1][j] + 2, dp[i][j - 1] + 2)
                );
            }
        }

        List<Map<String, Object>> alignment = new ArrayList<>();
        int i = n, j = m;

        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && cleanRef[i - 1].equalsIgnoreCase(cleanUser[j - 1]) && dp[i][j] == dp[i - 1][j - 1]) {
                alignment.add(0, Map.of(
                        "word", refWords[i - 1],
                        "spokenWord", userWords[j - 1],
                        "targetWordIndex", i - 1,
                        "status", "MATCH"
                ));
                i--;
                j--;
            } else if (i > 0 && j > 0 && isNearMatch(cleanRef[i - 1], cleanUser[j - 1]) && dp[i][j] == dp[i - 1][j - 1] + 1) {
                alignment.add(0, Map.of(
                        "word", refWords[i - 1],
                        "spokenWord", userWords[j - 1],
                        "targetWordIndex", i - 1,
                        "status", "NEAR_MATCH"
                ));
                i--;
                j--;
            } else if (i > 0 && j > 0 && dp[i][j] == dp[i - 1][j - 1] + 2) {
                // Distinct word substitution (e.g. "a" instead of "the")
                alignment.add(0, Map.of(
                        "word", refWords[i - 1],
                        "spokenWord", userWords[j - 1],
                        "expectedWord", refWords[i - 1],
                        "targetWordIndex", i - 1,
                        "status", "WRONG_WORD"
                ));
                i--;
                j--;
            } else if (i > 0 && (j == 0 || dp[i][j] == dp[i - 1][j] + 2)) {
                alignment.add(0, Map.of(
                        "word", refWords[i - 1],
                        "spokenWord", "",
                        "targetWordIndex", i - 1,
                        "status", "MISSING_WORD"
                ));
                i--;
            } else {
                alignment.add(0, Map.of(
                        "word", "",
                        "spokenWord", userWords[j - 1],
                        "targetWordIndex", -1,
                        "status", "EXTRA_WORD"
                ));
                j--;
            }
        }

        return alignment;
    }

    private boolean isNearMatch(String w1, String w2) {
        if (w1 == null || w2 == null) return false;
        if (w1.equalsIgnoreCase(w2)) return true;
        if (w1.length() >= 4 && w2.length() >= 4) {
            return computeLevenshteinDistance(w1.toLowerCase(), w2.toLowerCase()) <= 1;
        }
        return false;
    }

    private int computeLevenshteinDistance(String s1, String s2) {
        int[] costs = new int[s2.length() + 1];
        for (int j = 0; j <= s2.length(); j++) costs[j] = j;
        for (int i = 1; i <= s1.length(); i++) {
            costs[0] = i;
            int nw = i - 1;
            for (int j = 1; j <= s2.length(); j++) {
                int cj = Math.min(1 + Math.min(costs[j], costs[j - 1]),
                        s1.charAt(i - 1) == s2.charAt(j - 1) ? nw : nw + 1);
                nw = costs[j];
                costs[j] = cj;
            }
        }
        return costs[s2.length()];
    }

    // An ASR may write "9" for a spoken "nine". Normalize only unambiguous single-word cardinals;
    // dates, decimals and multiword alternatives retain their actual wording.
    private static final Map<String, String> SPOKEN_CARDINALS = Map.ofEntries(
            Map.entry("0", "zero"), Map.entry("1", "one"), Map.entry("2", "two"), Map.entry("3", "three"),
            Map.entry("4", "four"), Map.entry("5", "five"), Map.entry("6", "six"), Map.entry("7", "seven"),
            Map.entry("8", "eight"), Map.entry("9", "nine"), Map.entry("10", "ten"), Map.entry("11", "eleven"),
            Map.entry("12", "twelve"), Map.entry("13", "thirteen"), Map.entry("14", "fourteen"), Map.entry("15", "fifteen"),
            Map.entry("16", "sixteen"), Map.entry("17", "seventeen"), Map.entry("18", "eighteen"), Map.entry("19", "nineteen"),
            Map.entry("20", "twenty"), Map.entry("30", "thirty"), Map.entry("40", "forty"), Map.entry("50", "fifty"),
            Map.entry("60", "sixty"), Map.entry("70", "seventy"), Map.entry("80", "eighty"), Map.entry("90", "ninety"));

    private static final Map<String, String> UK_TO_US_SPELLING = Map.ofEntries(
            Map.entry("colour", "color"), Map.entry("colours", "colors"), Map.entry("coloured", "colored"), Map.entry("colouring", "coloring"),
            Map.entry("centre", "center"), Map.entry("centres", "centers"), Map.entry("centred", "centered"),
            Map.entry("organise", "organize"), Map.entry("organises", "organizes"), Map.entry("organised", "organized"), Map.entry("organising", "organizing"), Map.entry("organisation", "organization"),
            Map.entry("analyse", "analyze"), Map.entry("analyses", "analyzes"), Map.entry("analysed", "analyzed"), Map.entry("analysing", "analyzing"),
            Map.entry("travelling", "traveling"), Map.entry("travelled", "traveled"), Map.entry("traveller", "traveler"),
            Map.entry("behaviour", "behavior"), Map.entry("behaviours", "behaviors"),
            Map.entry("favour", "favor"), Map.entry("favours", "favors"), Map.entry("favoured", "favored"), Map.entry("favourite", "favorite"), Map.entry("favourites", "favorites"),
            Map.entry("programme", "program"), Map.entry("programmes", "programs"),
            Map.entry("realise", "realize"), Map.entry("realises", "realizes"), Map.entry("realised", "realized"), Map.entry("realising", "realizing"),
            Map.entry("theatre", "theater"), Map.entry("theatres", "theaters"));

    private String cleanWordForComparison(String token) {
        if (token == null) return "";
        String word = token.replaceAll("^[^a-zA-Z0-9']+|[^a-zA-Z0-9']+$", "").toLowerCase(Locale.ROOT);
        word = SPOKEN_CARDINALS.getOrDefault(word, word);
        return UK_TO_US_SPELLING.getOrDefault(word, word);
    }

    private String buildAlignmentFeedback(int accuracy, boolean isPerfectMatch) {
        if (isPerfectMatch && accuracy >= 100) {
            return "Khớp từ hoàn hảo! Bạn đã nói đúng toàn bộ các từ trong câu mẫu.";
        } else if (accuracy >= 80) {
            return "Độ khớp nội dung tốt. Hãy chú ý các từ bị thiếu hoặc nhận diện khác câu mẫu.";
        } else if (accuracy >= 50) {
            return "Độ khớp nội dung trung bình. Hãy nghe lại câu mẫu để nắm rõ từ ngữ.";
        } else {
            return "Độ khớp nội dung thấp. Hãy nghe lại câu mẫu nhiều lần trước khi thu âm.";
        }
    }

    public com.englishcoach.speaking.dto.EcsmAnalysisResponseDto analyzeEcsmSpeech(
            MultipartFile file,
            String expectedText,
            Long unitId,
            String referenceMode,
            String sessionId,
            String attemptId,
            String caseId,
            String parentAttemptId,
            String activeTargetId) {
        return analyzeEcsmSpeech(file, expectedText, unitId, referenceMode, sessionId, attemptId, caseId, parentAttemptId, activeTargetId, null);
    }

    public com.englishcoach.speaking.dto.EcsmAnalysisResponseDto analyzeEcsmSpeech(
            MultipartFile file,
            String expectedText,
            Long unitId,
            String referenceMode,
            String sessionId,
            String attemptId,
            String caseId,
            String parentAttemptId,
            String activeTargetId,
            Long userId) {
        if (file == null || file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio file payload is empty");
        }

        if (file.getSize() > 25 * 1024 * 1024L) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio file exceeds maximum size limit of 25MB");
        }

        validateTextLength(expectedText, "expectedText");
        String authoritativeText = resolveAuthoritativeExpectedText(expectedText, unitId);
        validateTextLength(authoritativeText, "expectedText");

        // Idempotency: If attemptId was already successfully analyzed and persisted, return it directly without re-inference
        if (sessionId != null && attemptId != null && speakingShadowingAttemptRepository != null && objectMapper != null) {
            try {
                Optional<Long> sessId = parseDatabaseSessionId(sessionId);
                if (sessId.isPresent()) {
                    var existingAttempt = speakingShadowingAttemptRepository.findBySessionIdAndClientAttemptId(sessId.get(), attemptId);
                    if (existingAttempt.isPresent()
                            && (existingAttempt.get().getProductContractVersion() == null
                            || existingAttempt.get().getProductContractVersion().startsWith("ECSM_"))
                            && existingAttempt.get().getProductSafeResultJson() != null
                            && !existingAttempt.get().getProductSafeResultJson().isBlank()) {
                        log.info("Idempotent ECSM analysis hit for session {} and attempt {} -> zero re-inference", sessionId, attemptId);
                        return objectMapper.readValue(existingAttempt.get().getProductSafeResultJson(), com.englishcoach.speaking.dto.EcsmAnalysisResponseDto.class);
                    }
                }
            } catch (Exception e) {
                log.warn("Idempotency check warning for attempt {}: {}", attemptId, e.getMessage());
            }
        }

        // Authoritative same-audio orchestration: Whisper/content correspondence
        // completes first, then ECSM receives the correspondence contract for the
        // exact same MultipartFile bytes. The frontend cannot override this gate.
        Map<String, Object> speakingAnalysis = forwardAudioForAnalysis(file, authoritativeText);
        String recognizedText = extractRecognizedText(speakingAnalysis);
        boolean transcriptionMocked = Boolean.TRUE.equals(speakingAnalysis.get("isMocked"));
        int contentMatchPercentage = speakingAnalysis.get("accuracyScore") instanceof Number n
                ? Math.max(0, Math.min(100, n.intValue()))
                : 0;
        double contentMatchRatio = contentMatchPercentage / 100.0;
        List<Integer> matchedTargetWordIndices = extractMatchedTargetWordIndices(speakingAnalysis.get("wordAlignment"));
        String audioIdentity;
        try {
            audioIdentity = sha256Hex(file.getBytes());
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Failed to verify uploaded audio identity");
        }

        if (transcriptionMocked) {
            log.error("Authoritative transcription unavailable for attempt {}; ECSM was not invoked", attemptId);
            return com.englishcoach.speaking.dto.EcsmAnalysisResponseDto.builder()
                    .status("FAILED")
                    .assessmentStatus("ASSESSMENT_UNAVAILABLE")
                    .attemptId(attemptId)
                    .caseId(caseId)
                    .recognizedTranscript(recognizedText)
                    .contentMatchPercentage(contentMatchPercentage)
                    .contentMatchRatio(contentMatchRatio)
                    .matchedTargetWordIndices(matchedTargetWordIndices)
                    .sameAudioVerified(false)
                    .audioIdentity(audioIdentity)
                    .errorCode("AUDIO_PIPELINE_REQUIRES_REPAIR")
                    .errorMessage("Speech transcription was unavailable; pronunciation assessment was not run.")
                    .retryable(true)
                    .failureStage("CONTENT_CORRESPONDENCE")
                    .internalReasonCode("AUTHORITATIVE_TRANSCRIPTION_UNAVAILABLE")
                    .gatingReasons(List.of("AUDIO_PIPELINE_REQUIRES_REPAIR"))
                    .build();
        }

        String targetUrl = aiBaseUrl + "/api/v1/ecsm/analyze";
        log.info("Forwarding ECSM pronunciation analysis request to {} (filename={}, contentType={}, size={} bytes, expectedText='{}')",
                targetUrl, resolveAudioFilename(file), file.getContentType(), file.getSize(), authoritativeText != null ? authoritativeText : "");

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);

        String resolvedFilename = resolveAudioFilename(file);

        try {
            MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
            body.add("file", buildAudioPart(file, resolvedFilename));
            body.add("expected_text", authoritativeText != null ? authoritativeText.trim() : "");
            body.add("recognized_text", recognizedText);
            body.add("content_match_ratio", Double.toString(contentMatchRatio));
            body.add("matched_target_word_indices_json", objectMapper.writeValueAsString(matchedTargetWordIndices));
            body.add("audio_identity", audioIdentity);
            if (caseId != null) body.add("case_id", caseId);
            body.add("reference_mode", referenceMode != null ? referenceMode : "SHADOWING_REFERENCE_RELATIVE");
            if (sessionId != null) body.add("session_id", sessionId);
            if (attemptId != null) body.add("attempt_id", attemptId);
            if (parentAttemptId != null) body.add("parent_attempt_id", parentAttemptId);
            if (activeTargetId != null) body.add("active_target_id", activeTargetId);
            body.add("view_mode", "PRODUCT_SAFE");

            HttpEntity<MultiValueMap<String, Object>> requestEntity = new HttpEntity<>(body, headers);
            RestTemplate restTemplate = createRestTemplateWithTimeout();

            ResponseEntity<com.englishcoach.speaking.dto.EcsmAnalysisResponseDto> response = restTemplate.postForEntity(
                    targetUrl,
                    requestEntity,
                    com.englishcoach.speaking.dto.EcsmAnalysisResponseDto.class
            );

            com.englishcoach.speaking.dto.EcsmAnalysisResponseDto result = response.getBody();
            if (result != null && result.getAttemptId() == null && attemptId != null) {
                result.setAttemptId(attemptId);
            }
            if (result != null) {
                result.setCaseId(caseId);
                result.setRecognizedTranscript(recognizedText);
                result.setContentMatchPercentage(contentMatchPercentage);
                result.setContentMatchRatio(contentMatchRatio);
                result.setMatchedTargetWordIndices(matchedTargetWordIndices);
                result.setAudioIdentity(audioIdentity);
                result.setSameAudioVerified(Boolean.TRUE.equals(result.getSameAudioVerified()));
            }

            // Persist durable product-safe attempt record with retry lineage and locked target
            if (result != null && sessionId != null && attemptId != null && userId != null && speakingShadowingService != null) {
                try {
                    Optional<Long> sessId = parseDatabaseSessionId(sessionId);
                    if (sessId.isPresent()) {
                        speakingShadowingService.recordEcsmAttempt(
                                userId, sessId.get(), unitId, attemptId, parentAttemptId, activeTargetId, result
                        );
                    }
                } catch (Exception e) {
                    log.warn("Failed to persist product-safe attempt record {}: {}", attemptId, e.getMessage());
                }
            }

            return result;

        } catch (org.springframework.web.client.HttpStatusCodeException httpEx) {
            log.warn("AI service HTTP error during ECSM analysis: status={}, body={}",
                    httpEx.getStatusCode(), httpEx.getResponseBodyAsString());
            if (httpEx.getStatusCode() == HttpStatus.TOO_MANY_REQUESTS) {
                throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "ECSM Runtime inference queue is busy. Please retry.");
            }
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "AI speech service is currently unavailable");
        } catch (Exception e) {
            log.error("Failed to forward ECSM speech analysis to AI service: {}", e.getMessage(), e);
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "AI speech service is currently unreachable");
        }
    }

    private Optional<Long> parseDatabaseSessionId(String sessionId) {
        if (sessionId == null || !sessionId.matches("\\d+")) {
            return Optional.empty();
        }
        try {
            return Optional.of(Long.parseLong(sessionId));
        } catch (NumberFormatException ignored) {
            return Optional.empty();
        }
    }

    String resolveAuthoritativeExpectedText(String expectedText, Long unitId) {
        String authoritativeText = expectedText;
        if ((authoritativeText == null || authoritativeText.isBlank()) && unitId != null && speakingShadowingUnitRepository != null) {
            var unitOpt = speakingShadowingUnitRepository.findById(unitId);
            if (unitOpt.isPresent()) {
                authoritativeText = unitOpt.get().getDisplayText();
                log.info("Resolved authoritative expectedText from SpeakingShadowingUnit id={}: '{}'", unitId, authoritativeText);
            }
        }
        return authoritativeText;
    }

    private String extractRecognizedText(Map<String, Object> responseMap) {
        if (responseMap == null) return "";
        if (responseMap.get("transcription") != null) {
            return String.valueOf(responseMap.get("transcription"));
        }
        if (responseMap.get("transcript") instanceof Map<?, ?> transcript && transcript.get("text") != null) {
            return String.valueOf(transcript.get("text"));
        }
        return "";
    }

    List<Integer> extractMatchedTargetWordIndices(Object rawAlignment) {
        if (!(rawAlignment instanceof List<?> alignment)) return List.of();
        List<Integer> result = new ArrayList<>();
        for (Object item : alignment) {
            if (!(item instanceof Map<?, ?> row)) continue;
            String status = String.valueOf(row.get("status"));
            Object rawIndex = row.get("targetWordIndex");
            if (("MATCH".equalsIgnoreCase(status) || "NEAR_MATCH".equalsIgnoreCase(status)) && rawIndex instanceof Number n && n.intValue() >= 0) {
                result.add(n.intValue());
            }
        }
        return result.stream().distinct().sorted().toList();
    }

    private String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    private String resolveAudioFilename(MultipartFile file) {
        if (file.getOriginalFilename() != null && !file.getOriginalFilename().isBlank()) {
            String rawName = file.getOriginalFilename();
            // Strip directory traversal and path separators
            int lastSep = Math.max(rawName.lastIndexOf('/'), rawName.lastIndexOf('\\'));
            if (lastSep >= 0) {
                rawName = rawName.substring(lastSep + 1);
            }
            String sanitized = rawName.replaceAll("[^a-zA-Z0-9._-]", "_");
            if (!sanitized.isBlank()) {
                return sanitized;
            }
        }
        String contentType = file.getContentType();
        if (contentType != null) {
            String ct = contentType.toLowerCase();
            if (ct.contains("mp4") || ct.contains("m4a")) return "recording.mp4";
            if (ct.contains("ogg")) return "recording.ogg";
            if (ct.contains("wav")) return "recording.wav";
            if (ct.contains("mp3") || ct.contains("mpeg")) return "recording.mp3";
        }
        return "recording.webm";
    }

    private HttpEntity<ByteArrayResource> buildAudioPart(MultipartFile file, String resolvedFilename) throws IOException {
        ByteArrayResource resource = new ByteArrayResource(file.getBytes()) {
            @Override
            public String getFilename() {
                return resolvedFilename;
            }
        };
        HttpHeaders partHeaders = new HttpHeaders();
        String contentType = file.getContentType();
        try {
            partHeaders.setContentType(contentType != null && !contentType.isBlank()
                    ? MediaType.parseMediaType(contentType)
                    : MediaType.APPLICATION_OCTET_STREAM);
        } catch (IllegalArgumentException ignored) {
            partHeaders.setContentType(MediaType.APPLICATION_OCTET_STREAM);
        }
        return new HttpEntity<>(resource, partHeaders);
    }

    private HttpEntity<ByteArrayResource> buildAudioPart(byte[] audioBytes, String resolvedFilename, String contentType) {
        ByteArrayResource resource = new ByteArrayResource(audioBytes) {
            @Override
            public String getFilename() {
                return resolvedFilename != null ? resolvedFilename : "recording.wav";
            }
        };
        HttpHeaders partHeaders = new HttpHeaders();
        try {
            partHeaders.setContentType(contentType != null && !contentType.isBlank()
                    ? MediaType.parseMediaType(contentType)
                    : MediaType.APPLICATION_OCTET_STREAM);
        } catch (IllegalArgumentException ignored) {
            partHeaders.setContentType(MediaType.APPLICATION_OCTET_STREAM);
        }
        return new HttpEntity<>(resource, partHeaders);
    }

    @Transactional
    public SpeakingSession createSession(Long userId, SpeakingSessionRequest request) {
        User user = userRepository.findById(userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found: " + userId));

        com.englishcoach.speaking.entity.SpeakingScenario scenario = null;
        if (request != null && request.scenarioId() != null) {
            scenario = speakingScenarioRepository.findByIdAndAccessible(request.scenarioId(), userId)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking scenario not found: " + request.scenarioId()));
        }

        String mode = (request != null && request.mode() != null) ? request.mode().toUpperCase() : "SHADOWING";
        if (!"SHADOWING".equals(mode) && !"ROLEPLAY".equals(mode)) {
            mode = "SHADOWING";
        }

        String sourceType = request != null && request.sourceType() != null && !request.sourceType().isBlank()
                ? request.sourceType().trim().toUpperCase(Locale.ROOT)
                : null;
        Long sourceId = request != null ? request.sourceId() : null;
        if (sourceId != null) {
            if ("READING".equals(sourceType)) {
                if (readingMaterialRepository != null
                        && readingMaterialRepository.findByIdAndVisibleToUser(sourceId, userId).isEmpty()) {
                    throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Reading material not found: " + sourceId);
                }
            } else if ("LISTENING".equals(sourceType) || sourceType == null) {
                if (listeningMaterialRepository != null
                        && listeningMaterialRepository.findByIdAndVisibleToUser(sourceId, userId).isEmpty()) {
                    throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Listening material not found: " + sourceId);
                }
            } else if (!"VOCABULARY".equals(sourceType)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported sourceType");
            }
        }

        String resolvedVoiceId = "us_female";
        if (request != null && request.voiceId() != null && !request.voiceId().isBlank()) {
            String candidate = request.voiceId().trim().toLowerCase();
            if (List.of("us_male", "us_female", "uk_male", "uk_female").contains(candidate)) {
                resolvedVoiceId = candidate;
            }
        } else if (scenario != null && scenario.getDefaultVoiceId() != null && !scenario.getDefaultVoiceId().isBlank()) {
            resolvedVoiceId = scenario.getDefaultVoiceId().trim().toLowerCase();
        }

        SpeakingSession session = SpeakingSession.builder()
                .user(user)
                .scenario(scenario)
                .mode(mode)
                .status("ACTIVE")
                .sourceType(sourceType)
                .sourceId(sourceId)
                .durationSeconds(0)
                .voiceId(resolvedVoiceId)
                .build();
        return speakingSessionRepository.save(session);
    }

    @Transactional
    public SpeakingSession updateSession(Long userId, Long sessionId, SpeakingSessionUpdateRequest request) {
        SpeakingSession session = speakingSessionRepository.findById(sessionId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking session not found: " + sessionId));

        if (!session.getUser().getId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Unauthorized session access");
        }

        if (request != null) {
            if (request.status() != null && !request.status().isBlank()) {
                String targetStatus = request.status().toUpperCase();

                // Validate legal state transitions
                if ("COMPLETED".equalsIgnoreCase(session.getStatus()) && !"COMPLETED".equalsIgnoreCase(targetStatus)) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Cannot alter state of an already completed session");
                }

                if (!List.of("ACTIVE", "COMPLETED", "ABANDONED").contains(targetStatus)) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid session status: " + request.status());
                }

                session.setStatus(targetStatus);
            }
            if (request.durationSeconds() != null) {
                if (request.durationSeconds() < 0) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "durationSeconds must be non-negative");
                }
                int maxAllowed = MAX_SESSION_DURATION_SECONDS;
                if (session.getCreatedAt() != null) {
                    long elapsed = java.time.Duration.between(session.getCreatedAt(), java.time.LocalDateTime.now()).getSeconds();
                    long serverCap = Math.max(0L, elapsed) + SESSION_DURATION_GRACE_SECONDS;
                    maxAllowed = (int) Math.min(MAX_SESSION_DURATION_SECONDS, serverCap);
                }
                session.setDurationSeconds(Math.min(request.durationSeconds(), maxAllowed));
            }
        }

        return speakingSessionRepository.save(session);
    }

    public PronunciationV2ResponseDto analyzePronunciationV2(
            MultipartFile file,
            String expectedText,
            String freeTranscript,
            String sessionId,
            String attemptId) {
        return analyzePronunciationV2(file, expectedText, freeTranscript, sessionId, attemptId, null);
    }

    public PronunciationV2ResponseDto analyzePronunciationV2(
            MultipartFile file,
            String expectedText,
            String freeTranscript,
            String sessionId,
            String attemptId,
            String accent) {
        if (file == null || file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio file payload is empty");
        }
        if (file.getSize() > MAX_AUDIO_BYTES) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio file exceeds maximum size limit of 25MB");
        }
        try {
            return analyzePronunciationV2(
                    file.getBytes(),
                    resolveAudioFilename(file),
                    file.getContentType(),
                    expectedText,
                    freeTranscript,
                    sessionId,
                    attemptId,
                    accent
            );
        } catch (IOException e) {
            log.warn("Failed to read audio file bytes for pronunciation analysis: {}", e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Failed to read audio file");
        }
    }

    public PronunciationV2ResponseDto analyzePronunciationV2(
            byte[] audioBytes,
            String filename,
            String expectedText,
            String freeTranscript,
            String sessionId,
            String attemptId) {
        return analyzePronunciationV2(audioBytes, filename, null, expectedText, freeTranscript, sessionId, attemptId, null);
    }

    public PronunciationV2ResponseDto analyzePronunciationV2(
            byte[] audioBytes,
            String filename,
            String contentType,
            String expectedText,
            String freeTranscript,
            String sessionId,
            String attemptId,
            String accent) {
        validateAudioPayload(audioBytes);
        if (expectedText == null || expectedText.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "expectedText is required");
        }
        validateTextLength(expectedText, "expectedText");
        validateTextLength(freeTranscript, "freeTranscript");
        String targetUrl = aiBaseUrl + "/pronunciation/v2/analyze";
        String resolvedFilename = filename != null ? filename : "recording.wav";
        String resolvedMime = detectAudioMime(audioBytes, resolvedFilename, contentType);
        log.info("Forwarding Pronunciation V2 request to AI service at {} (mime={}, size={} bytes)", targetUrl, resolvedMime, audioBytes.length);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);

        MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
        body.add("file", buildAudioPart(audioBytes, resolvedFilename, resolvedMime));
        body.add("expected_text", expectedText.trim());
        if (freeTranscript != null && !freeTranscript.isBlank()) {
            body.add("free_transcript", freeTranscript.trim());
        }
        if (sessionId != null) body.add("session_id", sessionId);
        if (attemptId != null) body.add("attempt_id", attemptId);
        if (accent != null && !accent.isBlank()) {
            String cleanAccent = accent.trim();
            if (!cleanAccent.matches("[a-zA-Z0-9_-]{1,32}")) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid accent parameter");
            }
            body.add("accent", cleanAccent);
        }

        HttpEntity<MultiValueMap<String, Object>> requestEntity = new HttpEntity<>(body, headers);
        RestTemplate restTemplate = createRestTemplateWithTimeout();
        try {
            ResponseEntity<PronunciationV2ResponseDto> response = restTemplate.postForEntity(targetUrl, requestEntity, PronunciationV2ResponseDto.class);
            var result = response.getBody();
            return result == null ? null : result.useMeasuredStress();
        } catch (Exception e) {
            log.error("Error communicating with Pronunciation V2 service: {}", e.getMessage());
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Pronunciation analysis service is currently unavailable");
        }
    }

    /**
     * Canonical unified Shadowing attempt analysis.
     * Takes uploaded audio once in memory, obtains Whisper STT for content match,
     * and runs Pronunciation V2.2 for acoustic phonetics/prosody.
     * Invariant: Never substitutes content score as pronunciation score.
     */
    public ShadowingAnalysisResponseDto analyzeShadowingAttempt(
            MultipartFile file,
            Long unitId,
            String expectedText,
            String sessionId,
            String attemptId,
            String parentAttemptId,
            String activeTargetId
    ) {
        return analyzeShadowingAttempt(file, unitId, expectedText, sessionId, attemptId, parentAttemptId, activeTargetId, null);
    }

    public ShadowingAnalysisResponseDto analyzeShadowingAttempt(
            MultipartFile file,
            Long unitId,
            String expectedText,
            String sessionId,
            String attemptId,
            String parentAttemptId,
            String activeTargetId,
            Long userId
    ) {
        if (file == null || file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio file payload is empty");
        }
        if (file.getSize() > MAX_AUDIO_BYTES) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Audio file exceeds maximum size limit of 25MB");
        }
        if (expectedText == null || expectedText.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "expectedText is required");
        }
        validateTextLength(expectedText, "expectedText");

        byte[] audioBytes;
        try {
            audioBytes = file.getBytes();
        } catch (IOException e) {
            log.warn("Failed to read audio file bytes for shadowing attempt: {}", e.getMessage());
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Failed to read audio file");
        }
        validateAudioPayload(audioBytes);

        Long databaseSession = null;
        String digest = sha256Hex(audioBytes);
        if (userId != null) {
            databaseSession = parseDatabaseSessionId(sessionId).orElseThrow(() ->
                    new ResponseStatusException(HttpStatus.BAD_REQUEST, "Valid shadowing session required"));
            if (attemptId == null || !attemptId.matches("[a-zA-Z0-9_-]{1,100}")) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Valid attempt identifier required");
            }
            expectedText = speakingShadowingService.referenceForAnalysis(userId, databaseSession, unitId);
            validateTextLength(expectedText, "expectedText");
            var previous = analysisReceipts.lookup(userId, attemptId, databaseSession, unitId, digest);
            if (previous != null) return previous;
        }
        String filename = resolveAudioFilename(file);

        // Persist learner audio securely to persistent backend volume (cleaned up on STT/receipt failure)
        String audioRef = null;
        boolean newlySavedAudio = false;
        if (userId != null && attemptId != null && speakingAudioStorageService != null) {
            boolean existedBefore = speakingAudioStorageService.getAudioRefIfExists(userId, attemptId) != null;
            audioRef = speakingAudioStorageService.saveAttemptAudio(userId, attemptId, audioBytes, filename);
            if (audioRef == null) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Cannot save recording");
            newlySavedAudio = !existedBefore;
        }

        boolean receiptIssued = false;
        try {
            // 1. STT via Whisper (content matching)
            Map<String, Object> sttAnalysis = forwardAudioForAnalysis(
                    audioBytes,
                    filename,
                    file.getContentType(),
                    expectedText,
                    true
            );
            String transcript = "";
            if (sttAnalysis.get("transcription") != null) {
                transcript = String.valueOf(sttAnalysis.get("transcription"));
            } else if (sttAnalysis.get("transcript") instanceof Map tMap && tMap.get("text") != null) {
                transcript = String.valueOf(tMap.get("text"));
            }

            Double contentMatchScore = null;
            if (sttAnalysis.get("accuracyScore") instanceof Number n) {
                contentMatchScore = n.doubleValue();
            }
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> wordAlignment = (List<Map<String, Object>>) sttAnalysis.get("wordAlignment");
            boolean isMocked = Boolean.TRUE.equals(sttAnalysis.get("isMocked"));

            // 2. Acoustic Pronunciation Assessment via Pronunciation V2.2 / V3
            PronunciationV2ResponseDto v2Response = null;
            Double pronScore = null;
            Double fluency = null;
            Integer measuredDurationSeconds = null;
            try {
                v2Response = analyzePronunciationV2(
                        audioBytes,
                        filename,
                        file.getContentType(),
                        expectedText,
                        transcript,
                        sessionId,
                        attemptId,
                        null
                );
                if (v2Response != null && v2Response.getAudioQuality() != null
                        && v2Response.getAudioQuality().getDurationSec() != null
                        && Double.isFinite(v2Response.getAudioQuality().getDurationSec())
                        && v2Response.getAudioQuality().getDurationSec() >= 0.0) {
                    measuredDurationSeconds = (int) Math.max(0L, Math.min(180L, Math.round(v2Response.getAudioQuality().getDurationSec())));
                }
                if (v2Response != null && "COMPLETED".equals(v2Response.getStatus()) && v2Response.getOverall() != null) {
                    if (v2Response.getOverall().getOverallScore() != null) {
                        pronScore = v2Response.getOverall().getOverallScore().doubleValue();
                    }
                    if (v2Response.getOverall().getFluencyScore() != null) {
                        fluency = v2Response.getOverall().getFluencyScore().doubleValue();
                    }
                }
            } catch (Exception e) {
                log.warn("Pronunciation V2.2 analysis unavailable for attempt {}: {}", attemptId, e.getMessage());
                // Invariant: NEVER substitute content match score as pronunciation score
                pronScore = null;
                fluency = null;
            }

            var analysis = ShadowingAnalysisResponseDto.builder()
                    .clientAttemptId(attemptId)
                    .learnerTranscript(transcript)
                    .accuracyScore(contentMatchScore)
                    .pronunciationScore(pronScore)
                    .fluencyScore(fluency)
                    .wordAlignment(wordAlignment)
                    .pronunciationV2(v2Response)
                    .isMocked(isMocked)
                    .feedback((String) sttAnalysis.get("feedback"))
                    .durationSeconds(measuredDurationSeconds)
                    .audioRef(audioRef)
                    .build();
            ShadowingAnalysisResponseDto result = userId == null
                    ? analysis
                    : analysisReceipts.issue(userId, attemptId, databaseSession, unitId, digest, analysis);
            receiptIssued = true;
            return result;
        } finally {
            if (!receiptIssued && newlySavedAudio && audioRef != null && speakingAudioStorageService != null) {
                boolean ownedByExistingAttempt = speakingShadowingAttemptRepository != null
                        && speakingShadowingAttemptRepository.findByClientAttemptId(attemptId).isPresent();
                if (!ownedByExistingAttempt) {
                    speakingAudioStorageService.deleteAttemptAudioByRef(audioRef);
                }
            }
        }
    }
}
