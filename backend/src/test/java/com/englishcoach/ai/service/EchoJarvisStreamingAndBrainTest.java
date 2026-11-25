package com.englishcoach.ai.service;

import com.englishcoach.ai.controller.EchoIntelligenceController;
import com.englishcoach.ai.controller.EchoTranscriptionController;
import com.englishcoach.ai.dto.*;
import com.englishcoach.ai.echo.*;
import com.englishcoach.ai.echo.tools.OpenPageTool;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.echocoach.entity.EchoCoachMessage;
import com.englishcoach.echocoach.entity.EchoCoachSession;
import com.englishcoach.echocoach.repository.EchoCoachMessageRepository;
import com.englishcoach.echocoach.repository.EchoCoachSessionRepository;
import com.englishcoach.echocoach.service.EchoCoachServiceImpl;
import com.englishcoach.flashcard.service.FlashcardService;
import com.englishcoach.grammar.GrammarContent;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.proficiency.api.ProficiencyDtos;
import com.englishcoach.proficiency.api.ProficiencyQueryService;
import com.englishcoach.progress.dto.UnifiedStreakDto;
import com.englishcoach.progress.service.UnifiedProgressService;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingTurnRepository;
import com.englishcoach.speaking.service.SpeakingAudioStorageService;
import com.englishcoach.speaking.service.SpeakingTtsService;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.web.client.RestTemplate;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class EchoJarvisStreamingAndBrainTest {

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
    void voiceVisibleTextReleasesClauseZeroFastWhileStrippingEchoMetaAndSecrets() {
        List<String> chunks = new ArrayList<>();
        EchoVisibleText gate = new EchoVisibleText(
                "private system line that exceeds sixty five characters to guard against verbatim copying in output",
                EchoPolicy.Intent.GRAMMAR,
                EchoVisibleText.Mode.VOICE,
                chunks::add);

        String clause0 = "Sure, I opened the B1 reading lesson for you right now. ";
        String clause1 = "Let us check paragraph one together [ECHO_META]{\"debug\":true}[/ECHO_META]";
        gate.advance(clause0);
        assertThat(chunks).isNotEmpty();
        assertThat(String.join("", chunks)).startsWith("Sure, I opened");

        String cleanedFinal = EchoPolicy.output(clause0 + clause1, "prompt", EchoPolicy.Intent.GRAMMAR);
        gate.finish(cleanedFinal);
        String full = String.join("", chunks);
        assertThat(full).doesNotContain("ECHO_META", "debug");
        assertThat(full).contains("Sure, I opened the B1 reading lesson", "Let us check paragraph one together");

        assertThat(EchoPolicy.redactSecrets("Token sk-or-v1-abcdefghijklmnopqrstuvwx123456 here"))
                .contains("[REDACTED]")
                .doesNotContain("abcdefghijklmnopqrstuvwx123456");
    }

    @Test
    void roundZeroStreamsTokensWithToolsAttachedAndDispatchesActionsBeforeRoundOneCompletes() throws Exception {
        CountDownLatch allowRoundOneFinish = new CountDownLatch(1);
        CountDownLatch roundZeroActionDispatched = new CountDownLatch(1);
        AtomicInteger callIndex = new AtomicInteger(0);
        AtomicBoolean actionArrivedBeforeRoundOneText = new AtomicBoolean(false);
        List<String> timeline = new CopyOnWriteArrayList<>();

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            int round = callIndex.getAndIncrement();
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try (OutputStream os = exchange.getResponseBody()) {
                if (round == 0) {
                    // Round 0 calls open_page tool
                    String p1 = "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_nav\",\"type\":\"function\",\"function\":{\"name\":\"open_page\",\"arguments\":\"{\\\"destination\\\":\\\"reading_mybooks\\\"}\"}}]}}]}\n\n";
                    String p2 = "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":15,\"cost\":0.0001}}\n\n";
                    os.write((p1 + p2 + "data: [DONE]\n\n").getBytes(StandardCharsets.UTF_8));
                    os.flush();
                } else {
                    // Wait until Round-0 action was already dispatched before finishing Round-1 speech!
                    boolean dispatchedEarly = roundZeroActionDispatched.await(3, TimeUnit.SECONDS);
                    if (dispatchedEarly) {
                        allowRoundOneFinish.countDown();
                    }
                    String s1 = "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"I opened My Books for you right now, so you can pick up where you left off.\"}}]}\n\n";
                    String s2 = "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":140,\"completion_tokens\":20,\"cost\":0.0001}}\n\n";
                    os.write((s1 + s2 + "data: [DONE]\n\n").getBytes(StandardCharsets.UTF_8));
                    os.flush();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        // Second context for pure Round-0 conversational turn with tools attached (no tool called)
        AtomicBoolean directConversationalMode = new AtomicBoolean(false);
        HttpServer convServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        convServer.createContext("/v1/chat/completions", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try (OutputStream os = exchange.getResponseBody()) {
                String c1 = "data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Great question, let us practise your speaking fluency together right now. \"}}]}\n\n";
                os.write(c1.getBytes(StandardCharsets.UTF_8));
                os.flush();
                Thread.sleep(60);
                String c2 = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Tell me about your favourite book.\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":25,\"cost\":0.0001}}\n\ndata: [DONE]\n\n";
                os.write(c2.getBytes(StandardCharsets.UTF_8));
                os.flush();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        server.start();
        convServer.start();

        try {
            EchoDestinations destinations = new EchoDestinations(
                    none(GrammarContent.class), none(ReadingMaterialRepository.class), none(ListeningMaterialRepository.class));
            EchoToolRegistry registry = new EchoToolRegistry(
                    List.of(new OpenPageTool(destinations, mapper)), mapper, none(PlatformTransactionManager.class));
            EchoModels models = new EchoModels("fast-m", "fast-fb", "strong-m", "strong-fb", 3);

            // 1. Verify mid-turn immediate action dispatch on Round 0 BEFORE Round 1 completes (and deduplicated at end)
            OpenRouterChatServiceImpl svc = new OpenRouterChatServiceImpl(
                    new RestTemplate(), "sk-test-key", "http://127.0.0.1:" + server.getAddress().getPort() + "/v1", "fast-m", null, mapper);
            svc.useIntelligence(models, registry, null, mock(EchoUsageLedger.class), destinations);

            CountDownLatch doneLatch = new CountDownLatch(1);
            List<EchoAction> receivedActions = new CopyOnWriteArrayList<>();
            AiChatRequest navReq = new AiChatRequest(
                    List.of(new AiChatMessageDto("user", "Open my books shelf and suggest how to read")),
                    null, "voice", "en", "turn-mid-action-1");

            svc.streamVoiceTurn(42L, navReq, new AiChatService.VoiceStreamCallbacks() {
                @Override
                public void onDelta(String delta) {
                    timeline.add("delta:" + delta);
                }

                @Override
                public void onActions(List<EchoAction> actions) {
                    if (timeline.stream().noneMatch(s -> s.startsWith("delta:"))) {
                        actionArrivedBeforeRoundOneText.set(true);
                    }
                    timeline.add("actions:" + actions.size());
                    receivedActions.addAll(actions);
                    roundZeroActionDispatched.countDown();
                }

                @Override
                public void onComplete(AiChatResponse response) {
                    timeline.add("complete");
                    doneLatch.countDown();
                }
            });

            assertThat(doneLatch.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(actionArrivedBeforeRoundOneText.get()).isTrue();
            // Deduplicated: exactly 1 action emitted across the whole turn!
            assertThat(receivedActions).hasSize(1);
            assertThat(receivedActions.get(0).href()).isEqualTo("/reading?section=mybooks");
            assertThat(receivedActions.get(0).auto()).isTrue();

            // 2. Verify Round-0 live delta streaming when tools ARE attached (`tool_choice: "auto"`) and 0 tools called
            OpenRouterChatServiceImpl convSvc = new OpenRouterChatServiceImpl(
                    new RestTemplate(), "sk-test-key", "http://127.0.0.1:" + convServer.getAddress().getPort() + "/v1", "fast-m", null, mapper);
            convSvc.useIntelligence(models, registry, null, mock(EchoUsageLedger.class), destinations);
            directConversationalMode.set(true);

            CountDownLatch convDone = new CountDownLatch(1);
            List<String> deltas = new CopyOnWriteArrayList<>();
            AiChatRequest convReq = new AiChatRequest(
                    List.of(new AiChatMessageDto("user", "I want to practise speaking about my study routine")),
                    null, "voice", "en", "turn-round0-live-1");
            convSvc.streamVoiceTurn(42L, convReq, new AiChatService.VoiceStreamCallbacks() {
                @Override public void onDelta(String delta) { deltas.add(delta); }
                @Override public void onComplete(AiChatResponse response) { convDone.countDown(); }
            });
            assertThat(convDone.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(deltas.size()).isGreaterThanOrEqualTo(2);
            assertThat(String.join("", deltas)).contains("Great question", "Tell me about your favourite book.");
        } finally {
            server.stop(0);
            convServer.stop(0);
        }
    }

    @Test
    void coldEchoLearnerBrainBuildsSubQueriesInParallelAndIsolatesFailures() {
        ProficiencyQueryService prof = mock(ProficiencyQueryService.class);
        when(prof.me(99L)).thenAnswer(inv -> {
            Thread.sleep(110);
            return new ProficiencyDtos.ProficiencyMeResponse(
                    new ProficiencyDtos.OverallDto(1200, "B2", 1200, "B2", 0.85, "VERIFIED", "HIGH"),
                    List.of(), null, Map.of(), false);
        });
        FlashcardService cards = mock(FlashcardService.class);
        when(cards.countReviewDue(99L)).thenAnswer(inv -> { Thread.sleep(110); return 8L; });
        when(cards.countActualDue(99L)).thenReturn(15L);

        UnifiedProgressService prog = mock(UnifiedProgressService.class);
        when(prog.getStreak(99L)).thenAnswer(inv -> {
            Thread.sleep(110);
            return new UnifiedStreakDto(5, 12, true);
        });
        LearnerDnaAggregatorService dna = mock(LearnerDnaAggregatorService.class);
        when(dna.getLearnerDnaJson(99L)).thenAnswer(inv -> {
            Thread.sleep(110);
            return "{\"reading\":{\"estimated_band_score\":6.5}}";
        });

        EchoLearnerBrain brain = new EchoLearnerBrain(
                mapper,
                none(PlatformTransactionManager.class),
                of(ProficiencyQueryService.class, prof),
                none(com.englishcoach.learningpath.LearningPathService.class), // missing -> isolated into unknown
                of(LearnerDnaAggregatorService.class, dna),
                none(com.englishcoach.exams.repository.ExamProfileRepository.class),
                none( com.englishcoach.grammar.GrammarService.class),
                of(FlashcardService.class, cards),
                of(UnifiedProgressService.class, prog),
                none(EchoMemoryService.class));
        try {
            long t0 = System.nanoTime();
            EchoLearnerBrain.Snapshot snap = brain.snapshot(99L, true, false);
            long elapsedMs = (System.nanoTime() - t0) / 1_000_000;

            // 4 x 110ms sections serially would take >= 440ms; parallel 4-thread pool completes in ~120-260ms!
            assertThat(elapsedMs).isLessThan(380L);
            assertThat(snap.levelCefr()).isEqualTo("B2");
            assertThat(snap.json()).contains("\"currentCefr\":\"B2\"", "\"reviewDueNow\":8", "\"currentStreakDays\":5");
            assertThat(snap.json()).contains("\"unknown\"");
        } finally {
            brain.shutdown();
        }
    }

    @Test
    void warmTruncateTurnCheckAutoLangAndStreamingTtsBehavePerContract() throws Exception {
        // 1. Truncate latest assistant message on EchoCoachServiceImpl (enforces session ownership!)
        EchoCoachSessionRepository sessionRepo = mock(EchoCoachSessionRepository.class);
        EchoCoachMessageRepository msgRepo = mock(EchoCoachMessageRepository.class);
        EchoCoachServiceImpl coach = new EchoCoachServiceImpl(sessionRepo, msgRepo);

        EchoCoachSession session = EchoCoachSession.builder().id(77L).userId(42L).title("Voice").createdAt(Instant.now()).updatedAt(Instant.now()).build();
        EchoCoachMessage m1 = EchoCoachMessage.builder().id(1L).sessionId(77L).role("user").content("Explain agree").createdAt(Instant.now()).build();
        EchoCoachMessage m2 = EchoCoachMessage.builder().id(2L).sessionId(77L).role("assistant")
                .content("Almost! Instead of I am agree, say I agree. Remember agree is already a verb.").createdAt(Instant.now()).build();
        when(sessionRepo.findByIdAndUserId(77L, 42L)).thenReturn(Optional.of(session));
        when(msgRepo.findBySessionIdOrderByCreatedAtAsc(77L)).thenReturn(List.of(m1, m2));

        EchoLearnerBrain brain = mock(EchoLearnerBrain.class);
        SpeakingAudioStorageService storage = mock(SpeakingAudioStorageService.class);
        SpeakingTtsService tts = new SpeakingTtsService(storage, mock(SpeakingSessionRepository.class), mock(SpeakingTurnRepository.class));

        // Verify remote Tailscale aiBaseUrl puts :8000/api/v1/tts/omnivoice FIRST ahead of default 127.0.0.1:8005!
        ReflectionTestUtils.setField(tts, "aiBaseUrl", "http://198.51.100.16:8000");
        ReflectionTestUtils.setField(tts, "omnivoiceUrl", "http://127.0.0.1:8005/tts/omnivoice");
        List<String> orderedUrls = new ArrayList<>(tts.buildOmnivoiceCandidateUrls());
        assertThat(orderedUrls.get(0)).isEqualTo("http://198.51.100.16:8000/api/v1/tts/omnivoice");

        // Local mock GPU server for /api/v1/tts/stream, /api/v1/tts/omnivoice WAV fallback, and /api/v1/coach/transcribe?lang=auto
        AtomicBoolean failStreamEndpoint = new AtomicBoolean(false);
        HttpServer gpu = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        gpu.createContext("/api/v1/tts/stream", ex -> {
            ex.getRequestBody().readAllBytes();
            if (failStreamEndpoint.get()) {
                ex.sendResponseHeaders(404, -1);
                ex.close();
                return;
            }
            byte[] pcm = new byte[3840];
            Arrays.fill(pcm, (byte) 0x12);
            ex.getResponseHeaders().set("Content-Type", "application/octet-stream");
            ex.sendResponseHeaders(200, pcm.length);
            ex.getResponseBody().write(pcm);
            ex.getResponseBody().close();
        });
        gpu.createContext("/api/v1/tts/omnivoice", ex -> {
            ex.getRequestBody().readAllBytes();
            byte[] wav = buildMinimalWav(new byte[]{1, 2, 3, 4, 5, 6, 7, 8});
            ex.getResponseHeaders().set("Content-Type", "audio/wav");
            ex.sendResponseHeaders(200, wav.length);
            ex.getResponseBody().write(wav);
            ex.getResponseBody().close();
        });
        gpu.createContext("/api/v1/coach/transcribe", ex -> {
            ex.getRequestBody().readAllBytes();
            String q = ex.getRequestURI().getQuery();
            byte[] body = ("{\"text\":\"Open reading please\",\"reviewNeeded\":false,\"language\":\"" + (q.contains("auto") ? "en" : "vi") + "\"}")
                    .getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "application/json");
            ex.sendResponseHeaders(200, body.length);
            ex.getResponseBody().write(body);
            ex.getResponseBody().close();
        });
        gpu.start();

        try {
            String gpuBase = "http://127.0.0.1:" + gpu.getAddress().getPort();
            ReflectionTestUtils.setField(tts, "aiBaseUrl", gpuBase);
            ReflectionTestUtils.setField(tts, "omnivoiceUrl", gpuBase + "/api/v1/tts/omnivoice");
            ReflectionTestUtils.setField(tts, "timeoutMs", 4000);

            EchoIntelligenceController intel = new EchoIntelligenceController(
                    mock(EchoMemoryService.class), brain, mock(EchoConfirmations.class), mock(EchoSuggestionService.class), coach, tts);
            UserDetailsImpl principal = new UserDetailsImpl(42L, "learner@example.com", "pw", List.of());

            // /api/v1/ai/chat/warm -> 200 {warm: true}, calls brain.warm(42L)
            var warmRes = intel.warm(principal);
            assertThat(warmRes.getBody()).containsEntry("warm", true);
            verify(brain).warm(42L);

            // /api/v1/ai/chat/truncate -> slices stored assistant message to heard prefix
            var truncRes = intel.truncate(principal, new EchoIntelligenceController.TruncateRequest(77L, "Almost! Instead of I am agree, say I agree."));
            assertThat(truncRes.getBody()).containsEntry("truncated", true);
            assertThat(m2.getContent()).isEqualTo("Almost! Instead of I am agree, say I agree.");

            // Foreign session truncate -> 404
            assertThatThrownBy(() -> intel.truncate(new UserDetailsImpl(99L, "other@example.com", "pw", List.of()),
                    new EchoIntelligenceController.TruncateRequest(77L, "short")))
                    .hasMessageContaining("404");

            // /api/v1/ai/chat/speech/stream -> streams 24kHz PCM16LE with X-Sample-Rate: 24000
            MockHttpServletResponse streamResp = new MockHttpServletResponse();
            intel.streamSpeech(principal, new EchoIntelligenceController.SpeechStreamRequest("uk_male", "Good morning, ready when you are."), streamResp);
            assertThat(streamResp.getStatus()).isEqualTo(200);
            assertThat(streamResp.getHeader("X-Sample-Rate")).isEqualTo("24000");
            assertThat(streamResp.getContentAsByteArray()).hasSize(3840);

            // WAV PCM-strip fallback when /tts/stream returns 404
            failStreamEndpoint.set(true);
            ByteArrayOutputStream fallbackPcm = new ByteArrayOutputStream();
            tts.streamEchoSentence(42L, "us_female", "Fallback check.", fallbackPcm::writeBytes);
            assertThat(fallbackPcm.toByteArray()).containsExactly(1, 2, 3, 4, 5, 6, 7, 8);

            // /api/v1/ai/chat/transcribe?lang=auto & /api/v1/ai/chat/turn-check safe offline fallback
            EchoTranscriptionController stt = new EchoTranscriptionController(gpuBase, tts);
            MockHttpServletRequest sttReq = new MockHttpServletRequest();
            byte[] pcm16 = new byte[3200];
            sttReq.setContent(pcm16);
            var tr = stt.transcribe(principal, "auto", sttReq);
            assertThat(tr.getBody()).isNotNull();
            assertThat(tr.getBody().text()).isEqualTo("Open reading please");
            assertThat(tr.getBody().language()).isEqualTo("en");

            // Unreachable GPU on /turn-check -> returns safe fallback {complete: true, probability: 0.7, recommendedWaitMs: 350}
            EchoTranscriptionController offlineTurn = new EchoTranscriptionController("http://127.0.0.1:9", tts);
            MockHttpServletRequest turnReq = new MockHttpServletRequest();
            turnReq.setContent(new byte[1600]);
            var turnRes = offlineTurn.turnCheck(principal, turnReq);
            assertThat(turnRes.getBody()).isEqualTo(new EchoTranscriptionController.TurnCheckResult(true, 0.7, 350));
        } finally {
            gpu.stop(0);
        }
    }

    private static byte[] buildMinimalWav(byte[] pcmData) {
        ByteBuffer buf = ByteBuffer.allocate(44 + pcmData.length).order(ByteOrder.LITTLE_ENDIAN);
        buf.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(36 + pcmData.length);
        buf.put("WAVE".getBytes(StandardCharsets.US_ASCII));
        buf.put("fmt ".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(16);
        buf.putShort((short) 1);
        buf.putShort((short) 1);
        buf.putInt(24000);
        buf.putInt(48000);
        buf.putShort((short) 2);
        buf.putShort((short) 16);
        buf.put("data".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(pcmData.length);
        buf.put(pcmData);
        return buf.array();
    }
}
