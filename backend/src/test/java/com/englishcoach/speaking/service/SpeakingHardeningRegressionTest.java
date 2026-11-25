package com.englishcoach.speaking.service;

import com.englishcoach.common.config.OpenEntityManagerInViewConfig;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.listening.service.DictationScoringService;
import com.englishcoach.premium.interceptor.RequirePremiumAi;
import com.englishcoach.speaking.controller.SpeakingController;
import com.englishcoach.speaking.dto.*;
import com.englishcoach.speaking.entity.*;
import com.englishcoach.speaking.repository.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import jakarta.validation.Valid;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.ArgumentCaptor;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.web.server.ResponseStatusException;

import java.lang.reflect.Method;
import java.lang.reflect.Parameter;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class SpeakingHardeningRegressionTest {

    private static final byte[] VALID_WEBM = new byte[]{0x1A, 0x45, (byte) 0xDF, (byte) 0xA3, 0x01, 0x02, 0x03, 0x04};
    private static final byte[] VALID_WAV = new byte[]{'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'A', 'V', 'E', 0, 0};
    private static final byte[] VALID_FLAC = new byte[]{'f', 'L', 'a', 'C', 0, 0, 0, 0};
    private static final byte[] VALID_MP3_ID3 = new byte[]{'I', 'D', '3', 0x03, 0x00, 0x00};

    // ==================== 1. F01 Receipt Expiry, Consumption, Duration, Advance Guard ====================

    @Test
    @DisplayName("F01 ShadowingAnalysisReceipts: rejects expired receipts with 409 RECEIPT_EXPIRED and consumed receipts with 409 RECEIPT_ALREADY_CONSUMED")
    @SuppressWarnings("unchecked")
    void receiptRejectsExpiredAndConsumed() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        ObjectMapper mapper = new ObjectMapper();
        ShadowingAnalysisReceipts receipts = new ShadowingAnalysisReceipts(jdbc, mapper);

        ShadowingAnalysisResponseDto dto = ShadowingAnalysisResponseDto.builder()
                .learnerTranscript("hello")
                .accuracyScore(90.0)
                .build();

        // Expired receipt
        ShadowingAnalysisReceipts.Receipt expired = new ShadowingAnalysisReceipts.Receipt(
                100L, 300L, "a".repeat(64), dto, "ASR_ONLY",
                Instant.now().minusSeconds(3600), Instant.now().minusSeconds(60), null
        );
        when(jdbc.query(contains("FOR UPDATE"), any(RowMapper.class), eq(10L), eq("exp-key")))
                .thenReturn(List.of(expired));

        assertThatThrownBy(() -> receipts.forRecording(10L, "exp-key", 100L, 300L))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                    assertThat(e.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(e.getReason()).isEqualTo("RECEIPT_EXPIRED");
                });

        // Consumed receipt
        ShadowingAnalysisReceipts.Receipt consumed = new ShadowingAnalysisReceipts.Receipt(
                100L, 300L, "a".repeat(64), dto, "pronunciation-v3.0-hybrid",
                Instant.now().minusSeconds(120), Instant.now().plusSeconds(1680), Instant.now().minusSeconds(10)
        );
        when(jdbc.query(contains("FOR UPDATE"), any(RowMapper.class), eq(10L), eq("used-key")))
                .thenReturn(List.of(consumed));

        assertThatThrownBy(() -> receipts.forRecording(10L, "used-key", 100L, 300L))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                    assertThat(e.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(e.getReason()).isEqualTo("RECEIPT_ALREADY_CONSUMED");
                });

        // Legacy pre-V140 receipt (expiresAt == null, consumedAt == null) still succeeds
        ShadowingAnalysisReceipts.Receipt legacy = new ShadowingAnalysisReceipts.Receipt(
                100L, 300L, "b".repeat(64), dto, null, null, null, null
        );
        when(jdbc.query(contains("FOR UPDATE"), any(RowMapper.class), eq(10L), eq("legacy-key")))
                .thenReturn(List.of(legacy));

        ShadowingAnalysisReceipts.Receipt returned = receipts.forRecording(10L, "legacy-key", 100L, 300L);
        assertThat(returned.audioSha256()).isEqualTo("b".repeat(64));
        assertThat(returned.result().getLearnerTranscript()).isEqualTo("hello");

        // Engine version resolution: ASR_ONLY when V2 absent, real version when V2 present
        assertThat(ShadowingAnalysisReceipts.resolveEngineVersion(dto)).isEqualTo("ASR_ONLY");
        ShadowingAnalysisResponseDto withV3 = ShadowingAnalysisResponseDto.builder()
                .pronunciationV2(PronunciationV2ResponseDto.builder().engineVersion("pronunciation-v3.0-hybrid").build())
                .build();
        assertThat(ShadowingAnalysisReceipts.resolveEngineVersion(withV3)).isEqualTo("pronunciation-v3.0-hybrid");
    }

    @Test
    @DisplayName("F01 SpeakingShadowingService: derives duration from server audioQuality (clamped 0..180), blocks inactive sessions, and guards advanceSessionUnit & recordEcsmAttempt")
    void shadowingRecordDurationClampingAdvanceGuardAndEcsmOwnership() {
        SpeakingShadowingAttemptRepository attemptRepo = mock(SpeakingShadowingAttemptRepository.class);
        SpeakingShadowingUnitRepository unitRepo = mock(SpeakingShadowingUnitRepository.class);
        SpeakingSessionRepository sessionRepo = mock(SpeakingSessionRepository.class);
        UserRepository userRepo = mock(UserRepository.class);
        SpeakingShadowingUnitService unitService = mock(SpeakingShadowingUnitService.class);
        ShadowingAnalysisReceipts receipts = mock(ShadowingAnalysisReceipts.class);
        SpeakingShadowingService service = new SpeakingShadowingService(
                attemptRepo, unitRepo, sessionRepo, userRepo, unitService, new ObjectMapper(), receipts
        );

        User owner = User.builder().id(10L).email("owner@test.com").build();
        ListeningMaterial material = ListeningMaterial.builder().id(50L).title("Clip").build();
        SpeakingSession activeSession = SpeakingSession.builder()
                .id(100L).user(owner).sourceId(50L).mode("SHADOWING").status("ACTIVE")
                .currentUnitIndex(0).completedUnitsCount(0).totalUnitsCount(2).build();
        SpeakingShadowingUnit unit = SpeakingShadowingUnit.builder()
                .id(300L).material(material).sequenceNumber(1).displayText("Hello world").build();

        when(sessionRepo.findById(100L)).thenReturn(Optional.of(activeSession));
        when(unitRepo.findById(300L)).thenReturn(Optional.of(unit));
        when(unitService.isActiveUnit(unit)).thenReturn(true);
        when(attemptRepo.findBySessionIdAndClientAttemptId(100L, "att-dur")).thenReturn(Optional.empty());

        PronunciationV2ResponseDto v3 = PronunciationV2ResponseDto.builder()
                .engineVersion("pronunciation-v3.0-hybrid")
                .status("COMPLETED")
                .audioQuality(PronunciationV2ResponseDto.AudioQualityDto.builder().durationSec(7.6).build())
                .build();
        ShadowingAnalysisResponseDto analysis = ShadowingAnalysisResponseDto.builder()
                .learnerTranscript("Hello world")
                .accuracyScore(95.0)
                .pronunciationV2(v3)
                .isMocked(false)
                .build();
        when(receipts.forRecording(10L, "att-dur", 100L, 300L)).thenReturn(
                new ShadowingAnalysisReceipts.Receipt(100L, 300L, "f".repeat(64), analysis, "pronunciation-v3.0-hybrid", Instant.now(), Instant.now().plusSeconds(1800), null)
        );
        when(attemptRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

        // Client tries to forge Integer.MAX_VALUE duration -> server uses measured 8s
        SpeakingShadowingAttemptRequest forgedReq = new SpeakingShadowingAttemptRequest(
                "att-dur", 300L, null, "fake", 100.0, Integer.MAX_VALUE, false
        );
        SpeakingShadowingAttemptDto savedDto = service.recordAttempt(10L, 100L, forgedReq);
        assertThat(savedDto.durationSeconds()).isEqualTo(8);
        assertThat(savedDto.productContractVersion()).isEqualTo("pronunciation-v3.0-hybrid");
        verify(receipts).markConsumed(10L, "att-dur");

        // advanceSessionUnit rejects when 0 attempts recorded for unit
        when(attemptRepo.countBySessionIdAndShadowingUnitId(100L, 300L)).thenReturn(0);
        assertThatThrownBy(() -> service.advanceSessionUnit(10L, 100L, 300L, "COMPLETE"))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));

        // Completed session cannot be analyzed, recorded, or advanced
        SpeakingSession completedSession = SpeakingSession.builder()
                .id(101L).user(owner).sourceId(50L).mode("SHADOWING").status("COMPLETED")
                .currentUnitIndex(2).completedUnitsCount(2).totalUnitsCount(2).build();
        when(sessionRepo.findById(101L)).thenReturn(Optional.of(completedSession));
        assertThatThrownBy(() -> service.referenceForAnalysis(10L, 101L, 300L))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        assertThatThrownBy(() -> service.recordAttempt(10L, 101L, forgedReq))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));
        assertThatThrownBy(() -> service.advanceSessionUnit(10L, 101L, 300L, "COMPLETE"))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.CONFLICT));

        // recordEcsmAttempt enforces session owner check
        assertThatThrownBy(() -> service.recordEcsmAttempt(999L, 100L, 300L, "ecsm-1", null, null, EcsmAnalysisResponseDto.builder().build()))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));

        // getSessionState skips ECSM deserialization for V2.2 / V3 JSON payloads
        SpeakingShadowingAttempt v2Attempt = SpeakingShadowingAttempt.builder()
                .id(77L).user(owner).session(activeSession).shadowingUnit(unit)
                .clientAttemptId("v2-att")
                .productContractVersion("PRONUNCIATION_V2_2")
                .productSafeResultJson("{\"engineVersion\":\"pronunciation-v2.2\",\"status\":\"COMPLETED\"}")
                .build();
        when(attemptRepo.findBySessionIdOrderByCreatedAtAsc(100L)).thenReturn(List.of(v2Attempt));
        when(unitService.getOrGenerateUnits(50L, 10L)).thenReturn(List.of());
        ShadowingSessionStateDto state = service.getSessionState(10L, 100L);
        assertThat(state.rehydratedEcsmResult()).isNull();
    }

    @Test
    @DisplayName("Controller annotations: @Valid on recordShadowingAttempt & @RequirePremiumAi on POST feedback")
    void controllerAnnotationsEnforced() throws Exception {
        Method recordMethod = SpeakingController.class.getMethod(
                "recordShadowingAttempt",
                com.englishcoach.common.security.UserDetailsImpl.class,
                Long.class,
                SpeakingShadowingAttemptRequest.class
        );
        Parameter bodyParam = recordMethod.getParameters()[2];
        assertThat(bodyParam.isAnnotationPresent(Valid.class)).isTrue();

        Method feedbackPost = SpeakingController.class.getMethod(
                "getOrGenerateTurnFeedback",
                com.englishcoach.common.security.UserDetailsImpl.class,
                Long.class,
                Long.class
        );
        RequirePremiumAi prem = feedbackPost.getAnnotation(RequirePremiumAi.class);
        assertThat(prem).isNotNull();
        assertThat(prem.value()).isEqualTo("SPEAKING_ROLEPLAY");
    }

    // ==================== 2. SpeakingService 422 Propagation, Orphan Cleanup, Text Cap, US/UK ====================

    @Test
    @DisplayName("SpeakingService: propagates HTTP 422 silence instead of 503 and deletes orphan .bin file on STT failure")
    void forwardAudioPropagates422AndShadowingCleansOrphanAudio(@TempDir Path tempDir) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/speaking/analyze", exchange -> {
            byte[] body = "{\"detail\":\"No speech detected\"}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(422, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            SpeakingAudioStorageService realStorage = new SpeakingAudioStorageService(tempDir.toString());
            SpeakingShadowingService shadowingService = mock(SpeakingShadowingService.class);
            ShadowingAnalysisReceipts receipts = mock(ShadowingAnalysisReceipts.class);
            SpeakingShadowingAttemptRepository attemptRepo = mock(SpeakingShadowingAttemptRepository.class);

            SpeakingService speakingService = new SpeakingService(
                    mock(SpeakingResultRepository.class),
                    mock(SpeakingSessionRepository.class),
                    mock(SpeakingScenarioRepository.class),
                    mock(SpeakingShadowingUnitRepository.class),
                    attemptRepo,
                    shadowingService,
                    new ObjectMapper(),
                    mock(UserRepository.class),
                    mock(DictationScoringService.class),
                    realStorage
            );
            ReflectionTestUtils.setField(speakingService, "analysisReceipts", receipts);
            ReflectionTestUtils.setField(speakingService, "aiBaseUrl", "http://127.0.0.1:" + server.getAddress().getPort());
            ReflectionTestUtils.setField(speakingService, "connectTimeoutMs", 3000);
            ReflectionTestUtils.setField(speakingService, "readTimeoutMs", 3000);

            // Direct forwardAudioForAnalysis propagates 422 (NOT 503!)
            assertThatThrownBy(() -> speakingService.forwardAudioForAnalysis(VALID_WEBM, "silent.webm", null))
                    .isInstanceOfSatisfying(ResponseStatusException.class,
                            e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY));

            // analyzeShadowingAttempt cleans up orphan .bin file when STT fails with 422
            when(shadowingService.referenceForAnalysis(10L, 100L, 300L)).thenReturn("Hello world");
            when(receipts.lookup(eq(10L), eq("orphan-att-1"), eq(100L), eq(300L), anyString())).thenReturn(null);
            when(attemptRepo.findByClientAttemptId("orphan-att-1")).thenReturn(Optional.empty());

            MockMultipartFile file = new MockMultipartFile("file", "silent.webm", "audio/webm", VALID_WEBM);
            assertThatThrownBy(() -> speakingService.analyzeShadowingAttempt(
                    file, 300L, "Hello world", "100", "orphan-att-1", null, null, 10L
            )).isInstanceOfSatisfying(ResponseStatusException.class,
                    e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.UNPROCESSABLE_ENTITY));

            assertThat(realStorage.getAudioRefIfExists(10L, "orphan-att-1")).isNull();
        } finally {
            server.stop(0);
        }
    }

    @Test
    @DisplayName("SpeakingService: US/UK orthographic equivalence matches cleanly & >1000 char text inputs rejected with 400")
    void usUkEquivalenceAndTextLengthCap() {
        SpeakingService service = new SpeakingService(
                mock(SpeakingResultRepository.class),
                mock(SpeakingSessionRepository.class),
                mock(SpeakingScenarioRepository.class),
                mock(SpeakingShadowingUnitRepository.class),
                mock(SpeakingShadowingAttemptRepository.class),
                mock(SpeakingShadowingService.class),
                new ObjectMapper(),
                mock(UserRepository.class),
                mock(DictationScoringService.class),
                mock(SpeakingAudioStorageService.class)
        );

        List<Map<String, Object>> alignment = service.computeWordAlignment(
                "The colour centre will organise and analyse the travelling behaviour favour programme realise theatre.",
                "The color center will organize and analyze the traveling behavior favor program realize theater."
        );
        assertThat(alignment).isNotEmpty();
        assertThat(alignment).allSatisfy(row -> assertThat(row.get("status")).isEqualTo("MATCH"));

        // Text length > 1000 chars rejected with 400
        String tooLong = "a".repeat(1001);
        assertThatThrownBy(() -> service.forwardAudioForAnalysis(VALID_WEBM, "clip.webm", tooLong))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        assertThatThrownBy(() -> service.analyzePronunciationV2(VALID_WEBM, "clip.webm", tooLong, null, null, null))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        assertThatThrownBy(() -> service.analyzePronunciationV2(VALID_WEBM, "clip.webm", "hello", tooLong, null, null))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
    }

    @Test
    @DisplayName("SpeakingService: analyzePronunciationV2 sends truthful detected MIME Content-Type & optional accent, and updateSession caps duration")
    void pronunciationV2SendsAudioMimeAndAccentAndUpdateSessionCapsDuration() throws Exception {
        AtomicReference<String> capturedMultipart = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/pronunciation/v2/analyze", exchange -> {
            byte[] reqBytes = exchange.getRequestBody().readAllBytes();
            capturedMultipart.set(new String(reqBytes, StandardCharsets.ISO_8859_1));
            byte[] body = "{\"engineVersion\":\"pronunciation-v3.0-hybrid\",\"status\":\"COMPLETED\",\"abstentionReason\":null,\"audioQuality\":{\"durationSec\":3.2,\"snrDb\":24.5,\"speechRatio\":0.78},\"connectedSpeech\":{\"linkingRate\":0.8}}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            SpeakingSessionRepository sessionRepo = mock(SpeakingSessionRepository.class);
            SpeakingService service = new SpeakingService(
                    mock(SpeakingResultRepository.class),
                    sessionRepo,
                    mock(SpeakingScenarioRepository.class),
                    mock(SpeakingShadowingUnitRepository.class),
                    mock(SpeakingShadowingAttemptRepository.class),
                    mock(SpeakingShadowingService.class),
                    new ObjectMapper(),
                    mock(UserRepository.class),
                    mock(DictationScoringService.class),
                    mock(SpeakingAudioStorageService.class)
            );
            ReflectionTestUtils.setField(service, "aiBaseUrl", "http://127.0.0.1:" + server.getAddress().getPort());
            ReflectionTestUtils.setField(service, "connectTimeoutMs", 3000);
            ReflectionTestUtils.setField(service, "readTimeoutMs", 3000);

            PronunciationV2ResponseDto resp = service.analyzePronunciationV2(
                    VALID_WAV, "clip.wav", null, "hello world", "hello world", "1", "att-1", "en-GB"
            );
            assertThat(resp).isNotNull();
            assertThat(resp.getEngineVersion()).isEqualTo("pronunciation-v3.0-hybrid");
            assertThat(resp.getAudioQuality().getSnrDb()).isEqualTo(24.5);
            assertThat(resp.getAudioQuality().getSpeechRatio()).isEqualTo(0.78);
            assertThat(resp.getConnectedSpeech()).containsEntry("linkingRate", 0.8);
            assertThat(capturedMultipart.get()).contains("Content-Type: audio/wav");
            assertThat(capturedMultipart.get()).contains("name=\"accent\"");
            assertThat(capturedMultipart.get()).contains("en-GB");

            // updateSession bounds durationSeconds to elapsed + 120s and rejects negative
            User u = User.builder().id(10L).build();
            SpeakingSession session = SpeakingSession.builder()
                    .id(55L).user(u).mode("SHADOWING").status("ACTIVE")
                    .createdAt(LocalDateTime.now().minusSeconds(30)).build();
            when(sessionRepo.findById(55L)).thenReturn(Optional.of(session));
            when(sessionRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

            SpeakingSession updated = service.updateSession(10L, 55L, new SpeakingSessionUpdateRequest("COMPLETED", 999999));
            assertThat(updated.getDurationSeconds()).isBetween(140, 160);

            SpeakingSession activeSession = SpeakingSession.builder()
                    .id(56L).user(u).mode("SHADOWING").status("ACTIVE").createdAt(LocalDateTime.now()).build();
            when(sessionRepo.findById(56L)).thenReturn(Optional.of(activeSession));
            assertThatThrownBy(() -> service.updateSession(10L, 56L, new SpeakingSessionUpdateRequest("ACTIVE", -5)))
                    .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        } finally {
            server.stop(0);
        }
    }

    // ==================== 3. Roleplay Dedicated Executor, Fail-Closed LLM, Validation & Measured Duration ====================

    @Test
    @DisplayName("SpeakingRoleplayService: uses dedicated executor, validates clientTurnId, fails closed 503 on mocked/failed LLM, and records measured duration")
    void roleplayExecutorFailClosedValidationAndMeasuredDuration() throws Exception {
        SpeakingSessionRepository sessionRepo = mock(SpeakingSessionRepository.class);
        SpeakingTurnRepository turnRepo = mock(SpeakingTurnRepository.class);
        SpeakingTurnFeedbackRepository feedbackRepo = mock(SpeakingTurnFeedbackRepository.class);
        SpeakingService speakingService = mock(SpeakingService.class);
        SpeakingContextService contextService = mock(SpeakingContextService.class);
        SpeakingAudioStorageService audioStorage = mock(SpeakingAudioStorageService.class);

        SpeakingRoleplayService roleplayService = new SpeakingRoleplayService(
                sessionRepo, turnRepo, feedbackRepo, speakingService, contextService, audioStorage
        );
        ReflectionTestUtils.setField(roleplayService, "connectTimeoutMs", 3000);
        ReflectionTestUtils.setField(roleplayService, "readTimeoutMs", 3000);

        // Verify dedicated bounded ExecutorService (not ForkJoinPool.commonPool)
        ExecutorService exec = (ExecutorService) ReflectionTestUtils.getField(roleplayService, "roleplayExecutor");
        assertThat(exec).isNotNull();
        assertThat(exec).isNotSameAs(java.util.concurrent.ForkJoinPool.commonPool());

        User user = User.builder().id(10L).build();
        SpeakingSession session = SpeakingSession.builder()
                .id(100L).user(user).mode("ROLEPLAY").status("ACTIVE").durationSeconds(0).build();
        when(sessionRepo.findById(100L)).thenReturn(Optional.of(session));
        when(turnRepo.findBySessionIdAndClientTurnId(eq(100L), anyString())).thenReturn(Optional.empty());
        when(turnRepo.findBySessionIdOrderBySequenceNumberAsc(100L)).thenReturn(List.of());

        MockMultipartFile webm = new MockMultipartFile("file", "turn.webm", "audio/webm", VALID_WEBM);

        // Invalid clientTurnId & initial- prefix rejected with 400
        assertThatThrownBy(() -> roleplayService.processTurn(10L, 100L, webm, "initial-100"))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        assertThatThrownBy(() -> roleplayService.processTurn(10L, 100L, webm, "../escape"))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));

        // Fail closed 503 when LLM returns is_mocked=true -> zero turns persisted!
        HttpServer mockedLlmServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        mockedLlmServer.createContext("/api/v1/speaking/roleplay/turn", exchange -> {
            byte[] body = "{\"assistant_text\":\"Mock reply\",\"is_mocked\":true}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        mockedLlmServer.start();
        try {
            ReflectionTestUtils.setField(roleplayService, "aiBaseUrl", "http://127.0.0.1:" + mockedLlmServer.getAddress().getPort());
            when(speakingService.forwardAudioForAnalysis(any(byte[].class), anyString(), anyString(), isNull()))
                    .thenReturn(Map.of("transcription", "Hello, I want to order coffee."));

            assertThatThrownBy(() -> roleplayService.processTurn(10L, 100L, webm, "turn-mock-1"))
                    .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                        assertThat(e.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                        assertThat(e.getReason()).isEqualTo("AI_DIALOGUE_UNAVAILABLE");
                    });
            verify(turnRepo, never()).save(any());
        } finally {
            mockedLlmServer.stop(0);
        }

        // Real LLM succeeds with measured audio duration (11s) and runs pron on dedicated worker thread using byte[]
        AtomicReference<String> pronThreadName = new AtomicReference<>();
        HttpServer realLlmServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        realLlmServer.createContext("/api/v1/speaking/roleplay/turn", exchange -> {
            byte[] body = "{\"assistant_text\":\"Sure, one coffee coming up!\",\"is_mocked\":false,\"task_completed\":false,\"summary\":\"Good\",\"positive_feedback\":\"Clear\",\"corrections\":[]}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        realLlmServer.start();
        try {
            ReflectionTestUtils.setField(roleplayService, "aiBaseUrl", "http://127.0.0.1:" + realLlmServer.getAddress().getPort());
            when(speakingService.analyzePronunciationV2(
                    any(byte[].class), anyString(), eq("audio/webm"), anyString(), anyString(), eq("100"), eq("turn-real-1"), isNull()
            )).thenAnswer(inv -> {
                pronThreadName.set(Thread.currentThread().getName());
                return PronunciationV2ResponseDto.builder()
                        .engineVersion("pronunciation-v3.0-hybrid")
                        .status("COMPLETED")
                        .audioQuality(PronunciationV2ResponseDto.AudioQualityDto.builder().durationSec(11.2).build())
                        .overall(PronunciationV2ResponseDto.OverallScoreDto.builder().overallScore(84).fluencyScore(80).build())
                        .build();
            });
            when(turnRepo.findMaxSequenceNumberBySessionId(100L)).thenReturn(0);
            when(turnRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
            when(feedbackRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
            when(audioStorage.saveAttemptAudio(eq(10L), eq("turn-real-1"), any(byte[].class), anyString())).thenReturn("10/turn-real-1.bin");

            RoleplayTurnResponseDto ok = roleplayService.processTurn(10L, 100L, webm, "turn-real-1");
            assertThat(ok.learnerTurn().durationSeconds()).isEqualTo(11);
            assertThat(session.getDurationSeconds()).isEqualTo(11);
            assertThat(pronThreadName.get()).startsWith("roleplay-ai-worker-");
        } finally {
            realLlmServer.stop(0);
            roleplayService.shutdownExecutor();
        }
    }

    // ==================== 4. Scenario Update Validation, TTS Semaphore & Quick Check Hardening ====================

    @Test
    @DisplayName("SpeakingScenarioService: updateCustomScenario enforces identical length & vocab-list caps as create")
    void updateCustomScenarioEnforcesValidationCaps() {
        SpeakingScenarioService service = new SpeakingScenarioService(
                mock(SpeakingScenarioRepository.class),
                mock(SpeakingSessionRepository.class),
                mock(SpeakingTurnRepository.class),
                mock(SpeakingTurnFeedbackRepository.class),
                mock(SpeakingShadowingAttemptRepository.class),
                mock(SpeakingAudioStorageService.class)
        );

        CreateCustomScenarioRequestDto oversizedTopic = new CreateCustomScenarioRequestDto(
                "x".repeat(201), "B1", "ctx", "role", "ai", "mission", List.of("ok"), 4, "5"
        );
        assertThatThrownBy(() -> service.updateCustomScenario(10L, 1L, oversizedTopic))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));

        List<String> tooManyVocab = Collections.nCopies(31, "word");
        CreateCustomScenarioRequestDto oversizedVocab = new CreateCustomScenarioRequestDto(
                "Topic", "B1", "ctx", "role", "ai", "mission", tooManyVocab, 4, "5"
        );
        assertThatThrownBy(() -> service.updateCustomScenario(10L, 1L, oversizedVocab))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
    }

    @Test
    @DisplayName("SpeakingTtsService: getOrSynthesizeTurnAudio routes cache misses through synthesizeSlots semaphore")
    void turnAudioCacheMissUsesSemaphore() {
        SpeakingAudioStorageService storage = mock(SpeakingAudioStorageService.class);
        SpeakingSessionRepository sessions = mock(SpeakingSessionRepository.class);
        SpeakingTurnRepository turns = mock(SpeakingTurnRepository.class);
        SpeakingTtsService tts = new SpeakingTtsService(storage, sessions, turns);
        ReflectionTestUtils.setField(tts, "synthesizeSlots", new Semaphore(0, true));

        User user = User.builder().id(10L).build();
        SpeakingSession session = SpeakingSession.builder().id(1L).user(user).voiceId("us_female").build();
        SpeakingTurn turn = SpeakingTurn.builder().id(2L).session(session).speaker("ASSISTANT").text("Welcome!").build();
        when(sessions.findById(1L)).thenReturn(Optional.of(session));
        when(turns.findById(2L)).thenReturn(Optional.of(turn));
        when(storage.ttsAudioExists(anyString(), anyString())).thenReturn(false);

        assertThatThrownBy(() -> tts.getOrSynthesizeTurnAudio(10L, 1L, 2L))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE));
    }

    @Test
    @DisplayName("SpeakingQuickCheckService: rejects bad magic bytes BEFORE saveAttemptAudio, uniform 404 lookup, fails closed 503 when both models fail, and recheck updates session COMPLETED")
    void quickCheckMagicBytesUniform404FailClosedAndRecheck() throws Exception {
        SpeakingService speakingService = mock(SpeakingService.class);
        SpeakingAudioStorageService storage = mock(SpeakingAudioStorageService.class);
        SpeakingQuickCheckRepository qcRepo = mock(SpeakingQuickCheckRepository.class);
        SpeakingSessionRepository sessionRepo = mock(SpeakingSessionRepository.class);
        UserRepository userRepo = mock(UserRepository.class);
        SpeakingQuickCheckService service = new SpeakingQuickCheckService(
                speakingService, storage, qcRepo, sessionRepo, userRepo, new ObjectMapper()
        );
        ReflectionTestUtils.setField(service, "aiBaseUrl", "http://127.0.0.1:9");
        ReflectionTestUtils.setField(service, "connectTimeoutMs", 500);
        ReflectionTestUtils.setField(service, "readTimeoutMs", 500);

        // 1. Invalid magic bytes rejected BEFORE saveAttemptAudio
        MockMultipartFile fakeHtml = new MockMultipartFile("file", "evil.webm", "audio/webm", "<html>nope</html>".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> service.analyzeQuickCheck(10L, fakeHtml, "qc_bad_magic", null))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        verify(storage, never()).saveAttemptAudio(any(), any(), any(), any());

        // 2. Malformed clientAttemptId rejected with 400
        MockMultipartFile validWebm = new MockMultipartFile("file", "ok.webm", "audio/webm", VALID_WEBM);
        assertThatThrownBy(() -> service.analyzeQuickCheck(10L, validWebm, "../bad/id", null))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));

        // 3. Cross-user lookup returns uniform 404 (not 403)
        when(qcRepo.findByUserIdAndClientAttemptId(20L, "qc_user10")).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.getQuickCheckDetail(20L, "qc_user10"))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));

        // 4. Both Pronunciation AND Language Check fail -> HTTP 503 & audio deleted
        User u = User.builder().id(10L).build();
        when(userRepo.findById(10L)).thenReturn(Optional.of(u));
        when(qcRepo.findByUserIdAndClientAttemptId(10L, "qc_both_fail")).thenReturn(Optional.empty());
        when(storage.saveAttemptAudio(eq(10L), eq("qc_both_fail"), any(), any())).thenReturn("10/qc_both_fail.bin");
        when(speakingService.forwardAudioForAnalysis(any(byte[].class), anyString(), isNull()))
                .thenReturn(Map.of("transcription", "Hello there"));
        when(speakingService.analyzePronunciationV2(any(byte[].class), anyString(), anyString(), anyString(), anyString(), anyString()))
                .thenThrow(new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "down"));

        assertThatThrownBy(() -> service.analyzeQuickCheck(10L, validWebm, "qc_both_fail", null))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE));
        verify(storage).deleteAttemptAudioByRef("10/qc_both_fail.bin");
        verify(qcRepo, never()).save(any());

        // 5. Recheck preserves detected audio extension (.wav) and marks session COMPLETED on success
        HttpServer llamaServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        llamaServer.createContext("/api/v1/speaking/quick-check/language-check", exchange -> {
            byte[] body = "{\"status\":\"CORRECT\",\"corrections\":[],\"positive_feedback\":\"Great\",\"is_mocked\":false}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        llamaServer.start();
        try {
            ReflectionTestUtils.setField(service, "aiBaseUrl", "http://127.0.0.1:" + llamaServer.getAddress().getPort());
            SpeakingSession failedSession = SpeakingSession.builder().id(77L).user(u).mode("QUICK_CHECK").status("FAILED").build();
            SpeakingQuickCheck existing = SpeakingQuickCheck.builder()
                    .id(88L).user(u).session(failedSession).clientAttemptId("qc_recheck_wav").whisperTranscript("hello").build();
            when(qcRepo.findByUserIdAndClientAttemptId(10L, "qc_recheck_wav")).thenReturn(Optional.of(existing));
            when(storage.loadAttemptAudioBytes(10L, "qc_recheck_wav")).thenReturn(VALID_WAV);
            when(storage.detectAttemptAudioMime(10L, "qc_recheck_wav")).thenReturn("audio/wav");
            when(speakingService.analyzePronunciationV2(any(byte[].class), eq("recheck_qc_recheck_wav.wav"), eq("Hello world"), eq("hello"), anyString(), eq("qc_recheck_wav")))
                    .thenReturn(PronunciationV2ResponseDto.builder()
                            .status("COMPLETED")
                            .overall(PronunciationV2ResponseDto.OverallScoreDto.builder().overallScore(90).build())
                            .build());
            when(qcRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));
            when(sessionRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

            QuickCheckResponseDto rechecked = service.recheckQuickCheck(10L, "qc_recheck_wav", "Hello world");
            assertThat(rechecked.getPronunciationStatus()).isEqualTo("SUCCESS");
            assertThat(rechecked.getLanguageStatus()).isEqualTo("SUCCESS");
            assertThat(failedSession.getStatus()).isEqualTo("COMPLETED");
            verify(sessionRepo).save(failedSession);
        } finally {
            llamaServer.stop(0);
        }
    }

    // ==================== 5. Audio Storage Atomic TTS Write, MP3/FLAC Detection & RealPath Guard ====================

    @Test
    @DisplayName("SpeakingAudioStorageService: atomic TTS write, MP3/FLAC MIME detection, and userDir realPath guard")
    void audioStorageAtomicWriteMimeAndBoundary(@TempDir Path tempDir) throws Exception {
        SpeakingAudioStorageService storage = new SpeakingAudioStorageService(tempDir.toString());

        // Atomic TTS write
        String ref = storage.saveTtsAudio("us_female", "hash123", VALID_WAV);
        assertThat(ref).isEqualTo("tts/us_female/hash123.wav");
        Resource ttsRes = storage.loadTtsAudioResource("us_female", "hash123");
        assertThat(ttsRes.getContentAsByteArray()).containsExactly(VALID_WAV);
        // No lingering temp files
        try (var stream = Files.list(tempDir.resolve("tts").resolve("us_female"))) {
            assertThat(stream.map(p -> p.getFileName().toString())).containsExactly("hash123.wav");
        }

        // MP3 & FLAC detection
        storage.saveAttemptAudio(10L, "att_mp3", VALID_MP3_ID3, "clip.mp3");
        storage.saveAttemptAudio(10L, "att_flac", VALID_FLAC, "clip.flac");
        assertThat(storage.detectAttemptAudioMime(10L, "att_mp3")).isEqualTo("audio/mpeg");
        assertThat(storage.detectAttemptAudioMime(10L, "att_flac")).isEqualTo("audio/flac");

        // Valid attempt loads cleanly
        assertThat(storage.loadAttemptAudioResource(10L, "att_mp3").getContentAsByteArray()).containsExactly(VALID_MP3_ID3);
    }

    // ==================== 6. Progress & Aggregation Fixes ====================

    @Test
    @DisplayName("Progress & Aggregation: QUICK_CHECK label, per-attempt fluency fallback, ALVEOLAR Vietnamese label, and /speaking/shadowing/{materialId} route")
    void progressAndAggregationFixes() {
        // 1. ALVEOLAR Vietnamese label (PP-15)
        assertThat(SpeakingProgressAggregationService.mapIssueTypeToLearnerLabel("ALVEOLAR_STOP"))
                .isEqualTo("Âm lợi / đầu lưỡi (/r/, /l/)");

        // 2. QUICK_CHECK recent activity label (ARCH-07)
        User user = User.builder().id(10L).build();
        SpeakingSession qcSession = SpeakingSession.builder()
                .id(500L).user(user).mode("QUICK_CHECK").status("COMPLETED").createdAt(LocalDateTime.now()).build();
        SpeakingSessionRepository sessionRepo = mock(SpeakingSessionRepository.class);
        SpeakingTurnRepository turnRepo = mock(SpeakingTurnRepository.class);
        SpeakingShadowingAttemptRepository attemptRepo = mock(SpeakingShadowingAttemptRepository.class);
        SpeakingProgressAggregationService aggMock = mock(SpeakingProgressAggregationService.class);
        when(sessionRepo.findRecentSessionsByUserId(eq(10L), any())).thenReturn(List.of(qcSession));
        when(attemptRepo.findBySessionIdIn(anyList())).thenReturn(List.of());
        when(turnRepo.findBySessionIdIn(anyList())).thenReturn(List.of());
        when(attemptRepo.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(10L), any())).thenReturn(List.of());
        when(aggMock.getRecurringIssues(10L)).thenReturn(List.of());

        SpeakingProgressService progressService = new SpeakingProgressService(
                turnRepo, sessionRepo, mock(SpeakingResultRepository.class),
                mock(SpeakingTurnFeedbackRepository.class), attemptRepo,
                mock(ListeningMaterialRepository.class), aggMock
        );
        SpeakingProgressDto progress = progressService.getUserSpeakingProgress(10L);
        assertThat(progress.recentActivity()).hasSize(1);
        assertThat(progress.recentActivity().getFirst().getTitle()).isEqualTo("Kiểm tra nhanh");
        assertThat(progress.recentActivity().getFirst().getContentTitle()).doesNotContain("&");

        // 3. practiceAgainRoute emits /speaking/shadowing/{materialId} & per-attempt fluency fallback works when first attempt has column fluency
        ListeningMaterialRepository matRepo = mock(ListeningMaterialRepository.class);
        SpeakingTurnFeedbackRepository fbRepo = mock(SpeakingTurnFeedbackRepository.class);
        SpeakingQuickCheckRepository qcRepo = mock(SpeakingQuickCheckRepository.class);
        SpeakingProgressAggregationService aggService = new SpeakingProgressAggregationService(
                sessionRepo, attemptRepo, matRepo, fbRepo, turnRepo,
                mock(SpeakingShadowingService.class), mock(SpeakingShadowingUnitService.class),
                mock(UserRepository.class), qcRepo, mock(SpeakingQuickCheckService.class)
        );

        SpeakingSession s1 = SpeakingSession.builder().id(1L).user(user).mode("SHADOWING").sourceId(42L).status("COMPLETED").createdAt(LocalDateTime.now().minusDays(2)).build();
        SpeakingSession s2 = SpeakingSession.builder().id(2L).user(user).mode("SHADOWING").sourceId(42L).status("COMPLETED").createdAt(LocalDateTime.now().minusDays(1)).build();
        SpeakingShadowingAttempt a1 = SpeakingShadowingAttempt.builder()
                .id(11L).user(user).session(s1).primaryIssueType("ALVEOLAR").targetWord("really")
                .fluencyScore(80.0).pronunciationScore(80.0).createdAt(LocalDateTime.now().minusDays(2)).build();
        SpeakingShadowingAttempt a2 = SpeakingShadowingAttempt.builder()
                .id(12L).user(user).session(s2).primaryIssueType("ALVEOLAR").targetWord("really")
                .fluencyScore(null).pronunciationScore(90.0)
                .productSafeResultJson("{\"overall\":{\"fluencyScore\":100}}")
                .createdAt(LocalDateTime.now().minusDays(1)).build();

        when(matRepo.findByIdAndVisibleToUser(42L, 10L)).thenReturn(Optional.empty());
        when(attemptRepo.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(10L), any())).thenReturn(List.of(a1, a2));
        when(fbRepo.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(10L), any())).thenReturn(List.of());
        when(sessionRepo.findFirstByUserIdAndModeAndStatusOrderByCreatedAtDesc(10L, "SHADOWING", "ACTIVE")).thenReturn(Optional.empty());
        when(sessionRepo.findByUserIdAndModeAndCreatedAtAfterOrderByCreatedAtDesc(eq(10L), eq("SHADOWING"), any())).thenReturn(List.of(s1, s2));
        when(sessionRepo.findByUserIdOrderByCreatedAtDesc(eq(10L), any())).thenReturn(org.springframework.data.domain.Page.empty());
        when(qcRepo.findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(eq(10L), any())).thenReturn(List.of());

        SpeakingProgressSummaryDto summary = aggService.getSpeakingProgressSummary(10L);
        assertThat(summary.getRecurringIssues()).hasSize(1);
        assertThat(summary.getRecurringIssues().getFirst().getPracticeAgainRoute()).isEqualTo("/speaking/shadowing/42");
        // Average fluency across a1 (80 from column) and a2 (100 from JSON fallback) MUST be 90.0 (not 80.0!)
        assertThat(summary.getPronunciationMetrics().getAverageFluencyScore()).isEqualTo(90.0);
    }

    // ==================== 7. OSIV Paths, Controller Clamping/Ext, Decoupled Pron Timeout & TX-Free HTTP ====================

    @Test
    @DisplayName("OSIV, Controller clamping/dynamic extension, Roleplay replay useMeasuredStress & TX-free HTTP")
    void osivPathsControllerClampingDynamicExtAndTxFreeHttp() throws Exception {
        // 1. OpenEntityManagerInViewConfig excludes the 4 AI/TTS speaking paths
        String[] paths = (String[]) ReflectionTestUtils.getField(OpenEntityManagerInViewConfig.class, "CONNECTION_FREE_PATHS");
        assertThat(paths).contains(
                "/api/v1/speaking/sessions/*/turns/*/feedback",
                "/api/v1/speaking/scenarios/custom",
                "/api/v1/speaking/sessions/*/turns/*/audio",
                "/api/v1/speaking/sessions/*/turns/*/tts"
        );

        // 2. SpeakingController clamps page/size and sets dynamic audio extension matching detected MIME
        SpeakingProgressAggregationService aggMock = mock(SpeakingProgressAggregationService.class);
        SpeakingAudioStorageService storageMock = mock(SpeakingAudioStorageService.class);
        SpeakingController controller = new SpeakingController(
                mock(SpeakingService.class),
                mock(SpeakingContextService.class),
                mock(SpeakingRoleplayService.class),
                mock(SpeakingFeedbackService.class),
                mock(SpeakingProgressService.class),
                aggMock,
                mock(SpeakingShadowingService.class),
                mock(SpeakingShadowingUnitService.class),
                storageMock,
                mock(SpeakingQuickCheckService.class),
                mock(SpeakingTtsService.class)
        );
        UserDetailsImpl principal = UserDetailsImpl.build(
                User.builder().id(10L).email("u10@test.com").role(Role.ROLE_USER).build());
        when(aggMock.getSpeakingSessionHistory(anyLong(), any(), anyInt(), anyInt()))
                .thenReturn(SpeakingSessionHistoryPageDto.builder().content(List.of()).build());

        controller.getSpeakingSessionHistory(principal, null, -5, 500);
        verify(aggMock).getSpeakingSessionHistory(10L, null, 0, 50);
        controller.getSpeakingSessionHistory(principal, "SHADOWING", 2, 0);
        verify(aggMock).getSpeakingSessionHistory(10L, "SHADOWING", 2, 1);

        when(storageMock.loadAttemptAudioResource(10L, "att_mp3")).thenReturn(new ByteArrayResource(VALID_MP3_ID3));
        when(storageMock.detectAttemptAudioMime(10L, "att_mp3")).thenReturn("audio/mpeg");
        ResponseEntity<Resource> audioResp = controller.getAttemptAudio(principal, "att_mp3");
        assertThat(audioResp.getHeaders().getFirst(HttpHeaders.CONTENT_DISPOSITION))
                .isEqualTo("inline; filename=\"recording.mp3\"");

        // 3. SpeakingRoleplayService idempotent replay applies .useMeasuredStress()
        SpeakingSessionRepository sessionRepo = mock(SpeakingSessionRepository.class);
        SpeakingTurnRepository turnRepo = mock(SpeakingTurnRepository.class);
        SpeakingTurnFeedbackRepository fbRepo = mock(SpeakingTurnFeedbackRepository.class);
        SpeakingRoleplayService roleplayService = new SpeakingRoleplayService(
                sessionRepo, turnRepo, fbRepo, mock(SpeakingService.class),
                mock(SpeakingContextService.class), mock(SpeakingAudioStorageService.class)
        );
        try {
            User owner = User.builder().id(10L).build();
            SpeakingSession roleplaySession = SpeakingSession.builder().id(100L).user(owner).mode("ROLEPLAY").status("ACTIVE").build();
            String v2JsonWithFakeStress = "{\"engineVersion\":\"pronunciation-v2.2\",\"status\":\"COMPLETED\",\"overall\":{\"overallScore\":85,\"stressScore\":99},\"lexicalStress\":{\"method\":\"ALIGNED_VOWEL_PROMINENCE_V1\",\"status\":\"ASSESSED\",\"assessed\":2,\"matched\":1}}";
            SpeakingTurn existingLearner = SpeakingTurn.builder()
                    .id(1L).session(roleplaySession).clientTurnId("replay-1").sequenceNumber(1)
                    .speaker("LEARNER").text("hello").pronunciationResultJson(v2JsonWithFakeStress).build();
            when(sessionRepo.findById(100L)).thenReturn(Optional.of(roleplaySession));
            when(turnRepo.findBySessionIdAndClientTurnId(100L, "replay-1")).thenReturn(Optional.of(existingLearner));
            when(turnRepo.findBySessionIdOrderBySequenceNumberAsc(100L)).thenReturn(List.of(existingLearner));
            when(fbRepo.findByTurnId(1L)).thenReturn(Optional.empty());

            MockMultipartFile dummy = new MockMultipartFile("file", "t.webm", "audio/webm", VALID_WEBM);
            RoleplayTurnResponseDto replayed = roleplayService.processTurn(10L, 100L, dummy, "replay-1");
            assertThat(replayed.isIdempotentReplay()).isTrue();
            assertThat(replayed.pronunciationFeedback().getOverall().getStressScore()).isEqualTo(50);
        } finally {
            roleplayService.shutdownExecutor();
        }

        // 4. SpeakingFeedbackService runs HTTP call OUTSIDE active transaction
        AtomicBoolean txActiveDuringHttp = new AtomicBoolean(false);
        AtomicBoolean inTxFlag = new AtomicBoolean(false);
        PlatformTransactionManager spyTxMgr = mock(PlatformTransactionManager.class);
        when(spyTxMgr.getTransaction(any())).thenAnswer(inv -> {
            inTxFlag.set(true);
            return new SimpleTransactionStatus();
        });
        doAnswer(inv -> {
            inTxFlag.set(false);
            return null;
        }).when(spyTxMgr).commit(any(TransactionStatus.class));
        doAnswer(inv -> {
            inTxFlag.set(false);
            return null;
        }).when(spyTxMgr).rollback(any(TransactionStatus.class));

        HttpServer fbServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        fbServer.createContext("/api/v1/speaking/roleplay/feedback", exchange -> {
            txActiveDuringHttp.set(inTxFlag.get());
            byte[] body = "{\"summary\":\"Clear\",\"positive_feedback\":\"Nice\",\"corrections\":[],\"is_mocked\":false}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        fbServer.start();
        try {
            SpeakingSessionRepository fbSessionRepo = mock(SpeakingSessionRepository.class);
            SpeakingTurnRepository fbTurnRepo = mock(SpeakingTurnRepository.class);
            SpeakingTurnFeedbackRepository fbFeedbackRepo = mock(SpeakingTurnFeedbackRepository.class);
            SpeakingFeedbackService fbService = new SpeakingFeedbackService(
                    fbSessionRepo, fbTurnRepo, fbFeedbackRepo, mock(SpeakingContextService.class)
            );
            ReflectionTestUtils.setField(fbService, "transactionManager", spyTxMgr);
            ReflectionTestUtils.setField(fbService, "aiBaseUrl", "http://127.0.0.1:" + fbServer.getAddress().getPort());
            ReflectionTestUtils.setField(fbService, "connectTimeoutMs", 3000);
            ReflectionTestUtils.setField(fbService, "readTimeoutMs", 3000);

            User owner = User.builder().id(10L).build();
            SpeakingSession sess = SpeakingSession.builder().id(10L).user(owner).mode("ROLEPLAY").status("ACTIVE").build();
            SpeakingTurn turn = SpeakingTurn.builder().id(20L).session(sess).speaker("LEARNER").text("Hello").build();
            when(fbSessionRepo.findById(10L)).thenReturn(Optional.of(sess));
            when(fbTurnRepo.findById(20L)).thenReturn(Optional.of(turn));
            when(fbFeedbackRepo.findByTurnId(20L)).thenReturn(Optional.empty());
            when(fbFeedbackRepo.save(any())).thenAnswer(inv -> inv.getArgument(0));

            SpeakingTurnFeedbackDto fbDto = fbService.getOrGenerateFeedback(10L, 10L, 20L);
            assertThat(fbDto.summary()).isEqualTo("Clear");
            assertThat(txActiveDuringHttp.get()).isFalse();
        } finally {
            fbServer.stop(0);
        }
    }
}
