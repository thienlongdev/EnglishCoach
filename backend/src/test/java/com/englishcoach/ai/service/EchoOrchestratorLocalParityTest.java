package com.englishcoach.ai.service;

import com.englishcoach.ai.dto.AiChatMessageDto;
import com.englishcoach.ai.dto.AiChatRequest;
import com.englishcoach.ai.dto.AiChatResponse;
import com.englishcoach.ai.dto.EchoAction;
import com.englishcoach.ai.dto.EchoSalientResourceDto;
import com.englishcoach.ai.echo.*;
import com.englishcoach.ai.echo.tools.LessonSearchTool;
import com.englishcoach.ai.echo.tools.OpenPageTool;
import com.englishcoach.ai.echo.tools.WorkspaceControlTool;
import com.englishcoach.ai.voice.EchoVoiceWebSocketHandler;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.auth.service.AuthSessionService;
import com.englishcoach.common.security.AuthSessionContext;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.echocoach.dto.CreateSessionRequest;
import com.englishcoach.echocoach.dto.EchoCoachSessionDto;
import com.englishcoach.echocoach.dto.SaveMessagePairRequest;
import com.englishcoach.echocoach.service.EchoCoachService;
import com.englishcoach.grammar.GrammarContent;
import com.englishcoach.listening.dto.ListeningLibraryItemDto;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.listening.service.ListeningService;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.speaking.service.SpeakingTtsService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Workstream B2 verification for:
 * - Multi-round tool parity on Local {@code Qwen3-4B} failover ({@code callLocalLlmProvider}: {@code tools}, {@code tool_choice},
 *   {@code max_tokens} 200/640 vs 140/560 (voice/text), static {@link EchoPolicy#PROFESSOR} prefix + {@code --- DYNAMIC TURN CONTEXT ---},
 *   zero {@code Conversation intent:} injection, and Round 0 -> Round 1 multi-intent execution);
 * - Proportional {@link EchoRouter#fullProfile} loading + {@code COACHING_MODE} ({@code STRICT_CORRECTION} / {@code FREE_CHAT})
 *   detection, session carry-over, and auto-persistence;
 * - WS {@link EchoCoachService} session continuity (lazy creation + Plane-A & Plane-B persistence + {@code sessionId} wire field)
 *   and truthful {@code action.ack} speech handshake with {@code 220 ms} legacy timeout fallback.
 */
class EchoOrchestratorLocalParityTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private static <T> ObjectProvider<T> none(Class<T> type) {
        return new StaticListableBeanFactory().getBeanProvider(type);
    }

    private static <T> ObjectProvider<T> of(Class<T> type, T bean) {
        StaticListableBeanFactory f = new StaticListableBeanFactory();
        f.addBean("bean", bean);
        return f.getBeanProvider(type);
    }

    @Test
    void localQwenFailoverExecutesFullMultiRoundToolsWithStaticPrefixCacheAndAdaptiveMaxTokens() throws Exception {
        ListeningService listeningSvc = mock(ListeningService.class);
        when(listeningSvc.getSharedLibrary()).thenReturn(List.of(
                ListeningLibraryItemDto.builder().id(88L).title("Climate Action Podcast").level("B1").topic("Environment").durationSeconds(180).build()));

        ListeningMaterialRepository listeningRepo = mock(ListeningMaterialRepository.class);
        com.englishcoach.listening.entity.ListeningMaterial lm = new com.englishcoach.listening.entity.ListeningMaterial();
        lm.setTitle("Climate Action Podcast");
        lm.setSourceType("YOUTUBE");
        when(listeningRepo.findByIdAndVisibleToUser(88L, 42L)).thenReturn(Optional.of(lm));

        EchoDestinations dests = new EchoDestinations(
                none(GrammarContent.class), none(ReadingMaterialRepository.class), of(ListeningMaterialRepository.class, listeningRepo));
        EchoToolRegistry registry = new EchoToolRegistry(
                List.of(
                        new OpenPageTool(dests, mapper),
                        new LessonSearchTool(mock(JdbcTemplate.class), of(ListeningService.class, listeningSvc), mapper),
                        new WorkspaceControlTool(mapper)),
                mapper,
                none(PlatformTransactionManager.class));

        List<JsonNode> localPayloads = new CopyOnWriteArrayList<>();
        AtomicInteger localRound = new AtomicInteger(0);

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newCachedThreadPool());
        // OpenRouter primary fails immediately -> triggers local Qwen3-4B failover
        server.createContext("/api/v1/chat/completions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            byte[] err = "{\"error\":{\"message\":\"Request path cannot be relayed\",\"code\":400}}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(400, err.length);
            try (OutputStream os = exchange.getResponseBody()) { os.write(err); }
        });

        // Local Qwen3-4B endpoint (/api/v1/coach/chat/completions):
        // Round 0: streams spoken preamble + parallel tool_calls (search_lessons + open_page)
        // Round 1: receives role="tool" results and synthesizes final spoken answer (until Round 2 if needed)
        server.createContext("/api/v1/coach/chat/completions", exchange -> {
            JsonNode body = mapper.readTree(exchange.getRequestBody().readAllBytes());
            localPayloads.add(body);
            int r = localRound.getAndIncrement();
            String sse;
            if (r == 0) {
                sse = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Shadowing means repeating speech in real time. \"}}]}\n\n"
                        + "data: {\"choices\":[{\"delta\":{\"tool_calls\":["
                        + "{\"index\":0,\"id\":\"c_search\",\"type\":\"function\",\"function\":{\"name\":\"search_lessons\",\"arguments\":\"{\\\"module\\\":\\\"listening\\\",\\\"level\\\":\\\"B1\\\"}\"}},"
                        + "{\"index\":1,\"id\":\"c_open\",\"type\":\"function\",\"function\":{\"name\":\"open_page\",\"arguments\":\"{\\\"destination\\\":\\\"listening_lesson\\\",\\\"lesson_id\\\":88}\"}}"
                        + "]}}]}\n\n"
                        + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n"
                        + "data: [DONE]\n\n";
            } else {
                sse = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"I opened Climate Action Podcast for you.\"}}]}\n\n"
                        + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                        + "data: [DONE]\n\n";
            }
            byte[] out = sse.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
            exchange.sendResponseHeaders(200, out.length);
            try (OutputStream os = exchange.getResponseBody()) { os.write(out); }
        });
        server.start();

        String orBase = "http://127.0.0.1:" + server.getAddress().getPort() + "/api/v1";
        String localRoot = "http://127.0.0.1:" + server.getAddress().getPort();
        OpenRouterChatServiceImpl service = new OpenRouterChatServiceImpl(
                new RestTemplate(), "sk-test", orBase, "openai/gpt-6-luna", null, mapper);
        EchoModels models = new EchoModels("m-fast", "m-fast-fb", "m-strong", "m-strong-fb", 2);
        EchoUsageLedger ledger = mock(EchoUsageLedger.class);
        EchoLearnerBrain brain = mock(EchoLearnerBrain.class);
        when(brain.snapshot(eq(42L), anyBoolean(), anyBoolean()))
                .thenReturn(new EchoLearnerBrain.Snapshot("{\"verifiedProficiency\":{\"overall\":{\"currentCefr\":\"B1\"}}}", "B1", "VERIFIED"));
        EchoMemoryService memorySvc = mock(EchoMemoryService.class);

        service.useIntelligence(models, registry, brain, ledger, dests);
        service.useMemoryService(memorySvc);
        service.useLocalLlmFallback(localRoot, "svc-key", "qwen3-4b-instruct", 30_000L);

        try {
            CompletableFuture<AiChatResponse> done = new CompletableFuture<>();
            List<EchoAction> midStreamActions = new CopyOnWriteArrayList<>();
            AiChatRequest req = new AiChatRequest(
                    List.of(new AiChatMessageDto("user", "Explain what shadowing is, and open a B1 listening lesson")),
                    null, "voice", "en", "turn-b2-local-1", null,
                    List.of(new EchoSalientResourceDto(1, "Prior Lesson", "/listening/50", "listening")));

            service.streamVoiceTurn(42L, req, new AiChatService.VoiceStreamCallbacks() {
                @Override public void onStatus(String status) {}
                @Override public void onDelta(String textDelta) {}
                @Override public void onActions(List<EchoAction> actions) { midStreamActions.addAll(actions); }
                @Override public void onCards(List<com.englishcoach.ai.dto.EchoCard> cards) {}
                @Override public void onComplete(AiChatResponse finalResponse) { done.complete(finalResponse); }
                @Override public void onError(int status, String code, String kind, Instant resetsAt) {
                    done.completeExceptionally(new AssertionError("Unexpected error: " + code));
                }
            });

            AiChatResponse resp = done.get(8, TimeUnit.SECONDS);
            assertThat(resp.reply()).contains("Shadowing means repeating speech", "Climate Action Podcast");
            assertThat(resp.actions()).anySatisfy(a -> {
                assertThat(a.href()).isEqualTo("/listening/88");
                assertThat(a.auto()).isTrue();
            });
            assertThat(midStreamActions).isNotEmpty();

            // Verify Round-0 & Round-1 local payloads: tools present, tool_choice="auto", adaptive voice max_tokens=170,
            // static PROFESSOR prefix first + --- DYNAMIC TURN CONTEXT --- + zero "Conversation intent:"
            assertThat(localPayloads).hasSize(2);
            JsonNode round0 = localPayloads.get(0);
            assertThat(round0.path("tools").size()).isEqualTo(3);
            assertThat(round0.path("tool_choice").asText()).isEqualTo("auto");
            assertThat(round0.path("max_tokens").asInt()).isEqualTo(170);

            String sysMsg = round0.path("messages").get(0).path("content").asText();
            assertThat(sysMsg).startsWith(EchoPolicy.PROFESSOR);
            assertThat(sysMsg).contains("--- DYNAMIC TURN CONTEXT ---", "Prior Lesson", "NO unsolicited quizzes");
            assertThat(sysMsg).doesNotContain("Conversation intent:");

            JsonNode round1Msgs = localPayloads.get(1).path("messages");
            assertThat(round1Msgs.toString()).contains("\"role\":\"tool\"", "Climate Action Podcast", "\\\"opened\\\":true");

            // Proportional profile loading: mixed explanation+open did NOT dump 7-day fullProfile!
            verify(brain).snapshot(42L, false, false);
        } finally {
            service.stop();
            server.stop(0);
        }
    }

    @Test
    void coachingModeAdaptsAcrossSessionHistoryPersistsOnFromNowOnAndFullProfileLoadsProportionally() {
        // 1. CoachingMode detection & session carry-over
        assertThat(EchoPolicy.detectCoachingModeShift("Please correct everything I say from now on"))
                .contains(EchoPolicy.CoachingMode.STRICT_CORRECTION);
        assertThat(EchoPolicy.hasPersistentModeCue("Please correct everything I say from now on")).isTrue();

        assertThat(EchoPolicy.detectCoachingModeShift("Don't correct my grammar right now, let's just chat in English"))
                .contains(EchoPolicy.CoachingMode.FREE_CHAT);
        assertThat(EchoPolicy.detectCoachingModeShift("Đừng sửa lỗi vội, mình chỉ muốn nói chuyện thôi"))
                .contains(EchoPolicy.CoachingMode.FREE_CHAT);
        assertThat(EchoPolicy.detectCoachingModeShift("If I asked you to correct my grammar, what happens?"))
                .isEmpty();

        List<AiChatMessageDto> history = List.of(
                new AiChatMessageDto("user", "Correct all my mistakes"),
                new AiChatMessageDto("assistant", "Sure!"),
                new AiChatMessageDto("user", "Yesterday I go to the park."));
        assertThat(EchoPolicy.resolveEffectiveCoachingMode(history, "{}", mapper))
                .isEqualTo(EchoPolicy.CoachingMode.STRICT_CORRECTION);

        // Falls back to persisted learnerStated COACHING_MODE when current session has no explicit shift
        String storedStrict = "{\"learnerStated\":[{\"kind\":\"COACHING_MODE\",\"text\":\"FREE_CHAT\"}]}";
        assertThat(EchoPolicy.resolveEffectiveCoachingMode(List.of(new AiChatMessageDto("user", "Tell me about movies")), storedStrict, mapper))
                .isEqualTo(EchoPolicy.CoachingMode.FREE_CHAT);

        assertThat(EchoMemoryService.KINDS).contains("COACHING_MODE");

        // 2. Proportional fullProfile loading: false on ordinary questions/commands, true on weakness/progress/encouragement (incl. "stuck at B1")
        assertThat(EchoRouter.fullProfile(EchoPolicy.Intent.PRACTICE, "Open Speaking module")).isFalse();
        assertThat(EchoRouter.fullProfile(EchoPolicy.Intent.QUICK_VOCAB, "What does break the ice mean?")).isFalse();
        assertThat(EchoRouter.fullProfile(EchoPolicy.Intent.GENERAL_ENGLISH_CONTEXT, "Let's chat about sci-fi movies")).isFalse();
        assertThat(EchoRouter.fullProfile(EchoPolicy.Intent.WEAKNESS_ANALYSIS, "What are my weaknesses?")).isTrue();
        assertThat(EchoRouter.fullProfile(EchoPolicy.Intent.GENERAL_ENGLISH_CONTEXT, "I'm feeling discouraged, stuck at B1")).isTrue();

        // 3. Persistent FREE_CHAT mode ("Don't correct my grammar from now on" / "Từ giờ đừng sửa lỗi ngữ pháp cho mình")
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.update(anyString(), any(), any(), any())).thenReturn(1);
        EchoMemoryService realMemory = new EchoMemoryService(jdbc);
        assertThat(realMemory.rememberCoachingMode(42L, "Don't correct my grammar from now on", EchoPolicy.CoachingMode.FREE_CHAT))
                .contains("FREE_CHAT");
        assertThat(realMemory.rememberCoachingMode(42L, "Từ giờ đừng sửa lỗi ngữ pháp cho mình", EchoPolicy.CoachingMode.FREE_CHAT))
                .contains("FREE_CHAT");
        assertThat(realMemory.rememberCoachingMode(42L, "If I said don't correct my grammar from now on, what happens?", EchoPolicy.CoachingMode.FREE_CHAT))
                .isEmpty();

        // 4. Copy & sparkle stripping checks ([P2-3])
        assertThat(EchoPolicy.stripEchoMeta("Great job! \u2728 Keep going.")).isEqualTo("Great job!  Keep going.").doesNotContain("\u2728");
        assertThat(EchoDestinations.Dest.READING_MYBOOKS.label(true)).isEqualTo("Tủ sách của bạn");
        assertThat(new com.englishcoach.ai.echo.tools.GrammarPracticeTool(none(GrammarContent.class), mapper).description())
                .startsWith("Use ONLY when the learner explicitly asks for a quiz or practice check. ");
    }

    @Test
    void enforces10AbBookPrivacyAcrossHttpAndWsTurnCheckNewChatResetAnd404SessionHeal() throws Exception {
        // 1. HTTP/Plane-B 10 §AB defense-in-depth: BOOK_ACTIVE bookMeta/clientVisibleExcerpt NEVER serialized unless pageReferenced or selection!
        EchoDestinations dests = new EchoDestinations(
                none(GrammarContent.class), none(ReadingMaterialRepository.class), none(ListeningMaterialRepository.class));
        EchoPageContextResolver realResolver = new EchoPageContextResolver(
                mapper, none(GrammarContent.class), none(ReadingMaterialRepository.class),
                none(ListeningMaterialRepository.class), null, none(PlatformTransactionManager.class), dests, null);
        EchoToolRegistry registry = new EchoToolRegistry(
                List.of(new OpenPageTool(dests, mapper)), mapper, none(PlatformTransactionManager.class));

        List<JsonNode> receivedPrompts = new CopyOnWriteArrayList<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newCachedThreadPool());
        server.createContext("/api/v1/chat/completions", exchange -> {
            receivedPrompts.add(mapper.readTree(exchange.getRequestBody().readAllBytes()));
            String sse = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Clear answer.\"}}]}\n\n"
                    + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                    + "data: [DONE]\n\n";
            byte[] out = sse.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
            exchange.sendResponseHeaders(200, out.length);
            try (OutputStream os = exchange.getResponseBody()) { os.write(out); }
        });
        server.start();

        OpenRouterChatServiceImpl service = new OpenRouterChatServiceImpl(
                new RestTemplate(), "sk-test", "http://127.0.0.1:" + server.getAddress().getPort() + "/api/v1",
                "openai/gpt-6-luna", null, mapper);
        EchoLearnerBrain brain = mock(EchoLearnerBrain.class);
        when(brain.snapshot(eq(42L), anyBoolean(), anyBoolean()))
                .thenReturn(new EchoLearnerBrain.Snapshot("{\"verifiedProficiency\":{\"overall\":{\"currentCefr\":\"B1\"}}}", "B1", "VERIFIED"));
        service.useIntelligence(new EchoModels("m-fast", "m-fast-fb", "m-strong", "m-strong-fb", 2), registry, brain, mock(EchoUsageLedger.class), dests);
        ReflectionTestUtils.setField(service, "pages", realResolver);

        try {
            var secretBookPage = new com.englishcoach.ai.dto.EchoPageContextDto(
                    "BOOK_ACTIVE", null, null, null, null, "reading", null,
                    "TopSecretBookParagraphContent",
                    new com.englishcoach.ai.dto.EchoPageContextDto.BookMeta("Secret Diary Title", "Private Author", "Ch 9", 12, 100, 12.0, List.of("PrivateHighlight")),
                    "/reading", 0, null);

            // Non-page-referenced question -> ZERO bookMeta or clientVisibleExcerpt in LLM prompt!
            CompletableFuture<AiChatResponse> d1 = new CompletableFuture<>();
            service.streamVoiceTurn(42L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "What does resilient mean?")), secretBookPage, "voice", "en", "t-priv-1"),
                    new AiChatService.VoiceStreamCallbacks() {
                        @Override public void onStatus(String s) {}
                        @Override public void onDelta(String d) {}
                        @Override public void onActions(List<EchoAction> a) {}
                        @Override public void onCards(List<com.englishcoach.ai.dto.EchoCard> c) {}
                        @Override public void onComplete(AiChatResponse r) { d1.complete(r); }
                        @Override public void onError(int st, String code, String k, Instant ra) { d1.completeExceptionally(new AssertionError(code)); }
                    });
            d1.get(5, TimeUnit.SECONDS);
            String sys1 = receivedPrompts.get(0).path("messages").get(0).path("content").asText();
            assertThat(sys1).doesNotContain("TopSecretBookParagraphContent", "Secret Diary Title", "PrivateHighlight");

            // Explicit book question ("Summarize this chapter of the book") -> includes bookMeta & clientVisibleExcerpt!
            receivedPrompts.clear();
            CompletableFuture<AiChatResponse> d2 = new CompletableFuture<>();
            service.streamVoiceTurn(42L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "Summarize this chapter of the book")), secretBookPage, "voice", "en", "t-priv-2"),
                    new AiChatService.VoiceStreamCallbacks() {
                        @Override public void onStatus(String s) {}
                        @Override public void onDelta(String d) {}
                        @Override public void onActions(List<EchoAction> a) {}
                        @Override public void onCards(List<com.englishcoach.ai.dto.EchoCard> c) {}
                        @Override public void onComplete(AiChatResponse r) { d2.complete(r); }
                        @Override public void onError(int st, String code, String k, Instant ra) { d2.completeExceptionally(new AssertionError(code)); }
                    });
            d2.get(5, TimeUnit.SECONDS);
            String sys2 = receivedPrompts.get(0).path("messages").get(0).path("content").asText();
            assertThat(sys2).contains("TopSecretBookParagraphContent", "Secret Diary Title");

            // Direct IDENTITY & Work-Route NAVIGATE honesty
            AiChatResponse idResp = service.chat(42L, new AiChatRequest(List.of(new AiChatMessageDto("user", "Who are you?")), null, "text", "en", "t-id"));
            assertThat(idResp.reply()).isEqualTo("I'm Echo — your AI companion and English learning copilot inside English Coach.");

            var activeWorkPage = new com.englishcoach.ai.dto.EchoPageContextDto(
                    "SHADOWING_LESSON", null, 12L, null, null, "speaking", null, null, null, "/speaking/shadowing/12");
            AiChatResponse workNavResp = service.chat(42L, new AiChatRequest(List.of(new AiChatMessageDto("user", "Open Reading")), activeWorkPage, "text", "en", "t-work"));
            assertThat(workNavResp.reply()).contains("You have active practice open. Please confirm if you want to switch to Reading.");

            // 2. WS Turn-Check metadata + sessionId:null reset + 404 NOT_FOUND session self-heal
            EchoCoachService coach = mock(EchoCoachService.class);
            doThrow(new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND))
                    .when(coach).saveMessages(eq(42L), eq(500L), any());
            when(coach.createSession(eq(42L), any(CreateSessionRequest.class)))
                    .thenReturn(new EchoCoachSessionDto(888L, "Healed Session", Instant.now(), Instant.now()));

            SpeakingTtsService tts = mock(SpeakingTtsService.class);
            AuthSessionService sessions = mock(AuthSessionService.class);
            UserRepository users = mock(UserRepository.class);
            UUID authSid = UUID.randomUUID();
            when(sessions.validateAndTouchActiveSession(authSid, 42L)).thenReturn(true);
            User u = new User(); u.setId(42L); u.setAccountStatus("ACTIVE");
            when(users.findById(42L)).thenReturn(Optional.of(u));

            EchoVoiceWebSocketHandler wsHandler = new EchoVoiceWebSocketHandler(
                    mock(AiChatService.class), brain, coach, mock(EchoConfirmations.class), tts, mapper,
                    "http://127.0.0.1:8000", sessions, users, null);

            Map<String, Object> attrs = new HashMap<>();
            attrs.put(EchoVoiceWebSocketHandler.ATTR_USER_ID, 42L);
            UserDetailsImpl principal = new UserDetailsImpl(42L, "u42@example.com", "pw", List.of());
            UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(principal, null, List.of());
            auth.setDetails(new AuthSessionContext(authSid, 42L, "CREDENTIALS", Instant.now(), null, null, null));
            attrs.put(EchoVoiceWebSocketHandler.ATTR_AUTHENTICATION, auth);

            List<String> frames = new CopyOnWriteArrayList<>();
            CountDownLatch planLatch = new CountDownLatch(1);
            CountDownLatch doneLatch = new CountDownLatch(1);
            WebSocketSession ws = mock(WebSocketSession.class);
            when(ws.getId()).thenReturn("ws-heal-1");
            when(ws.getAttributes()).thenReturn(attrs);
            when(ws.isOpen()).thenReturn(true);
            doAnswer(inv -> {
                if (inv.getArgument(0) instanceof TextMessage tm) {
                    frames.add(tm.getPayload());
                    if (tm.getPayload().contains("\"action.client_plan\"")) planLatch.countDown();
                    if (tm.getPayload().contains("\"response.done\"")) doneLatch.countDown();
                }
                return null;
            }).when(ws).sendMessage(any(WebSocketMessage.class));

            try {
                wsHandler.afterConnectionEstablished(ws);
                // Commit with stale sessionId=500 + BOOK_ACTIVE excerpt -> state.pageContext must strip bookMeta & excerpt!
                wsHandler.handleMessage(ws, new TextMessage(
                        "{\"type\":\"input.commit\",\"turnSeq\":1,\"sessionId\":500,\"text\":\"Open Reading\","
                                + "\"pageContext\":{\"kind\":\"BOOK_ACTIVE\",\"pathname\":\"/reading\",\"clientVisibleExcerpt\":\"SecretBook\",\"bookMeta\":{\"title\":\"Secret\"}}}"));
                assertThat(planLatch.await(3, TimeUnit.SECONDS)).isTrue();
                wsHandler.handleMessage(ws, new TextMessage("{\"type\":\"action.ack\",\"turnSeq\":1,\"status\":\"done\",\"spokenMessage\":\"Opened Reading.\"}"));
                assertThat(doneLatch.await(3, TimeUnit.SECONDS)).isTrue();

                // Verify 404 on session 500 healed to session 888 and saved!
                verify(coach).saveMessages(eq(42L), eq(888L), any(SaveMessagePairRequest.class));
                assertThat(frames).anyMatch(f -> f.contains("\"response.done\"") && f.contains("\"sessionId\":888"));

                Map<?, ?> stMap = (Map<?, ?>) ReflectionTestUtils.getField(wsHandler, "sessions");
                Object st = stMap.get("ws-heal-1");
                var persistedPage = (com.englishcoach.ai.dto.EchoPageContextDto) ReflectionTestUtils.getField(st, "pageContext");
                assertThat(persistedPage.clientVisibleExcerpt()).isNull();
                assertThat(persistedPage.bookMeta()).isNull();

                // Verify passive input.speech_started with sessionId:null does NOT wipe active session 888!
                wsHandler.handleMessage(ws, new TextMessage("{\"type\":\"input.speech_started\",\"turnSeq\":2,\"sessionId\":null}"));
                assertThat(ReflectionTestUtils.getField(st, "echoSessionId")).isEqualTo(888L);

                // Verify explicit resetSession:true (newChat) clears echoSessionId, salientResources, and history!
                wsHandler.handleMessage(ws, new TextMessage("{\"type\":\"session.update\",\"resetSession\":true,\"sessionId\":null,\"messages\":[],\"salientResources\":[]}"));
                assertThat(ReflectionTestUtils.getField(st, "echoSessionId")).isNull();
                assertThat((List<?>) ReflectionTestUtils.getField(st, "salientResources")).isEmpty();
            } finally {
                ReflectionTestUtils.invokeMethod(wsHandler, "shutdown");
            }
        } finally {
            service.stop();
            server.stop(0);
        }
    }

    @Test
    void wsHandlerEnsuresEchoCoachSessionPersistsPlaneAAndPlaneBAndHonorsActionAckHandshake() throws Exception {
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

        when(coach.createSession(eq(42L), any(CreateSessionRequest.class)))
                .thenReturn(new EchoCoachSessionDto(777L, "Open Reading", Instant.now(), Instant.now()));

        List<String> spokenTtsLines = new CopyOnWriteArrayList<>();
        doAnswer(inv -> {
            spokenTtsLines.add(inv.getArgument(2));
            @SuppressWarnings("unchecked")
            Consumer<byte[]> sink = inv.getArgument(3);
            sink.accept(new byte[1920]);
            return null;
        }).when(tts).streamEchoSentence(eq(42L), anyString(), anyString(), any());

        EchoVoiceWebSocketHandler handler = new EchoVoiceWebSocketHandler(
                chat, brain, coach, mock(EchoConfirmations.class), tts, mapper, "http://127.0.0.1:8000", sessions, users, null);
        ReflectionTestUtils.setField(handler, "asrClient", asr);
        ReflectionTestUtils.setField(handler, "turnCheckClient", turnCheck);

        Map<String, Object> attrs = new HashMap<>();
        attrs.put(EchoVoiceWebSocketHandler.ATTR_USER_ID, 42L);
        UserDetailsImpl principal = new UserDetailsImpl(42L, "u42@example.com", "pw", List.of());
        UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(principal, null, List.of());
        auth.setDetails(new AuthSessionContext(authSid, 42L, "CREDENTIALS", Instant.now(), null, null, null));
        attrs.put(EchoVoiceWebSocketHandler.ATTR_AUTHENTICATION, auth);

        CountDownLatch turn1PlanSent = new CountDownLatch(1);
        CountDownLatch turn1Done = new CountDownLatch(1);
        CountDownLatch turn2Done = new CountDownLatch(1);
        List<String> textFrames = new CopyOnWriteArrayList<>();
        AtomicBoolean open = new AtomicBoolean(true);

        WebSocketSession ws = mock(WebSocketSession.class);
        when(ws.getId()).thenReturn("ws-b2-ack");
        when(ws.getAttributes()).thenReturn(attrs);
        when(ws.isOpen()).thenAnswer(inv -> open.get());
        doAnswer(inv -> {
            WebSocketMessage<?> msg = inv.getArgument(0);
            if (msg instanceof TextMessage tm) {
                String payload = tm.getPayload();
                textFrames.add(payload);
                if (payload.contains("\"action.client_plan\"") && payload.contains("\"turnSeq\":1")) {
                    turn1PlanSent.countDown();
                }
                if (payload.contains("\"response.done\"") && payload.contains("\"turnSeq\":1")) {
                    turn1Done.countDown();
                }
                if (payload.contains("\"response.done\"") && payload.contains("\"turnSeq\":2")) {
                    turn2Done.countDown();
                }
            }
            return null;
        }).when(ws).sendMessage(any(WebSocketMessage.class));

        try {
            handler.afterConnectionEstablished(ws);
            // Start WITHOUT sessionId + WITH salientResources
            handler.handleMessage(ws, new TextMessage(
                    "{\"type\":\"session.start\",\"voiceId\":\"us_female\",\"lang\":\"en\","
                            + "\"salientResources\":[{\"index\":1,\"title\":\"Ocean Story\",\"href\":\"/reading?materialId=55\",\"kind\":\"reading\"}]}"));

            // Turn 1: Anaphoric Plane-A ("open it") -> lazily creates EchoCoachSession 777 + waits for action.ack -> speaks custom ack!
            handler.handleMessage(ws, new TextMessage("{\"type\":\"input.commit\",\"turnSeq\":1,\"text\":\"open it\"}"));
            assertThat(turn1PlanSent.await(3, TimeUnit.SECONDS)).isTrue();
            handler.handleMessage(ws, new TextMessage(
                    "{\"type\":\"action.ack\",\"turnSeq\":1,\"status\":\"done\",\"spokenMessage\":\"Opened Ocean Story right away.\"}"));
            assertThat(turn1Done.await(3, TimeUnit.SECONDS)).isTrue();

            assertThat(spokenTtsLines).contains("Opened Ocean Story right away.");
            assertThat(textFrames).anyMatch(f -> f.contains("\"action.client_plan\"") && f.contains("\"sessionId\":777") && f.contains("/reading?materialId=55"));
            assertThat(textFrames).anyMatch(f -> f.contains("\"response.done\"") && f.contains("\"sessionId\":777"));

            ArgumentCaptor<SaveMessagePairRequest> saveCaptor = ArgumentCaptor.forClass(SaveMessagePairRequest.class);
            verify(coach).createSession(eq(42L), any(CreateSessionRequest.class));
            verify(coach).saveMessages(eq(42L), eq(777L), saveCaptor.capture());
            assertThat(saveCaptor.getValue().userMessage()).isEqualTo("open it");
            assertThat(saveCaptor.getValue().assistantMessage()).isEqualTo("Opened Ocean Story right away.");

            // Turn 2: action.ack with status="cancelled" and blank spokenMessage -> skips TTS cleanly!
            spokenTtsLines.clear();
            handler.handleMessage(ws, new TextMessage("{\"type\":\"input.commit\",\"turnSeq\":2,\"text\":\"Sign out\"}"));
            Thread.sleep(40);
            handler.handleMessage(ws, new TextMessage("{\"type\":\"action.ack\",\"turnSeq\":2,\"status\":\"cancelled\",\"spokenMessage\":\"\"}"));
            assertThat(turn2Done.await(3, TimeUnit.SECONDS)).isTrue();
            assertThat(spokenTtsLines).isEmpty();
        } finally {
            ReflectionTestUtils.invokeMethod(handler, "shutdown");
        }
    }

    @Test
    void resilienceRefinementsFastTripRelay400AvoidLocalNonStreamRetryScaleAdaptiveVoiceBudgetsAndReleaseQuotaSynchronously() throws Exception {
        // 1. Retired model remap & expanded secret redaction
        assertThat(EchoModels.normalizeModelId("google/gemini-2.0-flash-001")).isEqualTo("google/gemini-2.5-flash");
        EchoModels remappedModels = new EchoModels("google/gemini-2.0-flash-001", "anthropic/claude-haiku-5.5", "openai/gpt-6.1-terra", "google/gemini-2.0-flash-001", 2);
        assertThat(remappedModels.fast()).isEqualTo("google/gemini-2.5-flash");
        assertThat(remappedModels.candidates(EchoRouter.Route.FAST, true)).contains("google/gemini-2.5-flash").doesNotContain("google/gemini-2.0-flash-001");
        assertThat(EchoPolicy.redactSecrets("Auth Bearer tok_secret_987654321 and X-EC-Service-Key: svc-internal-99999999"))
                .doesNotContain("tok_secret_987654321", "svc-internal-99999999");
        assertThat(EchoPolicy.redactSecrets("Bearer authentication is standard.")).contains("Bearer authentication");

        // 2. Non-freezing bracket/angle scan & sub-second Clause-0 voice release in EchoVisibleText
        List<String> visChunks = new ArrayList<>();
        EchoVisibleText voiceGate = new EchoVisibleText("system", EchoPolicy.Intent.GRAMMAR, EchoVisibleText.Mode.VOICE, visChunks::add);
        voiceGate.advance("Tất nhiên! Đây là cách phát âm [rɪˈzɪliənt] trong câu ví dụ thực tế cho bạn nhé.");
        assertThat(visChunks).isNotEmpty();
        assertThat(String.join("", visChunks)).contains("Tất nhiên!", "[rɪˈzɪliənt]");

        // 3. Single-hop relay_400 fast-trip, zero local stream:false retry on 503, adaptive voice max_tokens (520 / 320 / 260 / 180),
        //    and synchronous pre-output cancel reservation release + CANCELLED ledger outcome
        AtomicInteger openRouterCalls = new AtomicInteger(0);
        AtomicInteger localStreamCalls = new AtomicInteger(0);
        AtomicInteger localNonStreamCalls = new AtomicInteger(0);
        AtomicBoolean failLocalWith503 = new AtomicBoolean(false);
        CountDownLatch slowPrefillEntered = new CountDownLatch(1);
        CountDownLatch releaseSlowPrefill = new CountDownLatch(1);
        AtomicBoolean holdSlowPrefill = new AtomicBoolean(false);
        List<JsonNode> localCaptured = new CopyOnWriteArrayList<>();

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newCachedThreadPool());
        server.createContext("/api/v1/chat/completions", ex -> {
            ex.getRequestBody().readAllBytes();
            openRouterCalls.incrementAndGet();
            byte[] err = "{\"error\":{\"message\":\"Request path cannot be relayed\",\"code\":400}}".getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "application/json");
            ex.sendResponseHeaders(400, err.length);
            try (OutputStream os = ex.getResponseBody()) { os.write(err); }
        });
        server.createContext("/api/v1/coach/chat/completions", ex -> {
            JsonNode body = mapper.readTree(ex.getRequestBody().readAllBytes());
            localCaptured.add(body);
            boolean isStream = body.path("stream").asBoolean(false);
            if (isStream) localStreamCalls.incrementAndGet();
            else localNonStreamCalls.incrementAndGet();

            if (failLocalWith503.get()) {
                byte[] busy = "{\"detail\":\"Local chat service is busy\"}".getBytes(StandardCharsets.UTF_8);
                ex.getResponseHeaders().set("Content-Type", "application/json");
                ex.sendResponseHeaders(503, busy.length);
                try (OutputStream os = ex.getResponseBody()) { os.write(busy); }
                return;
            }
            if (holdSlowPrefill.get()) {
                ex.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
                ex.sendResponseHeaders(200, 0);
                slowPrefillEntered.countDown();
                try { releaseSlowPrefill.await(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
                ex.close();
                return;
            }
            String sse = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"<think>draft</think>Clean spoken answer.\"}}]}\n\n"
                    + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                    + "data: [DONE]\n\n";
            byte[] out = sse.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
            ex.sendResponseHeaders(200, out.length);
            try (OutputStream os = ex.getResponseBody()) { os.write(out); }
        });
        server.start();

        EchoDestinations dests = new EchoDestinations(
                none(GrammarContent.class), none(ReadingMaterialRepository.class), none(ListeningMaterialRepository.class));
        EchoToolRegistry registry = new EchoToolRegistry(
                List.of(new OpenPageTool(dests, mapper)), mapper, none(PlatformTransactionManager.class));
        EchoUsageLedger ledger = mock(EchoUsageLedger.class);
        com.englishcoach.premium.service.PremiumUsageService usage = mock(com.englishcoach.premium.service.PremiumUsageService.class);
        com.englishcoach.premium.service.PremiumEntitlementService entitlement = mock(com.englishcoach.premium.service.PremiumEntitlementService.class);
        when(entitlement.isUserPremium(42L)).thenReturn(false);
        when(usage.reserveUsage(eq(42L), anyString(), any(), eq(false))).thenReturn(901L);

        String orBase = "http://127.0.0.1:" + server.getAddress().getPort() + "/api/v1";
        String localRoot = "http://127.0.0.1:" + server.getAddress().getPort();
        OpenRouterChatServiceImpl svc = new OpenRouterChatServiceImpl(
                new RestTemplate(), "sk-test", orBase, "openai/gpt-6-luna", null, mapper);
        svc.useIntelligence(new EchoModels("m-fast", "m-fast-fb", "m-strong", "m-strong-fb", 2), registry, null, ledger, dests);
        svc.useQuota(usage, entitlement);
        svc.useLocalLlmFallback(localRoot, "svc-key", "qwen3-4b-instruct", 180_000L);

        try {
            // (a) Turn 1 (flashcard save cue -> 520 max_tokens): OpenRouter hits relay_400 ONCE (no wasted sanitized/bridge retries!)
            CompletableFuture<AiChatResponse> t1 = new CompletableFuture<>();
            svc.streamVoiceTurn(42L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "Create flashcards from resilient and tenacious")), null, "voice", "en", "t-fc-520"),
                    new AiChatService.VoiceStreamCallbacks() {
                        @Override public void onDelta(String d) {}
                        @Override public void onComplete(AiChatResponse r) { t1.complete(r); }
                        @Override public void onError(int s, String c, String k, Instant ra) { t1.completeExceptionally(new AssertionError(c)); }
                    });
            assertThat(t1.get(5, TimeUnit.SECONDS).reply()).isEqualTo("Clean spoken answer.");
            assertThat(openRouterCalls.get()).isEqualTo(1);
            assertThat(localCaptured.get(0).path("max_tokens").asInt()).isEqualTo(520);

            // (b) Turn 2 (directTeaching grammar explanation -> 210 max_tokens, 0 OpenRouter calls while breaker OPEN)
            localCaptured.clear();
            CompletableFuture<AiChatResponse> t2 = new CompletableFuture<>();
            svc.streamVoiceTurn(42L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "Explain the difference between make and do")), null, "voice", "en", "t-teach-210"),
                    new AiChatService.VoiceStreamCallbacks() {
                        @Override public void onDelta(String d) {}
                        @Override public void onComplete(AiChatResponse r) { t2.complete(r); }
                        @Override public void onError(int s, String c, String k, Instant ra) { t2.completeExceptionally(new AssertionError(c)); }
                    });
            t2.get(5, TimeUnit.SECONDS);
            assertThat(openRouterCalls.get()).isEqualTo(1);
            assertThat(localCaptured.get(0).path("max_tokens").asInt()).isEqualTo(210);

            // (c) Local 503 failure -> ZERO non-streaming (`stream: false`) retry!
            localStreamCalls.set(0);
            localNonStreamCalls.set(0);
            failLocalWith503.set(true);
            CountDownLatch err503 = new CountDownLatch(1);
            svc.streamVoiceTurn(42L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "Hello there")), null, "voice", "en", "t-503-no-retry"),
                    new AiChatService.VoiceStreamCallbacks() {
                        @Override public void onDelta(String d) {}
                        @Override public void onComplete(AiChatResponse r) { err503.countDown(); }
                        @Override public void onError(int s, String c, String k, Instant ra) { err503.countDown(); }
                    });
            assertThat(err503.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(localStreamCalls.get()).isEqualTo(1);
            assertThat(localNonStreamCalls.get()).isZero();
            failLocalWith503.set(false);

            // (d) Synchronous pre-output cancellation releases quota reservation BEFORE worker finishes!
            reset(usage, ledger);
            when(usage.reserveUsage(eq(42L), anyString(), any(), eq(false))).thenReturn(999L);
            holdSlowPrefill.set(true);
            CountDownLatch cancelCallback = new CountDownLatch(1);
            Runnable cancelHandle = svc.streamVoiceTurn(42L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "Hi Echo")), null, "voice", "en", "t-sync-cancel"),
                    new AiChatService.VoiceStreamCallbacks() {
                        @Override public void onDelta(String d) {}
                        @Override public void onComplete(AiChatResponse r) { cancelCallback.countDown(); }
                        @Override public void onError(int s, String c, String k, Instant ra) { cancelCallback.countDown(); }
                    });
            assertThat(slowPrefillEntered.await(5, TimeUnit.SECONDS)).isTrue();
            cancelHandle.run();
            // Released synchronously inside cancelHandle.run() while worker is still blocked!
            verify(usage, times(1)).releaseReservation(999L);
            releaseSlowPrefill.countDown();
            assertThat(cancelCallback.await(5, TimeUnit.SECONDS)).isTrue();
            // Never double-released or committed when worker exits; DB check constraint echo_ai_turns_outcome_check receives FAILED!
            verify(usage, times(1)).releaseReservation(999L);
            verify(usage, never()).commitReservation(anyLong());
            verify(ledger).record(eq(42L), eq(true), any(), anyString(), anyString(), any(), anyLong(), eq("FAILED"));
            assertThat(OpenRouterChatServiceImpl.normalizeLedgerOutcome("TIMEOUT")).isEqualTo("FAILED");
            assertThat(OpenRouterChatServiceImpl.normalizeLedgerOutcome("CANCELLED")).isEqualTo("FAILED");
            assertThat(OpenRouterChatServiceImpl.normalizeLedgerOutcome("ANSWERED")).isEqualTo("ANSWERED");
            assertThat(OpenRouterChatServiceImpl.normalizeLedgerOutcome("FILTERED")).isEqualTo("FILTERED");
            assertThat(OpenRouterChatServiceImpl.normalizeLedgerOutcome("REFUSED")).isEqualTo("REFUSED");

            // (e) Control.cancelByTimeout() distinguishes server budget timeout from user barge-in and maps 504 -> turn_timeout
            EchoProviderStream.Control timeoutCtrl = new EchoProviderStream.Control();
            timeoutCtrl.cancelByTimeout();
            assertThat(timeoutCtrl.isTimedOut()).isTrue();
            assertThat(OpenRouterChatServiceImpl.classifyVoiceErrorCode(504)).isEqualTo("turn_timeout");
            assertThat(EchoProviderStream.STREAM_REQUEST_TIMEOUT_SECONDS).isEqualTo(75L);

            // (f) Progress-aware sliding TurnWatchdog: 45s initial pre-output budget, +30s per progress step, 95s hard ceiling
            java.util.concurrent.atomic.AtomicLong fakeNano = new java.util.concurrent.atomic.AtomicLong(0L);
            OpenRouterChatServiceImpl.TurnWatchdog watchdog = new OpenRouterChatServiceImpl.TurnWatchdog(fakeNano::get);
            assertThat(watchdog.budgetFromStartMs()).isEqualTo(45_000L);
            assertThat(watchdog.isExpired()).isFalse();
            // Advance to t=44s while streaming spoken clauses -> recordProgress() extends deadline to 74s (not killed at 45s!)
            fakeNano.set(TimeUnit.MILLISECONDS.toNanos(44_000L));
            watchdog.recordProgress();
            assertThat(watchdog.budgetFromStartMs()).isEqualTo(74_000L);
            fakeNano.set(TimeUnit.MILLISECONDS.toNanos(45_500L));
            assertThat(watchdog.isExpired()).isFalse();
            // Advance to t=80s with more progress -> capped strictly at 95s hard ceiling
            fakeNano.set(TimeUnit.MILLISECONDS.toNanos(80_000L));
            watchdog.recordProgress();
            assertThat(watchdog.budgetFromStartMs()).isEqualTo(95_000L);
            fakeNano.set(TimeUnit.MILLISECONDS.toNanos(95_000L));
            assertThat(watchdog.isExpired()).isTrue();

            // (g) Speaking Profile forced Round-0 tool_choice reliability (EN + VI + speech-act negation/quote safety)
            assertThat(OpenRouterChatServiceImpl.requestsSpeakingProfileCheck("Check my speaking profile")).isTrue();
            assertThat(OpenRouterChatServiceImpl.requestsSpeakingProfileCheck("How is my pronunciation profile looking?")).isTrue();
            assertThat(OpenRouterChatServiceImpl.requestsSpeakingProfileCheck("Kiểm tra hồ sơ luyện nói của mình nhé")).isTrue();
            assertThat(OpenRouterChatServiceImpl.requestsSpeakingProfileCheck("Phân tích hồ sơ phát âm của tôi")).isTrue();
            assertThat(OpenRouterChatServiceImpl.requestsSpeakingProfileCheck("Don't check my speaking profile")).isFalse();
            assertThat(OpenRouterChatServiceImpl.requestsSpeakingProfileCheck("Đừng kiểm tra hồ sơ luyện nói của mình")).isFalse();
            assertThat(OpenRouterChatServiceImpl.requestsSpeakingProfileCheck("What does \"check my speaking profile\" mean?")).isFalse();
            assertThat(OpenRouterChatServiceImpl.requestsSpeakingProfileCheck("If I check my speaking profile, what happens?")).isFalse();
            assertThat(OpenRouterChatServiceImpl.requestsSpeakingProfileCheck("Open speaking profile and turn on dark mode")).isFalse();
        } finally {
            releaseSlowPrefill.countDown();
            svc.stop();
            server.stop(0);
        }
    }

    @Test
    void checkSpeakingProfileForcesGetSpeakingProfileToolChoiceOnRound0AcrossLocalFailover() throws Exception {
        List<JsonNode> capturedLocal = new CopyOnWriteArrayList<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newCachedThreadPool());
        server.createContext("/api/v1/chat/completions", ex -> {
            ex.getRequestBody().readAllBytes();
            byte[] err = "{\"error\":{\"message\":\"Request path cannot be relayed\",\"code\":400}}".getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "application/json");
            ex.sendResponseHeaders(400, err.length);
            try (OutputStream os = ex.getResponseBody()) { os.write(err); }
        });
        server.createContext("/api/v1/coach/chat/completions", ex -> {
            JsonNode req = mapper.readTree(ex.getRequestBody().readAllBytes());
            int roundIdx = capturedLocal.size();
            capturedLocal.add(req);
            String sse;
            if (roundIdx == 0) {
                sse = "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"index\":0,\"id\":\"call_sp_1\",\"type\":\"function\",\"function\":{\"name\":\"get_speaking_profile\",\"arguments\":\"{\\\"section\\\":\\\"both\\\"}\"}}]}}]}\n\n"
                        + "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n"
                        + "data: [DONE]\n\n";
            } else {
                sse = "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Your V2.2 pronunciation score is 84 with steady fluency.\"}}]}\n\n"
                        + "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                        + "data: [DONE]\n\n";
            }
            byte[] out = sse.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
            ex.sendResponseHeaders(200, out.length);
            try (OutputStream os = ex.getResponseBody()) { os.write(out); }
        });
        server.start();

        EchoDestinations dests = new EchoDestinations(
                none(GrammarContent.class), none(ReadingMaterialRepository.class), none(ListeningMaterialRepository.class));
        EchoTool mockProfileTool = new EchoTool() {
            @Override public String name() { return "get_speaking_profile"; }
            @Override public String description() { return "Read speaking profile"; }
            @Override public Map<String, Object> parameters() {
                return EchoToolRegistry.schema(
                        Map.of("section", EchoToolRegistry.enumOf("section", List.of("overview", "pronunciation", "both"))),
                        List.of());
            }
            @Override public Kind kind() { return Kind.READ; }
            @Override public String status(boolean vi) { return vi ? "Đang kiểm tra hồ sơ luyện nói…" : "Checking speaking profile…"; }
            @Override public boolean readOnlyTransaction() { return false; }
            @Override public String run(com.englishcoach.ai.echo.EchoTurn turn, JsonNode args) {
                return "{\"status\":\"READY\",\"pronunciationScore\":84,\"fluencyScore\":81}";
            }
        };
        EchoToolRegistry registry = new EchoToolRegistry(
                List.of(mockProfileTool, new OpenPageTool(dests, mapper)), mapper, none(PlatformTransactionManager.class));

        String orBase = "http://127.0.0.1:" + server.getAddress().getPort() + "/api/v1";
        String localRoot = "http://127.0.0.1:" + server.getAddress().getPort();
        OpenRouterChatServiceImpl svc = new OpenRouterChatServiceImpl(
                new RestTemplate(), "sk-test", orBase, "openai/gpt-6-luna", null, mapper);
        svc.useIntelligence(new EchoModels("m-fast", "m-fast-fb", "m-strong", "m-strong-fb", 2), registry, null, null, dests);
        svc.useLocalLlmFallback(localRoot, "svc-key", "qwen3-4b-instruct", 180_000L);

        try {
            CompletableFuture<AiChatResponse> done = new CompletableFuture<>();
            svc.streamVoiceTurn(42L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "Check my speaking profile")), null, "voice", "en", "t-b5-profile"),
                    new AiChatService.VoiceStreamCallbacks() {
                        @Override public void onDelta(String d) {}
                        @Override public void onComplete(AiChatResponse r) { done.complete(r); }
                        @Override public void onError(int s, String c, String k, Instant ra) { done.completeExceptionally(new AssertionError(c)); }
                    });
            AiChatResponse resp = done.get(5, TimeUnit.SECONDS);
            assertThat(resp.reply()).contains("84");
            assertThat(capturedLocal).hasSize(2);
            // Round 0 forced get_speaking_profile object tool_choice; Round 1 reverted to "auto" with grounded tool result!
            assertThat(capturedLocal.get(0).path("tool_choice").path("type").asText()).isEqualTo("function");
            assertThat(capturedLocal.get(0).path("tool_choice").path("function").path("name").asText()).isEqualTo("get_speaking_profile");
            assertThat(capturedLocal.get(0).path("max_tokens").asInt()).isEqualTo(170);
            assertThat(capturedLocal.get(1).path("tool_choice").asText()).isEqualTo("auto");
            assertThat(capturedLocal.get(1).path("messages").toString()).contains("\\\"pronunciationScore\\\":84");
        } finally {
            svc.stop();
            server.stop(0);
        }
    }
}
