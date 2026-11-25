package com.englishcoach.speaking.service;

import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingTurnRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.Resource;
import org.springframework.http.*;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.io.InputStream;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.Arrays;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

@Service
@RequiredArgsConstructor
@Slf4j
public class SpeakingTtsService {

    public static final String PREVIEW_SENTENCE = "Hi! It's great to meet you. What would you like to talk about today?";

    public record VoiceMetaDto(String voiceId, String displayName, String accent, String gender) {}

    public static final List<VoiceMetaDto> CANONICAL_VOICES = List.of(
            new VoiceMetaDto("us_male", "American Male", "US", "male"),
            new VoiceMetaDto("us_female", "American Female", "US", "female"),
            new VoiceMetaDto("uk_male", "British Male", "UK", "male"),
            new VoiceMetaDto("uk_female", "British Female", "UK", "female")
    );

    private final SpeakingAudioStorageService speakingAudioStorageService;
    private final SpeakingSessionRepository speakingSessionRepository;
    private final SpeakingTurnRepository speakingTurnRepository;

    @Autowired(required = false)
    private PlatformTransactionManager transactionManager;

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

    private record TurnAudioPhase1(String existingAudioRef, String rawVoiceId, String text) {}

    @Value("${tts.omnivoice.url:http://127.0.0.1:8005/tts/omnivoice}")
    private String omnivoiceUrl;

    @Value("${ai.base-url:http://localhost:8000}")
    private String aiBaseUrl;

    @Value("${tts.omnivoice.timeout-ms:45000}")
    private int timeoutMs;

    @Value("${tts.omnivoice.service-key:${ai.service-key:}}")
    private String aiServiceKey;

    public List<VoiceMetaDto> getVoices() {
        return CANONICAL_VOICES;
    }

    public static String normalizeText(String text) {
        if (text == null) return "";
        return text.trim().replaceAll("\\s+", " ");
    }

    public static String sanitizeVoiceId(String voiceId) {
        if (voiceId == null || voiceId.isBlank()) {
            return "us_female";
        }
        String clean = voiceId.trim().toLowerCase();
        if (List.of("us_male", "us_female", "uk_male", "uk_female").contains(clean)) {
            return clean;
        }
        return "us_female";
    }

