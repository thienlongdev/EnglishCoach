package com.englishcoach.ai.controller;

import com.englishcoach.ai.voice.EchoVoiceThrottleService;
import com.englishcoach.common.ai.AiServiceRequestFactory;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.speaking.service.SpeakingTtsService;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.Set;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;

/** Transient voice input and Smart Turn v3.2 endpointing. Chat authorization, allowance and persistence run on send. */
@RestController
@RequestMapping("/api/v1/ai/chat")
public class EchoTranscriptionController {
    private static final int MAX_BYTES = 640_000;
    private static final int MAX_TURN_CHECK_BYTES = 256 * 1024;
    private static final Set<String> ALLOWED_LANGS = Set.of("vi", "en", "auto");
    private static final TurnCheckResult FALLBACK_TURN_CHECK = new TurnCheckResult(true, 0.7, 350);

    private final EchoVoiceThrottleService throttle;
    private final RestTemplate speech;
    private final RestTemplate turnCheckClient;
    private final SpeakingTtsService voices;
    private final String endpoint;
    private final String turnCheckEndpoint;

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Transcript(
            String text,
            String stableText,
            Boolean reviewNeeded,
            String language,
            Double noSpeechProb,
            Double avgLogprob,
            Double compressionRatio,
            String rejectedReason) {
        public Transcript(
                String text,
                Boolean reviewNeeded,
                String language,
                Double noSpeechProb,
                Double avgLogprob,
                Double compressionRatio,
                String rejectedReason) {
            this(text, null, reviewNeeded, language, noSpeechProb, avgLogprob, compressionRatio, rejectedReason);
        }

        public Transcript(String text, Boolean reviewNeeded) {
            this(text, null, reviewNeeded, null, null, null, null, null);
        }

        public Transcript(String text, Boolean reviewNeeded, String language) {
            this(text, null, reviewNeeded, language, null, null, null, null);
        }

        /** True when the GPU 7-layer anti-hallucination shield rejected this clip or no-speech probability is high on short noise. */
        public boolean isHallucinationRejected() {
            if (rejectedReason != null && !rejectedReason.isBlank()) return true;
            if (noSpeechProb != null && noSpeechProb > 0.72) {
                String t = text == null ? "" : text.trim();
                if (t.isEmpty() || t.length() < 24) return true;
            }
            return false;
        }
    }

    public record TurnCheckResult(Boolean complete, Double probability, Integer recommendedWaitMs) {}

    public EchoTranscriptionController(String baseUrl, SpeakingTtsService voices) {
        this(baseUrl, voices, new EchoVoiceThrottleService());
    }

    @Autowired
    public EchoTranscriptionController(@Value("${ai.base-url:http://localhost:8000}") String baseUrl,
                                       SpeakingTtsService voices,
                                       @Autowired(required = false) EchoVoiceThrottleService throttle) {
        this.voices = voices;
        this.throttle = throttle != null ? throttle : new EchoVoiceThrottleService();
        String cleanBase = (baseUrl == null ? "http://localhost:8000" : baseUrl.trim()).replaceAll("/+$", "");
        var factory = new AiServiceRequestFactory();
        factory.setConnectTimeout(2000);
        factory.setReadTimeout(12000);
        this.speech = new RestTemplate(factory);
        this.endpoint = cleanBase + "/api/v1/coach/transcribe?lang={lang}";

        var turnFactory = new AiServiceRequestFactory();
        turnFactory.setConnectTimeout(800);
        turnFactory.setReadTimeout(1500);
        this.turnCheckClient = new RestTemplate(turnFactory);
        this.turnCheckEndpoint = cleanBase + "/api/v1/coach/turn-check";
    }

    public record SpokenSentence(String voiceId, String text) {}

    @PostMapping(value = "/speech", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<byte[]> speak(@AuthenticationPrincipal UserDetailsImpl principal, @RequestBody SpokenSentence sentence) {
        if (principal == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        byte[] wav = voices.synthesizeEchoSentence(principal.getId(), sentence.voiceId(), sentence.text());
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).contentType(MediaType.parseMediaType("audio/wav")).body(wav);
    }

    @PostMapping(value = "/transcribe", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<Transcript> transcribe(@AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(defaultValue = "auto") String lang, HttpServletRequest request) throws IOException {
        if (principal == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        String cleanLang = lang == null ? "auto" : lang.trim().toLowerCase(java.util.Locale.ROOT);
        if (!ALLOWED_LANGS.contains(cleanLang)) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        if (request.getContentLengthLong() > MAX_BYTES) throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE);
        if (!throttle.admitFinalAsr(principal.getId())) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS);
        if (!throttle.acquireAsrSlot(true)) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE);
        try {
            byte[] pcm = request.getInputStream().readNBytes(MAX_BYTES + 1);
            if (pcm.length > MAX_BYTES) throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE);
            if (pcm.length < 3200 || pcm.length % 2 != 0) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
            var headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_OCTET_STREAM);
            var result = speech.postForObject(endpoint, new HttpEntity<>(pcm, headers), Transcript.class, cleanLang);
            if (result == null || result.text() == null || result.text().length() > 4000)
                throw new ResponseStatusException(HttpStatus.BAD_GATEWAY);
            String resolvedLang = (result.language() == null || result.language().isBlank())
                    ? ("auto".equals(cleanLang) ? null : cleanLang)
                    : result.language();
            if (result.isHallucinationRejected()) {
                return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                        .body(new Transcript("", "", false, resolvedLang,
                                result.noSpeechProb(), result.avgLogprob(), result.compressionRatio(), result.rejectedReason()));
            }
            String resolvedStable = (result.stableText() != null && !result.stableText().isBlank())
                    ? result.stableText()
                    : result.text();
            return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                    .body(new Transcript(result.text(), resolvedStable, Boolean.TRUE.equals(result.reviewNeeded()), resolvedLang,
                            result.noSpeechProb(), result.avgLogprob(), result.compressionRatio(), result.rejectedReason()));
        } catch (RestClientException unavailable) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE);
        } finally {
            throttle.releaseAsrSlot();
        }
    }

    /** Smart Turn v3.2 prosodic EOU check (<= 256 KB 16 kHz PCM16LE) with safe local fallback when GPU is offline. */
    @PostMapping(value = "/turn-check", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<TurnCheckResult> turnCheck(@AuthenticationPrincipal UserDetailsImpl principal,
                                                     HttpServletRequest request) throws IOException {
        if (principal == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        if (request.getContentLengthLong() > MAX_TURN_CHECK_BYTES) throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE);
        if (!throttle.admitTurnCheck(principal.getId())) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS);
        byte[] pcm = request.getInputStream().readNBytes(MAX_TURN_CHECK_BYTES + 1);
        if (pcm.length > MAX_TURN_CHECK_BYTES) throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE);
        if (pcm.length < 640 || pcm.length % 2 != 0) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        try {
            var headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_OCTET_STREAM);
            var result = turnCheckClient.postForObject(turnCheckEndpoint, new HttpEntity<>(pcm, headers), TurnCheckResult.class);
            if (result == null || result.complete() == null || result.probability() == null || result.recommendedWaitMs() == null) {
                return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(FALLBACK_TURN_CHECK);
            }
            double prob = Math.max(0.0, Math.min(1.0, result.probability()));
            int waitMs = Math.max(0, Math.min(3000, result.recommendedWaitMs()));
            return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                    .body(new TurnCheckResult(result.complete(), prob, waitMs));
        } catch (RuntimeException unreachable) {
            return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(FALLBACK_TURN_CHECK);
        }
    }
}
