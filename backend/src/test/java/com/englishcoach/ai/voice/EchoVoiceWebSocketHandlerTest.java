package com.englishcoach.ai.voice;

import com.englishcoach.ai.controller.EchoTranscriptionController.Transcript;
import com.englishcoach.ai.dto.AiChatResponse;
import com.englishcoach.ai.dto.EchoAction;
import com.englishcoach.ai.echo.EchoConfirmations;
import com.englishcoach.ai.echo.EchoLearnerBrain;
import com.englishcoach.ai.service.AiChatService;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.AuthSessionService;
import com.englishcoach.common.security.AuthSecurityProperties;
import com.englishcoach.common.security.AuthSessionContext;
import com.englishcoach.common.security.CustomJwtAuthenticationConverter;
import com.englishcoach.common.security.SessionCookies;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.echocoach.service.EchoCoachService;
import com.englishcoach.speaking.service.SpeakingTtsService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.http.server.ServletServerHttpResponse;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.socket.*;

import java.nio.ByteBuffer;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class EchoVoiceWebSocketHandlerTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private static UsernamePasswordAuthenticationToken authFor(long userId, UUID sessionId, String authMethod) {
        UserDetailsImpl principal = new UserDetailsImpl(userId, "u" + userId + "@example.com", "pw", List.of());
        UsernamePasswordAuthenticationToken token = new UsernamePasswordAuthenticationToken(principal, null, List.of());
        token.setDetails(new AuthSessionContext(sessionId, userId, authMethod, Instant.now(), null, null, null));
        return token;
    }

    private static WebSocketSession mockSocket(String id, Map<String, Object> attrs, List<WebSocketMessage<?>> sent, CloseStatus[] closedWith) throws Exception {
        WebSocketSession ws = mock(WebSocketSession.class);
        AtomicBoolean open = new AtomicBoolean(true);
        when(ws.getId()).thenReturn(id);
        when(ws.getAttributes()).thenReturn(attrs);
        when(ws.isOpen()).thenAnswer(inv -> open.get());
        doAnswer(inv -> {
            sent.add(inv.getArgument(0));
            return null;
        }).when(ws).sendMessage(any(WebSocketMessage.class));
        doAnswer(inv -> {
            open.set(false);
            closedWith[0] = inv.getArgument(0);
            return null;
        }).when(ws).close(any(CloseStatus.class));
        return ws;
    }

    @Test
    void handshakeEnforcesCookieJwtOriginAndRefusesEchoAnywhereAndExcessSockets() throws Exception {
        JwtDecoder decoder = mock(JwtDecoder.class);
        CustomJwtAuthenticationConverter converter = mock(CustomJwtAuthenticationConverter.class);
        EchoVoiceWebSocketHandler handler = mock(EchoVoiceWebSocketHandler.class);

        AuthSecurityProperties secProps = mock(AuthSecurityProperties.class);
        when(secProps.isProduction()).thenReturn(false);
        StaticListableBeanFactory bf = new StaticListableBeanFactory();
        bf.addBean("secProps", secProps);

        EchoVoiceWebSocketConfig config = new EchoVoiceWebSocketConfig(
                handler, decoder, converter, bf.getBeanProvider(AuthSecurityProperties.class));
        var interceptor = config.handshakeInterceptor(Set.of("https://englishcoach.io.vn", "http://localhost:3000"));

        // 1. Anonymous (no cookie) -> 401
        MockHttpServletRequest anonReq = new MockHttpServletRequest();
        anonReq.addHeader("Origin", "https://englishcoach.io.vn");
        MockHttpServletResponse anonRes = new MockHttpServletResponse();
        assertThat(interceptor.beforeHandshake(new ServletServerHttpRequest(anonReq), new ServletServerHttpResponse(anonRes), handler, new HashMap<>()))
                .isFalse();
        assertThat(anonRes.getStatus()).isEqualTo(HttpStatus.UNAUTHORIZED.value());

        // 2. Disallowed Origin -> 403
        MockHttpServletRequest evilOrigin = new MockHttpServletRequest();
        evilOrigin.addHeader("Origin", "https://evil.attacker.example");
        evilOrigin.setCookies(new Cookie(SessionCookies.ACCESS_DEV, "valid-jwt"));
        MockHttpServletResponse evilRes = new MockHttpServletResponse();
        assertThat(interceptor.beforeHandshake(new ServletServerHttpRequest(evilOrigin), new ServletServerHttpResponse(evilRes), handler, new HashMap<>()))
                .isFalse();
        assertThat(evilRes.getStatus()).isEqualTo(HttpStatus.FORBIDDEN.value());

        // 3. ECHO_ANYWHERE token -> 401 refused
        Jwt extJwt = Jwt.withTokenValue("ext-jwt").header("alg", "HS256").claim("userId", 42L).claim("authMethod", "ECHO_ANYWHERE").build();
        when(decoder.decode("ext-jwt")).thenReturn(extJwt);
        MockHttpServletRequest extReq = new MockHttpServletRequest();
        extReq.addHeader("Origin", "https://englishcoach.io.vn");
        extReq.setCookies(new Cookie(SessionCookies.ACCESS_DEV, "ext-jwt"));
        MockHttpServletResponse extRes = new MockHttpServletResponse();
        assertThat(interceptor.beforeHandshake(new ServletServerHttpRequest(extReq), new ServletServerHttpResponse(extRes), handler, new HashMap<>()))
                .isFalse();
        assertThat(extRes.getStatus()).isEqualTo(HttpStatus.UNAUTHORIZED.value());

        // 4. Valid CREDENTIALS cookie -> accepted & populates principal
        UUID sid = UUID.randomUUID();
        Jwt goodJwt = Jwt.withTokenValue("good-jwt").header("alg", "HS256").claim("userId", 42L).claim("authMethod", "CREDENTIALS").build();
        when(decoder.decode("good-jwt")).thenReturn(goodJwt);
        when(converter.convert(goodJwt)).thenReturn(authFor(42L, sid, "CREDENTIALS"));

        MockHttpServletRequest okReq = new MockHttpServletRequest();
        okReq.addHeader("Origin", "https://englishcoach.io.vn");
        okReq.setCookies(new Cookie(SessionCookies.ACCESS_DEV, "good-jwt"));
        Map<String, Object> attrs = new HashMap<>();
        assertThat(interceptor.beforeHandshake(new ServletServerHttpRequest(okReq), new ServletServerHttpResponse(new MockHttpServletResponse()), handler, attrs))
                .isTrue();
        assertThat(attrs.get(EchoVoiceWebSocketHandler.ATTR_USER_ID)).isEqualTo(42L);

        // 5. Max 2 concurrent voice sockets per userId; 3rd closes with 1008
        EchoVoiceWebSocketHandler realHandler = new EchoVoiceWebSocketHandler(
                mock(AiChatService.class), mock(EchoLearnerBrain.class), mock(EchoCoachService.class),
                mock(EchoConfirmations.class), mock(SpeakingTtsService.class), mapper,
                mock(RestTemplate.class), mock(RestTemplate.class), null, null);

        CloseStatus[] c1 = {null}, c2 = {null}, c3 = {null};
        WebSocketSession s1 = mockSocket("s1", new HashMap<>(attrs), new CopyOnWriteArrayList<>(), c1);
        WebSocketSession s2 = mockSocket("s2", new HashMap<>(attrs), new CopyOnWriteArrayList<>(), c2);
        WebSocketSession s3 = mockSocket("s3", new HashMap<>(attrs), new CopyOnWriteArrayList<>(), c3);

        realHandler.afterConnectionEstablished(s1);
        realHandler.afterConnectionEstablished(s2);
        realHandler.afterConnectionEstablished(s3);

        assertThat(c1[0]).isNull();
        assertThat(c2[0]).isNull();
        assertThat(c3[0]).isNotNull();
        assertThat(c3[0].getCode()).isEqualTo(1008);

        realHandler.afterConnectionClosed(s1, CloseStatus.NORMAL);
        realHandler.afterConnectionClosed(s2, CloseStatus.NORMAL);
        realHandler.shutdown();
    }

    @Test
    void fullDuplexBinaryUplinkStreamsLlmActionsAndTtsFramesAndSupportsCancelAndTruncate() throws Exception {
        AiChatService chat = mock(AiChatService.class);
        EchoLearnerBrain brain = mock(EchoLearnerBrain.class);
        EchoCoachService coach = mock(EchoCoachService.class);
        SpeakingTtsService tts = mock(SpeakingTtsService.class);
        RestTemplate asr = mock(RestTemplate.class);
        RestTemplate turnCheck = mock(RestTemplate.class);
        AuthSessionService sessions = mock(AuthSessionService.class);
        UserRepository users = mock(UserRepository.class);

        UUID authSid = UUID.randomUUID();
        when(sessions.validateAndTouchActiveSession(authSid, 42L)).thenReturn(true);
        User activeUser = new User();
        activeUser.setId(42L);
        activeUser.setAccountStatus("ACTIVE");
        when(users.findById(42L)).thenReturn(Optional.of(activeUser));

        when(asr.postForObject(anyString(), any(HttpEntity.class), eq(Transcript.class), anyString(), eq("final")))
                .thenReturn(new Transcript("Open Reading and explain skimming", false, "en"));

        // Mock TTS streaming 3,840 bytes (2 x 1,920B frames)
        doAnswer(inv -> {
            @SuppressWarnings("unchecked")
            Consumer<byte[]> onChunk = inv.getArgument(3);
            byte[] pcm = new byte[3840];
            Arrays.fill(pcm, (byte) 0x2A);
            onChunk.accept(pcm);
            return null;
        }).when(tts).streamEchoSentence(eq(42L), anyString(), anyString(), any());

        CountDownLatch turnDone = new CountDownLatch(1);
        AtomicBoolean cancelInvoked = new AtomicBoolean(false);

        when(chat.streamVoiceTurn(eq(42L), any(), any())).thenAnswer(inv -> {
            AiChatService.VoiceStreamCallbacks cb = inv.getArgument(2);
            CompletableFuture.runAsync(() -> {
                cb.onActions(List.of(EchoAction.navigate("/reading", "Reading", true)));
                cb.onDelta("Opening Reading for you right now. ");
                cb.onDelta("Skimming means reading quickly for the main idea.");
                cb.onComplete(new AiChatResponse(
                        "Opening Reading for you right now. Skimming means reading quickly for the main idea.",
                        "fast-model", "FAST", List.of(), List.of(EchoAction.navigate("/reading", "Reading", true))));
            });
            return (Runnable) () -> cancelInvoked.set(true);
        });

        when(coach.truncateLatestAssistantMessage(42L, 99L, "Opening Reading for you right now.")).thenReturn(true);

        EchoVoiceWebSocketHandler handler = new EchoVoiceWebSocketHandler(
                chat, brain, coach, mock(EchoConfirmations.class), tts, mapper, asr, turnCheck, sessions, users);

        Map<String, Object> attrs = new HashMap<>();
        attrs.put(EchoVoiceWebSocketHandler.ATTR_USER_ID, 42L);
        attrs.put(EchoVoiceWebSocketHandler.ATTR_AUTHENTICATION, authFor(42L, authSid, "CREDENTIALS"));

        List<WebSocketMessage<?>> outbound = new CopyOnWriteArrayList<>() {
            @Override
            public boolean add(WebSocketMessage<?> e) {
                boolean r = super.add(e);
                if (e instanceof TextMessage tm && tm.getPayload().contains("\"response.done\"")) {
                    turnDone.countDown();
                }
                return r;
            }
        };
        CloseStatus[] closed = {null};
        WebSocketSession ws = mockSocket("voice-1", attrs, outbound, closed);

        try {
            handler.afterConnectionEstablished(ws);
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"session.start\",\"sessionId\":99,\"voiceId\":\"uk_male\",\"lang\":\"auto\"}"));
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"input.speech_started\",\"turnSeq\":1}"));
            verify(brain, atLeastOnce()).warm(42L);

            // Send 0x01 + turnSeq=1 + sampleOffset=0 + 3,200B 16kHz PCM16LE
            byte[] uplink = new byte[7 + 3200];
            uplink[0] = 0x01;
            uplink[1] = 0x00;
            uplink[2] = 0x01;
            handler.handleBinaryMessage(ws, new BinaryMessage(uplink));

            // Commit turn 1
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"input.commit\",\"turnSeq\":1}"));
            assertThat(turnDone.await(5, TimeUnit.SECONDS)).isTrue();

            List<String> textPayloads = outbound.stream()
                    .filter(TextMessage.class::isInstance)
                    .map(m -> ((TextMessage) m).getPayload())
                    .toList();
            List<BinaryMessage> audioFrames = outbound.stream()
                    .filter(BinaryMessage.class::isInstance)
                    .map(BinaryMessage.class::cast)
                    .toList();

            assertThat(textPayloads).anyMatch(p -> p.contains("\"asr.final\"") && p.contains("Open Reading"));
            assertThat(textPayloads).anyMatch(p -> p.contains("\"action.dispatch\"") && p.contains("/reading"));
            assertThat(textPayloads).anyMatch(p -> p.contains("\"llm.delta\""));
            assertThat(audioFrames).isNotEmpty();
            for (BinaryMessage bm : audioFrames) {
                ByteBuffer bb = bm.getPayload();
                assertThat(bb.remaining()).isLessThanOrEqualTo(1927);
                assertThat(bb.get(0)).isEqualTo((byte) 0x02);
                int seq = ((bb.get(1) & 0xFF) << 8) | (bb.get(2) & 0xFF);
                assertThat(seq).isEqualTo(1);
            }

            // Barge-in cancel + heard-audio truncate
            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"response.cancel\",\"turnSeq\":1}"));
            assertThat(cancelInvoked.get()).isTrue();

            handler.handleTextMessage(ws, new TextMessage(
                    "{\"type\":\"conversation.item.truncate\",\"sessionId\":99,\"turnSeq\":1,\"spokenText\":\"Opening Reading for you right now.\",\"playedMs\":1200}"));
            verify(coach).truncateLatestAssistantMessage(42L, 99L, "Opening Reading for you right now.");
            assertThat(outbound.stream().filter(TextMessage.class::isInstance).map(m -> ((TextMessage) m).getPayload()))
                    .anyMatch(p -> p.contains("\"conversation.item.truncated\"") && p.contains("Opening Reading for you right now."));

            // Simulate revoked session on 30s recheck -> closes with 1008
            JsonNode dummy = mapper.readTree("{}");
            assertThat(dummy).isNotNull();
            when(sessions.validateAndTouchActiveSession(authSid, 42L)).thenReturn(false);
            // Force recheck window elapsed
            var stateMap = (Map<?, ?>) org.springframework.test.util.ReflectionTestUtils.getField(handler, "sessions");
            Object st = stateMap.get("voice-1");
            org.springframework.test.util.ReflectionTestUtils.setField(st, "lastSessionCheckMs", 0L);

            handler.handleTextMessage(ws, new TextMessage("{\"type\":\"ping\"}"));
            assertThat(closed[0]).isNotNull();
            assertThat(closed[0].getCode()).isEqualTo(1008);
        } finally {
            handler.shutdown();
        }
    }
}
