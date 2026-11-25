package com.englishcoach.ai.voice;

import com.englishcoach.ai.controller.EchoTranscriptionController.Transcript;
import com.englishcoach.ai.controller.EchoTranscriptionController.TurnCheckResult;
import com.englishcoach.ai.dto.AiChatMessageDto;
import com.englishcoach.ai.dto.AiChatRequest;
import com.englishcoach.ai.dto.AiChatResponse;
import com.englishcoach.ai.dto.EchoAction;
import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.dto.EchoPageContextDto;
import com.englishcoach.ai.dto.EchoSalientResourceDto;
import com.englishcoach.ai.echo.EchoConfirmations;
import com.englishcoach.ai.echo.EchoLearnerBrain;
import com.englishcoach.ai.echo.EchoRouter;
import com.englishcoach.ai.echo.camel.TurnProvenance;
import com.englishcoach.ai.service.AiChatService;
import com.englishcoach.ai.service.EchoPolicy;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.AuthSessionService;
import com.englishcoach.common.ai.AiServiceRequestFactory;
import com.englishcoach.common.security.AuthSessionContext;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.echocoach.dto.CreateSessionRequest;
import com.englishcoach.echocoach.dto.EchoCoachSessionDto;
import com.englishcoach.echocoach.dto.SaveMessagePairRequest;
import com.englishcoach.echocoach.service.EchoCoachService;
import com.englishcoach.extension.EchoAnywhereConfig;
import com.englishcoach.speaking.service.SpeakingTtsService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Full-duplex binary + JSON WebSocket handler for Echo JARVIS voice (`/ws-card-blast/echo-voice`).
 * <ul>
 *   <li>Strict principal authentication at handshake AND message time (`CREDENTIALS` / `GOOGLE` only; refuses anonymous and
 *       `ECHO_ANYWHERE` tokens with close `1008`).</li>
 *   <li>Jittered 25–30 s `AuthSessionService.validateAndTouchActiveSession` + `ACTIVE` user status revalidation.</li>
 *   <li>Max `2` concurrent voice sockets per `userId` and `<= 32 KiB` idle/frame audio buffer (`416 MB` SerialGC heap safe).</li>
 *   <li>Binary `0x01` (`7B` header + `16 kHz` `PCM16LE`) uplink, `0x02` (`7B` header + `24 kHz` `PCM16LE`, `<= 1,927 B`/frame)
 *       downlink, `response.cancel`, and `conversation.item.truncate` heard-audio truncation.</li>
 * </ul>
 */
@Component
@Slf4j
public class EchoVoiceWebSocketHandler extends AbstractWebSocketHandler {

    public static final String ATTR_USER_ID = "EC_VOICE_USER_ID";
    public static final String ATTR_AUTHENTICATION = "EC_VOICE_AUTH";
    public static final Set<String> ALLOWED_WS_AUTH_METHODS = Set.of("CREDENTIALS", "GOOGLE");

    public static final byte FRAME_MIC_PCM16 = 0x01;
    public static final byte FRAME_TTS_PCM24 = 0x02;
    public static final byte FRAME_PING = 0x03;

    static final int BINARY_HEADER_BYTES = 7;
    static final int MAX_BINARY_FRAME_BYTES = 32 * 1024; // <= 32 KiB per frame / pre-allocated buffer
    static final int MAX_TEXT_FRAME_BYTES = 64 * 1024;   // 64 KiB text limit (fits 1.0 s base64 barge_in.probe + session.update context)
    static final int MAX_TURN_PCM_BYTES = 640_000;       // 20.0 s @ 16 kHz mono int16le
    static final int MAX_TURN_CARRY_BYTES = 480_000;     // 15.0 s @ 16 kHz mono int16le max carried prefix
    static final long CLIENT_SPEECH_START_PREROLL_MS = 480L; // 15 * 512 = 7,680 samples (15,360 B) client speech-start preroll
    static final int MAX_TURN_CHECK_BYTES = 256 * 1024;  // 8.192 s @ 16 kHz mono int16le
    static final int MAX_TTS_PCM_PER_FRAME = 1920;       // 40 ms @ 24 kHz mono int16le -> 1920 + 7 = 1927 B/frame
    static final int MAX_SOCKETS_PER_USER = 2;
    static final long SESSION_RECHECK_MS = 30_000L;
    static final int MAX_CONSECUTIVE_RECHECK_ERRORS = 2;
    static final int MAX_BARGE_PROBE_BYTES = 32_000;     // 1.0 s @ 16 kHz mono int16le (~42.7 KiB base64 inside 64 KiB text limit)
    static final long MAX_PAUSE_WAIT_MS = 1_500L;
    static final long ACTION_ACK_TIMEOUT_MS = 680L;
    /**
     * A turn auto-committed on a pause ("Hi Echo, … what is …") that has produced NO output yet is merged into the speech
     * that resumes within this window instead of becoming a fragment turn (incident 2026-11-25: Smart Turn judged the comma
     * pause after "Hi Echo," complete; the fragment went to the model and the rest of the question became another turn).
     */
    static final long TURN_MERGE_WINDOW_MS = 1_600L;
    static final long VOCATIVE_MERGE_WINDOW_MS = 2_400L;
    static final int PARTIAL_PROMOTE_MIN_PCM_BYTES = 16_000; // >= 0.5 s voiced speech decoded
    static final int PARTIAL_PROMOTE_MAX_TAIL_BYTES = 25_600; // <= 0.8 s trailing silence window
    static final double PARTIAL_PROMOTE_MIN_AVG_LOGPROB = -0.65;
    static final double PARTIAL_PROMOTE_MAX_NO_SPEECH_PROB = 0.35;
    // -42.0 dBFS in int16 sample units: (32768 * 10^(-42/20))^2 = 260.285^2 = 67,748.4
    private static final double TAIL_SILENCE_MAX_MEAN_SQUARE_INT16 = 67_748.4;
    // -38.0 dBFS in int16 sample units: (32768 * 10^(-38/20))^2 = 412.874^2 = 170,464.9
    private static final double TURN_CHECK_RESUME_MIN_MEAN_SQUARE_INT16 = 170_464.9;
    private static final java.util.regex.Pattern BACKCHANNEL_RE = java.util.regex.Pattern.compile(
            "^(?:uh[- ]?huh|mm[- ]?hmm|mhm|hmm|hm|yeah|yep|yup|yes|ok|okay|got it|i see|right|sure|ah|oh|go on|go ahead|continue|keep going|u|um|uh|o|om|a|a ha|vang|vang a|da|da vang|o ke|dung roi|roi|tiep di|noi tiep di|duoc roi|hieu roi|ok roi|oke)$");
    static final java.util.regex.Pattern BARE_VOCATIVE_RE = java.util.regex.Pattern.compile(
            "^(?:(?:hi|high|hey|hello|yo|ok|okay|alo|xin chao|chao|nay|oi|da|vang|e)\\s+){0,2}"
            + "(?:echo(?:\\s+jarvis)?|jarvis)(?:\\s+(?:oi|a|nha|nhe))?$");

    private final AiChatService chatService;
    private final EchoLearnerBrain brain;
    private final EchoCoachService coachService;
    private final EchoConfirmations confirmations;
    private final SpeakingTtsService voices;
    private final EchoVoiceThrottleService throttle;
    private final ObjectMapper mapper;
    private final RestTemplate asrClient;
    private final RestTemplate turnCheckClient;
    private final String transcribeUrl;
    private final String turnCheckUrl;

    private AuthSessionService authSessionService;
    private UserRepository userRepository;