    public static String computeCacheKey(String voiceId, String text) {
        String cleanVoice = sanitizeVoiceId(voiceId);
        String normalized = normalizeText(text);
        String raw = "omnivoice-v1:" + cleanVoice + ":" + normalized;
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(raw.getBytes(StandardCharsets.UTF_8));
            StringBuilder hexString = new StringBuilder();
            for (byte b : hash) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) hexString.append('0');
                hexString.append(hex);
            }
            return hexString.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 algorithm missing", e);
        }
    }

    /**
     * The fixed preview sentence in one of the four voices; public. Normally served from the cache. When a preview is
     * not cached yet it costs one synthesis: an anonymous caller takes a free worker slot or is told to come back, it
     * never queues for the worker.
     */
    public Resource synthesizePreview(String voiceId) {
        String cleanVoice = sanitizeVoiceId(voiceId);
        String hash = computeCacheKey(cleanVoice, PREVIEW_SENTENCE);
        if (speakingAudioStorageService.ttsAudioExists(cleanVoice, hash)) {
            return speakingAudioStorageService.loadTtsAudioResource(cleanVoice, hash);
        }
        java.util.concurrent.Semaphore slots = synthesizeSlots();
        if (!slots.tryAcquire()) {
            throw retryLater(HttpStatus.SERVICE_UNAVAILABLE, "Echo đang bận tạo giọng đọc. Vui lòng thử lại sau giây lát.", 5);
        }
        try {
            return synthesize(cleanVoice, PREVIEW_SENTENCE);
        } finally {
            slots.release();
        }
    }

    /** Reuses the Speaking provider without publishing private study text into its public cache. */
    public byte[] synthesizePrivatePassage(String voiceId, String text) {
        if (CANONICAL_VOICES.stream().noneMatch(v -> v.voiceId().equals(voiceId))
                || text == null || text.isBlank() || text.length() > 500) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid voice or passage");
        }
        try {
            return invokeOmnivoiceUpstream(voiceId, normalizeText(text));
        } catch (Exception e) {
            // Do not return upstream details or private text to the learner.
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Chưa thể tạo giọng đọc. Vui lòng thử lại sau.");
        }
    }

    /** Longest text one learner request may synthesize (a roleplay turn or a typed preview, never a document). */
    @Value("${tts.synthesize.max-chars:1200}")
    private int synthesizeMaxChars;

    /** New syntheses running on the GPU worker at once for this endpoint; a cached text never takes a slot. */
    @Value("${tts.synthesize.max-concurrent:6}")
    private int synthesizeMaxConcurrent;

    /** New (uncached) syntheses one learner may start per ten minutes. */
    @Value("${tts.synthesize.user-new-per-10-min:40}")
    private int synthesizeUserNewPer10Min;

    private volatile java.util.concurrent.Semaphore synthesizeSlots;

    /** The shared rate-limit store (absent in slim unit tests: the per-learner count is then not applied). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.englishcoach.auth.service.LoginThrottleService throttleService;

    private java.util.concurrent.Semaphore synthesizeSlots() {
        java.util.concurrent.Semaphore slots = synthesizeSlots;
        if (slots == null) {
            synchronized (this) {
                if (synthesizeSlots == null) {
                    synthesizeSlots = new java.util.concurrent.Semaphore(Math.max(1, synthesizeMaxConcurrent), true);
                }
                slots = synthesizeSlots;
            }
        }
        return slots;
    }

    private static ResponseStatusException retryLater(HttpStatus status, String message, int retryAfterSeconds) {
        return new ResponseStatusException(status, message) {
            @Override
            public HttpHeaders getHeaders() {
                HttpHeaders headers = new HttpHeaders();
                headers.set(HttpHeaders.RETRY_AFTER, String.valueOf(retryAfterSeconds));
                return headers;
            }
        };
    }

    /**
     * Speech for a signed-in learner's own text. Refusals happen before any GPU work: a text that is too long, a
     * learner who started too many new syntheses, a worker that is already busy.
     */
    public byte[] synthesizeEchoSentence(Long userId, String voiceId, String text) {
        if (userId == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        if (text == null || text.isBlank() || text.length() > 500 || CANONICAL_VOICES.stream().noneMatch(v -> v.voiceId().equals(voiceId)))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid voice or sentence");
        if (throttleService != null && !throttleService.countRequest("TTS_SYNTH_USER", String.valueOf(userId),
                synthesizeUserNewPer10Min > 0 ? synthesizeUserNewPer10Min : 40, 10))
            throw retryLater(HttpStatus.TOO_MANY_REQUESTS, "Voice synthesis limit reached", 60);
        var slots = synthesizeSlots();
        if (!slots.tryAcquire()) throw retryLater(HttpStatus.SERVICE_UNAVAILABLE, "Voice synthesis busy", 3);
        try { return synthesizePrivatePassage(voiceId, text); }
        finally { slots.release(); }
    }

    /** Shared keep-alive HTTP/1.1 client for GPU TTS calls (eliminates per-clause TCP handshakes & prevents redirects). */
    private static final HttpClient SHARED_TTS_HTTP = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .connectTimeout(Duration.ofMillis(2500))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();

    /**
     * Charges the per-user {@code TTS_SYNTH_USER} rolling budget ONCE for an entire multi-clause voice turn
     * (so a 4-clause Echo JARVIS reply consumes 1 turn instead of 4 quota hits).
     */
    public boolean admitEchoVoiceTtsTurn(Long userId) {
        if (userId == null) return false;
        if (throttleService == null) return true;
        return throttleService.countRequest("TTS_SYNTH_USER", String.valueOf(userId),
                synthesizeUserNewPer10Min > 0 ? synthesizeUserNewPer10Min : 40, 10);
    }

    /**
     * Streams 24 kHz PCM16LE chunks for a signed-in learner's spoken Echo sentence using the exact same auth, length
     * ({@code <= 500}), per-user throttle ({@code TTS_SYNTH_USER}), and concurrency bulkhead as {@link #synthesizeEchoSentence}.
     * Streams live from {@code /api/v1/tts/stream}, falling back cleanly to {@link #synthesizePrivatePassage} WAV PCM-strip
     * if the streaming route is unavailable.
     */
    public void streamEchoSentence(Long userId, String voiceId, String text, Consumer<byte[]> onChunk) {
        streamEchoSentence(userId, voiceId, text, onChunk, false);
    }

    /**
     * Overload allowing a WebSocket voice turn that already charged {@link #admitEchoVoiceTtsTurn(Long)} once at turn start
     * to stream Clause 0..N without multiplying per-user throttle hits, while still enforcing bounded GPU slot concurrency.
     */
    public void streamEchoSentence(Long userId, String voiceId, String text, Consumer<byte[]> onChunk, boolean skipUserThrottle) {
        if (userId == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        if (onChunk == null || text == null || text.isBlank() || text.length() > 500
                || CANONICAL_VOICES.stream().noneMatch(v -> v.voiceId().equals(voiceId))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid voice or sentence");
        }
        if (!skipUserThrottle && !admitEchoVoiceTtsTurn(userId)) {
            throw retryLater(HttpStatus.TOO_MANY_REQUESTS, "Voice synthesis limit reached", 60);
        }
        var slots = synthesizeSlots();
        boolean acquired;
        try {
            acquired = slots.tryAcquire(1500, java.util.concurrent.TimeUnit.MILLISECONDS);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            acquired = false;
        }
        if (!acquired) throw retryLater(HttpStatus.SERVICE_UNAVAILABLE, "Voice synthesis busy", 3);
        try {
            String normalized = normalizeText(text);
            boolean[] emittedAny = {false};
            Consumer<byte[]> trackedSink = chunk -> {
                if (chunk != null && chunk.length > 0) {
                    emittedAny[0] = true;
                    onChunk.accept(chunk);
                }
            };
            try {
                if (invokeStreamUpstream(voiceId, normalized, trackedSink)) {
                    return;
                }
            } catch (UncheckedIOException clientClosed) {
                throw clientClosed;
            } catch (Exception streamFailed) {
                if (emittedAny[0]) {
                    log.debug("TTS stream ended mid-utterance: {}", streamFailed.getClass().getSimpleName());
                    return;
                }
                log.debug("TTS /stream unavailable ({}), falling back to WAV PCM strip", streamFailed.getClass().getSimpleName());
            }
            // Fallback to WAV synthesis and strip RIFF header into 40ms (1920-byte) 24kHz PCM16LE slices
            byte[] wav = synthesizePrivatePassage(voiceId, normalized);
            byte[] pcm = stripWavToPcm16Le(wav);
            if (pcm.length == 0) {
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Chưa thể tạo giọng đọc. Vui lòng thử lại sau.");
            }
            int frameBytes = 1920; // 40 ms @ 24,000 Hz mono int16le
            for (int off = 0; off < pcm.length; off += frameBytes) {
                int end = Math.min(pcm.length, off + frameBytes);
                int evenLen = (end - off) & ~1;
                if (evenLen > 0) {
                    trackedSink.accept(Arrays.copyOfRange(pcm, off, off + evenLen));
                }
            }
        } finally {
            slots.release();
        }
    }

    public Resource synthesizeForLearner(Long userId, String voiceId, String text) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required");
        }
        String cleanVoice = sanitizeVoiceId(voiceId);
        String normalizedText = normalizeText(text);
        if (normalizedText.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Text to synthesize cannot be empty");
        }
        int maxChars = synthesizeMaxChars > 0 ? synthesizeMaxChars : 1200;
        if (normalizedText.length() > maxChars) {
            throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "Text is too long to synthesize");
        }
        String hash = computeCacheKey(cleanVoice, normalizedText);
        if (speakingAudioStorageService.ttsAudioExists(cleanVoice, hash)) {
            return speakingAudioStorageService.loadTtsAudioResource(cleanVoice, hash);
        }

        int perUser = synthesizeUserNewPer10Min > 0 ? synthesizeUserNewPer10Min : 40;
        if (throttleService != null && !throttleService.countRequest("TTS_SYNTH_USER", String.valueOf(userId), perUser, 10)) {
            throw retryLater(HttpStatus.TOO_MANY_REQUESTS, "Bạn đã tạo nhiều giọng đọc mới. Vui lòng thử lại sau ít phút.", 60);
        }

        java.util.concurrent.Semaphore slots = synthesizeSlots();
        boolean admitted;
        try {
            admitted = slots.tryAcquire(2, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            admitted = false;
        }
        if (!admitted) {
            throw retryLater(HttpStatus.SERVICE_UNAVAILABLE, "Echo đang bận tạo giọng đọc. Vui lòng thử lại sau giây lát.", 5);
        }
        try {
            return synthesize(cleanVoice, normalizedText);
        } finally {
            slots.release();
        }
    }

    public Resource synthesize(String voiceId, String text) {
        String cleanVoice = sanitizeVoiceId(voiceId);
        String normalizedText = normalizeText(text);
        if (normalizedText.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Text to synthesize cannot be empty");
        }

        String hash = computeCacheKey(cleanVoice, normalizedText);

        // 1. Reusable Cache Check: 0 model calls if identical voice + text exists
        if (speakingAudioStorageService.ttsAudioExists(cleanVoice, hash)) {
            log.info("TTS cache hit for voiceId={}, hash={}, length={}", cleanVoice, hash, normalizedText.length());
            return speakingAudioStorageService.loadTtsAudioResource(cleanVoice, hash);
        }

        log.info("TTS cache miss for voiceId={}, hash={}, length={}. Calling OmniVoice upstream...", cleanVoice, hash, normalizedText.length());

        // 2. Call OmniVoice Upstream Service
        byte[] wavBytes = invokeOmnivoiceUpstream(cleanVoice, normalizedText);
        if (wavBytes == null || wavBytes.length == 0) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "OmniVoice speech synthesis returned empty audio");
        }

        // 3. Persist to storage cache
        String audioRef = speakingAudioStorageService.saveTtsAudio(cleanVoice, hash, wavBytes);
        log.info("Successfully synthesized and cached OmniVoice audio -> {}", audioRef);

        return speakingAudioStorageService.loadTtsAudioResource(cleanVoice, hash);
    }

    public Resource getOrSynthesizeTurnAudio(Long userId, Long sessionId, Long turnId) {
        // Phase 1 (short read TX): verify ownership/speaker and capture detached fields
        TurnAudioPhase1 phase1 = inReadTx(() -> {
            SpeakingSession session = speakingSessionRepository.findById(sessionId)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking session not found: " + sessionId));

            if (!session.getUser().getId().equals(userId)) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Unauthorized session access");
            }

            SpeakingTurn turn = speakingTurnRepository.findById(turnId)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking turn not found: " + turnId));

            if (!turn.getSession().getId().equals(sessionId)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Turn does not belong to session: " + sessionId);
            }

            if (!"ASSISTANT".equalsIgnoreCase(turn.getSpeaker())) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "TTS synthesis is only applicable for AI assistant turns");
            }

            return new TurnAudioPhase1(turn.getSynthesizedAudioRef(), session.getVoiceId(), turn.getText());
        });

        // Fast path: turn already has persisted synthesized audio ref and file exists on disk (OUTSIDE TX)
        if (phase1.existingAudioRef() != null && !phase1.existingAudioRef().isBlank()) {
            try {
                Resource resource = speakingAudioStorageService.loadTtsAudioResourceByRef(phase1.existingAudioRef());
                log.info("Turn {} already has synthesized audio ref {}, returning persisted audio (0 generations)",
                        turnId, phase1.existingAudioRef());
                return resource;
            } catch (Exception e) {
                log.warn("Persisted audio ref {} for turn {} not readable on disk, will regenerate or check cache",
                        phase1.existingAudioRef(), turnId);
            }
        }

        boolean needsVoiceBackfill = (phase1.rawVoiceId() == null || phase1.rawVoiceId().isBlank());
        String voiceId = needsVoiceBackfill ? "us_female" : sanitizeVoiceId(phase1.rawVoiceId());
        String text = phase1.text();
        String hash = computeCacheKey(voiceId, text);

        // Check cache before invoking model; gate cache misses through synthesizeSlots semaphore (OUTSIDE TX)
        if (!speakingAudioStorageService.ttsAudioExists(voiceId, hash)) {
            java.util.concurrent.Semaphore slots = synthesizeSlots();
            boolean admitted;
            try {
                admitted = slots.tryAcquire(2, java.util.concurrent.TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                admitted = false;
            }
            if (!admitted) {
                throw retryLater(HttpStatus.SERVICE_UNAVAILABLE, "Echo đang bận tạo giọng đọc. Vui lòng thử lại sau giây lát.", 5);
            }
            try {
                if (!speakingAudioStorageService.ttsAudioExists(voiceId, hash)) {
                    byte[] wavBytes = invokeOmnivoiceUpstream(voiceId, normalizeText(text));
                    if (wavBytes == null || wavBytes.length == 0) {
                        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "OmniVoice speech synthesis returned empty audio");
                    }
                    speakingAudioStorageService.saveTtsAudio(voiceId, hash, wavBytes);
                }
            } finally {
                slots.release();
            }
        }

        String audioRef = "tts/" + voiceId + "/" + hash + ".wav";

        // Phase 2 (short write TX): persist synthesizedAudioRef (and default voiceId on legacy sessions)
        inTx(() -> {
            if (needsVoiceBackfill) {
                speakingSessionRepository.findById(sessionId).ifPresent(s -> {
                    if (s.getVoiceId() == null || s.getVoiceId().isBlank()) {
                        s.setVoiceId(voiceId);
                        speakingSessionRepository.save(s);
                        log.info("Assigned and persisted canonical default voiceId {} on legacy session {}", voiceId, sessionId);
                    }
                });
            }
            speakingTurnRepository.findById(turnId).ifPresent(t -> {
                t.setSynthesizedAudioRef(audioRef);
                speakingTurnRepository.save(t);
            });
            return null;
        });

        return speakingAudioStorageService.loadTtsAudioResource(voiceId, hash);
    }

    /**
     * Ensures the turn's synthesized audio exists and returns the persisted audio ref without
     * requiring callers to touch {@code SpeakingTurnRepository} directly.
     */
    public String getOrSynthesizeTurnAudioRef(Long userId, Long sessionId, Long turnId) {
        getOrSynthesizeTurnAudio(userId, sessionId, turnId);
        return inReadTx(() -> speakingTurnRepository.findById(turnId)
                .map(t -> t.getSynthesizedAudioRef() != null ? t.getSynthesizedAudioRef() : "")
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND)));
    }

    public Resource loadAudioByRef(String audioRef) {
        return speakingAudioStorageService.loadTtsAudioResourceByRef(audioRef);
    }

    /**
     * Ordered candidate URLs for WAV synthesis. Always prioritizes {@code aiBaseUrl + "/api/v1/tts/omnivoice"} FIRST
     * whenever {@code omnivoiceUrl} points to ANY legacy {@code :8005} endpoint (including remote Tailscale {@code :8005}
     * from frozen {@code docker-compose.prod.yml}) so requests never stall probing a closed port.
     */
    public LinkedHashSet<String> buildOmnivoiceCandidateUrls() {
        LinkedHashSet<String> candidateUrls = new LinkedHashSet<>();
        String cleanOmni = omnivoiceUrl == null ? "" : omnivoiceUrl.trim();
        String cleanAiBase = aiBaseUrl == null ? "" : aiBaseUrl.trim().replaceAll("/+$", "");

        boolean legacyPort8005 = cleanOmni.isEmpty() || isLegacyPort8005(cleanOmni);

        if (!cleanAiBase.isBlank() && legacyPort8005) {
            candidateUrls.add(cleanAiBase + "/api/v1/tts/omnivoice");
            candidateUrls.add(cleanAiBase + "/tts/omnivoice");
            return candidateUrls;
        }

        if (!cleanOmni.isBlank()) {
            candidateUrls.add(cleanOmni);
        }
        if (!cleanAiBase.isBlank()) {
            candidateUrls.add(cleanAiBase + "/api/v1/tts/omnivoice");
            candidateUrls.add(cleanAiBase + "/tts/omnivoice");
        }
        return candidateUrls;
    }

    private static boolean isLegacyPort8005(String rawUrl) {
        try {
            URI u = URI.create(rawUrl);
            if (u.getPort() == 8005) return true;
        } catch (IllegalArgumentException ignored) { }
        return rawUrl.contains(":8005/") || rawUrl.endsWith(":8005");
    }

    private String resolveInternalAuthHeader(String url, Collection<String> authorizedUrls) {
        if (aiServiceKey == null || aiServiceKey.isBlank() || url == null) return null;
        String targetOrigin = originOf(url);
        if (targetOrigin == null) return null;
        if (targetOrigin.equals(originOf(aiBaseUrl))) {
            return aiServiceKey.trim();
        }
        if (authorizedUrls != null) {
            for (String allowed : authorizedUrls) {
                if (targetOrigin.equals(originOf(allowed))) {
                    return aiServiceKey.trim();
                }
            }
        }
        return null;
    }

    private static String originOf(String rawUrl) {
        if (rawUrl == null || rawUrl.isBlank()) return null;
        try {
            URI u = URI.create(rawUrl.trim());
            if (u.getScheme() == null || u.getHost() == null) return null;
            String scheme = u.getScheme().toLowerCase(java.util.Locale.ROOT);
            int port = u.getPort() != -1 ? u.getPort() : ("https".equals(scheme) ? 443 : 80);
            return scheme + "://" + u.getHost().toLowerCase(java.util.Locale.ROOT) + ":" + port;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private boolean invokeStreamUpstream(String voiceId, String text, Consumer<byte[]> onChunk) {
        if (aiBaseUrl == null || aiBaseUrl.isBlank()) return false;
        String cleanAiBase = aiBaseUrl.trim().replaceAll("/+$", "");
        List<String> streamUrls = List.of(cleanAiBase + "/api/v1/tts/stream", cleanAiBase + "/tts/stream");

        byte[] jsonBody = ("{\"voiceId\":\"" + escapeJson(voiceId) + "\",\"text\":\"" + escapeJson(text) + "\",\"lang\":\"auto\"}")
                .getBytes(StandardCharsets.UTF_8);
        Duration reqTimeout = Duration.ofMillis(timeoutMs > 0 ? timeoutMs : 45000);

        for (String url : streamUrls) {
            boolean[] produced = {false};
            try {
                HttpRequest.Builder reqBuilder = HttpRequest.newBuilder(URI.create(url))
                        .timeout(reqTimeout)
                        .header("Content-Type", "application/json")
                        .header("Accept", "application/octet-stream, */*")
                        .POST(HttpRequest.BodyPublishers.ofByteArray(jsonBody));
                String authHeader = resolveInternalAuthHeader(url, streamUrls);
                if (authHeader != null) {
                    reqBuilder.header(com.englishcoach.common.ai.AiServiceAuth.HEADER, authHeader);
                }
                HttpResponse<InputStream> res = SHARED_TTS_HTTP.send(reqBuilder.build(), HttpResponse.BodyHandlers.ofInputStream());
                try (InputStream in = res.body()) {
                    if (res.statusCode() < 200 || res.statusCode() >= 300 || in == null) {
                        continue;
                    }
                    byte[] buf = new byte[1920]; // 40 ms @ 24 kHz mono PCM16LE
                    int carry = -1;
                    int read;
                    while ((read = in.read(buf)) != -1) {
                        if (read == 0) continue;
                        byte[] combined;
                        int totalLen;
                        if (carry >= 0) {
                            combined = new byte[read + 1];
                            combined[0] = (byte) carry;
                            System.arraycopy(buf, 0, combined, 1, read);
                            totalLen = read + 1;
                            carry = -1;
                        } else {
                            combined = buf;
                            totalLen = read;
                        }
                        int evenLen = totalLen & ~1;
                        if (totalLen != evenLen) {
                            carry = combined[totalLen - 1] & 0xff;
                        }
                        if (evenLen > 0) {
                            produced[0] = true;
                            onChunk.accept(Arrays.copyOfRange(combined, 0, evenLen));
                        }
                    }
                    if (produced[0]) return true;
                }
            } catch (UncheckedIOException clientClosed) {
                throw clientClosed;
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                if (produced[0]) throw new RuntimeException("TTS stream interrupted", ie);
                return false;
            } catch (Exception ex) {
                if (produced[0]) throw ex instanceof RuntimeException re ? re : new RuntimeException(ex);
                log.debug("TTS stream probe at {} did not succeed: {}", url, ex.getMessage());
            }
        }
        return false;
    }

    static byte[] stripWavToPcm16Le(byte[] wav) {
        if (wav == null || wav.length <= 44) return new byte[0];
        if (wav[0] == 'R' && wav[1] == 'I' && wav[2] == 'F' && wav[3] == 'F'
                && wav[8] == 'W' && wav[9] == 'A' && wav[10] == 'V' && wav[11] == 'E') {
            int pos = 12;
            while (pos + 8 <= wav.length) {
                int chunkSize = ByteBuffer.wrap(wav, pos + 4, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
                if (chunkSize < 0) break;
                if (wav[pos] == 'd' && wav[pos + 1] == 'a' && wav[pos + 2] == 't' && wav[pos + 3] == 'a') {
                    int start = pos + 8;
                    int end = Math.min(wav.length, start + chunkSize);
                    int evenLen = Math.max(0, (end - start) & ~1);
                    return evenLen == 0 ? new byte[0] : Arrays.copyOfRange(wav, start, start + evenLen);
                }
                long next = (long) pos + 8L + chunkSize + (chunkSize & 1);
                if (next > wav.length || next <= pos) break;
                pos = (int) next;
            }
            int fallbackLen = (wav.length - 44) & ~1;
            return fallbackLen <= 0 ? new byte[0] : Arrays.copyOfRange(wav, 44, 44 + fallbackLen);
        }
        int evenLen = wav.length & ~1;
        return evenLen <= 0 ? new byte[0] : Arrays.copyOfRange(wav, 0, evenLen);
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(' ');
                    else sb.append(c);
                }
            }
        }
        return sb.toString();
    }

    private byte[] invokeOmnivoiceUpstream(String voiceId, String text) {
        LinkedHashSet<String> candidateUrls = buildOmnivoiceCandidateUrls();
        byte[] jsonBody = ("{\"voiceId\":\"" + escapeJson(voiceId) + "\",\"text\":\"" + escapeJson(text) + "\"}")
                .getBytes(StandardCharsets.UTF_8);
        Duration reqTimeout = Duration.ofMillis(timeoutMs > 0 ? timeoutMs : 45000);

        Exception lastException = null;
        for (String targetUrl : candidateUrls) {
            try {
                log.info("Attempting OmniVoice synthesis at url: {}", targetUrl);
                HttpRequest.Builder reqBuilder = HttpRequest.newBuilder(URI.create(targetUrl))
                        .timeout(reqTimeout)
                        .header("Content-Type", "application/json")
                        .header("Accept", "audio/wav, application/octet-stream, */*")
                        .POST(HttpRequest.BodyPublishers.ofByteArray(jsonBody));
                String authHeader = resolveInternalAuthHeader(targetUrl, candidateUrls);
                if (authHeader != null) {
                    reqBuilder.header(com.englishcoach.common.ai.AiServiceAuth.HEADER, authHeader);
                }
                HttpResponse<byte[]> response = SHARED_TTS_HTTP.send(reqBuilder.build(), HttpResponse.BodyHandlers.ofByteArray());
                if (response.statusCode() >= 200 && response.statusCode() < 300
                        && response.body() != null && response.body().length > 0) {
                    return response.body();
                }
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                lastException = ie;
                break;
            } catch (Exception e) {
                lastException = e;
                log.warn("OmniVoice call failed at {}: {}", targetUrl, e.getMessage());
            }
        }

        log.error("OmniVoice speech synthesis failed on all candidate URLs: {} (lastError={})",
                candidateUrls, lastException != null ? lastException.getMessage() : "none");
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                "OmniVoice speech synthesis service unavailable");
    }
}
