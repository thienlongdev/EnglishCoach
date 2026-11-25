package com.englishcoach.ai.voice;

import com.englishcoach.ai.controller.EchoTranscriptionController.Transcript;
import com.englishcoach.ai.dto.AiChatResponse;
import com.englishcoach.ai.echo.EchoConfirmations;
import com.englishcoach.ai.echo.EchoLearnerBrain;
import com.englishcoach.ai.service.AiChatService;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.AuthSessionService;
import com.englishcoach.common.security.AuthSessionContext;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.echocoach.service.EchoCoachService;
import com.englishcoach.speaking.service.SpeakingTtsService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpEntity;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Verifies EchoVoiceWebSocketHandler recovery guarantees:
 * - Duplicate Smart Turn autoCommit + trailing input.commit idempotence (never self-cancels in-flight turn);
 * - Structured localized error codes (never raw "failed" or stack traces/provider internals);
 * - Markdown/divider sanitization before TTS synthesis;
 * - Clean session state recovery so subsequent turns on the same socket succeed without poisoning.
 */
class EchoVoiceRecoveryWebSocketTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void duplicateCommitIsIgnoredErrorIsStructuredAndFollowUpTurnSucceedsUnpoisoned() throws Exception {
        AiChatService chat = mock(AiChatService.class);
        EchoLearnerBrain brain = mock(EchoLearnerBrain.class);
        EchoCoachService coach = mock(EchoCoachService.class);
        SpeakingTtsService tts = mock(SpeakingTtsService.class);
        RestTemplate asr = mock(RestTemplate.class);
        RestTemplate turnCheck = mock(RestTemplate.class);
        AuthSessionService sessions = mock(AuthSessionService.class);
        UserRepository users = mock(UserRepository.class);

        UUID sid = UUID.randomUUID();
        when(sessions.validateAndTouchActiveSession(sid, 88L)).thenReturn(true);
        User activeUser = new User();
        activeUser.setId(88L);
        activeUser.setAccountStatus("ACTIVE");
        when(users.findById(88L)).thenReturn(Optional.of(activeUser));

        when(asr.postForObject(anyString(), any(HttpEntity.class), eq(Transcript.class), anyString(), eq("final")))
                .thenReturn(new Transcript("Explain conditional sentences", false, "en"))
                .thenReturn(new Transcript("Give me a quick study tip", false, "en"));

        when(turnCheck.postForObject(anyString(), any(HttpEntity.class), eq(Map.class), anyBoolean()))
                .thenReturn(Map.of("complete", true, "probability", 0.91, "recommendedWaitMs", 0));

        List<String> synthesizedTexts = new CopyOnWriteArrayList<>();
        doAnswer(inv -> {
            String spoken = inv.getArgument(2);
            synthesizedTexts.add(spoken);
            @SuppressWarnings("unchecked")
            Consumer<byte[]> onChunk = inv.getArgument(3);
            byte[] pcm = new byte[1920];
            onChunk.accept(pcm);
            return null;
        }).when(tts).streamEchoSentence(eq(88L), anyString(), anyString(), any());
        doAnswer(inv -> {
            String spoken = inv.getArgument(2);
            synthesizedTexts.add(spoken);
            @SuppressWarnings("unchecked")
            Consumer<byte[]> onChunk = inv.getArgument(3);
            byte[] pcm = new byte[1920];
            onChunk.accept(pcm);
            return null;
        }).when(tts).streamEchoSentence(eq(88L), anyString(), anyString(), any(), anyBoolean());

        CountDownLatch turn1ErrorLatch = new CountDownLatch(1);
        CountDownLatch turn1InFlight = new CountDownLatch(1);
        CountDownLatch releaseTurn1 = new CountDownLatch(1);
        CountDownLatch turn2DoneLatch = new CountDownLatch(1);
        AtomicBoolean turn1Cancelled = new AtomicBoolean(false);
        AtomicInteger turnCounter = new AtomicInteger(0);

