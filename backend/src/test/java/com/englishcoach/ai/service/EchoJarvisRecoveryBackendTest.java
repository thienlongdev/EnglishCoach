package com.englishcoach.ai.service;

import com.englishcoach.ai.controller.EchoIntelligenceController;
import com.englishcoach.ai.dto.AiChatMessageDto;
import com.englishcoach.ai.dto.AiChatRequest;
import com.englishcoach.ai.dto.AiChatResponse;
import com.englishcoach.ai.echo.EchoDestinations;
import com.englishcoach.ai.echo.EchoModels;
import com.englishcoach.ai.echo.EchoRouter;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.ai.echo.EchoUsageLedger;
import com.englishcoach.ai.echo.tools.OpenPageTool;
import com.englishcoach.ai.voice.EchoVoiceFastPathMatcher;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumUsageService;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.speaking.service.SpeakingTtsService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestTemplate;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Echo JARVIS Production Recovery verification suite:
 * - OpenRouter HTTP 400 ("Request path cannot be relayed"), unsupported parameter stripping, non-streaming JSON bridge,
 *   pre-output stream failover, 4-provider model cascade, and secondary provider failover (`X-EC-Service-Key` / `Bearer`);
 * - Zero quota charge / zero STRONG budget burn / zero state-changing tool replay on failed turns;
 * - 4-Tier Adaptive Intelligence (Tier A < 1 ms, Tier B effort=none, Tier C analytical reasoning + voice STRONG escalation, Tier D tools);
 * - HTTP speech stream X-Accel-Buffering: no and AiChatRequest sessionId tolerance.
 */
class EchoJarvisRecoveryBackendTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private static <T> ObjectProvider<T> none(Class<T> type) {
        return new StaticListableBeanFactory().getBeanProvider(type);
    }

    private EchoDestinations emptyDestinations() {
        return new EchoDestinations(
                none(com.englishcoach.grammar.GrammarContent.class),
                none(ReadingMaterialRepository.class),
                none(ListeningMaterialRepository.class));
    }

    private EchoToolRegistry minimalRegistry(EchoTool... extraTools) {
        List<EchoTool> list = new ArrayList<>();
        list.add(new OpenPageTool(emptyDestinations(), mapper));
        list.addAll(Arrays.asList(extraTools));
        return new EchoToolRegistry(list, mapper, none(PlatformTransactionManager.class));
    }

    @Test
    void openRouterHttp400RelayParameterErrorsCascadeAndSecondaryProviderFailoverAllRecoverCleanly() throws Exception {
        List<JsonNode> receivedPayloads = new CopyOnWriteArrayList<>();
        List<String> secondaryServiceHeaders = new CopyOnWriteArrayList<>();
        AtomicInteger scenario = new AtomicInteger(1);

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newCachedThreadPool());
        server.createContext("/api/v1/chat/completions", exchange -> {
            byte[] reqBytes = exchange.getRequestBody().readAllBytes();
            JsonNode reqJson = mapper.readTree(reqBytes);
            receivedPayloads.add(reqJson);
            String model = reqJson.path("model").asText("");
            boolean isStream = reqJson.path("stream").asBoolean(false);

            if (scenario.get() == 1) {
                if (reqJson.has("reasoning") || reqJson.has("provider")) {
                    byte[] err = "{\"error\":{\"message\":\"Unsupported parameter: reasoning\",\"code\":400}}"
                            .getBytes(StandardCharsets.UTF_8);
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                    exchange.sendResponseHeaders(400, err.length);
                    try (OutputStream os = exchange.getResponseBody()) { os.write(err); }
                    return;
                }
                sendSseAnswer(exchange, "Present simple describes habits and facts clearly.");
                return;
            }

            if (scenario.get() == 2) {
                if (isStream) {
                    byte[] err = "{\"error\":{\"message\":\"Request path cannot be relayed\",\"code\":400}}"
                            .getBytes(StandardCharsets.UTF_8);
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                    exchange.sendResponseHeaders(400, err.length);
                    try (OutputStream os = exchange.getResponseBody()) { os.write(err); }
                    return;
                }
                byte[] json = mapper.writeValueAsBytes(Map.of(
                        "choices", List.of(Map.of("message", Map.of(
                                "role", "assistant",
                                "content", "Recovered seamlessly via non-streaming JSON bridge."))),
                        "usage", Map.of("prompt_tokens", 120, "completion_tokens", 18, "cost", 0.0001)));
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, json.length);
                try (OutputStream os = exchange.getResponseBody()) { os.write(json); }
                return;
            }

            if (scenario.get() == 3) {
                if ("openai/gpt-6-luna".equals(model)) {
                    byte[] err = "{\"error\":{\"message\":\"Request path cannot be relayed\",\"code\":400}}"
                            .getBytes(StandardCharsets.UTF_8);
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                    exchange.sendResponseHeaders(400, err.length);
                    try (OutputStream os = exchange.getResponseBody()) { os.write(err); }
                    return;
                }
                if ("anthropic/claude-haiku-5.5".equals(model)) {
                    byte[] err = "{\"error\":{\"message\":\"Upstream overloaded\",\"code\":503}}"
                            .getBytes(StandardCharsets.UTF_8);
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                    exchange.sendResponseHeaders(503, err.length);
                    try (OutputStream os = exchange.getResponseBody()) { os.write(err); }
                    return;
                }
                if ("google/gemini-2.5-flash".equals(model)) {
                    exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
                    exchange.sendResponseHeaders(200, 0);
                    exchange.getResponseBody().close();
                    return;
                }
                sendSseAnswer(exchange, "Fourth candidate openai/gpt-4.1-mini answered cleanly.");
                return;
            }

            // Scenario 4: ALL OpenRouter models reject with 400 "Request path cannot be relayed"
            byte[] err = "{\"error\":{\"message\":\"Request path cannot be relayed\",\"code\":400}}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(400, err.length);
            try (OutputStream os = exchange.getResponseBody()) { os.write(err); }
        });

        server.createContext("/api/v1/coach/chat/completions", exchange -> {
            String svcHeader = exchange.getRequestHeaders().getFirst("X-EC-Service-Key");
            if (svcHeader != null) secondaryServiceHeaders.add(svcHeader);
            byte[] reqBytes = exchange.getRequestBody().readAllBytes();
            receivedPayloads.add(mapper.readTree(reqBytes));
            // Also include a split <think>...</think> block to prove zero <think> leakage to user/TTS!
            String sse = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"<thi\"}}]}\n\n"
                    + "data: {\"choices\":[{\"delta\":{\"content\":\"nk>internal draft</think>Local GPU host \"}}]}\n\n"
                    + "data: {\"choices\":[{\"delta\":{\"content\":\"instruct endpoint answered fluently.\"}}]}\n\n"
                    + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
                    + "data: [DONE]\n\n";
            byte[] out = sse.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
            exchange.sendResponseHeaders(200, out.length);
            try (OutputStream os = exchange.getResponseBody()) { os.write(out); }
        });
        server.start();

        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/api/v1";
        String aiServiceRoot = "http://127.0.0.1:" + server.getAddress().getPort();
        try {
            OpenRouterChatServiceImpl service = new OpenRouterChatServiceImpl(
                    new RestTemplate(), "sk-test-recovery-key", baseUrl, "google/gemini-2.5-flash", null, mapper);
            EchoModels models = new EchoModels(
                    "openai/gpt-6-luna", "anthropic/claude-haiku-5.5",
                    "openai/gpt-6.1-terra", "openai/gpt-6-luna", 1)
                    .withFallbackChains("google/gemini-2.5-flash,openai/gpt-4.1-mini", "google/gemini-2.5-flash");
            EchoUsageLedger ledger = mock(EchoUsageLedger.class);
            when(ledger.strongToday(anyLong())).thenReturn(0);
            service.useIntelligence(models, minimalRegistry(), null, ledger, emptyDestinations());

            // Scenario 1: Parameter-sanitized retry
            AiChatResponse r1 = awaitVoiceTurn(service, 71L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "Explain present simple")), null, "voice", "en", "turn-rec-0001"));
            assertThat(r1.reply()).contains("Present simple describes habits");
            assertThat(r1.model()).isEqualTo("openai/gpt-6-luna");

            // Scenario 2: Non-streaming JSON bridge on SSE relay 400
            receivedPayloads.clear();
            scenario.set(2);
            AiChatResponse r2 = awaitVoiceTurn(service, 72L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "Explain past continuous")), null, "voice", "en", "turn-rec-0002"));
            assertThat(r2.reply()).contains("Recovered seamlessly via non-streaming JSON bridge");

            // Scenario 3: Full 4-model cascade down to openai/gpt-4.1-mini
            receivedPayloads.clear();
            scenario.set(3);
            AiChatResponse r3 = awaitVoiceTurn(service, 73L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "Explain present perfect")), null, "voice", "en", "turn-rec-0003"));
            assertThat(r3.reply()).contains("Fourth candidate openai/gpt-4.1-mini answered cleanly");
            assertThat(r3.model()).isEqualTo("openai/gpt-4.1-mini");

            JsonNode fourthPayload = receivedPayloads.stream()
                    .filter(p -> "openai/gpt-4.1-mini".equals(p.path("model").asText()))
                    .findFirst().orElseThrow();
            assertThat(fourthPayload.has("reasoning")).isFalse();
            assertThat(fourthPayload.path("temperature").asDouble()).isEqualTo(0.4);

            // Scenario 4: Built-in Tertiary Local LLM failover (/api/v1/coach/chat/completions + X-EC-Service-Key)
            // + 45s half-open circuit breaker (Turn 2 skips OpenRouter in 0 ms; after cooldown expires, OpenRouter heals!)
            receivedPayloads.clear();
            scenario.set(4);
            service.useLocalLlmFallback(aiServiceRoot, "svc-internal-canary", "qwen3-1.7b-instruct", 5_000L);
            AiChatResponse r4 = awaitVoiceTurn(service, 74L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "Explain first conditional")), null, "voice", "en", "turn-rec-0004"));
            assertThat(r4.reply()).isEqualTo("Local GPU host instruct endpoint answered fluently.").doesNotContain("<think>", "internal draft");
            assertThat(r4.model()).isEqualTo("qwen3-1.7b-instruct");
            assertThat(secondaryServiceHeaders).contains("svc-internal-canary");
            assertThat(service.isOpenRouterCircuitOpen()).isTrue();

            // Turn 5 while circuit breaker is OPEN -> 0 OpenRouter requests made, instant 0 ms failover to Tertiary Local LLM!
            receivedPayloads.clear();
            AiChatResponse r5 = awaitVoiceTurn(service, 75L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "Give me one example sentence")), null, "voice", "en", "turn-rec-0005"));
            assertThat(r5.reply()).isEqualTo("Local GPU host instruct endpoint answered fluently.");
            assertThat(receivedPayloads).hasSize(1); // Only the 1 local-LLM request; 0 OpenRouter attempts!
            assertThat(receivedPayloads.get(0).has("tools")).isTrue(); // Full multi-round tool parity on local Qwen3-4B failover
            assertThat(receivedPayloads.get(0).path("tool_choice").asText()).isEqualTo("auto");

            service.stop();
        } finally {
            server.stop(0);
        }
    }

    @Test
    void failedTurnReleasesQuotaNeverChargesStrongBudgetAndNeverReplaysStatefulTools() throws Exception {
        PremiumUsageService usage = mock(PremiumUsageService.class);
        PremiumEntitlementService entitlement = mock(PremiumEntitlementService.class);
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        EchoUsageLedger realLedger = new EchoUsageLedger(jdbc);

        when(entitlement.isUserPremium(55L)).thenReturn(false);
        when(usage.reserveUsage(eq(55L), eq(PremiumUsageService.COACH_CHAT), any(), eq(false))).thenReturn(777L);
        when(jdbc.queryForObject(anyString(), eq(Integer.class), eq(55L), any(Timestamp.class))).thenReturn(0);

        AtomicInteger statefulRuns = new AtomicInteger(0);
        EchoTool statefulTool = new EchoTool() {
            @Override public String name() { return "record_study_note"; }
            @Override public String description() { return "Stateful preparation tool"; }
            @Override public Map<String, Object> parameters() {
                return EchoToolRegistry.schema(Map.of("note", EchoToolRegistry.str("note", 80)), List.of("note"));
            }
            @Override public Kind kind() { return Kind.PREPARE; }
            @Override public boolean readOnlyTransaction() { return false; }
            @Override public String status(boolean vi) { return "saving"; }
            @Override public String run(EchoTurn turn, JsonNode args) {
                statefulRuns.incrementAndGet();
                return "{\"saved\":true}";
            }
        };

        AtomicInteger serverCalls = new AtomicInteger(0);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newCachedThreadPool());
        server.createContext("/api/v1/chat/completions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            int callNo = serverCalls.incrementAndGet();
            if (callNo == 1) {
                // Round 0: SSE streams a tool_call for record_study_note
                String sse = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"record_study_note\",\"arguments\":\"{\\\"note\\\":\\\"review conditionals\\\"}\"}}]}}]}\n\n"
                        + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":15}}\n\n"
                        + "data: [DONE]\n\n";
                byte[] out = sse.getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
                exchange.sendResponseHeaders(200, out.length);
                try (OutputStream os = exchange.getResponseBody()) { os.write(out); }
                return;
            }
            // Round 1: All candidates fail with HTTP 400 "Request path cannot be relayed"
            byte[] err = "{\"error\":{\"message\":\"Request path cannot be relayed\",\"code\":400}}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(400, err.length);
            try (OutputStream os = exchange.getResponseBody()) { os.write(err); }
        });
        server.start();

        String baseUrl = "http://127.0.0.1:" + server.getAddress().getPort() + "/api/v1";
        OpenRouterChatServiceImpl service = new OpenRouterChatServiceImpl(
                new RestTemplate(), "sk-test", baseUrl, "google/gemini-2.5-flash", null, mapper);
        EchoModels models = new EchoModels("m-fast", "m-fast-fb", "m-strong", "m-strong-fb", 1);
        service.useQuota(usage, entitlement);
        service.useIntelligence(models, minimalRegistry(statefulTool), null, realLedger, emptyDestinations());

        try {
            CountDownLatch errLatch = new CountDownLatch(1);
            List<String> errorCodes = new CopyOnWriteArrayList<>();
            service.streamVoiceTurn(55L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "Analyze my Learner DNA strengths and weaknesses in depth")),
                            null, "voice", "en", "turn-fail-55"),
                    new AiChatService.VoiceStreamCallbacks() {
                        @Override public void onStatus(String status) {}
                        @Override public void onDelta(String textDelta) {}
                        @Override public void onActions(List<com.englishcoach.ai.dto.EchoAction> actions) {}
                        @Override public void onCards(List<com.englishcoach.ai.dto.EchoCard> cards) {}
                        @Override public void onComplete(AiChatResponse finalResponse) { errLatch.countDown(); }
                        @Override public void onError(int status, String code, String kind, Instant resetsAt) {
                            errorCodes.add(code);
                            errLatch.countDown();
                        }
                    });

            assertThat(errLatch.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(errorCodes).hasSize(1);
            assertThat(errorCodes.get(0)).isNotEqualTo("failed");
            verify(usage).releaseReservation(777L);
            verify(usage, never()).commitReservation(anyLong());
            assertThat(statefulRuns.get()).isEqualTo(1);

            realLedger.strongToday(55L);
            realLedger.strongThisMonth(55L);
            ArgumentCaptor<String> sqlCaptor = ArgumentCaptor.forClass(String.class);
            verify(jdbc, times(3)).queryForObject(sqlCaptor.capture(), eq(Integer.class), eq(55L), any(Timestamp.class));
            for (String sql : sqlCaptor.getAllValues()) {
                assertThat(sql).contains("route = 'STRONG'").contains("outcome = 'ANSWERED'");
            }
        } finally {
            service.stop();
            server.stop(0);
        }
    }

    @Test
    void fourTierAdaptiveIntelligencePreservesDeepReasoningOnTierCWhileKeepingTierBUltraFast() {
        long t0 = System.nanoTime();
        var fastHit = EchoVoiceFastPathMatcher.evaluate("Open Reading", "/dashboard", false, false);
        long elapsedUs = (System.nanoTime() - t0) / 1_000L;
        assertThat(fastHit.plan()).isNotNull();
        assertThat(elapsedUs).isLessThan(10_000L);

        EchoModels models = new EchoModels();

        // Tier B: Simple conversational voice query -> FAST + effort="none"
        String tierBQuery = "How do I greet a colleague politely in the morning?";
        EchoPolicy.Intent tierBIntent = EchoPolicy.intent(tierBQuery);
        EchoRouter.Route tierBRoute = EchoRouter.route(tierBIntent, tierBQuery, true, true);
        boolean tierBDeep = EchoRouter.tierCDeepReasoning(tierBIntent, tierBQuery, tierBRoute);
        assertThat(tierBRoute).isEqualTo(EchoRouter.Route.FAST);
        assertThat(tierBDeep).isFalse();
        assertThat(models.reasoningEffortFor(tierBRoute, true, tierBDeep)).isEqualTo("none");
        assertThat(EchoRouter.classifyTier(tierBIntent, tierBQuery, tierBRoute, false))
                .isEqualTo(EchoRouter.IntelligenceTier.TIER_B_CONVERSATIONAL);

        // Tier C (explicit deep voice query): escalates voice to STRONG + effort="low" (never "none") + fullProfile=true
        String tierCVoiceQuery = "Analyze my Learner DNA strengths and weaknesses in detail and build a 2-week study plan";
        EchoPolicy.Intent tierCIntent = EchoPolicy.intent(tierCVoiceQuery);
        EchoRouter.Route tierCVoiceRoute = EchoRouter.route(tierCIntent, tierCVoiceQuery, true, true);
        boolean tierCVoiceDeep = EchoRouter.tierCDeepReasoning(tierCIntent, tierCVoiceQuery, tierCVoiceRoute);
        assertThat(tierCVoiceRoute).isEqualTo(EchoRouter.Route.STRONG);
        assertThat(tierCVoiceDeep).isTrue();
        assertThat(models.reasoningEffortFor(tierCVoiceRoute, true, tierCVoiceDeep)).isEqualTo("low");
        assertThat(models.reasoningEffortFor(tierCVoiceRoute, false, tierCVoiceDeep)).isEqualTo("medium");
        assertThat(EchoRouter.fullProfile(tierCIntent, tierCVoiceQuery)).isTrue();
        assertThat(EchoRouter.classifyTier(tierCIntent, tierCVoiceQuery, tierCVoiceRoute, true))
                .isEqualTo(EchoRouter.IntelligenceTier.TIER_C_DEEP_EDUCATIONAL);

        // Short weakness voice question stays FAST (900 max_tokens) while preserving analytical reasoning ("low")
        String shortWeakness = "Mình yếu gì?";
        EchoPolicy.Intent swIntent = EchoPolicy.intent(shortWeakness);
        EchoRouter.Route swRoute = EchoRouter.route(swIntent, shortWeakness, true, true);
        assertThat(swRoute).isEqualTo(EchoRouter.Route.FAST);
        assertThat(models.maxTokens(swRoute, true)).isEqualTo(900);
        assertThat(EchoRouter.tierCDeepReasoning(swIntent, shortWeakness, swRoute)).isTrue();
        assertThat(models.reasoningEffortFor(swRoute, true, true)).isEqualTo("low");

        // Tier D: Agentic tool query -> TIER_D_AGENTIC_TOOLS
        String tierDQuery = "Find B1 reading passages about technology for me";
        EchoPolicy.Intent tierDIntent = EchoPolicy.intent(tierDQuery);
        EchoRouter.Route tierDRoute = EchoRouter.route(tierDIntent, tierDQuery, true, true);
        assertThat(EchoRouter.classifyTier(tierDIntent, tierDQuery, tierDRoute, true))
                .isEqualTo(EchoRouter.IntelligenceTier.TIER_D_AGENTIC_TOOLS);
    }

    @Test
    void speechStreamSetsXAccelBufferingNoAndAiChatRequestDeserializesSessionId() throws Exception {
        SpeakingTtsService tts = mock(SpeakingTtsService.class);
        doAnswer(inv -> {
            @SuppressWarnings("unchecked")
            Consumer<byte[]> sink = inv.getArgument(3);
            sink.accept(new byte[]{1, 2, 3, 4});
            return null;
        }).when(tts).streamEchoSentence(eq(42L), eq("us_female"), eq("Hello there"), any());

        EchoIntelligenceController controller = new EchoIntelligenceController(
                null, null, null, null, null, tts);
        MockHttpServletResponse response = new MockHttpServletResponse();
        UserDetailsImpl principal = new UserDetailsImpl(42L, "u42@example.com", "pw", List.of());

        controller.streamSpeech(principal, new EchoIntelligenceController.SpeechStreamRequest("us_female", "Hello there"), response);
        assertThat(response.getHeader("X-Accel-Buffering")).isEqualTo("no");
        assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
        assertThat(response.getHeader("X-Sample-Rate")).isEqualTo("24000");

        AiChatRequest withSession = mapper.readValue(
                "{\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}],\"channel\":\"text\",\"locale\":\"en\",\"turnId\":\"turn-12345678\",\"sessionId\":99,\"clientExtra\":true}",
                AiChatRequest.class);
        assertThat(withSession.sessionId()).isEqualTo(99L);
        assertThat(withSession.english()).isTrue();

        AiChatRequest withoutSession = mapper.readValue(
                "{\"messages\":[{\"role\":\"user\",\"content\":\"Xin chào\"}],\"channel\":\"voice\",\"locale\":\"vi\",\"turnId\":\"turn-87654321\"}",
                AiChatRequest.class);
        assertThat(withoutSession.sessionId()).isNull();
        assertThat(withoutSession.voice()).isTrue();
    }

    @Test
    void liveEndToEndFailoverToLocal8018StreamsPersonalizedEnglishAndVietnameseVoiceAndTtsPcm() throws Exception {
        org.junit.jupiter.api.Assumptions.assumeTrue(
                Boolean.getBoolean("echo.live8018"), "Live 127.0.0.1:8018 E2E probe runs when -Decho.live8018=true");
        String svcKey = System.getenv("AI_SERVICE_KEY");
        org.junit.jupiter.api.Assumptions.assumeTrue(
                svcKey != null && !svcKey.isBlank(), "AI_SERVICE_KEY required in environment");

        AtomicInteger brokenOpenRouterCalls = new AtomicInteger(0);
        HttpServer brokenOpenRouter = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        brokenOpenRouter.setExecutor(Executors.newCachedThreadPool());
        brokenOpenRouter.createContext("/api/v1/chat/completions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            brokenOpenRouterCalls.incrementAndGet();
            byte[] err = "{\"error\":{\"message\":\"Request path cannot be relayed\",\"code\":400}}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(400, err.length);
            try (OutputStream os = exchange.getResponseBody()) { os.write(err); }
        });
        brokenOpenRouter.start();

        String brokenOrUrl = "http://127.0.0.1:" + brokenOpenRouter.getAddress().getPort() + "/api/v1";
        com.englishcoach.ai.echo.EchoLearnerBrain brain = mock(com.englishcoach.ai.echo.EchoLearnerBrain.class);
        when(brain.snapshot(eq(901L), org.mockito.ArgumentMatchers.anyBoolean(), org.mockito.ArgumentMatchers.anyBoolean()))
                .thenReturn(new com.englishcoach.ai.echo.EchoLearnerBrain.Snapshot(
                        "{\"verifiedProficiency\":{\"overall\":{\"status\":\"VERIFIED\",\"currentCefr\":\"B1\"}},"
                                + "\"vocabulary\":{\"dueCards\":14},\"grammar\":{\"weakTopics\":[\"conditionals\"]},"
                                + "\"consistency\":{\"streakDays\":6}}",
                        "B1", "VERIFIED"));

        OpenRouterChatServiceImpl service = new OpenRouterChatServiceImpl(
                new RestTemplate(), "sk-or-test-relay-broken", brokenOrUrl, "openai/gpt-6-luna", null, mapper);
        EchoModels models = new EchoModels(
                "openai/gpt-6-luna", "anthropic/claude-haiku-5.5",
                "openai/gpt-6.1-terra", "openai/gpt-6-luna", 1);
        EchoUsageLedger ledger = mock(EchoUsageLedger.class);
        when(ledger.strongToday(anyLong())).thenReturn(0);
        service.useIntelligence(models, minimalRegistry(), brain, ledger, emptyDestinations());
        service.useLocalLlmFallback("http://127.0.0.1:8018", svcKey, "echo-local-instruct", 45_000L);

        SpeakingTtsService realTts = new SpeakingTtsService(null, null, null);
        org.springframework.test.util.ReflectionTestUtils.setField(realTts, "omnivoiceUrl", "http://127.0.0.1:8005/tts/omnivoice");
        org.springframework.test.util.ReflectionTestUtils.setField(realTts, "aiBaseUrl", "http://127.0.0.1:8018");
        org.springframework.test.util.ReflectionTestUtils.setField(realTts, "aiServiceKey", svcKey);
        org.springframework.test.util.ReflectionTestUtils.setField(realTts, "timeoutMs", 30_000);
        org.springframework.test.util.ReflectionTestUtils.setField(realTts, "synthesizeMaxConcurrent", 6);

        try {
            // Turn 1 (English Voice): OpenRouter returns 400 "Request path cannot be relayed" -> trips 45s breaker ->
            // fails over to live 127.0.0.1:8018 Qwen3-4B-Instruct-2507 -> streams spoken English -> Kokoro-82M 24kHz PCM!
            long t1Start = System.nanoTime();
            long[] enFirstDeltaMs = {-1L};
            CompletableFuture<AiChatResponse> enDone = new CompletableFuture<>();
            service.streamVoiceTurn(901L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "Based on my profile, what should I focus on today?")),
                            null, "voice", "en", "turn-live8018-en"),
                    new AiChatService.VoiceStreamCallbacks() {
                        @Override public void onStatus(String status) {}
                        @Override public void onDelta(String textDelta) {
                            if (enFirstDeltaMs[0] < 0) enFirstDeltaMs[0] = (System.nanoTime() - t1Start) / 1_000_000L;
                        }
                        @Override public void onActions(List<com.englishcoach.ai.dto.EchoAction> actions) {}
                        @Override public void onCards(List<com.englishcoach.ai.dto.EchoCard> cards) {}
                        @Override public void onComplete(AiChatResponse finalResponse) { enDone.complete(finalResponse); }
                        @Override public void onError(int status, String code, String kind, Instant resetsAt) {
                            enDone.completeExceptionally(new AssertionError("Live EN error: " + status + " " + code));
                        }
                    });
            AiChatResponse enRes = enDone.get(25, TimeUnit.SECONDS);
            int callsAfterTurn1 = brokenOpenRouterCalls.get();
            assertThat(enRes.reply()).isNotBlank().doesNotContain("<think>", "</think>");
            assertThat(service.isOpenRouterCircuitOpen()).isTrue();

            String enClause0 = enRes.reply().length() > 180 ? enRes.reply().substring(0, 180) : enRes.reply();
            AtomicInteger enPcmBytes = new AtomicInteger(0);
            long ttsEnStart = System.nanoTime();
            long[] enTtfaMs = {-1L};
            realTts.streamEchoSentence(901L, "us_female", enClause0, chunk -> {
                if (enTtfaMs[0] < 0) enTtfaMs[0] = (System.nanoTime() - ttsEnStart) / 1_000_000L;
                enPcmBytes.addAndGet(chunk.length);
            });
            assertThat(enPcmBytes.get()).isGreaterThan(4800);

            // Turn 2 (Vietnamese Voice): Circuit breaker is OPEN -> 0 OpenRouter calls, instant 0 ms failover to :8018 ->
            // streams Vietnamese answer -> VieNeu-v3-Turbo 24kHz PCM!
            long t2Start = System.nanoTime();
            long[] viFirstDeltaMs = {-1L};
            CompletableFuture<AiChatResponse> viDone = new CompletableFuture<>();
            service.streamVoiceTurn(901L,
                    new AiChatRequest(List.of(new AiChatMessageDto("user", "Hôm nay mình còn bao nhiêu thẻ từ vựng cần ôn và nên học gì?")),
                            null, "voice", "vi", "turn-live8018-vi"),
                    new AiChatService.VoiceStreamCallbacks() {
                        @Override public void onStatus(String status) {}
                        @Override public void onDelta(String textDelta) {
                            if (viFirstDeltaMs[0] < 0) viFirstDeltaMs[0] = (System.nanoTime() - t2Start) / 1_000_000L;
                        }
                        @Override public void onActions(List<com.englishcoach.ai.dto.EchoAction> actions) {}
                        @Override public void onCards(List<com.englishcoach.ai.dto.EchoCard> cards) {}
                        @Override public void onComplete(AiChatResponse finalResponse) { viDone.complete(finalResponse); }
                        @Override public void onError(int status, String code, String kind, Instant resetsAt) {
                            viDone.completeExceptionally(new AssertionError("Live VI error: " + status + " " + code));
                        }
                    });
            AiChatResponse viRes = viDone.get(25, TimeUnit.SECONDS);
            assertThat(brokenOpenRouterCalls.get()).isEqualTo(callsAfterTurn1); // 0 OpenRouter calls while circuit OPEN!
            assertThat(viRes.reply()).isNotBlank().doesNotContain("<think>", "</think>");

            String viClause0 = viRes.reply().length() > 180 ? viRes.reply().substring(0, 180) : viRes.reply();
            AtomicInteger viPcmBytes = new AtomicInteger(0);
            long ttsViStart = System.nanoTime();
            long[] viTtfaMs = {-1L};
            realTts.streamEchoSentence(901L, "us_female", viClause0, chunk -> {
                if (viTtfaMs[0] < 0) viTtfaMs[0] = (System.nanoTime() - ttsViStart) / 1_000_000L;
                viPcmBytes.addAndGet(chunk.length);
            }, true);
            assertThat(viPcmBytes.get()).isGreaterThan(4800);

            System.out.printf(
                    "[LIVE-8018-E2E] EN firstVisibleDeltaMs=%d ttsTtfaMs=%d pcmBytes=%d replyLen=%d | VI(breaker-open) firstVisibleDeltaMs=%d ttsTtfaMs=%d pcmBytes=%d replyLen=%d%n",
                    enFirstDeltaMs[0], enTtfaMs[0], enPcmBytes.get(), enRes.reply().length(),
                    viFirstDeltaMs[0], viTtfaMs[0], viPcmBytes.get(), viRes.reply().length());
        } finally {
            service.stop();
            brokenOpenRouter.stop(0);
        }
    }

    private static void sendSseAnswer(com.sun.net.httpserver.HttpExchange exchange, String content) throws java.io.IOException {
        String sse = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"" + content + "\"}}]}\n\n"
                + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":80,\"completion_tokens\":12}}\n\n"
                + "data: [DONE]\n\n";
        byte[] out = sse.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
        exchange.sendResponseHeaders(200, out.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(out);
        }
    }

    private static AiChatResponse awaitVoiceTurn(OpenRouterChatServiceImpl service, long userId, AiChatRequest req) throws Exception {
        CompletableFuture<AiChatResponse> done = new CompletableFuture<>();
        service.streamVoiceTurn(userId, req, new AiChatService.VoiceStreamCallbacks() {
            @Override public void onStatus(String status) {}
            @Override public void onDelta(String textDelta) {}
            @Override public void onActions(List<com.englishcoach.ai.dto.EchoAction> actions) {}
            @Override public void onCards(List<com.englishcoach.ai.dto.EchoCard> cards) {}
            @Override public void onComplete(AiChatResponse finalResponse) { done.complete(finalResponse); }
            @Override public void onError(int status, String code, String kind, Instant resetsAt) {
                done.completeExceptionally(new AssertionError("Unexpected voice error: " + status + " " + code));
            }
        });
        return done.get(8, TimeUnit.SECONDS);
    }
}
