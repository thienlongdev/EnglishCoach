package com.englishcoach.speaking;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.auth.policy.OfficialAdminPolicy;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.avatarframe.entity.AvatarFrame;
import com.englishcoach.avatarframe.entity.AvatarFrameSeries;
import com.englishcoach.avatarframe.evaluator.PrestigeEvaluationEngine;
import com.englishcoach.avatarframe.repository.AvatarFrameRepository;
import com.englishcoach.avatarframe.repository.UserAvatarFrameRepository;
import com.englishcoach.avatarframe.service.AvatarFrameServiceImpl;
import com.englishcoach.avatarframe.service.FrameAudience;
import com.englishcoach.common.ai.AiServiceAuth;
import com.englishcoach.common.ai.AiServiceRequestFactory;
import com.englishcoach.common.security.AuthSessionContext;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.repository.ExerciseAttemptRepository;
import com.englishcoach.listening.repository.ListeningExerciseRepository;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.listening.repository.ListeningSessionRepository;
import com.englishcoach.listening.repository.TranscriptSegmentRepository;
import com.englishcoach.listening.service.AiDiagnosticAgentService;
import com.englishcoach.listening.service.DictationScoringService;
import com.englishcoach.listening.service.ListeningAnalyticsService;
import com.englishcoach.listening.service.ListeningServiceImpl;
import com.englishcoach.mocktest.entity.ExamResult;
import com.englishcoach.notification.service.NotificationService;
import com.englishcoach.premium.interceptor.RequirePremiumAi;
import com.englishcoach.reading.entity.ReadingMaterial;
import com.englishcoach.reading.repository.DocumentHighlightRepository;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.reading.service.ReadingService;
import com.englishcoach.speaking.controller.SpeakingController;
import com.englishcoach.speaking.controller.SpeakingScenarioController;
import com.englishcoach.speaking.dto.CreateCustomScenarioRequestDto;
import com.englishcoach.speaking.dto.SpeakingProgressDto;
import com.englishcoach.speaking.dto.SpeakingSessionDetailDto;
import com.englishcoach.speaking.dto.SpeakingSessionRequest;
import com.englishcoach.speaking.entity.SpeakingResult;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.speaking.repository.SpeakingQuickCheckRepository;
import com.englishcoach.speaking.repository.SpeakingResultRepository;
import com.englishcoach.speaking.repository.SpeakingScenarioRepository;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingUnitRepository;
import com.englishcoach.speaking.repository.SpeakingTurnFeedbackRepository;
import com.englishcoach.speaking.repository.SpeakingTurnRepository;
import com.englishcoach.speaking.service.SpeakingAudioStorageService;
import com.englishcoach.speaking.service.SpeakingContextService;
import com.englishcoach.speaking.service.SpeakingFeedbackService;
import com.englishcoach.speaking.service.SpeakingProgressAggregationService;
import com.englishcoach.speaking.service.SpeakingProgressService;
import com.englishcoach.speaking.service.SpeakingQuickCheckService;
import com.englishcoach.speaking.service.SpeakingRoleplayService;
import com.englishcoach.speaking.service.SpeakingScenarioService;
import com.englishcoach.speaking.service.SpeakingService;
import com.englishcoach.speaking.service.SpeakingShadowingService;
import com.englishcoach.speaking.service.SpeakingShadowingUnitService;
import com.englishcoach.speaking.service.SpeakingTtsService;
import com.englishcoach.vocabulary.repository.VocabularyCourseRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.data.jpa.repository.Query;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * Security regression tests for Reading, Listening, Speaking, TTS, AvatarFrame, and AI transport defenses.
 * Covers EC-SEC-2026-004, EC-SEC-2026-007, EC-SEC-2026-009, EC-SEC-2026-018, EC-SEC-2026-030,
 * EC-SEC-2026-031, EC-SEC-2026-036, EC-SEC-2026-037, AUTHZ-03, AUTHZ-10, AUTHZ-16, AI-10, and AI-13.
 */