        when(chat.streamVoiceTurn(eq(88L), any(), any())).thenAnswer(inv -> {
            AiChatService.VoiceStreamCallbacks cb = inv.getArgument(2);
            int n = turnCounter.incrementAndGet();
            if (n == 1) {
                CompletableFuture.runAsync(() -> {
                    turn1InFlight.countDown();
                    try { releaseTurn1.await(3, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
                    cb.onError(503, "service_busy", null, null);
                });
                return (Runnable) () -> turn1Cancelled.set(true);
            }
            CompletableFuture.runAsync(() -> {
                String mdReply = "### Quick Tip\n---\n**Read aloud** from [Reading](/reading) for 10 minutes every day.";
                cb.onDelta(mdReply);
                cb.onComplete(new AiChatResponse(mdReply, "openai/gpt-6-luna", "FAST", List.of(), List.of()));
            });
            return (Runnable) () -> {};
        });

        EchoVoiceWebSocketHandler handler = new EchoVoiceWebSocketHandler(
                chat, brain, coach, mock(EchoConfirmations.class), tts, mapper, asr, turnCheck, sessions, users);

        Map<String, Object> attrs = new HashMap<>();
        attrs.put(EchoVoiceWebSocketHandler.ATTR_USER_ID, 88L);
        UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(
                new UserDetailsImpl(88L, "u88@example.com", "pw", List.of()), null, List.of());
        auth.setDetails(new AuthSessionContext(sid, 88L, "CREDENTIALS", Instant.now(), null, null, null));
        attrs.put(EchoVoiceWebSocketHandler.ATTR_AUTHENTICATION, auth);

        List<WebSocketMessage<?>> outbound = new CopyOnWriteArrayList<>() {
            @Override
            public boolean add(WebSocketMessage<?> e) {
                boolean r = super.add(e);
                if (e instanceof TextMessage tm) {
                    String p = tm.getPayload();
                    if (p.contains("\"type\":\"error\"")) turn1ErrorLatch.countDown();
                    if (p.contains("\"response.done\"")) turn2DoneLatch.countDown();
                }
                return r;
            }
        };
        WebSocketSession ws = mock(WebSocketSession.class);
        when(ws.getId()).thenReturn("ws-recovery-88");
        when(ws.getAttributes()).thenReturn(attrs);
        when(ws.isOpen()).thenReturn(true);
        doAnswer(inv -> { outbound.add(inv.getArgument(0)); return null; }).when(ws).sendMessage(any(WebSocketMessage.class));

        try {
            handler.afterConnectionEstablished(ws);
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"session.start\",\"sessionId\":101,\"voiceId\":\"us_female\",\"lang\":\"en\"}"));
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"input.speech_started\",\"turnSeq\":1}"));

            byte[] pcmFrame = new byte[7 + 6400];
            pcmFrame[0] = 0x01; pcmFrame[1] = 0x00; pcmFrame[2] = 0x01;
            handler.handleBinaryMessage(ws, new BinaryMessage(pcmFrame));

            // 1. Smart Turn autoCommit=true commits turnSeq=1
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"input.turn_check\",\"turnSeq\":1,\"autoCommit\":true}"));
            assertThat(turn1InFlight.await(3, TimeUnit.SECONDS)).isTrue();

            // 2. Client speech-end sends trailing input.commit for the SAME turnSeq=1 -> MUST be ignored without self-cancelling!
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"input.commit\",\"turnSeq\":1}"));
            assertThat(turn1Cancelled.get()).isFalse();

            // Allow Turn 1 to finish with structured error
            releaseTurn1.countDown();
            assertThat(turn1ErrorLatch.await(3, TimeUnit.SECONDS)).isTrue();

            String errFrame = outbound.stream()
                    .filter(TextMessage.class::isInstance)
                    .map(m -> ((TextMessage) m).getPayload())
                    .filter(p -> p.contains("\"type\":\"error\""))
                    .findFirst().orElseThrow();
            JsonNode errJson = mapper.readTree(errFrame);
            assertThat(errJson.path("code").asText()).isEqualTo("service_busy").isNotEqualTo("failed");
            assertThat(errJson.path("message").asText()).isNotBlank().doesNotContain("Exception").doesNotContain("openrouter");

            // 3. Turn 2 on the SAME WebSocket session succeeds cleanly (session is NOT poisoned)
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"input.speech_started\",\"turnSeq\":2}"));
            byte[] pcmFrame2 = new byte[7 + 6400];
            pcmFrame2[0] = 0x01; pcmFrame2[1] = 0x00; pcmFrame2[2] = 0x02;
            handler.handleBinaryMessage(ws, new BinaryMessage(pcmFrame2));
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"input.commit\",\"turnSeq\":2}"));

            assertThat(turn2DoneLatch.await(5, TimeUnit.SECONDS)).isTrue();
            verify(chat, times(2)).streamVoiceTurn(eq(88L), any(), any());
            assertThat(synthesizedTexts).isNotEmpty();
            String combinedSpoken = String.join(" ", synthesizedTexts);
            assertThat(combinedSpoken).doesNotContain("###").doesNotContain("---").doesNotContain("(/reading)").contains("Read aloud");
        } finally {
            handler.afterConnectionClosed(ws, CloseStatus.NORMAL);
            handler.shutdown();
        }
    }

    @Test
    void ambientTruncateWithNullSessionIdStaysOpenAndMidStreamBargeInNeverOverwritesPriorTurnHistory() throws Exception {
        AiChatService chat = mock(AiChatService.class);
        EchoLearnerBrain brain = mock(EchoLearnerBrain.class);
        EchoCoachService coach = mock(EchoCoachService.class);
        SpeakingTtsService tts = mock(SpeakingTtsService.class);
        RestTemplate asr = mock(RestTemplate.class);
        RestTemplate turnCheck = mock(RestTemplate.class);
        AuthSessionService sessions = mock(AuthSessionService.class);
        UserRepository users = mock(UserRepository.class);

        UUID sid = UUID.randomUUID();
        when(sessions.validateAndTouchActiveSession(sid, 91L)).thenReturn(true);
        User activeUser = new User();
        activeUser.setId(91L);
        activeUser.setAccountStatus("ACTIVE");
        when(users.findById(91L)).thenReturn(Optional.of(activeUser));

        doAnswer(inv -> {
            @SuppressWarnings("unchecked")
            Consumer<byte[]> onChunk = inv.getArgument(3);
            onChunk.accept(new byte[1920]);
            return null;
        }).when(tts).streamEchoSentence(eq(91L), anyString(), anyString(), any());

        CountDownLatch turn1Done = new CountDownLatch(1);
        CountDownLatch turn2DeltaSent = new CountDownLatch(1);
        CountDownLatch holdTurn2 = new CountDownLatch(1);
        CountDownLatch turn3Done = new CountDownLatch(1);
        List<com.englishcoach.ai.dto.AiChatRequest> capturedRequests = new CopyOnWriteArrayList<>();
        AtomicInteger callNo = new AtomicInteger(0);

        String turn1FullReply = "Skimming is reading fast to catch the overall main idea of a passage.";
        String turn2FullStreamed = "Scanning means looking quickly through a text to locate specific numbers or names.";

        when(chat.streamVoiceTurn(eq(91L), any(), any())).thenAnswer(inv -> {
            com.englishcoach.ai.dto.AiChatRequest req = inv.getArgument(1);
            AiChatService.VoiceStreamCallbacks cb = inv.getArgument(2);
            capturedRequests.add(req);
            int n = callNo.incrementAndGet();
            if (n == 1) {
                CompletableFuture.runAsync(() -> {
                    cb.onDelta(turn1FullReply);
                    cb.onComplete(new AiChatResponse(turn1FullReply, "echo-local-instruct", "FAST", List.of(), List.of()));
                });
                return (Runnable) () -> {};
            }
            if (n == 2) {
                CompletableFuture.runAsync(() -> {
                    cb.onDelta(turn2FullStreamed);
                    turn2DeltaSent.countDown();
                    try { holdTurn2.await(3, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
                    // Simulate cancelled mid-stream turn: onComplete arrives after cancel and exits early in handler!
                    cb.onComplete(new AiChatResponse(turn2FullStreamed, "echo-local-instruct", "FAST", List.of(), List.of()));
                });
                return (Runnable) holdTurn2::countDown;
            }
            CompletableFuture.runAsync(() -> {
                cb.onDelta("For example, scan a timetable for a train departure time.");
                cb.onComplete(new AiChatResponse("For example, scan a timetable for a train departure time.",
                        "echo-local-instruct", "FAST", List.of(), List.of()));
            });
            return (Runnable) () -> {};
        });

        EchoVoiceWebSocketHandler handler = new EchoVoiceWebSocketHandler(
                chat, brain, coach, mock(EchoConfirmations.class), tts, mapper, asr, turnCheck, sessions, users);

        Map<String, Object> attrs = new HashMap<>();
        attrs.put(EchoVoiceWebSocketHandler.ATTR_USER_ID, 91L);
        UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(
                new UserDetailsImpl(91L, "u91@example.com", "pw", List.of()), null, List.of());
        auth.setDetails(new AuthSessionContext(sid, 91L, "CREDENTIALS", Instant.now(), null, null, null));
        attrs.put(EchoVoiceWebSocketHandler.ATTR_AUTHENTICATION, auth);

        AtomicInteger truncatedCount = new AtomicInteger(0);
        CountDownLatch truncated1Latch = new CountDownLatch(1);
        CountDownLatch truncated2Latch = new CountDownLatch(1);
        List<String> outboundText = new CopyOnWriteArrayList<>();

        AtomicBoolean open = new AtomicBoolean(true);
        CloseStatus[] closedWith = {null};
        WebSocketSession ws = mock(WebSocketSession.class);
        when(ws.getId()).thenReturn("ws-ambient-91");
        when(ws.getAttributes()).thenReturn(attrs);
        when(ws.isOpen()).thenAnswer(i -> open.get());
        doAnswer(inv -> {
            WebSocketMessage<?> m = inv.getArgument(0);
            if (m instanceof TextMessage tm) {
                String p = tm.getPayload();
                outboundText.add(p);
                if (p.contains("\"response.done\"") && p.contains("\"turnSeq\":1")) turn1Done.countDown();
                if (p.contains("\"response.done\"") && p.contains("\"turnSeq\":3")) turn3Done.countDown();
                if (p.contains("\"conversation.item.truncated\"")) {
                    int c = truncatedCount.incrementAndGet();
                    if (c == 1) truncated1Latch.countDown();
                    if (c == 2) truncated2Latch.countDown();
                }
            }
            return null;
        }).when(ws).sendMessage(any(WebSocketMessage.class));
        doAnswer(inv -> {
            open.set(false);
            closedWith[0] = inv.getArgument(0);
            return null;
        }).when(ws).close(any(CloseStatus.class));

        try {
            handler.afterConnectionEstablished(ws);
            // Ambient session.start WITHOUT sessionId -> state.echoSessionId remains null!
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"session.start\",\"voiceId\":\"us_female\",\"lang\":\"en\"}"));

            // BE-1 check #1: Ambient truncate before any sessionId exists (absent & explicit null sessionId) -> ZERO NPE, socket stays open!
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"conversation.item.truncate\",\"turnSeq\":0,\"spokenText\":\"Hi there\"}"));
            assertThat(truncated1Latch.await(2, TimeUnit.SECONDS)).isTrue();
            assertThat(ws.isOpen()).isTrue();
            assertThat(closedWith[0]).isNull();

            // Turn 1 completes normally
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"input.commit\",\"turnSeq\":1,\"text\":\"What is skimming?\"}"));
            assertThat(turn1Done.await(3, TimeUnit.SECONDS)).isTrue();

            // Turn 2 starts streaming, then learner barges in mid-stream before onComplete commits Turn 2!
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"input.commit\",\"turnSeq\":2,\"text\":\"And what is scanning?\"}"));
            assertThat(turn2DeltaSent.await(3, TimeUnit.SECONDS)).isTrue();

            // Mid-stream barge-in cancel + ambient truncate (no sessionId in payload, state.echoSessionId == null!)
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"response.cancel\",\"turnSeq\":2}"));
            handler.handleTextMessage(ws, new TextMessage(
                    "{\"type\":\"conversation.item.truncate\",\"sessionId\":null,\"turnSeq\":2,\"spokenText\":\"Scanning means looking quickly\",\"playedMs\":900}"));
            assertThat(truncated2Latch.await(3, TimeUnit.SECONDS)).isTrue();
            assertThat(ws.isOpen()).isTrue();
            assertThat(closedWith[0]).isNull();

            // Turn 3 commits -> verify history contains intact Turn 1 + truncated Turn 2 + Turn 3 user!
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"input.commit\",\"turnSeq\":3,\"text\":\"Give me one example.\"}"));
            assertThat(turn3Done.await(3, TimeUnit.SECONDS)).isTrue();

            assertThat(capturedRequests).hasSize(3);
            var turn3Msgs = capturedRequests.get(2).messages();
            assertThat(turn3Msgs).hasSize(5);
            assertThat(turn3Msgs.get(0).role()).isEqualTo("user");
            assertThat(turn3Msgs.get(0).content()).isEqualTo("What is skimming?");
            assertThat(turn3Msgs.get(1).role()).isEqualTo("assistant");
            assertThat(turn3Msgs.get(1).content()).isEqualTo(turn1FullReply); // Turn 1 NOT overwritten!
            assertThat(turn3Msgs.get(2).role()).isEqualTo("user");
            assertThat(turn3Msgs.get(2).content()).isEqualTo("And what is scanning?");
            assertThat(turn3Msgs.get(3).role()).isEqualTo("assistant");
            assertThat(turn3Msgs.get(3).content()).isEqualTo("Scanning means looking quickly"); // Turn 2 heard-only!
            assertThat(turn3Msgs.get(4).role()).isEqualTo("user");
            assertThat(turn3Msgs.get(4).content()).isEqualTo("Give me one example.");
        } finally {
            handler.afterConnectionClosed(ws, CloseStatus.NORMAL);
            handler.shutdown();
        }
    }
}