    private final ConcurrentHashMap<String, VoiceSessionState> sessions = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Long, Set<String>> userSockets = new ConcurrentHashMap<>();
    private final ExecutorService voiceWorkers;
    private final ExecutorService ttsWorkers;
    private final ScheduledExecutorService bridgeScheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "echo-voice-bridge");
        t.setDaemon(true);
        return t;
    });

    @Autowired
    public EchoVoiceWebSocketHandler(
            AiChatService chatService,
            @Autowired(required = false) EchoLearnerBrain brain,
            @Autowired(required = false) EchoCoachService coachService,
            @Autowired(required = false) EchoConfirmations confirmations,
            SpeakingTtsService voices,
            ObjectMapper mapper,
            @Value("${ai.base-url:http://localhost:8000}") String aiBaseUrl,
            @Autowired(required = false) AuthSessionService authSessionService,
            @Autowired(required = false) UserRepository userRepository,
            @Autowired(required = false) EchoVoiceThrottleService throttle) {
        this.chatService = chatService;
        this.brain = brain;
        this.coachService = coachService;
        this.confirmations = confirmations;
        this.voices = voices;
        this.throttle = throttle != null ? throttle : new EchoVoiceThrottleService();
        this.mapper = mapper != null ? mapper : new ObjectMapper();
        this.authSessionService = authSessionService;
        this.userRepository = userRepository;

        String cleanBase = (aiBaseUrl == null ? "http://localhost:8000" : aiBaseUrl.trim()).replaceAll("/+$", "");
        var asrFactory = new AiServiceRequestFactory();
        asrFactory.setConnectTimeout(2000);
        asrFactory.setReadTimeout(10000);
        this.asrClient = new RestTemplate(asrFactory);
        this.transcribeUrl = cleanBase + "/api/v1/coach/transcribe?lang={lang}&mode={mode}";

        var turnFactory = new AiServiceRequestFactory();
        turnFactory.setConnectTimeout(800);
        turnFactory.setReadTimeout(1500);
        this.turnCheckClient = new RestTemplate(turnFactory);
        this.turnCheckUrl = cleanBase + "/api/v1/coach/turn-check";

        AtomicInteger seq = new AtomicInteger();
        ThreadPoolExecutor pool = new ThreadPoolExecutor(
                8, 16, 60L, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(128),
                r -> {
                    Thread t = new Thread(r, "echo-voice-ws-" + seq.incrementAndGet());
                    t.setDaemon(true);
                    return t;
                },
                new ThreadPoolExecutor.AbortPolicy());
        pool.prestartCoreThread();
        pool.allowCoreThreadTimeOut(true);
        this.voiceWorkers = pool;

        AtomicInteger ttsSeq = new AtomicInteger();
        ThreadPoolExecutor ttsPool = new ThreadPoolExecutor(
                8, 16, 60L, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(64),
                r -> {
                    Thread t = new Thread(r, "echo-voice-tts-" + ttsSeq.incrementAndGet());
                    t.setDaemon(true);
                    return t;
                },
                new ThreadPoolExecutor.CallerRunsPolicy());
        ttsPool.prestartCoreThread();
        ttsPool.allowCoreThreadTimeOut(true);
        this.ttsWorkers = ttsPool;
    }

    /** Package-private test hook for overriding RestTemplates in unit tests. */
    EchoVoiceWebSocketHandler(
            AiChatService chatService,
            EchoLearnerBrain brain,
            EchoCoachService coachService,
            EchoConfirmations confirmations,
            SpeakingTtsService voices,
            ObjectMapper mapper,
            RestTemplate asrClient,
            RestTemplate turnCheckClient,
            AuthSessionService authSessionService,
            UserRepository userRepository) {
        this(chatService, brain, coachService, confirmations, voices, mapper, asrClient, turnCheckClient,
                authSessionService, userRepository, new EchoVoiceThrottleService());
    }

    EchoVoiceWebSocketHandler(
            AiChatService chatService,
            EchoLearnerBrain brain,
            EchoCoachService coachService,
            EchoConfirmations confirmations,
            SpeakingTtsService voices,
            ObjectMapper mapper,
            RestTemplate asrClient,
            RestTemplate turnCheckClient,
            AuthSessionService authSessionService,
            UserRepository userRepository,
            EchoVoiceThrottleService throttle) {
        this.chatService = chatService;
        this.brain = brain;
        this.coachService = coachService;
        this.confirmations = confirmations;
        this.voices = voices;
        this.throttle = throttle != null ? throttle : new EchoVoiceThrottleService();
        this.mapper = mapper != null ? mapper : new ObjectMapper();
        this.asrClient = asrClient;
        this.turnCheckClient = turnCheckClient;
        this.transcribeUrl = "http://localhost:8000/api/v1/coach/transcribe?lang={lang}&mode={mode}";
        this.turnCheckUrl = "http://localhost:8000/api/v1/coach/turn-check";
        this.authSessionService = authSessionService;
        this.userRepository = userRepository;
        this.voiceWorkers = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "echo-voice-test");
            t.setDaemon(true);
            return t;
        });
        this.ttsWorkers = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "echo-voice-tts-test");
            t.setDaemon(true);
            return t;
        });
    }

    @PreDestroy
    void shutdown() {
        sessions.values().forEach(VoiceSessionState::cancelActiveTurn);
        bridgeScheduler.shutdownNow();
        ttsWorkers.shutdownNow();
        voiceWorkers.shutdownNow();
    }

    static boolean isForbiddenAuthMethod(String authMethod) {
        if (authMethod == null || authMethod.isBlank()) {
            return false;
        }
        String normalized = authMethod.trim().toUpperCase(Locale.ROOT);
        if (EchoAnywhereConfig.AUTH_METHOD.equals(normalized)) {
            return true;
        }
        return !ALLOWED_WS_AUTH_METHODS.contains(normalized);
    }

    static boolean isForbiddenAuthentication(Authentication auth) {
        if (auth == null) return true;
        AuthSessionContext ctx = AuthSessionContext.of(auth);
        if (ctx != null && isForbiddenAuthMethod(ctx.authMethod())) {
            return true;
        }
        return !(auth.getPrincipal() instanceof UserDetailsImpl u) || u.getId() == null;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        Authentication auth = resolveAuthentication(session);
        if (isForbiddenAuthentication(auth)) {
            safeClose(session, new CloseStatus(1008, "Unauthorized"));
            return;
        }
        long userId = ((UserDetailsImpl) auth.getPrincipal()).getId();
        String sid = session.getId();

        AtomicBoolean registered = new AtomicBoolean(false);
        userSockets.compute(userId, (uid, set) -> {
            Set<String> active = set != null ? set : ConcurrentHashMap.newKeySet();
            if (active.contains(sid)) {
                registered.set(true);
                return active;
            }
            if (active.size() >= MAX_SOCKETS_PER_USER) {
                return active;
            }
            active.add(sid);
            registered.set(true);
            return active;
        });
        if (!registered.get()) {
            log.warn("[ECHO VOICE WS] Rejected socket {} for user {}: exceeded max {} voice sockets", sid, userId, MAX_SOCKETS_PER_USER);
            safeClose(session, new CloseStatus(1008, "Too many concurrent voice sessions"));
            return;
        }

        try {
            session.setBinaryMessageSizeLimit(MAX_BINARY_FRAME_BYTES);
            session.setTextMessageSizeLimit(MAX_TEXT_FRAME_BYTES);
        } catch (RuntimeException ignored) { }

        VoiceSessionState state = new VoiceSessionState(session, userId, auth);
        sessions.put(sid, state);

        sendJson(state, Map.of(
                "type", "session.ready",
                "sampleRateIn", 16000,
                "sampleRateOut", 24000,
                "maxFrameBytes", MAX_BINARY_FRAME_BYTES,
                "voiceId", state.voiceId,
                "lang", state.lang));
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        cleanupSession(session != null ? session.getId() : null);
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        if (session != null) {
            cleanupSession(session.getId());
            safeClose(session, CloseStatus.SERVER_ERROR);
        }
    }

    private void cleanupSession(String sid) {
        if (sid == null) return;
        VoiceSessionState state = sessions.remove(sid);
        if (state != null) {
            state.cancelActiveTurn();
            state.clearPcm();
            userSockets.computeIfPresent(state.userId, (uid, set) -> {
                set.remove(sid);
                return set.isEmpty() ? null : set;
            });
        }
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
        VoiceSessionState state = validateMessageSession(session);
        if (state == null) return;

        ByteBuffer payload = message.getPayload();
        int totalBytes = payload.remaining();
        if (totalBytes < 1 || totalBytes > MAX_BINARY_FRAME_BYTES) {
            safeClose(session, new CloseStatus(1008, "Invalid binary frame size"));
            cleanupSession(session.getId());
            return;
        }
        byte frameType = payload.get();
        if (frameType == FRAME_PING) {
            int rest = Math.min(32, payload.remaining());
            byte[] echo = new byte[1 + rest];
            echo[0] = FRAME_PING;
            if (rest > 0) payload.get(echo, 1, rest);
            sendBinary(state, echo);
            return;
        }
        if (frameType != FRAME_MIC_PCM16 || totalBytes < BINARY_HEADER_BYTES) {
            return;
        }
        int turnSeq = ((payload.get() & 0xFF) << 8) | (payload.get() & 0xFF);
        long sampleOffset = ((long) (payload.get() & 0xFF) << 24)
                | ((long) (payload.get() & 0xFF) << 16)
                | ((long) (payload.get() & 0xFF) << 8)
                | (payload.get() & 0xFFL);
        int pcmLen = payload.remaining() & ~1;
        if (pcmLen <= 0) return;

        byte[] pcm = new byte[pcmLen];
        payload.get(pcm);

        boolean newTurn = state.appendMicPcm(turnSeq, sampleOffset, pcm);
        if (newTurn && brain != null) {
            brain.warm(state.userId);
        }
        maybeTriggerPartialAsr(state, turnSeq);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        VoiceSessionState state = validateMessageSession(session);
        if (state == null) return;

        String raw = message.getPayload();
        if (raw == null || raw.isBlank() || raw.length() > MAX_TEXT_FRAME_BYTES) {
            safeClose(session, new CloseStatus(1008, "Invalid control frame"));
            cleanupSession(session.getId());
            return;
        }
        JsonNode json;
        try {
            json = mapper.readTree(raw);
        } catch (Exception malformed) {
            sendStructuredError(state, null, 400, "invalid_json", null, null);
            return;
        }
        if (json == null || !json.isObject()) return;

        String type = json.path("type").asText("");
        switch (type) {
            case "ping" -> sendJson(state, Map.of("type", "pong", "ts", json.path("ts").asLong(System.currentTimeMillis())));
            case "session.start", "session.update" -> handleSessionUpdate(state, json);
            case "input.speech_started" -> {
                applySessionMetadata(state, json, false);
                int seq = json.path("turnSeq").asInt(state.currentTurnSeq);
                int prematureSeq = state.activeResponseSeq;
                byte[] carry = state.takeMergeableCommittedAudio(seq, System.currentTimeMillis());
                if (carry != null) {
                    // The learner kept talking after a pause that was committed too early: supersede that fragment turn
                    // (no output was produced, nothing is charged) and continue the same utterance in the new turn.
                    state.cancelActiveTurn();
                    sendJson(state, Map.of("type", "response.cancelled", "turnSeq", prematureSeq, "reason", "merged"));
                    log.info("[ECHO VOICE WS] Merged premature turn {} into turn {} ({} bytes carried)", prematureSeq, seq, carry.length);
                }
                state.resetForSpeechStart(seq, carry);
                if (brain != null) brain.warm(state.userId);
                sendJson(state, Map.of("type", "entity.state", "state", "listening", "turnSeq", seq));
            }
            case "input.clear", "input.clear_backchannel" -> state.clearPcm();
            case "input.turn_check" -> handleTurnCheck(state, json);
            case "input.commit" -> handleInputCommit(state, json, false);
            case "turn.escalate" -> handleInputCommit(state, json, true);
            case "barge_in.probe" -> handleBargeInProbe(state, json);
            case "response.pause" -> {
                state.paused.set(true);
                sendJson(state, Map.of("type", "entity.state", "state", "listening", "turnSeq", state.activeResponseSeq));
            }
            case "response.resume" -> {
                state.paused.set(false);
                sendJson(state, Map.of("type", "entity.state", "state", "speaking", "turnSeq", state.activeResponseSeq));
            }
            case "response.cancel" -> {
                int seq = json.path("turnSeq").asInt(state.activeResponseSeq);
                state.cancelActiveTurn();
                sendJson(state, Map.of("type", "response.cancelled", "turnSeq", seq));
                sendJson(state, Map.of("type", "entity.state", "state", "interrupted", "turnSeq", seq));
            }
            case "conversation.item.truncate", "client.playback.truncate" -> handleTruncate(state, json);
            case "action.ack" -> handleActionAck(state, json);
            case "tool.confirm" -> handleToolConfirm(state, json);
            default -> sendStructuredError(state, null, 400, "unknown_event", null, null);
        }
    }

    private void handleActionAck(VoiceSessionState state, JsonNode json) {
        int seq = json.path("turnSeq").asInt(state.activeResponseSeq);
        state.completeActionAck(seq, json);
    }

    private void handleSessionUpdate(VoiceSessionState state, JsonNode json) {
        applySessionMetadata(state, json, false);
        if (brain != null) brain.warm(state.userId);
        sendJson(state, Map.of("type", "session.ready", "voiceId", state.voiceId, "lang", state.lang));
    }

    private void handleTurnCheck(VoiceSessionState state, JsonNode json) {
        int turnSeq = json.path("turnSeq").asInt(state.currentTurnSeq);
        boolean autoCommit = json.path("autoCommit").asBoolean(false);
        EchoPageContextDto turnPageContext = applySessionMetadata(state, json, autoCommit);
        int snapLen = state.currentPcmLengthForTurn(turnSeq);
        byte[] tailPcm = snapLen >= 640 ? state.snapshotTailPcm(MAX_TURN_CHECK_BYTES) : new byte[0];
        if (tailPcm.length < 640) {
            sendJson(state, Map.of(
                    "type", "vad.state",
                    "state", "thinking_pause",
                    "turnSeq", turnSeq,
                    "complete", false,
                    "probability", 0.0,
                    "recommendedWaitMs", 400));
            return;
        }
        if (!throttle.admitTurnCheck(state.userId)) {
            sendJson(state, Map.of(
                    "type", "vad.state",
                    "state", "thinking_pause",
                    "turnSeq", turnSeq,
                    "complete", false,
                    "probability", 0.0,
                    "recommendedWaitMs", 650));
            return;
        }
        submitWorker(state, () -> {
            if (!state.canAutoCommitTurnCheck(turnSeq, snapLen)) {
                if (state.currentTurnSeq == turnSeq) {
                    sendJson(state, Map.of(
                            "type", "vad.state",
                            "state", "thinking_pause",
                            "turnSeq", turnSeq,
                            "complete", false,
                            "probability", 0.0,
                            "recommendedWaitMs", 450));
                }
                return;
            }
            TurnCheckResult res = checkTurnCompletion(tailPcm);
            boolean stillValid = state.canAutoCommitTurnCheck(turnSeq, snapLen);
            boolean complete = stillValid && Boolean.TRUE.equals(res.complete());
            double prob = res.probability() != null ? res.probability().doubleValue() : 0.0;
            int waitMs = res.recommendedWaitMs() != null ? res.recommendedWaitMs().intValue() : (complete ? 0 : 650);
            if (autoCommit && complete) {
                VoiceSessionState.PcmCommitTicket ticket = state.snapshotAndCommitFromTurnCheck(turnSeq, snapLen);
                if (ticket == null) {
                    if (state.currentTurnSeq == turnSeq) {
                        sendJson(state, Map.of(
                                "type", "vad.state",
                                "state", "thinking_pause",
                                "turnSeq", turnSeq,
                                "complete", false,
                                "probability", 0.0,
                                "recommendedWaitMs", 450));
                    }
                    return;
                }
                sendJson(state, Map.of(
                        "type", "vad.state",
                        "state", "eou_committed",
                        "turnSeq", turnSeq,
                        "complete", true,
                        "probability", prob,
                        "recommendedWaitMs", waitMs));
                commitTurnInternal(state, turnSeq, ticket, null, state.lang, state.voiceId, false, turnPageContext);
                return;
            }
            if (state.currentTurnSeq == turnSeq) {
                sendJson(state, Map.of(
                        "type", "vad.state",
                        "state", complete ? "eou_committed" : "thinking_pause",
                        "turnSeq", turnSeq,
                        "complete", complete,
                        "probability", prob,
                        "recommendedWaitMs", waitMs));
            }
        });
    }

    private void handleBargeInProbe(VoiceSessionState state, JsonNode json) {
        int turnSeq = json.path("turnSeq").asInt(state.activeResponseSeq);
        if (!throttle.admitBargeInProbe(state.userId)) {
            state.paused.set(false);
            sendJson(state, Map.of("type", "barge_in.decision", "turnSeq", turnSeq, "decision", "backchannel", "text", ""));
            return;
        }
        byte[] probePcm = null;
        if (json.hasNonNull("pcmBase64")) {
            try {
                byte[] decoded = Base64.getDecoder().decode(json.get("pcmBase64").asText(""));
                if (decoded.length >= 640 && decoded.length <= MAX_BARGE_PROBE_BYTES && (decoded.length & 1) == 0) {
                    probePcm = decoded;
                }
            } catch (IllegalArgumentException ignored) { }
        }
        if (probePcm == null) {
            probePcm = state.snapshotTailPcm(MAX_BARGE_PROBE_BYTES);
        }
        if (probePcm.length < 1600) {
            state.paused.set(false);
            sendJson(state, Map.of("type", "barge_in.decision", "turnSeq", turnSeq, "decision", "backchannel", "text", ""));
            return;
        }
        final byte[] pcm = probePcm;
        String requestedLang = json.hasNonNull("lang")
                ? json.get("lang").asText(state.lang).trim().toLowerCase(Locale.ROOT)
                : state.lang;
        final String probeLang = Set.of("auto", "en", "vi").contains(requestedLang) ? requestedLang : state.lang;
        submitWorker(state, () -> {
            Transcript tr = transcribePcmWithGate(state.userId, pcm, probeLang, "partial", null, -1, null);
            String text = (tr == null || tr.isHallucinationRejected() || tr.text() == null) ? "" : tr.text().trim();
            // Emit probeOnly asr.partial alongside barge_in.decision so FE BargeInClassifier stays in sync
            sendJson(state, Map.of(
                    "type", "asr.partial",
                    "probeOnly", true,
                    "turnSeq", turnSeq,
                    "text", text,
                    "stableText", text,
                    "lang", tr != null && tr.language() != null ? tr.language() : ""));
            String rawClean = text.toLowerCase(Locale.ROOT)
                    .replaceAll("[\\p{Punct}]+", " ")
                    .replaceAll("\\s+", " ")
                    .trim();
            String folded = EchoVoiceFastPathMatcher.normalizeAsciiFold(text)
                    .replaceAll("[.?:!/]+", " ")
                    .replaceAll("\\s+", " ")
                    .trim();
            boolean isBackchannel = folded.isEmpty()
                    || "đúng".equals(rawClean)
                    || BACKCHANNEL_RE.matcher(folded).matches();
            if (isBackchannel) {
                state.paused.set(false);
                sendJson(state, Map.of("type", "barge_in.decision", "turnSeq", turnSeq, "decision", "backchannel", "text", text));
                sendJson(state, Map.of("type", "entity.state", "state", "speaking", "turnSeq", state.activeResponseSeq));
            } else {
                state.cancelActiveTurn();
                sendJson(state, Map.of("type", "barge_in.decision", "turnSeq", turnSeq, "decision", "interrupt", "text", text));
                sendJson(state, Map.of("type", "response.cancelled", "turnSeq", turnSeq));
                sendJson(state, Map.of("type", "entity.state", "state", "interrupted", "turnSeq", turnSeq));
            }
        });
    }

    private void handleInputCommit(VoiceSessionState state, JsonNode json, boolean forceEscalate) {
        EchoPageContextDto turnPageContext = applySessionMetadata(state, json, true);
        int turnSeq = json.path("turnSeq").asInt(state.currentTurnSeq);
        String providedText = json.hasNonNull("text") ? json.get("text").asText("").trim() : null;
        boolean hasExplicitText = providedText != null && !providedText.isBlank();
        boolean skipFastPath = forceEscalate || json.path("escalate").asBoolean(false);
        VoiceSessionState.PcmCommitTicket ticket = state.snapshotAndClearPcmForTurn(turnSeq, hasExplicitText, skipFastPath);
        if (ticket == null) {
            return;
        }
        String lang = state.lang;
        String voiceId = state.voiceId;
        submitWorker(state, () -> commitTurnInternal(state, turnSeq, ticket, providedText, lang, voiceId, skipFastPath, turnPageContext));
    }

    /**
     * Applies session/turn metadata onto {@code state} while enforcing {@code 10 §AB} privacy:
     * {@code state.pageContext} NEVER retains {@code bookMeta} or {@code clientVisibleExcerpt} across turns.
     * When {@code returnTurnPageContext == true}, returns the unstripped {@link EchoPageContextDto} scoped strictly
     * to the single committed turn.
     */
    private EchoPageContextDto applySessionMetadata(VoiceSessionState state, JsonNode json, boolean returnTurnPageContext) {
        if (json.hasNonNull("voiceId")) state.voiceId = SpeakingTtsService.sanitizeVoiceId(json.get("voiceId").asText());
        if (json.hasNonNull("lang")) {
            String l = json.get("lang").asText("auto").trim().toLowerCase(Locale.ROOT);
            if (Set.of("vi", "en", "auto").contains(l)) state.lang = l;
        }
        if (json.hasNonNull("locale")) {
            String loc = json.get("locale").asText("vi").trim().toLowerCase(Locale.ROOT);
            if (Set.of("vi", "en").contains(loc)) state.locale = loc;
        }
        if (json.hasNonNull("pathname")) {
            String p = json.get("pathname").asText("/dashboard").trim();
            if (p.startsWith("/") && p.length() <= 160) state.pathname = p;
        }
        if (json.hasNonNull("hasPendingConfirmation")) {
            state.hasPendingConfirmation = json.get("hasPendingConfirmation").asBoolean(false);
        }
        if (json.hasNonNull("hasActiveStrictSentinel")) {
            state.hasActiveStrictSentinel = json.get("hasActiveStrictSentinel").asBoolean(false);
        }
        boolean explicitReset = json.path("resetSession").asBoolean(false)
                || ("session.update".equals(json.path("type").asText(""))
                && json.has("sessionId") && json.get("sessionId").isNull()
                && json.has("messages") && json.get("messages").isArray() && json.get("messages").isEmpty());
        if (explicitReset) {
            state.echoSessionId = null;
            state.salientResources = List.of();
            state.replaceHistory(List.of());
        } else if (json.hasNonNull("sessionId") && json.get("sessionId").canConvertToLong()) {
            long sid = json.get("sessionId").asLong();
            if (sid > 0) state.echoSessionId = sid;
        }
        EchoPageContextDto turnScopedPage = null;
        if (json.hasNonNull("pageContext") && json.get("pageContext").isObject()) {
            try {
                EchoPageContextDto parsed = mapper.treeToValue(json.get("pageContext"), EchoPageContextDto.class);
                if (parsed != null) {
                    // 10 §AB privacy: NEVER store bookMeta or clientVisibleExcerpt persistently onto state.pageContext!
                    state.pageContext = parsed.withoutOnDemandExcerpts();
                    turnScopedPage = returnTurnPageContext ? parsed : state.pageContext;
                    if (parsed.pathname() != null && parsed.pathname().startsWith("/")) {
                        state.pathname = parsed.pathname();
                    }
                }
            } catch (Exception ignored) { }
        }
        if (json.has("messages")) {
            if (json.get("messages").isNull()) {
                state.replaceHistory(List.of());
            } else if (json.get("messages").isArray()) {
                JsonNode msgs = json.get("messages");
                state.replaceHistory(msgs.isEmpty() ? List.of() : parseMessages(msgs));
            }
        }
        if (json.has("salientResources")) {
            if (json.get("salientResources").isNull()) {
                state.salientResources = List.of();
            } else if (json.get("salientResources").isArray()) {
                JsonNode arr = json.get("salientResources");
                state.salientResources = arr.isEmpty() ? List.of() : parseSalientResources(arr);
            }
        }
        return turnScopedPage != null ? turnScopedPage : state.pageContext;
    }

    private List<EchoSalientResourceDto> parseSalientResources(JsonNode arr) {
        List<EchoSalientResourceDto> raw = new ArrayList<>();
        for (JsonNode item : arr) {
            if (item == null || !item.isObject()) continue;
            try {
                EchoSalientResourceDto dto = mapper.treeToValue(item, EchoSalientResourceDto.class);
                if (dto != null) raw.add(dto);
                if (raw.size() >= 12) break;
            } catch (Exception ignored) { }
        }
        return TurnProvenance.sanitizeSalientResources(raw);
    }

    private Long ensureEchoSessionId(VoiceSessionState state, String firstUserText) {
        Long existing = state.echoSessionId;
        if (existing != null && existing > 0) return existing;
        if (coachService == null) return null;
        synchronized (state) {
            if (state.echoSessionId != null && state.echoSessionId > 0) return state.echoSessionId;
            try {
                String cleanTitle = firstUserText == null ? "" : firstUserText.replaceAll("\\s+", " ").trim();
                if (cleanTitle.isEmpty()) cleanTitle = "Echo Voice";
                if (cleanTitle.length() > 80) cleanTitle = cleanTitle.substring(0, 80).trim();
                EchoCoachSessionDto created = coachService.createSession(state.userId, new CreateSessionRequest(cleanTitle));
                if (created != null && created.id() != null && created.id() > 0) {
                    state.echoSessionId = created.id();
                    return created.id();
                }
            } catch (RuntimeException ex) {
                log.debug("[ECHO VOICE WS] Lazy EchoCoachSession creation skipped ({})", ex.getClass().getSimpleName());
            }
            return state.echoSessionId;
        }
    }

    private Long persistSessionMessagesWithHeal(VoiceSessionState state, Long sid, String userText, String assistantText) {
        if (sid == null || coachService == null || assistantText == null || assistantText.isBlank()) {
            return sid;
        }
        SaveMessagePairRequest pair = new SaveMessagePairRequest(userText, assistantText, null, null);
        try {
            coachService.saveMessages(state.userId, sid, pair);
            return sid;
        } catch (ResponseStatusException rse) {
            if (rse.getStatusCode().value() == 404) {
                // Stale or deleted EchoCoachSession: reset, create a fresh session, and persist once
                synchronized (state) {
                    if (Objects.equals(state.echoSessionId, sid)) {
                        state.echoSessionId = null;
                    }
                }
                Long freshSid = ensureEchoSessionId(state, userText);
                if (freshSid != null && freshSid > 0 && !freshSid.equals(sid)) {
                    try {
                        coachService.saveMessages(state.userId, freshSid, pair);
                        return freshSid;
                    } catch (RuntimeException retryErr) {
                        log.debug("[ECHO VOICE WS] Healed session save skipped ({})", retryErr.getClass().getSimpleName());
                    }
                }
                return freshSid;
            }
            log.debug("[ECHO VOICE WS] Session message save skipped ({})", rse.getStatusCode());
            return sid;
        } catch (RuntimeException e) {
            log.debug("[ECHO VOICE WS] Session message save skipped ({})", e.getClass().getSimpleName());
            return sid;
        }
    }

    static boolean isBareVocative(String transcriptText) {
        if (transcriptText == null || transcriptText.isBlank()) return false;
        String folded = EchoVoiceFastPathMatcher.normalizeAsciiFold(transcriptText)
                .replaceAll("[.?:!/,'_-]+", " ")
                .replaceAll("\\s+", " ")
                .trim();
        return !folded.isEmpty() && BARE_VOCATIVE_RE.matcher(folded).matches();
    }

    private void commitTurnInternal(VoiceSessionState state, int turnSeq, VoiceSessionState.PcmCommitTicket ticket,
                                    String explicitText, String lang, String voiceId,
                                    boolean skipFastPath, EchoPageContextDto turnPageContext) {
        AtomicBoolean cancelled = ticket.cancelled();
        if (cancelled.get()) {
            return;
        }
        boolean hasExplicitText = explicitText != null && !explicitText.isBlank();
        byte[] pcm = ticket.pcm();

        sendJson(state, Map.of("type", "entity.state", "state", "understanding", "turnSeq", turnSeq));

        String transcriptText = explicitText;
        boolean reviewNeeded = false;
        String detectedLang = "auto".equals(lang) ? state.locale : lang;

        if (!hasExplicitText) {
            if (pcm.length < 3200) {
                state.clearCommittedPcmIfTurn(turnSeq);
                state.releaseEmptyCommit(turnSeq);
                sendJson(state, Map.of("type", "asr.final", "turnSeq", turnSeq, "text", "", "reviewNeeded", false));
                sendJson(state, Map.of("type", "entity.state", "state", "listening", "turnSeq", turnSeq));
                return;
            }
            if (!throttle.admitFinalAsr(state.userId)) {
                state.clearCommittedPcmIfTurn(turnSeq);
                state.releaseEmptyCommit(turnSeq);
                sendStructuredError(state, turnSeq, 429, "rate_limited", null, null);
                sendJson(state, Map.of("type", "entity.state", "state", "listening", "turnSeq", turnSeq));
                return;
            }
            Transcript tr = tryPromoteTailSilencePartial(state, turnSeq, pcm, cancelled);
            if (tr == null) {
                String wsSid = state.session != null ? state.session.getId() : null;
                tr = transcribePcmWithGate(state.userId, pcm, lang, "final", wsSid, turnSeq, cancelled);
            }
            if (cancelled.get()) return;
            if (tr == null) {
                state.clearCommittedPcmIfTurn(turnSeq);
                state.releaseEmptyCommit(turnSeq);
                sendStructuredError(state, turnSeq, 503, "stt_unavailable", null, null);
                sendJson(state, Map.of("type", "entity.state", "state", "error", "turnSeq", turnSeq));
                return;
            }
            if (tr.isHallucinationRejected()) {
                state.clearCommittedPcmIfTurn(turnSeq);
                state.releaseEmptyCommit(turnSeq);
                Map<String, Object> rejected = new LinkedHashMap<>();
                rejected.put("type", "asr.final");
                rejected.put("turnSeq", turnSeq);
                rejected.put("text", "");
                rejected.put("reviewNeeded", false);
                rejected.put("language", tr.language() == null ? "" : tr.language());
                if (tr.rejectedReason() != null) rejected.put("rejectedReason", tr.rejectedReason());
                sendJson(state, rejected);
                sendJson(state, Map.of("type", "entity.state", "state", "listening", "turnSeq", turnSeq));
                return;
            }
            transcriptText = tr.text() == null ? "" : tr.text().trim();
            if (transcriptText.isEmpty() && tr.stableText() != null) {
                transcriptText = tr.stableText().trim();
            }
            reviewNeeded = Boolean.TRUE.equals(tr.reviewNeeded());
            if (tr.language() != null && !tr.language().isBlank()) {
                detectedLang = tr.language().trim().toLowerCase(Locale.ROOT);
            }
            sendJson(state, Map.of(
                    "type", "asr.final",
                    "turnSeq", turnSeq,
                    "text", transcriptText,
                    "reviewNeeded", reviewNeeded,
                    "language", detectedLang == null ? "" : detectedLang));
        } else {
            sendJson(state, Map.of(
                    "type", "asr.final",
                    "turnSeq", turnSeq,
                    "text", transcriptText,
                    "reviewNeeded", false,
                    "language", detectedLang == null ? "" : detectedLang));
        }

        if (transcriptText.isBlank() || transcriptText.length() > 4000) {
            state.clearCommittedPcmIfTurn(turnSeq);
            state.releaseEmptyCommit(turnSeq);
            sendJson(state, Map.of("type", "entity.state", "state", "listening", "turnSeq", turnSeq));
            return;
        }
        if (cancelled.get()) return;

        // Server bare-vocative guard: never call streamVoiceTurn, create a session, or reserve quota on bare
        // "Hi/High/Hey Echo" / "Echo ơi" comma-pause fragments; keep committedPcm mergeable for 2,400 ms!
        if (!hasExplicitText && isBareVocative(transcriptText)) {
            state.holdBareVocativeForMerge(turnSeq, VOCATIVE_MERGE_WINDOW_MS);
            sendJson(state, Map.of("type", "response.cancelled", "turnSeq", turnSeq, "reason", "merged"));
            sendJson(state, Map.of("type", "entity.state", "state", "listening", "turnSeq", turnSeq));
            return;
        }

        state.recordTurnUserText(turnSeq, transcriptText);

        // Server-mirrored <1 ms Plane-A fast-path & guard on WS ASR finals (0 LLM calls, 0 DB calls!)
        if (!skipFastPath) {
            EchoVoiceFastPathMatcher.Outcome fp = EchoVoiceFastPathMatcher.evaluate(
                    transcriptText, state.pathname, state.hasPendingConfirmation, state.hasActiveStrictSentinel, state.salientResources);
            if (fp.guard() != null) {
                if (cancelled.get()) return;
                EchoVoiceFastPathMatcher.Guard g = fp.guard();
                String guardLang = "en".equalsIgnoreCase(detectedLang) ? "en" : "vi";
                String spoken = "en".equals(guardLang) ? g.promptEn() : g.promptVi();
                state.markOutputStarted(turnSeq);
                sendJson(state, Map.of(
                        "type", "action.guard",
                        "turnSeq", turnSeq,
                        "decision", g.decision(),
                        "reason", g.reason(),
                        "lang", guardLang,
                        "spokenMessage", spoken,
                        "promptEn", g.promptEn(),
                        "promptVi", g.promptVi()));
                speakSingleShortReply(state, turnSeq, voiceId, spoken, "GUARD", cancelled);
                return;
            }
            if (fp.plan() != null) {
                if (cancelled.get()) return;
                EchoVoiceFastPathMatcher.FastPathPlan plan = fp.plan();
                Long sid = ensureEchoSessionId(state, transcriptText);
                boolean escalateOnEmpty = plan.intents().stream().anyMatch(i -> "mybooks_open_last".equals(i.get("kind")));
                sendJson(state, Map.of("type", "entity.state", "state", "executing", "turnSeq", turnSeq));
                CompletableFuture<JsonNode> ackFuture = state.registerPendingActionAck(turnSeq);
                Map<String, Object> planMsg = new LinkedHashMap<>();
                planMsg.put("type", "action.client_plan");
                planMsg.put("turnSeq", turnSeq);
                if (sid != null) planMsg.put("sessionId", sid);
                planMsg.put("lang", plan.language());
                planMsg.put("language", plan.language());
                planMsg.put("spokenAck", plan.spokenAck());
                planMsg.put("playEarcon", "action_ok");
                planMsg.put("escalateOnEmpty", escalateOnEmpty);
                planMsg.put("intents", plan.intents());
                state.markOutputStarted(turnSeq);
                sendJson(state, planMsg);

                String spokenLine = resolvePlaneASpokenAck(state, turnSeq, ackFuture, plan.spokenAck(), cancelled);
                state.clearPendingActionAck(turnSeq);
                if (cancelled.get()) return;

                if (spokenLine == null) {
                    // Client reported status='cancelled' with blank spokenMessage -> skip TTS cleanly
                    Map<String, Object> doneMsg = new LinkedHashMap<>();
                    doneMsg.put("type", "response.done");
                    doneMsg.put("turnSeq", turnSeq);
                    doneMsg.put("reply", "");
                    doneMsg.put("route", "PLANE_A");
                    if (sid != null) doneMsg.put("sessionId", sid);
                    sendJson(state, doneMsg);
                    sendJson(state, Map.of("type", "entity.state", "state", "listening", "turnSeq", turnSeq));
                    return;
                }

                state.commitTurnHistory(turnSeq, transcriptText, spokenLine);
                if (sid != null && coachService != null && !spokenLine.isBlank() && state.claimDbPersist(turnSeq)) {
                    sid = persistSessionMessagesWithHeal(state, sid, transcriptText, spokenLine);
                }
                speakSingleShortReply(state, turnSeq, voiceId, spokenLine, "PLANE_A", cancelled);
                return;
            }
        }

        if (cancelled.get()) return;
        sendJson(state, Map.of("type", "entity.state", "state", "thinking", "turnSeq", turnSeq));

        // Lazy session creation: never create an orphan/fragment EchoCoachSession row before streamVoiceTurn succeeds!
        Long sessionIdForTurn = state.echoSessionId;
        String effectiveLocale = "en".equalsIgnoreCase(detectedLang) ? "en"
                : "vi".equalsIgnoreCase(detectedLang) ? "vi"
                : inferUtteranceLocale(transcriptText, state.locale);
        List<AiChatMessageDto> turnMessages = state.buildMessagesForTurn(transcriptText);
        String turnId = ("ws-" + state.userId + "-" + turnSeq + "-" + UUID.randomUUID().toString().substring(0, 8));
        EchoPageContextDto rawPage = turnPageContext != null ? turnPageContext : state.pageContext;
        EchoPageContextDto requestPage = null;
        if (rawPage != null) {
            boolean allowExcerpts = EchoRouter.pageReferenced(transcriptText)
                    || (rawPage.selection() != null && !rawPage.selection().isBlank());
            requestPage = allowExcerpts ? rawPage : rawPage.withoutOnDemandExcerpts();
        }
        AiChatRequest request = new AiChatRequest(
                turnMessages, requestPage, "voice", effectiveLocale, turnId, sessionIdForTurn, state.salientResources);

        // Ordered single-consumer TTS queue for this turn so Clause 0 synthesizes while Clauses 1+ stream from provider
        BlockingQueue<String> ttsQueue = new LinkedBlockingQueue<>(32);
        String END_SENTINEL = "\u0000END";
        FirstClauseChunker chunker = new FirstClauseChunker(clause -> {
            if (!cancelled.get() && clause != null && !clause.isBlank()) {
                ttsQueue.offer(clause);
            }
        });
        StringBuilder fullGenerated = new StringBuilder();
        long[] sampleOffset = {0L};

        if (cancelled.get()) {
            return;
        }

        CompletableFuture<Void> ttsWorker = CompletableFuture.runAsync(() -> {
            int utteranceIdx = 0;
            boolean chargedTurnThrottle = false;
            int idlePolls = 0;
            try {
                while (!cancelled.get() && state.session.isOpen() && idlePolls < 50) {
                    String rawClause = ttsQueue.poll(1, TimeUnit.SECONDS);
                    if (cancelled.get() || !state.session.isOpen()) break;
                    if (rawClause == null) {
                        idlePolls++;
                        continue;
                    }
                    idlePolls = 0;
                    if (END_SENTINEL.equals(rawClause)) break;
                    List<String> speakableSlices = sanitizeAndSliceClauseForSpeech(rawClause);
                    for (String cleanClause : speakableSlices) {
                        if (cleanClause.isEmpty() || cancelled.get() || !state.session.isOpen()) continue;
                        waitWhilePaused(state, cancelled);
                        if (cancelled.get() || !state.session.isOpen()) break;
                        String utteranceId = turnSeq + "-" + (utteranceIdx++);
                        state.markOutputStarted(turnSeq);
                        if (utteranceIdx == 1) {
                            sendJson(state, Map.of("type", "entity.state", "state", "speaking", "turnSeq", turnSeq));
                        }
                        sendJson(state, Map.of(
                                "type", "tts.segment_start",
                                "turnSeq", turnSeq,
                                "utteranceId", utteranceId,
                                "sampleRate", 24000,
                                "text", cleanClause));
                        try {
                            // Charge per-user TTS_SYNTH_USER budget ONCE on Clause 0; Clauses 1..N of the same turn skip duplicate charge.
                            boolean skipThrottle = chargedTurnThrottle;
                            chargedTurnThrottle = true;
                            java.util.function.Consumer<byte[]> pcmConsumer = pcmChunk -> {
                                if (cancelled.get() || !state.session.isOpen()) {
                                    throw new CancellationException("Barge-in cancelled TTS");
                                }
                                emitPcm24Frames(state, turnSeq, sampleOffset, pcmChunk, cancelled);
                            };
                            if (!skipThrottle) {
                                voices.streamEchoSentence(state.userId, voiceId, cleanClause, pcmConsumer);
                            } else {
                                voices.streamEchoSentence(state.userId, voiceId, cleanClause, pcmConsumer, true);
                            }
                        } catch (CancellationException stopped) {
                            return;
                        } catch (Exception ttsUnavailable) {
                            log.debug("[ECHO VOICE WS] TTS stream fallback notice: {}", ttsUnavailable.getMessage());
                            sendJson(state, Map.of("type", "tts.fallback", "turnSeq", turnSeq, "text", cleanClause));
                        }
                    }
                }
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            }
        }, ttsWorkers);

        final String finalUserText = transcriptText;
        final EchoPolicy.Intent voiceIntent = EchoPolicy.intent(finalUserText);
        final EchoRouter.Route estimatedVoiceRoute = EchoRouter.route(voiceIntent, finalUserText, true, true);
        final boolean isTierCDeep = EchoRouter.tierCDeepReasoning(voiceIntent, finalUserText, estimatedVoiceRoute);
        final String toolBridgeLine = "en".equalsIgnoreCase(effectiveLocale)
                ? "Let me check that for you."
                : "M\u00ECnh \u0111ang ki\u1EC3m tra th\u00F4ng tin cho b\u1EA1n nh\u00E9.";
        final String deepBridgeLine = "en".equalsIgnoreCase(effectiveLocale)
                ? "Let me review your learning profile."
                : "\u0110\u1EC3 m\u00ECnh xem k\u1EF9 h\u1ED3 s\u01A1 h\u1ECDc t\u1EADp c\u1EE7a b\u1EA1n nh\u00E9.";
        final AtomicBoolean firstDeltaArrived = new AtomicBoolean(false);
        final AtomicBoolean bridgeScheduled = new AtomicBoolean(false);
        final AtomicInteger statusUpdates = new AtomicInteger(0);
        final ScheduledFuture<?>[] bridgeFuture = {null};

        if (cancelled.get()) {
            ttsQueue.offer(END_SENTINEL);
            return;
        }
        Runnable cancelHandle = chatService.streamVoiceTurn(state.userId, request, new AiChatService.VoiceStreamCallbacks() {
            @Override
            public void onStatus(String status) {
                if (cancelled.get()) return;
                int step = statusUpdates.incrementAndGet();
                if (step == 1) {
                    // Initial prompt-prepare status: stay in "thinking" (never emit filler audio on fast Tier B turns!)
                    if (sampleOffset[0] == 0L) {
                        sendJson(state, Map.of("type", "entity.state", "state", "thinking", "status", status, "turnSeq", turnSeq));
                    }
                    if (isTierCDeep && !firstDeltaArrived.get() && bridgeScheduled.compareAndSet(false, true)) {
                        try {
                            bridgeFuture[0] = bridgeScheduler.schedule(() -> {
                                if (!cancelled.get() && !firstDeltaArrived.get() && state.session.isOpen()) {
                                    ttsQueue.offer(deepBridgeLine);
                                }
                            }, 950L, TimeUnit.MILLISECONDS);
                        } catch (RejectedExecutionException ignored) { }
                    }
                    return;
                }
                // Actual tool execution started (step >= 2): transition to "executing" + schedule 450ms Round-0 voice bridge
                if (sampleOffset[0] == 0L) {
                    sendJson(state, Map.of("type", "entity.state", "state", "executing", "status", status, "turnSeq", turnSeq));
                }
                if (!firstDeltaArrived.get() && bridgeScheduled.compareAndSet(false, true)) {
                    try {
                        bridgeFuture[0] = bridgeScheduler.schedule(() -> {
                            if (!cancelled.get() && !firstDeltaArrived.get() && state.session.isOpen()) {
                                ttsQueue.offer(toolBridgeLine);
                            }
                        }, 450L, TimeUnit.MILLISECONDS);
                    } catch (RejectedExecutionException ignored) { }
                }
            }

            @Override
            public void onDelta(String delta) {
                if (cancelled.get() || delta == null || delta.isEmpty()) return;
                if (firstDeltaArrived.compareAndSet(false, true) && bridgeFuture[0] != null) {
                    bridgeFuture[0].cancel(false);
                }
                fullGenerated.append(delta);
                state.markOutputStarted(turnSeq);
                state.recordGeneratedAssistantText(turnSeq, fullGenerated.toString());
                sendJson(state, Map.of("type", "llm.delta", "turnSeq", turnSeq, "delta", delta));
                chunker.accept(delta);
            }

            @Override
            public void onActions(List<EchoAction> actions) {
                if (cancelled.get() || actions == null || actions.isEmpty()) return;
                state.markOutputStarted(turnSeq);
                if (sampleOffset[0] == 0L) {
                    sendJson(state, Map.of("type", "entity.state", "state", "executing", "turnSeq", turnSeq));
                }
                sendJson(state, Map.of("type", "action.dispatch", "turnSeq", turnSeq, "actions", actions));
            }

            @Override
            public void onCards(List<EchoCard> cards) {
                if (cancelled.get() || cards == null || cards.isEmpty()) return;
                state.markOutputStarted(turnSeq);
                sendJson(state, Map.of("type", "action.dispatch", "turnSeq", turnSeq, "cards", cards));
            }

            @Override
            public void onComplete(AiChatResponse response) {
                if (bridgeFuture[0] != null) bridgeFuture[0].cancel(false);
                if (cancelled.get()) {
                    ttsQueue.offer(END_SENTINEL);
                    return;
                }
                chunker.flush();
                ttsQueue.offer(END_SENTINEL);
                String replyText = response.reply() != null && !response.reply().isBlank()
                        ? response.reply() : fullGenerated.toString().trim();
                state.commitTurnHistory(turnSeq, finalUserText, replyText);
                Long sid = state.echoSessionId != null
                        ? state.echoSessionId
                        : (!replyText.isBlank() ? ensureEchoSessionId(state, finalUserText) : null);
                if (sid != null && coachService != null && !replyText.isBlank() && state.claimDbPersist(turnSeq)) {
                    sid = persistSessionMessagesWithHeal(state, sid, finalUserText, replyText);
                }
                try {
                    ttsWorker.get(45, TimeUnit.SECONDS);
                } catch (Exception ignored) { }
                state.recordGeneratedSamples(turnSeq, sampleOffset[0]);
                if (!cancelled.get()) {
                    sendJson(state, Map.of("type", "tts.done", "turnSeq", turnSeq, "totalSamples", sampleOffset[0]));
                    Map<String, Object> doneMsg = new LinkedHashMap<>();
                    doneMsg.put("type", "response.done");
                    doneMsg.put("turnSeq", turnSeq);
                    doneMsg.put("reply", replyText);
                    doneMsg.put("route", response.route() == null ? "FAST" : response.route());
                    if (sid != null) doneMsg.put("sessionId", sid);
                    sendJson(state, doneMsg);
                    if (sampleOffset[0] == 0L) {
                        sendJson(state, Map.of("type", "entity.state", "state", "listening", "turnSeq", turnSeq));
                    }
                }
            }

            @Override
            public void onError(int status, String code, String limitKind, Instant resetsAt) {
                if (bridgeFuture[0] != null) bridgeFuture[0].cancel(false);
                ttsQueue.clear();
                ttsQueue.offer(END_SENTINEL);
                state.paused.set(false);
                // Only this turn's audio: the learner may already be speaking the NEXT turn (clearing it lost its words).
                state.clearPcmIfTurn(turnSeq);
                if ("cancelled".equals(code) || cancelled.get()) return;
                String safeCode = (code == null || code.isBlank() || "failed".equalsIgnoreCase(code) || "unavailable".equalsIgnoreCase(code))
                        ? "service_busy" : code;
                sendStructuredError(state, turnSeq, status, safeCode, limitKind, resetsAt);
                sendJson(state, Map.of("type", "entity.state", "state", "error", "turnSeq", turnSeq));
            }
        });
        state.attachCancelHandle(turnSeq, () -> {
            cancelled.set(true);
            if (bridgeFuture[0] != null) bridgeFuture[0].cancel(false);
            ttsQueue.clear();
            ttsQueue.offer(END_SENTINEL);
            cancelHandle.run();
        });
    }

    private void speakSingleShortReply(VoiceSessionState state, int turnSeq, String voiceId,
                                       String text, String route, AtomicBoolean cancelled) {
        if (text == null || text.isBlank() || cancelled.get()) return;
        state.markOutputStarted(turnSeq);
        state.recordGeneratedAssistantText(turnSeq, text);
        long[] sampleOffset = {0L};
        sendJson(state, Map.of("type", "entity.state", "state", "speaking", "turnSeq", turnSeq));
        sendJson(state, Map.of(
                "type", "tts.segment_start",
                "turnSeq", turnSeq,
                "utteranceId", turnSeq + "-0",
                "sampleRate", 24000,
                "text", text));
        try {
            voices.streamEchoSentence(state.userId, voiceId, text, pcmChunk -> {
                if (cancelled.get() || !state.session.isOpen()) {
                    throw new CancellationException("Cancelled");
                }
                emitPcm24Frames(state, turnSeq, sampleOffset, pcmChunk, cancelled);
            });
        } catch (CancellationException stopped) {
            return;
        } catch (Exception ttsUnavailable) {
            sendJson(state, Map.of("type", "tts.fallback", "turnSeq", turnSeq, "text", text));
        }
        state.recordGeneratedSamples(turnSeq, sampleOffset[0]);
        if (!cancelled.get()) {
            sendJson(state, Map.of("type", "tts.done", "turnSeq", turnSeq, "totalSamples", sampleOffset[0]));
            Map<String, Object> doneMsg = new LinkedHashMap<>();
            doneMsg.put("type", "response.done");
            doneMsg.put("turnSeq", turnSeq);
            doneMsg.put("reply", text);
            doneMsg.put("route", route);
            if (state.echoSessionId != null) doneMsg.put("sessionId", state.echoSessionId);
            sendJson(state, doneMsg);
            if (sampleOffset[0] == 0L) {
                sendJson(state, Map.of("type", "entity.state", "state", "listening", "turnSeq", turnSeq));
            }
        }
    }

    private String resolvePlaneASpokenAck(VoiceSessionState state, int turnSeq, CompletableFuture<JsonNode> ackFuture,
                                          String fallbackSpokenAck, AtomicBoolean cancelled) {
        if (ackFuture == null || cancelled.get()) return fallbackSpokenAck;
        try {
            JsonNode ack = ackFuture.get(ACTION_ACK_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (ack == null) return fallbackSpokenAck;
            String status = ack.path("status").asText("").trim().toLowerCase(Locale.ROOT);
            String explicitMsg = ack.hasNonNull("spokenMessage") ? ack.get("spokenMessage").asText("").trim() : "";
            if ("cancelled".equals(status) && explicitMsg.isEmpty()) {
                return null;
            }
            if (!explicitMsg.isEmpty()) {
                return explicitMsg;
            }
            if (status.isEmpty() || "done".equals(status) || "succeeded".equals(status) || "ok".equals(status)) {
                return fallbackSpokenAck;
            }
            return null;
        } catch (TimeoutException legacyClientNoAck) {
            return fallbackSpokenAck;
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            return fallbackSpokenAck;
        } catch (ExecutionException | CancellationException ignored) {
            return fallbackSpokenAck;
        }
    }

    private void handleTruncate(VoiceSessionState state, JsonNode json) {
        int turnSeq = json.path("turnSeq").asInt(state.activeResponseSeq);
        if (turnSeq == state.activeResponseSeq) {
            state.cancelActiveTurn();
        }
        Long sessionId = state.echoSessionId;
        if (json.hasNonNull("sessionId") && json.get("sessionId").canConvertToLong()) {
            long explicitSid = json.get("sessionId").asLong();
            if (explicitSid > 0L) {
                sessionId = Long.valueOf(explicitSid);
            }
        }
        String spokenText = json.hasNonNull("spokenText") ? json.get("spokenText").asText("") : null;
        long playedMs = json.path("playedMs").asLong(-1L);

        String resolvedSpoken = state.truncateInMemoryHistory(turnSeq, spokenText, playedMs);
        if (sessionId == null && coachService != null && resolvedSpoken != null && !resolvedSpoken.isBlank()) {
            sessionId = ensureEchoSessionId(state, state.userTextForTurn(turnSeq));
        }
        boolean dbTruncated = false;
        if (sessionId != null && sessionId > 0 && coachService != null && resolvedSpoken != null && !resolvedSpoken.isBlank()) {
            try {
                // V46 race fix: ONLY update the latest persisted assistant row when THIS turnSeq was already persisted.
                // Otherwise, persist the interrupted (userText, heardAssistantText) pair once without corrupting prior turns!
                if (state.wasTurnPersisted(turnSeq)) {
                    dbTruncated = coachService.truncateLatestAssistantMessage(state.userId, sessionId, resolvedSpoken);
                } else if (state.claimDbPersist(turnSeq)) {
                    String userText = state.userTextForTurn(turnSeq);
                    if (userText != null && !userText.isBlank()) {
                        coachService.saveMessages(state.userId, sessionId,
                                new SaveMessagePairRequest(userText, resolvedSpoken, null, null));
                        dbTruncated = true;
                    }
                }
            } catch (RuntimeException ex) {
                log.debug("[ECHO VOICE WS] Truncate session {} rejected: {}", sessionId, ex.getMessage());
            }
        }
        Map<String, Object> truncPayload = new LinkedHashMap<>();
        truncPayload.put("type", "conversation.item.truncated");
        truncPayload.put("turnSeq", turnSeq);
        truncPayload.put("spokenText", resolvedSpoken == null ? "" : resolvedSpoken);
        truncPayload.put("truncated", dbTruncated || (resolvedSpoken != null && !resolvedSpoken.isBlank()));
        if (sessionId != null && sessionId > 0) {
            truncPayload.put("sessionId", sessionId);
        }
        sendJson(state, truncPayload);
    }

    private void handleToolConfirm(VoiceSessionState state, JsonNode json) {
        if (confirmations == null) {
            sendStructuredError(state, null, 503, "confirmations_unavailable", null, null);
            return;
        }
        String token = json.path("token").asText("");
        boolean accept = "CONFIRM".equalsIgnoreCase(json.path("decision").asText(""));
        try {
            var outcome = confirmations.decide(state.userId, token, accept);
            if (brain != null) brain.forget(state.userId);
            Map<String, Object> msg = new LinkedHashMap<>();
            msg.put("type", "tool.confirmed");
            msg.put("status", outcome.status());
            msg.put("plan", outcome.plan());
            if (outcome.plan() != null) {
                Object savedCards = outcome.plan().get("total") != null ? outcome.plan().get("total") : outcome.plan().get("created");
                if (savedCards instanceof Number n) {
                    msg.put("savedCards", n.intValue());
                }
            }
            sendJson(state, msg);
        } catch (RuntimeException ex) {
            sendStructuredError(state, null, 404, "confirmation_invalid", null, null);
        }
    }

    private void maybeTriggerPartialAsr(VoiceSessionState state, int turnSeq) {
        byte[] snapshot = state.snapshotForPartialIfDue(turnSeq);
        if (snapshot == null) return;
        if (!throttle.admitPartialAsr(state.userId)) {
            state.finishInFlightPartial(turnSeq, snapshot.length, null);
            return;
        }
        CompletableFuture<Transcript> partialFuture = state.registerInFlightPartial(turnSeq, snapshot.length);
        submitWorker(state, () -> {
            Transcript decoded = null;
            try {
                if (partialFuture.isCancelled() || state.currentTurnSeq != turnSeq) {
                    return;
                }
                String wsSid = state.session != null ? state.session.getId() : null;
                decoded = transcribePcmWithGate(state.userId, snapshot, state.lang, "partial", wsSid, turnSeq, null);
                if (partialFuture.isCancelled() || state.currentTurnSeq != turnSeq) {
                    decoded = null;
                    return;
                }
                if (decoded != null && !decoded.isHallucinationRejected()) {
                    String rawText = decoded.text() != null ? decoded.text().trim() : "";
                    String stable = (decoded.stableText() != null && !decoded.stableText().isBlank())
                            ? decoded.stableText().trim()
                            : rawText;
                    if (!rawText.isEmpty() || !stable.isEmpty()) {
                        sendJson(state, Map.of(
                                "type", "asr.partial",
                                "turnSeq", turnSeq,
                                "text", rawText.isEmpty() ? stable : rawText,
                                "stableText", stable,
                                "lang", decoded.language() == null ? "" : decoded.language()));
                    }
                }
            } finally {
                state.finishInFlightPartial(turnSeq, snapshot.length, decoded);
            }
        });
    }

    static Transcript tryPromoteTailSilencePartial(VoiceSessionState state, int turnSeq, byte[] pcm, AtomicBoolean cancelled) {
        if (pcm == null || pcm.length < PARTIAL_PROMOTE_MIN_PCM_BYTES || (cancelled != null && cancelled.get())) {
            return null;
        }
        CompletableFuture<Transcript> inflight = state.inFlightPartialForCoalesce(turnSeq, pcm.length);
        if (inflight != null && !inflight.isDone()) {
            int inflightLen = state.inFlightPartialLengthForTurn(turnSeq);
            if (inflightLen >= PARTIAL_PROMOTE_MIN_PCM_BYTES
                    && pcm.length - inflightLen <= PARTIAL_PROMOTE_MAX_TAIL_BYTES
                    && isSilentPcmBelowMinus42Dbfs(pcm, inflightLen, pcm.length)) {
                try {
                    inflight.get(350L, TimeUnit.MILLISECONDS);
                } catch (Exception ignored) { }
            }
        }
        if (cancelled != null && cancelled.get()) return null;
        return state.takePromotablePartialIfTailSilent(turnSeq, pcm);
    }

    static boolean isSilentPcmBelowMinus42Dbfs(byte[] pcm, int fromByte, int toByte) {
        int start = Math.max(0, fromByte) & ~1;
        int end = Math.min(pcm.length, toByte) & ~1;
        if (end <= start) return true;
        final int windowBytes = 640; // 20 ms @ 16 kHz mono int16le (320 samples)
        for (int off = start; off < end; off += windowBytes) {
            int winEnd = Math.min(end, off + windowBytes);
            int samples = (winEnd - off) / 2;
            if (samples <= 0) break;
            double sumSq = 0.0;
            for (int b = off; b + 1 < winEnd; b += 2) {
                short s = (short) ((pcm[b] & 0xFF) | (pcm[b + 1] << 8));
                sumSq += (double) s * (double) s;
            }
            if ((sumSq / samples) >= TAIL_SILENCE_MAX_MEAN_SQUARE_INT16) {
                return false;
            }
        }
        return true;
    }

    static boolean hasVoicedPcmAboveMinus38Dbfs(byte[] pcm, int fromByte, int toByte) {
        int start = Math.max(0, fromByte) & ~1;
        int end = Math.min(pcm.length, toByte) & ~1;
        if (end - start < 640) return false;
        final int windowBytes = 640;
        for (int off = start; off + windowBytes <= end; off += windowBytes) {
            double sumSq = 0.0;
            for (int b = off; b + 1 < off + windowBytes; b += 2) {
                short s = (short) ((pcm[b] & 0xFF) | (pcm[b + 1] << 8));
                sumSq += (double) s * (double) s;
            }
            if ((sumSq / 320.0) >= TURN_CHECK_RESUME_MIN_MEAN_SQUARE_INT16) {
                return true;
            }
        }
        return false;
    }

    private String buildTranscribeUrlWithSessionTurn(String wsSessionId, int turnSeq) {
        if (wsSessionId == null || wsSessionId.isBlank() || turnSeq < 0) {
            return transcribeUrl;
        }
        String safeSid = java.net.URLEncoder.encode(wsSessionId, java.nio.charset.StandardCharsets.UTF_8);
        return transcribeUrl + "&session_id=" + safeSid + "&turn_seq=" + turnSeq;
    }

    private Transcript transcribePcmWithGate(long userId, byte[] pcm, String lang, String mode,
                                             String wsSessionId, int turnSeq, AtomicBoolean cancelled) {
        if (cancelled != null && cancelled.get()) {
            return null;
        }
        boolean isFinal = "final".equals(mode);
        if (!throttle.acquireAsrSlot(isFinal)) {
            return null;
        }
        try {
            if (cancelled != null && cancelled.get()) {
                return null;
            }
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_OCTET_STREAM);
            String cleanLang = (lang == null || !Set.of("vi", "en", "auto").contains(lang)) ? "auto" : lang;
            String url = buildTranscribeUrlWithSessionTurn(wsSessionId, turnSeq);
            return asrClient.postForObject(url, new HttpEntity<>(pcm, headers), Transcript.class, cleanLang, mode);
        } catch (RuntimeException ex) {
            log.debug("[ECHO VOICE WS] ASR call ({}) unavailable: {}", mode, ex.getMessage());
            return null;
        } finally {
            throttle.releaseAsrSlot();
        }
    }

    private TurnCheckResult checkTurnCompletion(byte[] pcm) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_OCTET_STREAM);
            HttpEntity<byte[]> entity = new HttpEntity<>(pcm, headers);
            TurnCheckResult res = turnCheckClient.postForObject(turnCheckUrl, entity, TurnCheckResult.class);
            if (res != null && res.complete() != null && res.probability() != null && res.recommendedWaitMs() != null) {
                return res;
            }
            if (res == null) {
                Map<?, ?> fallbackMap = turnCheckClient.postForObject(turnCheckUrl, entity, Map.class, true);
                if (fallbackMap != null && fallbackMap.get("complete") instanceof Boolean completeBool) {
                    double prob = fallbackMap.get("probability") instanceof Number n ? n.doubleValue() : (completeBool ? 0.7 : 0.0);
                    int wait = fallbackMap.get("recommendedWaitMs") instanceof Number w ? w.intValue() : (completeBool ? 0 : 650);
                    return new TurnCheckResult(completeBool, prob, wait);
                }
            }
        } catch (RuntimeException ignored) { }
        return new TurnCheckResult(false, 0.0, 650);
    }

    private static void waitWhilePaused(VoiceSessionState state, AtomicBoolean cancelled) {
        long waited = 0L;
        while (state.paused.get() && !cancelled.get() && state.session.isOpen() && waited < MAX_PAUSE_WAIT_MS) {
            try {
                Thread.sleep(15L);
                waited += 15L;
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }

    private void emitPcm24Frames(VoiceSessionState state, int turnSeq, long[] sampleOffset, byte[] pcmChunk, AtomicBoolean cancelled) {
        state.markOutputStarted(turnSeq);
        int evenTotal = pcmChunk.length & ~1;
        for (int off = 0; off < evenTotal; off += MAX_TTS_PCM_PER_FRAME) {
            waitWhilePaused(state, cancelled);
            if (cancelled.get() || !state.session.isOpen()) {
                throw new CancellationException("Cancelled");
            }
            int len = Math.min(MAX_TTS_PCM_PER_FRAME, evenTotal - off) & ~1;
            if (len <= 0) continue;
            byte[] frame = new byte[BINARY_HEADER_BYTES + len];
            frame[0] = FRAME_TTS_PCM24;
            frame[1] = (byte) ((turnSeq >>> 8) & 0xFF);
            frame[2] = (byte) (turnSeq & 0xFF);
            long offset = sampleOffset[0];
            frame[3] = (byte) ((offset >>> 24) & 0xFF);
            frame[4] = (byte) ((offset >>> 16) & 0xFF);
            frame[5] = (byte) ((offset >>> 8) & 0xFF);
            frame[6] = (byte) (offset & 0xFF);
            System.arraycopy(pcmChunk, off, frame, BINARY_HEADER_BYTES, len);
            sampleOffset[0] += (len / 2);
            sendBinary(state, frame);
        }
    }

    private VoiceSessionState validateMessageSession(WebSocketSession session) {
        if (session == null || !session.isOpen()) return null;
        VoiceSessionState state = sessions.get(session.getId());
        if (state == null || isForbiddenAuthentication(state.auth) || !sessionStillLive(state)) {
            cleanupSession(session.getId());
            safeClose(session, new CloseStatus(1008, "Session ended"));
            return null;
        }
        return state;
    }

    boolean sessionStillLive(VoiceSessionState state) {
        if (authSessionService == null) return true;
        AuthSessionContext ctx = AuthSessionContext.of(state.auth);
        if (ctx == null || ctx.sessionId() == null) return true;
        long now = System.currentTimeMillis();
        long recheckInterval = SESSION_RECHECK_MS - Math.floorMod(state.session.getId().hashCode(), 5_000);
        if (now - state.lastSessionCheckMs < recheckInterval) return true;
        try {
            boolean live = authSessionService.validateAndTouchActiveSession(ctx.sessionId(), state.userId);
            if (live && userRepository != null) {
                live = userRepository.findById(state.userId)
                        .map(u -> "ACTIVE".equalsIgnoreCase(u.getAccountStatus()))
                        .orElse(false);
            }
            if (live) {
                state.lastSessionCheckMs = now;
                state.recheckFailures.set(0);
            }
            return live;
        } catch (RuntimeException ex) {
            int fails = state.recheckFailures.incrementAndGet();
            log.warn("[ECHO VOICE WS] Session recheck error #{} for {}: {}", fails, state.session.getId(), ex.getMessage());
            return fails < MAX_CONSECUTIVE_RECHECK_ERRORS;
        }
    }

    private static Authentication resolveAuthentication(WebSocketSession session) {
        if (session == null) return null;
        Map<String, Object> attrs = session.getAttributes();
        if (attrs != null && attrs.get(ATTR_AUTHENTICATION) instanceof Authentication a) {
            return a;
        }
        if (session.getPrincipal() instanceof Authentication p) {
            return p;
        }
        return null;
    }

    private void submitWorker(VoiceSessionState state, Runnable task) {
        try {
            voiceWorkers.execute(task);
        } catch (RejectedExecutionException overloaded) {
            sendStructuredError(state, null, 503, "service_busy", null, null);
        }
    }

    private void sendStructuredError(VoiceSessionState state, Integer turnSeq, int status, String code,
                                     String limitKind, Instant resetsAt) {
        String safeCode = (code == null || code.isBlank() || "failed".equalsIgnoreCase(code))
                ? "service_busy" : code;
        boolean vi = !"en".equalsIgnoreCase(state.locale);
        String msgVi = EchoPolicy.localizedErrorMessage(safeCode, true);
        String msgEn = EchoPolicy.localizedErrorMessage(safeCode, false);
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("type", "error");
        if (turnSeq != null) err.put("turnSeq", turnSeq);
        err.put("status", status);
        err.put("code", safeCode);
        err.put("recoverable", !"daily".equals(safeCode));
        err.put("message", vi ? msgVi : msgEn);
        err.put("messageVi", msgVi);
        err.put("messageEn", msgEn);
        if (limitKind != null) err.put("limitKind", limitKind);
        if (resetsAt != null) err.put("resetsAt", resetsAt.toString());
        sendJson(state, err);
    }

    static List<String> sanitizeAndSliceClauseForSpeech(String rawClause) {
        if (rawClause == null || rawClause.isBlank()) return List.of();
        String cleaned = EchoPolicy.stripEchoMeta(rawClause)
                .replaceAll("(?is)<(?:think|tool_call)>.*?(?:</(?:think|tool_call)>|$)", " ")
                .replaceAll("(?s)```.*?```", " ")
                .replaceAll("\\[[^\\]\\n]+->[^\\]\\n]+\\]", " ")
                .replaceAll("\\[([^\\]\\n]+)\\]\\([^)\\n]+\\)", "$1")
                .replaceAll("https?://\\S+", " ")
                .replaceAll("(?iu)\\b(?:pronunciation|ipa|phi\\u00EAn \\u00E2m|phien am)\\s*:\\s*(?:/[^/\\n]{1,60}/|\\[[^\\]\\n]{1,60}\\])?", " ")
                .replaceAll("(?:^|(?<=[\\s(\\[{:;,\\u2014-]))/(?![0-9]+/)[^/\\s\\n]{1,48}/(?=[\\s.,!?:;)\\]}]|$)", " ")
                .replaceAll("(?iu)\\(?\\bCEFR(?:\\s+level)?\\s*:\\s*[ABC][12](?:\\s*[-\\u2013\\u2014/\\s]+(?:to\\s+)?[ABC][12])?\\)?", " ")
                .replaceAll("(\\*\\*|__|`)", "")
                .replaceAll("(?<!\\*)\\*([^\\*\\n]+)\\*(?!\\*)", "$1")
                .replaceAll("(?<=^|[\\s(\\[{\"'])\\*(?=\\S)|(?<=\\S)\\*(?=$|[\\s.,!?:;)\\]}\"'])", "")
                .replaceAll("[\\x{1F1E6}-\\x{1F1FF}\\x{1F300}-\\x{1FAFF}\\u231A-\\u23FA\\u2600-\\u27BF\\u2B50\\u2B55\\uFE0E\\uFE0F\\u200D\\u20E3]+", " ")
                .replaceAll("(?m)^\\s*#{1,6}\\s+|^[ \\t]*[-•]\\s+", "")
                .replaceAll("(?:^|\\s)#{1,6}\\s+", " ")
                .replaceAll("(?:^|\\s)[-*_]{3,}(?=\\s|$)", " ")
                .replaceAll("\\s+([.,!?;:])", "$1")
                .replaceAll("^[.,;:!?\\-\\u2013\\u2014\\s]+", "")
                .replaceAll("\\s+", " ")
                .trim();
        boolean hasSpeakableChar = false;
        for (int i = 0; i < cleaned.length(); i++) {
            if (Character.isLetterOrDigit(cleaned.charAt(i))) {
                hasSpeakableChar = true;
                break;
            }
        }
        if (!hasSpeakableChar) return List.of();
        if (cleaned.length() <= 460) return List.of(cleaned);
        List<String> slices = new ArrayList<>();
        int cursor = 0;
        while (cursor < cleaned.length()) {
            int remaining = cleaned.length() - cursor;
            if (remaining <= 460) {
                String tail = cleaned.substring(cursor).trim();
                if (!tail.isEmpty()) slices.add(tail);
                break;
            }
            int cut = cursor + 460;
            int space = cleaned.lastIndexOf(' ', cut);
            if (space > cursor + 80) cut = space;
            String part = cleaned.substring(cursor, cut).trim();
            if (!part.isEmpty()) slices.add(part);
            cursor = cut;
            while (cursor < cleaned.length() && Character.isWhitespace(cleaned.charAt(cursor))) cursor++;
        }
        return slices;
    }

    private void sendJson(VoiceSessionState state, Map<String, Object> payload) {
        if (!state.session.isOpen()) return;
        try {
            String text = mapper.writeValueAsString(payload);
            synchronized (state.sendLock) {
                if (state.session.isOpen()) {
                    state.session.sendMessage(new TextMessage(text));
                }
            }
        } catch (IOException ignored) { }
    }

    private static void sendBinary(VoiceSessionState state, byte[] bytes) {
        if (!state.session.isOpen()) return;
        try {
            synchronized (state.sendLock) {
                if (state.session.isOpen()) {
                    state.session.sendMessage(new BinaryMessage(bytes));
                }
            }
        } catch (IOException ignored) { }
    }

    private static void safeClose(WebSocketSession session, CloseStatus status) {
        if (session == null) return;
        try {
            if (session.isOpen()) session.close(status);
        } catch (IOException ignored) { }
    }

    private static List<AiChatMessageDto> parseMessages(JsonNode arr) {
        List<AiChatMessageDto> out = new ArrayList<>();
        for (JsonNode item : arr) {
            String role = item.path("role").asText("").toLowerCase(Locale.ROOT);
            String content = item.path("content").asText("").trim();
            if ((role.equals("user") || role.equals("assistant")) && !content.isEmpty() && content.length() <= 4000) {
                out.add(new AiChatMessageDto(role, content));
                if (out.size() >= 14) break;
            }
        }
        return out;
    }

    private static String inferUtteranceLocale(String text, String fallback) {
        if (text == null) return fallback == null ? "vi" : fallback;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if ((c >= 0x00C0 && c <= 0x024F) || (c >= 0x1E00 && c <= 0x1EFF)) {
                return "vi";
            }
        }
        return "en";
    }

    /** Two-gear spoken clause chunker: fast Clause-0 release (24..56 chars) + smooth Prosody Clause 1+ (80..180 chars). */
    static final class FirstClauseChunker {
        private final java.util.function.Consumer<String> onClause;
        private final StringBuilder buf = new StringBuilder();
        private boolean firstEmitted;

        FirstClauseChunker(java.util.function.Consumer<String> onClause) {
            this.onClause = onClause;
        }

        synchronized void accept(String delta) {
            buf.append(delta);
            while (true) {
                int split = findSplit(buf, firstEmitted);
                if (split <= 0) break;
                String clause = buf.substring(0, split).trim();
                buf.delete(0, split);
                if (!clause.isEmpty()) {
                    firstEmitted = true;
                    onClause.accept(clause);
                }
            }
        }

        synchronized void flush() {
            String rest = buf.toString().trim();
            buf.setLength(0);
            if (!rest.isEmpty()) {
                firstEmitted = true;
                onClause.accept(rest);
            }
        }

        private static int findSplit(StringBuilder sb, boolean afterFirst) {
            int len = sb.length();
            int minPunct = afterFirst ? 56 : 8;
            int maxSoft = afterFirst ? 140 : 32;
            if (len < minPunct) return -1;
            for (int i = minPunct; i < len; i++) {
                char prev = sb.charAt(i - 1);
                char cur = sb.charAt(i);
                if (Character.isWhitespace(cur)) {
                    boolean sentenceEnd = prev == '.' || prev == '!' || prev == '?' || prev == '…';
                    boolean clauseEnd = !afterFirst && (prev == ',' || prev == ';' || prev == ':' || prev == '—');
                    if ((sentenceEnd || clauseEnd) && !(prev == '.' && i >= 2 && Character.isDigit(sb.charAt(i - 2)))) {
                        return i + 1;
                    }
                }
            }
            if (len >= maxSoft) {
                for (int i = len - 1; i >= minPunct; i--) {
                    if (Character.isWhitespace(sb.charAt(i))) return i + 1;
                }
            }
            return -1;
        }
    }

    static final class VoiceSessionState {
        record PcmCommitTicket(byte[] pcm, AtomicBoolean cancelled) {}

        final WebSocketSession session;
        final long userId;
        final Authentication auth;
        final Object sendLock = new Object();

        volatile String voiceId = "us_female";
        volatile String lang = "auto";
        volatile String locale = "vi";
        volatile String pathname = "/dashboard";
        volatile boolean hasPendingConfirmation = false;
        volatile boolean hasActiveStrictSentinel = false;
        volatile Long echoSessionId;
        volatile EchoPageContextDto pageContext;
        volatile List<EchoSalientResourceDto> salientResources = List.of();
        volatile long lastSessionCheckMs = System.currentTimeMillis();
        final AtomicInteger recheckFailures = new AtomicInteger(0);
        private final ConcurrentHashMap<Integer, CompletableFuture<JsonNode>> pendingActionAcks = new ConcurrentHashMap<>();

        // Audio turn accumulation: null (0 B) while idle; bounded <= 640 KB (20.0 s) during active speech
        private byte[] pcmBuf;
        private int pcmLen;
        private int lastPartialLen;
        private int carryOverlapTrimBytes;
        private int pendingCarryOverlapTrimBytes;
        volatile int currentTurnSeq = -1;
        final AtomicBoolean partialBusy = new AtomicBoolean(false);
        private int lastPartialTurnSeq = -1;
        private int lastCompletedPartialPcmLen = 0;
        private Transcript lastCompletedPartial;
        private int inFlightPartialTurnSeq = -1;
        private int inFlightPartialPcmLen = 0;
        private CompletableFuture<Transcript> inFlightPartialFuture;

        // Active response / barge-in control
        volatile int activeResponseSeq = -1;
        private int lastCommittedTurnSeq = -1;
        private AtomicBoolean activeCancelled = new AtomicBoolean(false);
        private volatile Runnable activeCancelHandle = () -> {};
        final AtomicBoolean paused = new AtomicBoolean(false);

        // Conversation memory & exact heard-audio truncation tracking (with V46 DB-persistence race guard)
        private final List<AiChatMessageDto> history = new ArrayList<>();
        private volatile int lastHistoryTurnSeq = -1;
        private volatile int lastTurnSeqUser = -1;
        private volatile String lastTurnUserText = "";
        private volatile int lastPersistedTurnSeq = -1;
        private volatile int lastAssistantTurnSeq = -1;
        private volatile String lastAssistantText = "";
        private volatile long lastAssistantSamples = 0L;

        VoiceSessionState(WebSocketSession session, long userId, Authentication auth) {
            this.session = session;
            this.userId = userId;
            this.auth = auth;
        }

        private void cancelPartialFuturesLocked() {
            if (inFlightPartialFuture != null) {
                inFlightPartialFuture.cancel(true);
                inFlightPartialFuture = null;
            }
            inFlightPartialTurnSeq = -1;
            inFlightPartialPcmLen = 0;
            partialBusy.set(false);
        }

        synchronized boolean appendMicPcm(int turnSeq, long sampleOffset, byte[] chunk) {
            boolean startedNew = false;
            if (turnSeq >= 0 && currentTurnSeq >= 0 && turnSeq < currentTurnSeq) {
                // A late frame of an older turn must never reset (and so erase) the turn being spoken now.
                return false;
            }
            if (turnSeq != currentTurnSeq || sampleOffset == 0 && pcmLen > 0 && turnSeq > currentTurnSeq) {
                cancelPartialFuturesLocked();
                currentTurnSeq = turnSeq;
                pcmLen = 0;
                lastPartialLen = 0;
                lastPartialTurnSeq = -1;
                lastCompletedPartialPcmLen = 0;
                lastCompletedPartial = null;
                carryOverlapTrimBytes = 0;
                pendingCarryOverlapTrimBytes = 0;
                startedNew = true;
            }
            int srcOff = 0;
            int copyLen = chunk.length & ~1;
            if (carryOverlapTrimBytes > 0) {
                int trim = Math.min(copyLen, carryOverlapTrimBytes) & ~1;
                srcOff += trim;
                copyLen -= trim;
                carryOverlapTrimBytes -= trim;
            }
            if (copyLen <= 0) {
                return startedNew;
            }
            if (pcmBuf == null) {
                pcmBuf = new byte[Math.min(MAX_BINARY_FRAME_BYTES, Math.max(8192, copyLen * 4))];
            }
            if (pcmLen + copyLen > MAX_TURN_PCM_BYTES) {
                // Keep most recent <= MAX_TURN_PCM_BYTES (rolling window, never OOM)
                int keep = MAX_TURN_PCM_BYTES - copyLen;
                if (keep > 0 && pcmLen > keep) {
                    System.arraycopy(pcmBuf, pcmLen - keep, pcmBuf, 0, keep);
                    pcmLen = keep;
                } else {
                    pcmLen = 0;
                }
                lastPartialLen = Math.min(lastPartialLen, pcmLen);
                lastCompletedPartial = null;
                lastCompletedPartialPcmLen = 0;
            }
            if (pcmLen + copyLen > pcmBuf.length) {
                int nextCap = Math.min(MAX_TURN_PCM_BYTES, Math.max(pcmBuf.length * 2, pcmLen + copyLen));
                pcmBuf = Arrays.copyOf(pcmBuf, nextCap);
            }
            System.arraycopy(chunk, srcOff, pcmBuf, pcmLen, copyLen);
            pcmLen += copyLen;
            return startedNew;
        }

        synchronized void resetForSpeechStart(int turnSeq) {
            resetForSpeechStart(turnSeq, null);
        }

        /** Starts a turn's buffer, optionally seeded with a merged premature turn's audio (bounded to MAX_TURN_CARRY_BYTES). */
        synchronized void resetForSpeechStart(int turnSeq, byte[] carry) {
            if (turnSeq != lastCommittedTurnSeq) {
                lastCommittedTurnSeq = -1;
            }
            cancelPartialFuturesLocked();
            currentTurnSeq = turnSeq;
            pcmLen = 0;
            lastPartialLen = 0;
            lastPartialTurnSeq = -1;
            lastCompletedPartialPcmLen = 0;
            lastCompletedPartial = null;
            if (carry != null && carry.length > 0) {
                int keep = Math.min(carry.length, MAX_TURN_CARRY_BYTES) & ~1;
                pcmBuf = Arrays.copyOf(Arrays.copyOfRange(carry, carry.length - keep, carry.length),
                        Math.min(MAX_TURN_PCM_BYTES, Math.max(8192, keep * 2)));
                pcmLen = keep;
                carryOverlapTrimBytes = pendingCarryOverlapTrimBytes;
            } else {
                carryOverlapTrimBytes = 0;
            }
            pendingCarryOverlapTrimBytes = 0;
        }

        synchronized void clearPcm() {
            cancelPartialFuturesLocked();
            pcmBuf = null;
            pcmLen = 0;
            lastPartialLen = 0;
            lastPartialTurnSeq = -1;
            lastCompletedPartialPcmLen = 0;
            lastCompletedPartial = null;
            carryOverlapTrimBytes = 0;
            pendingCarryOverlapTrimBytes = 0;
        }

        /** Clears the buffer only while it still belongs to {@code turnSeq} (never the next turn's speech). */
        synchronized void clearPcmIfTurn(int turnSeq) {
            if (currentTurnSeq == turnSeq) {
                clearPcm();
            }
            if (committedPcmSeq == turnSeq) {
                committedPcm = null;
                committedCarryWindowMs = TURN_MERGE_WINDOW_MS;
            }
        }

        // Premature end-of-turn merge bookkeeping (see TURN_MERGE_WINDOW_MS & VOCATIVE_MERGE_WINDOW_MS)
        private byte[] committedPcm;
        private int committedPcmSeq = -1;
        private long committedAtMs;
        private long committedCarryWindowMs = TURN_MERGE_WINDOW_MS;
        private boolean committedOutputStarted;

        synchronized void rememberCommittedAudio(int turnSeq, byte[] pcm) {
            rememberCommittedAudio(turnSeq, pcm, System.currentTimeMillis());
        }

        synchronized void rememberCommittedAudio(int turnSeq, byte[] pcm, long nowMs) {
            committedPcm = pcm != null && pcm.length > 0 ? pcm : null;
            committedPcmSeq = turnSeq;
            committedAtMs = nowMs;
            committedCarryWindowMs = TURN_MERGE_WINDOW_MS;
            committedOutputStarted = false;
        }

        synchronized void holdBareVocativeForMerge(int turnSeq, long mergeWindowMs) {
            if (committedPcmSeq == turnSeq && committedPcm != null) {
                committedCarryWindowMs = Math.max(committedCarryWindowMs, mergeWindowMs);
            }
            if (lastCommittedTurnSeq == turnSeq) {
                lastCommittedTurnSeq = -1;
            }
        }

        synchronized void clearCommittedPcmIfTurn(int turnSeq) {
            if (committedPcmSeq == turnSeq) {
                committedPcm = null;
                committedCarryWindowMs = TURN_MERGE_WINDOW_MS;
            }
        }

        synchronized void markOutputStarted(int turnSeq) {
            if (committedPcmSeq == turnSeq && !committedOutputStarted) {
                committedOutputStarted = true;
                committedPcm = null;
            }
        }

        /**
         * Returns (and forgets) the audio of the turn committed just before {@code newSeq} when that turn may be merged:
         * it is the active response, produced no output (no words, audio, card, guard, action or plan), was not cancelled,
         * and was committed within the active carry window ({@link #TURN_MERGE_WINDOW_MS} or {@link #VOCATIVE_MERGE_WINDOW_MS}).
         * Also computes {@code carryOverlapTrimBytes} when {@code elapsedMs < 480} so client speech-start preroll neither
         * clips nor duplicates syllables across the seam.
         */
        synchronized byte[] takeMergeableCommittedAudio(int newSeq, long nowMs) {
            if (committedPcm == null || newSeq <= committedPcmSeq || committedOutputStarted) return null;
            if (activeResponseSeq != committedPcmSeq || activeCancelled.get()) return null;
            long elapsedMs = Math.max(0L, nowMs - committedAtMs);
            if (elapsedMs > committedCarryWindowMs) return null;
            byte[] carry = committedPcm;
            committedPcm = null;
            committedCarryWindowMs = TURN_MERGE_WINDOW_MS;
            pendingCarryOverlapTrimBytes = elapsedMs < CLIENT_SPEECH_START_PREROLL_MS
                    ? (int) (((CLIENT_SPEECH_START_PREROLL_MS - elapsedMs) * 32L) & ~1L)
                    : 0;
            return carry;
        }

        synchronized int currentPcmLengthForTurn(int turnSeq) {
            if (currentTurnSeq != turnSeq || pcmBuf == null) return 0;
            return pcmLen;
        }

        synchronized boolean canAutoCommitTurnCheck(int turnSeq, int snapLen) {
            if (turnSeq < 0 || snapLen < 640) return false;
            if (currentTurnSeq != turnSeq || pcmBuf == null || pcmLen < snapLen) return false;
            if (lastCommittedTurnSeq == turnSeq && activeResponseSeq == turnSeq && !activeCancelled.get()) {
                return false;
            }
            if (pcmLen > snapLen && hasVoicedPcmAboveMinus38Dbfs(pcmBuf, snapLen, pcmLen)) {
                return false;
            }
            return true;
        }

        synchronized PcmCommitTicket snapshotAndCommitFromTurnCheck(int turnSeq, int snapLen) {
            if (!canAutoCommitTurnCheck(turnSeq, snapLen)) {
                return null;
            }
            cancelActiveTurn();
            AtomicBoolean cancelled = beginResponse(turnSeq);
            byte[] snap = takeAndClearPcm();
            if (snap.length > 0) {
                rememberCommittedAudio(turnSeq, snap);
            }
            return new PcmCommitTicket(snap, cancelled);
        }

        synchronized PcmCommitTicket snapshotAndClearPcmForTurn(int turnSeq, boolean hasExplicitText, boolean skipFastPath) {
            if (shouldIgnoreDuplicateCommit(turnSeq, hasExplicitText, skipFastPath)) {
                return null;
            }
            if (turnSeq >= 0 && (currentTurnSeq > turnSeq || activeResponseSeq > turnSeq)) {
                return null;
            }
            cancelActiveTurn();
            AtomicBoolean cancelled = beginResponse(turnSeq);
            byte[] snap = takeAndClearPcm();
            if (!hasExplicitText && snap.length > 0) {
                rememberCommittedAudio(turnSeq, snap);
            }
            return new PcmCommitTicket(snap, cancelled);
        }

        synchronized byte[] snapshotAndClearPcmForTurn(int turnSeq) {
            if (turnSeq >= 0 && currentTurnSeq > turnSeq) {
                return new byte[0];
            }
            return takeAndClearPcm();
        }

        synchronized byte[] takeAndClearPcm() {
            if (pcmBuf == null || pcmLen == 0) {
                pcmBuf = null;
                pcmLen = 0;
                carryOverlapTrimBytes = 0;
                return new byte[0];
            }
            byte[] snap = Arrays.copyOf(pcmBuf, pcmLen);
            pcmBuf = null; // release back to 0 B immediately after utterance ends
            pcmLen = 0;
            lastPartialLen = 0;
            carryOverlapTrimBytes = 0;
            return snap;
        }

        synchronized byte[] snapshotTailPcm(int maxBytes) {
            if (pcmBuf == null || pcmLen == 0) return new byte[0];
            int take = Math.min(pcmLen, maxBytes) & ~1;
            if (take <= 0) return new byte[0];
            return Arrays.copyOfRange(pcmBuf, pcmLen - take, pcmLen);
        }

        synchronized byte[] snapshotForPartialIfDue(int turnSeq) {
            if (currentTurnSeq != turnSeq || pcmBuf == null || pcmLen - lastPartialLen < 24_000) return null; // >= 0.75s new speech
            if (!partialBusy.compareAndSet(false, true)) return null;
            lastPartialLen = pcmLen;
            return Arrays.copyOf(pcmBuf, pcmLen);
        }

        synchronized CompletableFuture<Transcript> registerInFlightPartial(int turnSeq, int snapLen) {
            CompletableFuture<Transcript> f = new CompletableFuture<>();
            inFlightPartialTurnSeq = turnSeq;
            inFlightPartialPcmLen = snapLen;
            inFlightPartialFuture = f;
            return f;
        }

        synchronized void finishInFlightPartial(int turnSeq, int snapLen, Transcript decoded) {
            if (decoded != null && !decoded.isHallucinationRejected() && currentTurnSeq == turnSeq
                    && snapLen >= lastCompletedPartialPcmLen) {
                lastPartialTurnSeq = turnSeq;
                lastCompletedPartialPcmLen = snapLen;
                lastCompletedPartial = decoded;
            }
            if (inFlightPartialFuture != null && inFlightPartialTurnSeq == turnSeq) {
                inFlightPartialFuture.complete(decoded);
                inFlightPartialFuture = null;
                inFlightPartialTurnSeq = -1;
                inFlightPartialPcmLen = 0;
            }
            partialBusy.set(false);
        }

        synchronized void recordPartialForTest(int turnSeq, int snapLen, Transcript decoded) {
            lastPartialTurnSeq = turnSeq;
            lastCompletedPartialPcmLen = snapLen;
            lastCompletedPartial = decoded;
        }

        synchronized CompletableFuture<Transcript> inFlightPartialForCoalesce(int turnSeq, int totalPcmLen) {
            if (inFlightPartialFuture != null && inFlightPartialTurnSeq == turnSeq && totalPcmLen >= inFlightPartialPcmLen) {
                return inFlightPartialFuture;
            }
            return null;
        }

        synchronized int inFlightPartialLengthForTurn(int turnSeq) {
            return inFlightPartialTurnSeq == turnSeq ? inFlightPartialPcmLen : 0;
        }

        synchronized Transcript takePromotablePartialIfTailSilent(int turnSeq, byte[] fullPcm) {
            if (lastCompletedPartial == null || lastPartialTurnSeq != turnSeq || fullPcm == null) {
                return null;
            }
            Transcript cand = lastCompletedPartial;
            int partLen = lastCompletedPartialPcmLen;
            lastCompletedPartial = null;
            lastCompletedPartialPcmLen = 0;
            lastPartialTurnSeq = -1;
            if (partLen < PARTIAL_PROMOTE_MIN_PCM_BYTES || fullPcm.length < partLen) {
                return null;
            }
            int tailBytes = fullPcm.length - partLen;
            if (tailBytes > PARTIAL_PROMOTE_MAX_TAIL_BYTES) {
                return null;
            }
            if (!isSilentPcmBelowMinus42Dbfs(fullPcm, partLen, fullPcm.length)) {
                return null;
            }
            if (cand.isHallucinationRejected() || Boolean.TRUE.equals(cand.reviewNeeded())) {
                return null;
            }
            if (cand.avgLogprob() == null || cand.avgLogprob() < PARTIAL_PROMOTE_MIN_AVG_LOGPROB) {
                return null;
            }
            if (cand.noSpeechProb() == null || cand.noSpeechProb() > PARTIAL_PROMOTE_MAX_NO_SPEECH_PROB) {
                return null;
            }
            String txt = cand.text() != null ? cand.text().trim() : "";
            if (txt.isEmpty() && cand.stableText() != null) {
                txt = cand.stableText().trim();
            }
            return txt.isEmpty() ? null : cand;
        }

        synchronized boolean shouldIgnoreDuplicateCommit(int turnSeq, boolean hasExplicitText, boolean skipFastPath) {
            if (hasExplicitText || skipFastPath || turnSeq < 0) return false;
            if (turnSeq == lastCommittedTurnSeq && activeResponseSeq == turnSeq && !activeCancelled.get()) {
                pcmBuf = null;
                pcmLen = 0;
                lastPartialLen = 0;
                return true;
            }
            return false;
        }

        synchronized void releaseEmptyCommit(int turnSeq) {
            if (lastCommittedTurnSeq == turnSeq) {
                lastCommittedTurnSeq = -1;
            }
        }

        synchronized AtomicBoolean beginResponse(int turnSeq) {
            activeCancelled.set(true);
            activeResponseSeq = turnSeq;
            lastCommittedTurnSeq = turnSeq;
            activeCancelled = new AtomicBoolean(false);
            paused.set(false);
            activeCancelHandle = () -> activeCancelled.set(true);
            return activeCancelled;
        }

        synchronized void attachCancelHandle(int turnSeq, Runnable handle) {
            if (activeResponseSeq == turnSeq && !activeCancelled.get()) {
                activeCancelHandle = handle;
            } else {
                try {
                    handle.run();
                } catch (RuntimeException ignored) { }
            }
        }

        synchronized void cancelActiveTurn() {
            activeCancelled.set(true);
            cancelPartialFuturesLocked();
            pendingActionAcks.values().forEach(f -> f.cancel(true));
            pendingActionAcks.clear();
            Runnable h = activeCancelHandle;
            activeCancelHandle = () -> {};
            try { h.run(); } catch (RuntimeException ignored) { }
        }

        CompletableFuture<JsonNode> registerPendingActionAck(int turnSeq) {
            CompletableFuture<JsonNode> f = new CompletableFuture<>();
            pendingActionAcks.put(turnSeq, f);
            return f;
        }

        void completeActionAck(int turnSeq, JsonNode ack) {
            CompletableFuture<JsonNode> f = pendingActionAcks.remove(turnSeq);
            if (f != null) {
                f.complete(ack);
            }
        }

        void clearPendingActionAck(int turnSeq) {
            pendingActionAcks.remove(turnSeq);
        }

        synchronized void replaceHistory(List<AiChatMessageDto> msgs) {
            history.clear();
            history.addAll(msgs);
            lastHistoryTurnSeq = -1;
        }

        synchronized List<AiChatMessageDto> buildMessagesForTurn(String userText) {
            List<AiChatMessageDto> out = new ArrayList<>(history);
            out.add(new AiChatMessageDto("user", userText));
            return out;
        }

        synchronized void recordTurnUserText(int turnSeq, String userText) {
            lastTurnSeqUser = turnSeq;
            lastTurnUserText = userText == null ? "" : userText;
        }

        synchronized String userTextForTurn(int turnSeq) {
            return lastTurnSeqUser == turnSeq ? lastTurnUserText : null;
        }

        synchronized boolean wasTurnPersisted(int turnSeq) {
            return lastPersistedTurnSeq == turnSeq;
        }

        synchronized boolean claimDbPersist(int turnSeq) {
            if (lastPersistedTurnSeq == turnSeq) return false;
            lastPersistedTurnSeq = turnSeq;
            return true;
        }

        synchronized void recordGeneratedAssistantText(int turnSeq, String partialText) {
            lastAssistantTurnSeq = turnSeq;
            lastAssistantText = partialText == null ? "" : partialText;
        }

        synchronized void recordGeneratedSamples(int turnSeq, long samples) {
            if (lastAssistantTurnSeq == turnSeq) {
                lastAssistantSamples = samples;
            }
        }

        synchronized void commitTurnHistory(int turnSeq, String userText, String assistantText) {
            if (lastHistoryTurnSeq == turnSeq) {
                if (assistantText != null && !assistantText.isBlank()) {
                    for (int i = history.size() - 1; i >= 0; i--) {
                        if ("assistant".equalsIgnoreCase(history.get(i).role())) {
                            String cur = history.get(i).content();
                            if (cur == null || assistantText.length() < cur.length()) {
                                history.set(i, new AiChatMessageDto("assistant", assistantText));
                            }
                            break;
                        }
                    }
                }
                return;
            }
            history.add(new AiChatMessageDto("user", userText));
            if (assistantText != null && !assistantText.isBlank()) {
                history.add(new AiChatMessageDto("assistant", assistantText));
                lastAssistantTurnSeq = turnSeq;
                lastAssistantText = assistantText;
                lastHistoryTurnSeq = turnSeq;
            }
            while (history.size() > 14) {
                history.remove(0);
            }
        }

        synchronized String truncateInMemoryHistory(int turnSeq, String explicitSpokenText, long playedMs) {
            String full = (lastAssistantTurnSeq == turnSeq && lastAssistantText != null) ? lastAssistantText.trim() : "";
            String resolved = null;
            if (explicitSpokenText != null) {
                // Client explicitly provided spokenText (including "" when 0 words played at WebAudio clock):
                // never fabricate unheard words via playedMs / totalDurationMs ratio!
                resolved = explicitSpokenText.trim();
                if (!resolved.isEmpty() && !full.isEmpty() && resolved.length() > full.length()) {
                    resolved = full;
                }
                if (resolved.isEmpty() && lastHistoryTurnSeq == turnSeq) {
                    if (!history.isEmpty() && "assistant".equalsIgnoreCase(history.get(history.size() - 1).role())) {
                        history.remove(history.size() - 1);
                        if (!history.isEmpty() && "user".equalsIgnoreCase(history.get(history.size() - 1).role())) {
                            history.remove(history.size() - 1);
                        }
                    }
                    lastHistoryTurnSeq = -1;
                    lastAssistantText = "";
                }
            } else if (playedMs >= 0 && !full.isEmpty()) {
                double totalDurationMs = lastAssistantSamples > 0
                        ? (lastAssistantSamples * 1000.0) / 24000.0
                        : Math.max(600.0, (full.length() / 14.5) * 1000.0);
                double ratio = Math.max(0.0, Math.min(1.0, playedMs / totalDurationMs));
                int cutChars = (int) Math.round(full.length() * ratio);
                while (cutChars < full.length() && !Character.isWhitespace(full.charAt(cutChars))) cutChars++;
                resolved = full.substring(0, Math.min(full.length(), Math.max(0, cutChars))).trim();
            }
            if (resolved != null && !resolved.isEmpty()) {
                lastAssistantTurnSeq = turnSeq;
                lastAssistantText = resolved;
                if (lastHistoryTurnSeq == turnSeq) {
                    // Turn N was already appended to history by onComplete -> update Turn N's assistant entry in place
                    for (int i = history.size() - 1; i >= 0; i--) {
                        if ("assistant".equalsIgnoreCase(history.get(i).role())) {
                            String cur = history.get(i).content();
                            if (cur == null || resolved.length() <= cur.length()) {
                                history.set(i, new AiChatMessageDto("assistant", resolved));
                            }
                            break;
                        }
                    }
                } else if (lastTurnSeqUser == turnSeq && lastTurnUserText != null && !lastTurnUserText.isBlank()) {
                    // Turn N was cancelled mid-stream before onComplete appended it -> append (Turn N user, Turn N heard reply)
                    // without ever overwriting Turn N-1's assistant message!
                    history.add(new AiChatMessageDto("user", lastTurnUserText));
                    history.add(new AiChatMessageDto("assistant", resolved));
                    lastHistoryTurnSeq = turnSeq;
                    while (history.size() > 14) {
                        history.remove(0);
                    }
                }
            }
            return resolved;
        }
    }
}