class AuthzSpeakingListeningSecurityRegressionTest {

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    @DisplayName("EC-SEC-2026-018: Pre-MFA official admin and non-official ROLE_ADMIN are blocked from deleting system/foreign materials")
    void preMfaOfficialAdminAndNonOfficialRoleAdminBlockedOnDeleteMaterial() {
        UserRepository userRepo = mock(UserRepository.class);
        AdminIdentityService adminIdentityService = new AdminIdentityService(userRepo);

        User officialAdmin = User.builder()
                .id(1L)
                .email(OfficialAdminPolicy.OFFICIAL_ADMIN_EMAIL)
                .role(Role.ROLE_ADMIN)
                .accountStatus("ACTIVE")
                .build();
        User rogueAdmin = User.builder()
                .id(2L)
                .email("rogue-admin@example.com")
                .role(Role.ROLE_ADMIN)
                .accountStatus("ACTIVE")
                .build();
        when(userRepo.findById(1L)).thenReturn(Optional.of(officialAdmin));
        when(userRepo.findById(2L)).thenReturn(Optional.of(rogueAdmin));

        ReadingMaterialRepository readingRepo = mock(ReadingMaterialRepository.class);
        ReadingService readingService = new ReadingService(readingRepo, mock(DocumentHighlightRepository.class), userRepo);
        readingService.setAdminIdentityService(adminIdentityService);

        ReadingMaterial systemReading = ReadingMaterial.builder()
                .id(100L)
                .title("System Article")
                .isSystem(true)
                .ownerUserId(null)
                .build();
        when(readingRepo.findById(100L)).thenReturn(Optional.of(systemReading));

        ListeningMaterialRepository listeningRepo = mock(ListeningMaterialRepository.class);
        ListeningServiceImpl listeningService = new ListeningServiceImpl(
                listeningRepo,
                mock(TranscriptSegmentRepository.class),
                mock(ListeningExerciseRepository.class),
                mock(ExerciseAttemptRepository.class),
                mock(ListeningSessionRepository.class),
                mock(DictationScoringService.class),
                mock(ListeningAnalyticsService.class),
                mock(AiDiagnosticAgentService.class),
                userRepo,
                mock(SpeakingShadowingAttemptRepository.class),
                mock(SpeakingShadowingUnitRepository.class)
        );
        listeningService.setAdminIdentityService(adminIdentityService);

        ListeningMaterial systemListening = ListeningMaterial.builder()
                .id(200L)
                .title("System Listening")
                .audioUrl("https://www.youtube.com/watch?v=BF3bXji-J7I")
                .isSystem(true)
                .ownerUserId(null)
                .build();
        when(listeningRepo.findById(200L)).thenReturn(Optional.of(systemListening));

        // 1) Official admin whose MFA is withheld -> 404 on both Reading and Listening deletes.
        setSessionContext(officialAdmin, AuthSessionContext.AdminAccess.MFA_REQUIRED);
        assertThatThrownBy(() -> readingService.deleteMaterial(100L, 1L))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThatThrownBy(() -> listeningService.deleteMaterial(200L, 1L))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
        verify(readingRepo, never()).delete(any());
        verify(listeningRepo, never()).deleteByIdNative(anyLong());

        // 2) Non-official email with ROLE_ADMIN -> 404 on both deletes.
        setSessionContext(rogueAdmin, AuthSessionContext.AdminAccess.GRANTED);
        assertThatThrownBy(() -> readingService.deleteMaterial(100L, 2L))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThatThrownBy(() -> listeningService.deleteMaterial(200L, 2L))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));

        // 3) MFA-verified official admin -> allowed.
        setSessionContext(officialAdmin, AuthSessionContext.AdminAccess.GRANTED);
        readingService.deleteMaterial(100L, 1L);
        listeningService.deleteMaterial(200L, 1L);
        verify(readingRepo).delete(systemReading);
        verify(listeningRepo).deleteByIdNative(200L);
    }

    @Test
    @DisplayName("EC-SEC-2026-009: extractYouTubeVideoId rejects traversal/non-YouTube inputs and accepts canonical 11-char IDs")
    void extractYouTubeVideoIdRejectsPathTraversalAndNonYouTubeHosts() {
        for (String invalid : List.of(
                "../../../etc/passwd",
                "https://evil.example/watch?v=BF3bXji-J7I",
                "https://www.youtube.com/watch?v=../../etc/passwd",
                "BF3bXji-J7I/../../x",
                "short",
                "   "
        )) {
            assertThatThrownBy(() -> ListeningServiceImpl.extractYouTubeVideoId(invalid))
                    .as("invalid URL/ID: %s", invalid)
                    .isInstanceOf(ResponseStatusException.class)
                    .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        }
        assertThatThrownBy(() -> ListeningServiceImpl.extractYouTubeVideoId(null))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));

        assertThat(ListeningServiceImpl.extractYouTubeVideoId("BF3bXji-J7I")).isEqualTo("BF3bXji-J7I");
        assertThat(ListeningServiceImpl.extractYouTubeVideoId("https://www.youtube.com/watch?v=BF3bXji-J7I")).isEqualTo("BF3bXji-J7I");
        assertThat(ListeningServiceImpl.extractYouTubeVideoId("https://youtu.be/BF3bXji-J7I?si=abc")).isEqualTo("BF3bXji-J7I");
        assertThat(ListeningServiceImpl.extractYouTubeVideoId("https://www.youtube.com/shorts/BF3bXji-J7I")).isEqualTo("BF3bXji-J7I");
    }

    @Test
    @DisplayName("EC-SEC-2026-031: Entity JSON serialization and toString never expose BCrypt hashes or nested User graphs")
    void entityJsonSerializationNeverExposesPasswordHashOrNestedUser() throws Exception {
        String bcryptHash = "$2a$10$secretBcryptHashValueForTest012345678901234567890123";
        User user = User.builder()
                .id(5L)
                .email("learner5@example.com")
                .name("Learner Five")
                .password(bcryptHash)
                .role(Role.ROLE_USER)
                .build();
        SpeakingSession session = SpeakingSession.builder()
                .id(11L)
                .user(user)
                .mode("SHADOWING")
                .status("ACTIVE")
                .build();
        SpeakingResult result = SpeakingResult.builder()
                .id(12L)
                .user(user)
                .transcription("hello")
                .accuracyScore(90)
                .build();
        ExamResult examResult = ExamResult.builder()
                .id(13L)
                .user(user)
                .score(85)
                .build();

        ObjectMapper mapper = new ObjectMapper();
        String userJson = mapper.writeValueAsString(user);
        String sessionJson = mapper.writeValueAsString(session);
        String resultJson = mapper.writeValueAsString(result);
        String examJson = mapper.writeValueAsString(examResult);

        for (String json : List.of(userJson, sessionJson, resultJson, examJson)) {
            assertThat(json).doesNotContain(bcryptHash);
            assertThat(json).doesNotContain("\"password\"");
        }
        assertThat(sessionJson).doesNotContain("\"user\"");
        assertThat(resultJson).doesNotContain("\"user\"");
        assertThat(examJson).doesNotContain("\"user\"");

        assertThat(user.toString()).doesNotContain(bcryptHash);
        assertThat(session.toString()).doesNotContain(bcryptHash);
        assertThat(result.toString()).doesNotContain(bcryptHash);
        assertThat(examResult.toString()).doesNotContain(bcryptHash);
    }

    @Test
    @DisplayName("EC-SEC-2026-004: recheckQuickCheck and createCustomScenario enforce @RequirePremiumAi and input length caps")
    void speakingQuickCheckRecheckAndCustomScenarioEnforcePremiumAnnotationAndLengthCaps() throws Exception {
        Method recheckMethod = SpeakingController.class.getMethod(
                "recheckQuickCheck", UserDetailsImpl.class, String.class, String.class);
        RequirePremiumAi recheckAnn = recheckMethod.getAnnotation(RequirePremiumAi.class);
        assertThat(recheckAnn).isNotNull();
        assertThat(recheckAnn.value()).isEqualTo("SPEAKING_QUICK_CHECK");
        assertThat(recheckAnn.reuseClientRequestId()).isFalse();

        Method customScenarioMethod = SpeakingScenarioController.class.getMethod(
                "createCustomScenario", UserDetailsImpl.class, CreateCustomScenarioRequestDto.class);
        RequirePremiumAi scenarioAnn = customScenarioMethod.getAnnotation(RequirePremiumAi.class);
        assertThat(scenarioAnn).isNotNull();
        assertThat(scenarioAnn.value()).isEqualTo("SPEAKING_ROLEPLAY");
        assertThat(scenarioAnn.reuseClientRequestId()).isFalse();

        SpeakingQuickCheckService mockQuickCheck = mock(SpeakingQuickCheckService.class);
        SpeakingController controller = buildSpeakingController(
                mock(SpeakingService.class), mock(SpeakingRoleplayService.class), mock(SpeakingFeedbackService.class),
                mockQuickCheck, mock(SpeakingTtsService.class));
        UserDetailsImpl principal = UserDetailsImpl.build(
                User.builder().id(10L).email("u10@example.com").role(Role.ROLE_USER).build());

        assertThatThrownBy(() -> controller.recheckQuickCheck(principal, "qc_1", "a".repeat(501)))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        verifyNoInteractions(mockQuickCheck);

        SpeakingScenarioService scenarioService = new SpeakingScenarioService(
                mock(SpeakingScenarioRepository.class),
                mock(SpeakingSessionRepository.class),
                mock(SpeakingTurnRepository.class),
                mock(SpeakingTurnFeedbackRepository.class),
                mock(SpeakingShadowingAttemptRepository.class),
                mock(SpeakingAudioStorageService.class)
        );
        CreateCustomScenarioRequestDto oversizedTopic = new CreateCustomScenarioRequestDto(
                "t".repeat(201), "B1", "ctx", "role", "ai", "mission", List.of(), 6, "5 min");
        assertThatThrownBy(() -> scenarioService.createCustomScenario(10L, oversizedTopic))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));

        CreateCustomScenarioRequestDto oversizedContext = new CreateCustomScenarioRequestDto(
                "Valid topic", "B1", "c".repeat(1001), "role", "ai", "mission", List.of(), 6, "5 min");
        assertThatThrownBy(() -> scenarioService.createCustomScenario(10L, oversizedContext))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
    }

    @Test
    @DisplayName("EC-SEC-2026-036 & AUTHZ-10: /tts/preview sanitizes Content-Disposition, /tts/synthesize is POST-only, and GET /turns/{id}/feedback never calls LLM")
    void ttsPreviewSanitizesHeaderSynthesizeIsPostOnlyAndGetTurnFeedbackIsReadOnly() throws Exception {
        // 1) Content-Disposition sanitization on /tts/preview
        SpeakingTtsService ttsService = mock(SpeakingTtsService.class);
        when(ttsService.synthesizePreview("us_female")).thenReturn(new ByteArrayResource(new byte[]{1, 2, 3}));

        SpeakingFeedbackService feedbackService = mock(SpeakingFeedbackService.class);
        SpeakingTurnRepository turnRepo = mock(SpeakingTurnRepository.class);
        SpeakingSessionRepository sessionRepo = mock(SpeakingSessionRepository.class);
        SpeakingTurnFeedbackRepository turnFeedbackRepo = mock(SpeakingTurnFeedbackRepository.class);
        SpeakingRoleplayService roleplayService = new SpeakingRoleplayService(
                sessionRepo, turnRepo, turnFeedbackRepo, mock(SpeakingService.class),
                mock(SpeakingContextService.class), mock(SpeakingAudioStorageService.class)
        );

        SpeakingController controller = buildSpeakingController(
                mock(SpeakingService.class), roleplayService, feedbackService, mock(SpeakingQuickCheckService.class), ttsService);

        ResponseEntity<Resource> previewResp = controller.getTtsPreview("us_female\"\r\nSet-Cookie: pwn=1");
        String disposition = previewResp.getHeaders().getFirst(HttpHeaders.CONTENT_DISPOSITION);
        assertThat(disposition).isEqualTo("inline; filename=\"preview_us_female.wav\"");
        assertThat(disposition).doesNotContain("\r").doesNotContain("\n").doesNotContain("Set-Cookie");

        // 2) /tts/synthesize is @PostMapping only (no @GetMapping / multi-method @RequestMapping)
        Method synthMethod = SpeakingController.class.getMethod(
                "synthesizeCustomText", UserDetailsImpl.class, String.class, String.class);
        assertThat(synthMethod.isAnnotationPresent(PostMapping.class)).isTrue();
        assertThat(synthMethod.isAnnotationPresent(GetMapping.class)).isFalse();
        assertThat(synthMethod.isAnnotationPresent(RequestMapping.class)).isFalse();

        // 3) GET /sessions/{sessionId}/turns/{turnId}/feedback returns 404 when absent without calling LLM feedback service
        User owner = User.builder().id(10L).email("u10@example.com").role(Role.ROLE_USER).build();
        UserDetailsImpl principal = UserDetailsImpl.build(owner);
        SpeakingSession ownedSession = SpeakingSession.builder().id(55L).user(owner).mode("ROLEPLAY").status("ACTIVE").build();
        SpeakingTurn turn = SpeakingTurn.builder().id(99L).session(ownedSession).sequenceNumber(1).speaker("LEARNER").text("Hi").build();
        when(sessionRepo.findById(55L)).thenReturn(Optional.of(ownedSession));
        when(turnRepo.findById(99L)).thenReturn(Optional.of(turn));
        when(turnFeedbackRepo.findByTurnId(99L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> controller.getTurnFeedback(principal, 55L, 99L))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
        verifyNoInteractions(feedbackService);
    }

    @Test
    @DisplayName("EC-SEC-2026-037: Upstream failures in SpeakingTtsService and SpeakingService never leak internal host/port/URL")
    void upstreamErrorsInSpeakingServiceAndTtsDoNotLeakInternalHostOrPort() throws Exception {
        int closedPort;
        try (ServerSocket socket = new ServerSocket(0)) {
            closedPort = socket.getLocalPort();
        }

        // 1) SpeakingTtsService 503 hides host & port
        SpeakingAudioStorageService audioStorage = mock(SpeakingAudioStorageService.class);
        when(audioStorage.ttsAudioExists(anyString(), anyString())).thenReturn(false);
        SpeakingTtsService ttsService = new SpeakingTtsService(
                audioStorage, mock(SpeakingSessionRepository.class), mock(SpeakingTurnRepository.class));
        ReflectionTestUtils.setField(ttsService, "omnivoiceUrl", "http://localhost:" + closedPort + "/tts/omnivoice");
        ReflectionTestUtils.setField(ttsService, "aiBaseUrl", "");
        ReflectionTestUtils.setField(ttsService, "timeoutMs", 500);

        assertThatThrownBy(() -> ttsService.synthesize("us_female", "Hello world"))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> {
                    ResponseStatusException rse = (ResponseStatusException) ex;
                    assertThat(rse.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                    assertThat(rse.getReason()).doesNotContain("localhost")
                            .doesNotContain("http://")
                            .doesNotContain(String.valueOf(closedPort));
                });

        // 2) SpeakingService#analyzePronunciationV2 503 hides host & port
        SpeakingService speakingService = buildSpeakingService(audioStorage);
        ReflectionTestUtils.setField(speakingService, "aiBaseUrl", "http://127.0.0.1:" + closedPort);
        ReflectionTestUtils.setField(speakingService, "connectTimeoutMs", 500);
        ReflectionTestUtils.setField(speakingService, "readTimeoutMs", 500);

        byte[] validWav = new byte[]{'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'A', 'V', 'E', 0, 0};
        assertThatThrownBy(() -> speakingService.analyzePronunciationV2(validWav, "clip.wav", "hello", null, null, null))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> {
                    ResponseStatusException rse = (ResponseStatusException) ex;
                    assertThat(rse.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                    assertThat(rse.getReason()).doesNotContain("127.0.0.1")
                            .doesNotContain("http://")
                            .doesNotContain(String.valueOf(closedPort));
                });
    }

    @Test
    @DisplayName("EC-SEC-2026-030 & AI-10: Oversized audio rejected before storage write and magic bytes enforced")
    void speakingServiceRejectsOversizedAudioBeforeDiskWriteAndValidatesMagicBytes() {
        SpeakingAudioStorageService audioStorage = mock(SpeakingAudioStorageService.class);
        SpeakingService speakingService = buildSpeakingService(audioStorage);

        MultipartFile oversized = mock(MultipartFile.class);
        when(oversized.isEmpty()).thenReturn(false);
        when(oversized.getSize()).thenReturn(26L * 1024L * 1024L);

        assertThatThrownBy(() -> speakingService.analyzeShadowingAttempt(oversized, 1L, "Hello", "1", "att_1", null, null, 10L))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        assertThatThrownBy(() -> speakingService.analyzePronunciationV2(oversized, "Hello", null, "1", "att_1"))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        verifyNoInteractions(audioStorage);

        // Non-audio payloads (HLS playlist, ffconcat, HTML) are rejected.
        for (String nonAudio : List.of("#EXTM3U\n#EXTINF:10", "ffconcat version 1.0\nfile '/etc/passwd'", "<html>not audio</html>")) {
            byte[] payload = nonAudio.getBytes(StandardCharsets.UTF_8);
            assertThat(SpeakingService.isSupportedAudioHeader(payload)).isFalse();
            assertThatThrownBy(() -> speakingService.forwardAudioForAnalysis(payload, "fake.webm", null))
                    .isInstanceOf(ResponseStatusException.class)
                    .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST));
        }

        // Valid container magic headers are accepted.
        assertThat(SpeakingService.isSupportedAudioHeader(new byte[]{0x1A, 0x45, (byte) 0xDF, (byte) 0xA3})).isTrue(); // WebM
        assertThat(SpeakingService.isSupportedAudioHeader(new byte[]{'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'A', 'V', 'E'})).isTrue(); // WAV
        assertThat(SpeakingService.isSupportedAudioHeader(new byte[]{'O', 'g', 'g', 'S'})).isTrue(); // OGG
        assertThat(SpeakingService.isSupportedAudioHeader(new byte[]{0, 0, 0, 0x20, 'f', 't', 'y', 'p'})).isTrue(); // MP4/M4A
        assertThat(SpeakingService.isSupportedAudioHeader(new byte[]{'f', 'L', 'a', 'C'})).isTrue(); // FLAC
        assertThat(SpeakingService.isSupportedAudioHeader(new byte[]{'I', 'D', '3', 3})).isTrue(); // MP3 ID3
    }

    @Test
    @DisplayName("EC-SEC-2026-007 & AI-13: AiServiceRequestFactory disables redirects and sends X-EC-Service-Key only to authorized origins")
    void aiServiceRequestFactoryDisablesRedirectsAndScopesServiceKeyToAuthorizedOrigin() throws Exception {
        class InspectableFactory extends AiServiceRequestFactory {
            InspectableFactory(Collection<String> origins, String key) {
                super(origins, key);
            }

            void inspect(HttpURLConnection conn, String method) throws IOException {
                prepareConnection(conn, method);
            }
        }

        InspectableFactory factory = new InspectableFactory(
                List.of("http://198.51.100.16:8005/tts/omnivoice"), "internal-omni-secret");

        HttpURLConnection authorizedConn = mock(HttpURLConnection.class);
        when(authorizedConn.getURL()).thenReturn(URI.create("http://198.51.100.16:8005/tts/omnivoice").toURL());
        factory.inspect(authorizedConn, "GET");
        verify(authorizedConn, org.mockito.Mockito.atLeastOnce()).setInstanceFollowRedirects(false);
        verify(authorizedConn).setRequestProperty(AiServiceAuth.HEADER, "internal-omni-secret");

        HttpURLConnection foreignConn = mock(HttpURLConnection.class);
        when(foreignConn.getURL()).thenReturn(URI.create("https://attacker.example/collect").toURL());
        factory.inspect(foreignConn, "POST");
        verify(foreignConn, org.mockito.Mockito.atLeastOnce()).setInstanceFollowRedirects(false);
        verify(foreignConn, never()).setRequestProperty(eq(AiServiceAuth.HEADER), anyString());
    }

    @Test
    @DisplayName("AUTHZ-03: Speaking session creation and progress hydration never expose foreign private materials")
    void speakingSessionCreationAndProgressHideForeignPrivateMaterials() {
        UserRepository userRepo = mock(UserRepository.class);
        User learner = User.builder().id(10L).email("u10@example.com").role(Role.ROLE_USER).build();
        when(userRepo.findById(10L)).thenReturn(Optional.of(learner));

        ListeningMaterialRepository listeningRepo = mock(ListeningMaterialRepository.class);
        ReadingMaterialRepository readingRepo = mock(ReadingMaterialRepository.class);
        when(listeningRepo.findByIdAndVisibleToUser(999L, 10L)).thenReturn(Optional.empty());
        when(readingRepo.findByIdAndVisibleToUser(888L, 10L)).thenReturn(Optional.empty());

        SpeakingService speakingService = new SpeakingService(
                mock(SpeakingResultRepository.class),
                mock(SpeakingSessionRepository.class),
                mock(SpeakingScenarioRepository.class),
                mock(SpeakingShadowingUnitRepository.class),
                mock(SpeakingShadowingAttemptRepository.class),
                mock(SpeakingShadowingService.class),
                new ObjectMapper(),
                userRepo,
                mock(DictationScoringService.class),
                mock(SpeakingAudioStorageService.class)
        );
        speakingService.setListeningMaterialRepository(listeningRepo);
        speakingService.setReadingMaterialRepository(readingRepo);

        assertThatThrownBy(() -> speakingService.createSession(10L, new SpeakingSessionRequest("SHADOWING", null, "LISTENING", 999L)))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));
        assertThatThrownBy(() -> speakingService.createSession(10L, new SpeakingSessionRequest("SHADOWING", null, "READING", 888L)))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));

        // SpeakingProgressService hides titles of foreign private listening materials.
        SpeakingSession foreignLinkedSession = SpeakingSession.builder()
                .id(500L)
                .user(learner)
                .mode("SHADOWING")
                .status("ACTIVE")
                .sourceType("LISTENING")
                .sourceId(999L)
                .build();
        ListeningMaterial victimPrivateMaterial = ListeningMaterial.builder()
                .id(999L)
                .title("Victim Confidential Title")
                .audioUrl("https://www.youtube.com/watch?v=BF3bXji-J7I")
                .ownerUserId(20L)
                .isSystem(false)
                .build();

        SpeakingSessionRepository sessionRepo = mock(SpeakingSessionRepository.class);
        SpeakingTurnRepository turnRepo = mock(SpeakingTurnRepository.class);
        SpeakingShadowingAttemptRepository attemptRepo = mock(SpeakingShadowingAttemptRepository.class);
        SpeakingProgressAggregationService aggMock = mock(SpeakingProgressAggregationService.class);
        when(sessionRepo.findRecentSessionsByUserId(eq(10L), any())).thenReturn(List.of(foreignLinkedSession));
        when(listeningRepo.findAllById(Set.of(999L))).thenReturn(List.of(victimPrivateMaterial));
        when(aggMock.getRecurringIssues(10L)).thenReturn(List.of());

        SpeakingProgressService progressService = new SpeakingProgressService(
                turnRepo, sessionRepo, mock(SpeakingResultRepository.class),
                mock(SpeakingTurnFeedbackRepository.class), attemptRepo, listeningRepo, aggMock);

        SpeakingProgressDto progress = progressService.getUserSpeakingProgress(10L);
        assertThat(progress.recentActivity()).hasSize(1);
        assertThat(progress.recentActivity().get(0).getContentTitle()).doesNotContain("Victim Confidential Title");

        // SpeakingProgressAggregationService#getSpeakingSessionDetail also hides foreign private material title.
        SpeakingShadowingUnitService unitService = mock(SpeakingShadowingUnitService.class);
        when(sessionRepo.findById(500L)).thenReturn(Optional.of(foreignLinkedSession));
        when(attemptRepo.findBySessionIdOrderByCreatedAtAsc(500L)).thenReturn(List.of());
        when(unitService.getOrGenerateUnits(999L, 10L)).thenReturn(List.of());

        SpeakingProgressAggregationService aggService = new SpeakingProgressAggregationService(
                sessionRepo, attemptRepo, listeningRepo, mock(SpeakingTurnFeedbackRepository.class),
                turnRepo, mock(SpeakingShadowingService.class), unitService,
                userRepo, mock(SpeakingQuickCheckRepository.class), mock(SpeakingQuickCheckService.class));

        SpeakingSessionDetailDto detail = aggService.getSpeakingSessionDetail(10L, 500L);
        assertThat(detail.getMaterialTitle()).isEqualTo("Shadowing Practice");
    }

    @Test
    @DisplayName("AUTHZ-16: SpeakingContext fails closed on null user, AvatarFrame hides inactive/unoffered frames, and ListeningMaterialRepository scopes system rows")
    void speakingContextFailsClosedAvatarFrameHidesUnofferedAndListeningRepoChecksOwnerNull() throws Exception {
        // 1) SpeakingContextService never queries global highlights when userId == null
        ReadingMaterialRepository readingRepo = mock(ReadingMaterialRepository.class);
        DocumentHighlightRepository highlightRepo = mock(DocumentHighlightRepository.class);
        when(readingRepo.findByIdAndVisibleToUser(12L, null)).thenReturn(Optional.of(
                ReadingMaterial.builder().id(12L).title("Public Article").contentText("Hello world.").isSystem(true).build()));

        SpeakingContextService contextService = new SpeakingContextService(
                mock(VocabularyCourseRepository.class), readingRepo, highlightRepo, mock(ListeningMaterialRepository.class));
        contextService.resolveContext("READING", 12L, null);
        verify(highlightRepo, never()).findByReadingMaterialId(anyLong());

        // 2) AvatarFrameServiceImpl#getFrameBySlug returns 404 for inactive or unoffered/unowned frames
        AvatarFrameRepository frameRepo = mock(AvatarFrameRepository.class);
        UserAvatarFrameRepository userFrameRepo = mock(UserAvatarFrameRepository.class);
        AvatarFrameServiceImpl frameService = new AvatarFrameServiceImpl(
                frameRepo, userFrameRepo, mock(PrestigeEvaluationEngine.class), mock(NotificationService.class));
        FrameAudience gardenGate = (uid, lineage) -> !"GARDEN".equals(lineage);
        ReflectionTestUtils.setField(frameService, "frameAudiences", List.of(gardenGate));

        AvatarFrame inactiveFrame = AvatarFrame.builder()
                .id(1L)
                .slug("retired-frame")
                .name("Retired")
                .isActive(false)
                .series(AvatarFrameSeries.builder().id(1L).slug("std").name("Standard").lineage("STANDARD").build())
                .build();
        when(frameRepo.findBySlug("retired-frame")).thenReturn(Optional.of(inactiveFrame));
        when(userFrameRepo.findByUserIdAndFrameId(10L, 1L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> frameService.getFrameBySlug(10L, "retired-frame"))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));

        AvatarFrame gatedGardenFrame = AvatarFrame.builder()
                .id(2L)
                .slug("garden-secret")
                .name("Garden Secret")
                .isActive(true)
                .series(AvatarFrameSeries.builder().id(2L).slug("garden").name("Garden").lineage("GARDEN").build())
                .build();
        when(frameRepo.findBySlug("garden-secret")).thenReturn(Optional.of(gatedGardenFrame));
        when(userFrameRepo.findByUserIdAndFrameId(10L, 2L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> frameService.getFrameBySlug(10L, "garden-secret"))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> assertThat(((ResponseStatusException) ex).getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND));

        // 3) ListeningMaterialRepository system predicates enforce ownerUserId IS NULL
        Query visibleFilters = ListeningMaterialRepository.class
                .getMethod("findVisibleByFilters", Long.class, String.class, String.class, String.class)
                .getAnnotation(Query.class);
        Query byIdVisible = ListeningMaterialRepository.class
                .getMethod("findByIdAndVisibleToUser", Long.class, Long.class)
                .getAnnotation(Query.class);
        Query systemOnly = ListeningMaterialRepository.class
                .getMethod("findByIsSystemTrueOrderByIdAsc")
                .getAnnotation(Query.class);
        assertThat(visibleFilters.value()).contains("m.isSystem = true AND m.ownerUserId IS NULL");
        assertThat(byIdVisible.value()).contains("m.isSystem = true AND m.ownerUserId IS NULL");
        assertThat(systemOnly.value()).contains("m.isSystem = true AND m.ownerUserId IS NULL");
    }

    private void setSessionContext(User user, AuthSessionContext.AdminAccess access) {
        UserDetailsImpl principal = UserDetailsImpl.build(user);
        UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(
                principal, null, principal.getAuthorities());
        auth.setDetails(new AuthSessionContext(
                UUID.randomUUID(), user.getId(), "PASSWORD", Instant.now(),
                access == AuthSessionContext.AdminAccess.GRANTED ? Instant.now() : null,
                null, access));
        SecurityContextHolder.getContext().setAuthentication(auth);
    }

    private SpeakingController buildSpeakingController(
            SpeakingService speakingService,
            SpeakingRoleplayService roleplayService,
            SpeakingFeedbackService feedbackService,
            SpeakingQuickCheckService quickCheckService,
            SpeakingTtsService ttsService
    ) {
        return new SpeakingController(
                speakingService,
                mock(SpeakingContextService.class),
                roleplayService,
                feedbackService,
                mock(SpeakingProgressService.class),
                mock(SpeakingProgressAggregationService.class),
                mock(SpeakingShadowingService.class),
                mock(SpeakingShadowingUnitService.class),
                mock(SpeakingAudioStorageService.class),
                quickCheckService,
                ttsService
        );
    }

    private SpeakingService buildSpeakingService(SpeakingAudioStorageService audioStorage) {
        return new SpeakingService(
                mock(SpeakingResultRepository.class),
                mock(SpeakingSessionRepository.class),
                mock(SpeakingScenarioRepository.class),
                mock(SpeakingShadowingUnitRepository.class),
                mock(SpeakingShadowingAttemptRepository.class),
                mock(SpeakingShadowingService.class),
                new ObjectMapper(),
                mock(UserRepository.class),
                mock(DictationScoringService.class),
                audioStorage
        );
    }
}
