package com.englishcoach.speaking.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.speaking.dto.RoleplayTurnResponseDto;
import com.englishcoach.speaking.dto.SpeakingTurnDto;
import com.englishcoach.speaking.entity.SpeakingScenario;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.speaking.entity.enums.CefrLevel;
import com.englishcoach.speaking.entity.enums.ScenarioCategory;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingTurnRepository;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.server.ResponseStatusException;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SpeakingRoleplayServiceTest {

    @Mock
    private SpeakingSessionRepository speakingSessionRepository;

    @Mock
    private SpeakingTurnRepository speakingTurnRepository;

    @Mock
    private SpeakingService speakingService;

    @Mock
    private SpeakingContextService speakingContextService;

    @Mock
    private com.englishcoach.speaking.service.SpeakingAudioStorageService speakingAudioStorageService;

    @Mock
    private com.englishcoach.speaking.repository.SpeakingTurnFeedbackRepository speakingTurnFeedbackRepository;

    @InjectMocks
    private SpeakingRoleplayService speakingRoleplayService;

    private User sampleUser;
    private SpeakingSession roleplaySession;
    private SpeakingScenario sampleScenario;

    private static final byte[] VALID_WEBM = new byte[]{0x1A, 0x45, (byte) 0xDF, (byte) 0xA3, 0x01, 0x02};

    @BeforeEach
    void setUp() {
        ReflectionTestUtils.setField(speakingRoleplayService, "connectTimeoutMs", 5000);
        ReflectionTestUtils.setField(speakingRoleplayService, "readTimeoutMs", 5000);
        sampleUser = User.builder().id(10L).email("user@test.com").build();

        sampleScenario = SpeakingScenario.builder()
                .id(1L)
                .title("Hotel Check-in & Preferences")
                .cefrLevel(CefrLevel.B1)
                .category(ScenarioCategory.TRAVEL)
                .learnerRole("Hotel Guest")
                .aiRole("Front Desk Receptionist")
                .learnerGoal("Check in and confirm breakfast times.")
                .targetVocabulary(List.of("reservation", "amenities", "upgrade"))
                .build();

        roleplaySession = SpeakingSession.builder()
                .id(100L)
                .user(sampleUser)
                .scenario(sampleScenario)
                .mode("ROLEPLAY")
                .status("ACTIVE")
                .durationSeconds(0)
                .build();
    }

    @Test
    @DisplayName("Idempotency: Re-submitting the same clientTurnId returns existing turn without ASR or LLM invocation")
    void testIdempotentReplay() {
        SpeakingTurn existingLearnerTurn = SpeakingTurn.builder()
                .id(50L)
                .session(roleplaySession)
                .clientTurnId("client-uuid-123")
                .sequenceNumber(1)
                .speaker("LEARNER")
                .text("I have a reservation.")
                .detectedVocabulary(List.of("reservation"))
                .isMocked(false)
                .build();

        SpeakingTurn existingAiTurn = SpeakingTurn.builder()
                .id(51L)
                .session(roleplaySession)
                .clientTurnId("client-uuid-123-ai")
                .sequenceNumber(2)
                .speaker("ASSISTANT")
                .text("Welcome! Let me check your booking.")
                .detectedVocabulary(List.of())
                .isMocked(false)
                .build();

        when(speakingSessionRepository.findById(100L)).thenReturn(Optional.of(roleplaySession));
        when(speakingTurnRepository.findBySessionIdAndClientTurnId(100L, "client-uuid-123"))
                .thenReturn(Optional.of(existingLearnerTurn));
        when(speakingTurnRepository.findBySessionIdOrderBySequenceNumberAsc(100L))
                .thenReturn(List.of(existingLearnerTurn, existingAiTurn));

        MockMultipartFile audioFile = new MockMultipartFile("file", "test.webm", "audio/webm", "test".getBytes());

        RoleplayTurnResponseDto response = speakingRoleplayService.processTurn(10L, 100L, audioFile, "client-uuid-123");

        assertThat(response).isNotNull();
        assertThat(response.isIdempotentReplay()).isTrue();
        assertThat(response.learnerTurn().text()).isEqualTo("I have a reservation.");
        assertThat(response.assistantTurn().text()).isEqualTo("Welcome! Let me check your booking.");
        assertThat(response.detectedVocabularyThisTurn()).containsExactly("reservation");

        // Verify ASR was NEVER called
        verify(speakingService, never()).forwardAudioForAnalysis(any(byte[].class), any(), any(), any());
        verify(speakingTurnRepository, never()).save(any());
    }

    @Test
    @DisplayName("Safe Completion Gate: Session status remains ACTIVE even if advisory task_completed is true")
    void testSessionRemainsActiveWhenTaskCompleted() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/speaking/roleplay/turn", exchange -> {
            byte[] body = "{\"assistant_text\":\"Certainly! Welcome to the hotel.\",\"target_vocabulary_detected\":[\"reservation\"],\"task_completed\":true,\"is_mocked\":false,\"summary\":\"Good\",\"positive_feedback\":\"Clear\",\"corrections\":[]}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            ReflectionTestUtils.setField(speakingRoleplayService, "aiBaseUrl", "http://127.0.0.1:" + server.getAddress().getPort());
            when(speakingSessionRepository.findById(100L)).thenReturn(Optional.of(roleplaySession));
            when(speakingTurnRepository.findBySessionIdAndClientTurnId(100L, "uuid-new")).thenReturn(Optional.empty());
            when(speakingService.forwardAudioForAnalysis(any(byte[].class), anyString(), anyString(), isNull())).thenReturn(Map.of(
                    "transcription", "I would like to check in for my reservation.",
                    "isMocked", false
            ));
            when(speakingTurnRepository.findMaxSequenceNumberBySessionId(100L)).thenReturn(0);

            SpeakingTurn savedLearner = SpeakingTurn.builder()
                    .id(1L)
                    .session(roleplaySession)
                    .sequenceNumber(1)
                    .speaker("LEARNER")
                    .text("I would like to check in for my reservation.")
                    .detectedVocabulary(List.of("reservation"))
                    .isMocked(false)
                    .build();

            SpeakingTurn savedAssistant = SpeakingTurn.builder()
                    .id(2L)
                    .session(roleplaySession)
                    .sequenceNumber(2)
                    .speaker("ASSISTANT")
                    .text("Certainly! Welcome to the hotel.")
                    .detectedVocabulary(List.of())
                    .isMocked(false)
                    .build();

            when(speakingTurnRepository.save(any(SpeakingTurn.class)))
                    .thenReturn(savedLearner)
                    .thenReturn(savedAssistant);
            when(speakingTurnRepository.findBySessionIdOrderBySequenceNumberAsc(100L))
                    .thenReturn(List.of(savedLearner, savedAssistant));

            MockMultipartFile audioFile = new MockMultipartFile("file", "test.webm", "audio/webm", VALID_WEBM);

            RoleplayTurnResponseDto response = speakingRoleplayService.processTurn(10L, 100L, audioFile, "uuid-new");

            assertThat(response).isNotNull();
            assertThat(response.isTaskCompleted()).isTrue();
            // Crucial safety check: session status remains ACTIVE, not COMPLETED
            assertThat(roleplaySession.getStatus()).isEqualTo("ACTIVE");
            verify(speakingSessionRepository).save(roleplaySession);
        } finally {
            server.stop(0);
        }
    }

    @Test
    @DisplayName("Sequence Ordering: Sequence numbers strictly increment without duplicates")
    void testSequenceNumberProgression() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/speaking/roleplay/turn", exchange -> {
            byte[] body = "{\"assistant_text\":\"Hello there!\",\"target_vocabulary_detected\":[],\"task_completed\":false,\"is_mocked\":false,\"summary\":\"Good\",\"positive_feedback\":\"Clear\",\"corrections\":[]}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            ReflectionTestUtils.setField(speakingRoleplayService, "aiBaseUrl", "http://127.0.0.1:" + server.getAddress().getPort());
            when(speakingSessionRepository.findById(100L)).thenReturn(Optional.of(roleplaySession));
            when(speakingTurnRepository.findBySessionIdAndClientTurnId(100L, "turn-3")).thenReturn(Optional.empty());
            when(speakingService.forwardAudioForAnalysis(any(byte[].class), anyString(), anyString(), isNull())).thenReturn(Map.of("transcription", "Hello"));
            when(speakingTurnRepository.findMaxSequenceNumberBySessionId(100L)).thenReturn(4); // previous turns 1,2,3,4 exist

            ArgumentCaptor<SpeakingTurn> turnCaptor = ArgumentCaptor.forClass(SpeakingTurn.class);

            when(speakingTurnRepository.save(turnCaptor.capture())).thenAnswer(invocation -> invocation.getArgument(0));

            MockMultipartFile audioFile = new MockMultipartFile("file", "test.webm", "audio/webm", VALID_WEBM);
            speakingRoleplayService.processTurn(10L, 100L, audioFile, "turn-3");

            List<SpeakingTurn> savedTurns = turnCaptor.getAllValues();
            assertThat(savedTurns).hasSize(2);
            assertThat(savedTurns.get(0).getSequenceNumber()).isEqualTo(5);
            assertThat(savedTurns.get(0).getSpeaker()).isEqualTo("LEARNER");
            assertThat(savedTurns.get(1).getSequenceNumber()).isEqualTo(6);
            assertThat(savedTurns.get(1).getSpeaker()).isEqualTo("ASSISTANT");
        } finally {
            server.stop(0);
        }
    }

    @Test
    @DisplayName("Security: Accessing a session belonging to another user throws 403 Forbidden")
    void testUnauthorizedSessionAccess() {
        when(speakingSessionRepository.findById(100L)).thenReturn(Optional.of(roleplaySession));

        MockMultipartFile audioFile = new MockMultipartFile("file", "test.webm", "audio/webm", "test".getBytes());

        assertThatThrownBy(() -> speakingRoleplayService.processTurn(999L, 100L, audioFile, "uuid-1"))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("403 FORBIDDEN");
    }

    @Test
    @DisplayName("Mode Check: Submitting turns to a non-ROLEPLAY session throws 400 Bad Request")
    void testNonRoleplaySessionThrows() {
        SpeakingSession shadowingSession = SpeakingSession.builder()
                .id(200L)
                .user(sampleUser)
                .mode("SHADOWING")
                .status("ACTIVE")
                .build();

        when(speakingSessionRepository.findById(200L)).thenReturn(Optional.of(shadowingSession));

        MockMultipartFile audioFile = new MockMultipartFile("file", "test.webm", "audio/webm", "test".getBytes());

        assertThatThrownBy(() -> speakingRoleplayService.processTurn(10L, 200L, audioFile, "uuid-2"))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("400 BAD_REQUEST");
    }

    @Test
    @DisplayName("State Validation: Submitting turns to a COMPLETED session throws 400 Bad Request")
    void testCompletedSessionRejectsNewTurn() {
        SpeakingSession completedSession = SpeakingSession.builder()
                .id(300L)
                .user(sampleUser)
                .scenario(sampleScenario)
                .mode("ROLEPLAY")
                .status("COMPLETED")
                .build();

        when(speakingSessionRepository.findById(300L)).thenReturn(Optional.of(completedSession));

        MockMultipartFile audioFile = new MockMultipartFile("file", "test.webm", "audio/webm", "test".getBytes());

        assertThatThrownBy(() -> speakingRoleplayService.processTurn(10L, 300L, audioFile, "uuid-3"))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("Cannot submit turns to a COMPLETED session");
    }

    @Test
    @DisplayName("getSessionTurns returns existing ordered conversation turns")
    void testGetSessionTurns() {
        SpeakingTurn turn1 = SpeakingTurn.builder()
                .id(1L)
                .session(roleplaySession)
                .sequenceNumber(1)
                .speaker("LEARNER")
                .text("Hello")
                .createdAt(LocalDateTime.now())
                .build();

        SpeakingTurn turn2 = SpeakingTurn.builder()
                .id(2L)
                .session(roleplaySession)
                .sequenceNumber(2)
                .speaker("ASSISTANT")
                .text("Good afternoon!")
                .createdAt(LocalDateTime.now())
                .build();

        when(speakingSessionRepository.findById(100L)).thenReturn(Optional.of(roleplaySession));
        when(speakingTurnRepository.findBySessionIdOrderBySequenceNumberAsc(100L)).thenReturn(List.of(turn1, turn2));

        List<SpeakingTurnDto> turns = speakingRoleplayService.getSessionTurns(10L, 100L);

        assertThat(turns).hasSize(2);
        assertThat(turns.get(0).speaker()).isEqualTo("LEARNER");
        assertThat(turns.get(1).speaker()).isEqualTo("ASSISTANT");
    }

    @Test
    @DisplayName("getTurnPronunciation: Deserializes JSON result when present")
    void testGetTurnPronunciationJson() {
        String mockJson = "{\"engineVersion\":\"pronunciation-v2.2\",\"status\":\"COMPLETED\",\"overall\":{\"overallScore\":88,\"fluencyScore\":92}}";
        SpeakingTurn turn = SpeakingTurn.builder()
                .id(15L)
                .session(roleplaySession)
                .sequenceNumber(1)
                .speaker("LEARNER")
                .text("Hello world")
                .pronunciationScore(88)
                .pronunciationResultJson(mockJson)
                .build();

        when(speakingSessionRepository.findById(100L)).thenReturn(Optional.of(roleplaySession));
        when(speakingTurnRepository.findById(15L)).thenReturn(Optional.of(turn));

        com.englishcoach.speaking.dto.PronunciationV2ResponseDto result = speakingRoleplayService.getTurnPronunciation(10L, 100L, 15L);

        assertThat(result).isNotNull();
        assertThat(result.getEngineVersion()).isEqualTo("pronunciation-v2.2");
        assertThat(result.getStatus()).isEqualTo("COMPLETED");
        assertThat(result.getOverall().getOverallScore()).isEqualTo(88);
        assertThat(result.getOverall().getFluencyScore()).isEqualTo(92);
    }

    @Test
    @DisplayName("getTurnPronunciation: scalar history is preserved when detailed evidence is unavailable")
    void testGetTurnPronunciationFallback() {
        SpeakingTurn turn = SpeakingTurn.builder()
                .id(16L)
                .session(roleplaySession)
                .clientTurnId("turn-16")
                .sequenceNumber(1)
                .speaker("LEARNER")
                .text("I need an upgrade")
                .pronunciationScore(82)
                .fluencyScore(78)
                .stressScore(85)
                .intonationScore(80)
                .rhythmScore(79)
                .engineVersion("pronunciation-v2.2")
                .build();

        when(speakingSessionRepository.findById(100L)).thenReturn(Optional.of(roleplaySession));
        when(speakingTurnRepository.findById(16L)).thenReturn(Optional.of(turn));

        assertThatThrownBy(() -> speakingRoleplayService.getTurnPronunciation(10L, 100L, 16L))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("404");
        assertThat(turn.getPronunciationScore()).isEqualTo(82);
    }

    @Test
    @DisplayName("getTurnPronunciation: Throws 404 if no pronunciation metrics exist")
    void testGetTurnPronunciationNotFound() {
        SpeakingTurn turn = SpeakingTurn.builder()
                .id(17L)
                .session(roleplaySession)
                .sequenceNumber(1)
                .speaker("LEARNER")
                .text("No score yet")
                .build();

        when(speakingSessionRepository.findById(100L)).thenReturn(Optional.of(roleplaySession));
        when(speakingTurnRepository.findById(17L)).thenReturn(Optional.of(turn));

        assertThatThrownBy(() -> speakingRoleplayService.getTurnPronunciation(10L, 100L, 17L))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("No pronunciation metrics available for turn");
    }
}
