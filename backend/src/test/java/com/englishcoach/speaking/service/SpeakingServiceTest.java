package com.englishcoach.speaking.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.listening.service.DictationScoringService;
import com.englishcoach.speaking.dto.SpeakingSessionUpdateRequest;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.repository.SpeakingResultRepository;
import com.englishcoach.speaking.repository.SpeakingScenarioRepository;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpEntity;
import org.springframework.http.MediaType;
import org.springframework.web.server.ResponseStatusException;

import java.util.Optional;
import java.util.List;
import java.util.Map;
import java.lang.reflect.Method;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SpeakingServiceTest {

    @Mock
    private SpeakingResultRepository speakingResultRepository;

    @Mock
    private SpeakingSessionRepository speakingSessionRepository;

    @Mock
    private SpeakingScenarioRepository speakingScenarioRepository;

    @Mock
    private UserRepository userRepository;

    @Mock
    private DictationScoringService dictationScoringService;

    @InjectMocks
    private SpeakingService speakingService;

    private User sampleUser;
    private SpeakingSession sampleSession;

    @BeforeEach
    void setUp() {
        sampleUser = User.builder().id(10L).email("user@test.com").build();
        sampleSession = SpeakingSession.builder()
                .id(100L)
                .user(sampleUser)
                .mode("SHADOWING")
                .status("ACTIVE")
                .durationSeconds(30)
                .build();
    }

    @Test
    @DisplayName("Audio Validation: Empty audio upload throws 400 Bad Request")
    void testEmptyAudioFileThrowsBadRequest() {
        MockMultipartFile emptyFile = new MockMultipartFile("file", "empty.webm", "audio/webm", new byte[0]);

        assertThatThrownBy(() -> speakingService.forwardAudioForAnalysis(emptyFile, null))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("400 BAD_REQUEST");
    }

    @Test
    @DisplayName("Audio Validation: Oversized audio file (>25MB) throws 400 Bad Request")
    void testOverCapacityAudioFileThrowsBadRequest() {
        byte[] largeBytes = new byte[26 * 1024 * 1024]; // 26MB
        MockMultipartFile largeFile = new MockMultipartFile("file", "large.webm", "audio/webm", largeBytes);

        assertThatThrownBy(() -> speakingService.forwardAudioForAnalysis(largeFile, null))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("400 BAD_REQUEST");
    }

    @Test
    @DisplayName("ECSM Audio Validation: Empty audio upload throws 400 Bad Request")
    void testEmptyEcsmAudioThrowsBadRequest() {
        MockMultipartFile emptyFile = new MockMultipartFile("file", "empty.webm", "audio/webm", new byte[0]);

        assertThatThrownBy(() -> speakingService.analyzeEcsmSpeech(emptyFile, "Test", null, "SHADOWING_REFERENCE_RELATIVE", null, null, null, null, null))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("400 BAD_REQUEST");
    }

    @Test
    @DisplayName("ECSM Audio Validation: Oversized audio file (>25MB) throws 400 Bad Request")
    void testOverCapacityEcsmAudioThrowsBadRequest() {
        byte[] largeBytes = new byte[26 * 1024 * 1024]; // 26MB
        MockMultipartFile largeFile = new MockMultipartFile("file", "large.webm", "audio/webm", largeBytes);

        assertThatThrownBy(() -> speakingService.analyzeEcsmSpeech(largeFile, "Test", null, "SHADOWING_REFERENCE_RELATIVE", null, null, null, null, null))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("400 BAD_REQUEST");
    }

    @Test
    @DisplayName("Multipart forwarding preserves truthful WebM MIME type, filename, and bytes")
    void testWebmMultipartForwardingContract() throws Exception {
        byte[] webmBytes = new byte[] {0x1a, 0x45, (byte) 0xdf, (byte) 0xa3, 0x01, 0x02};
        MockMultipartFile file = new MockMultipartFile(
                "file", "recording.webm", "audio/webm;codecs=opus", webmBytes);

        Method method = SpeakingService.class.getDeclaredMethod(
                "buildAudioPart", org.springframework.web.multipart.MultipartFile.class, String.class);
        method.setAccessible(true);
        @SuppressWarnings("unchecked")
        HttpEntity<ByteArrayResource> part = (HttpEntity<ByteArrayResource>) method.invoke(
                speakingService, file, "recording.webm");

        assertThat(part.getHeaders().getContentType()).isEqualTo(MediaType.parseMediaType("audio/webm;codecs=opus"));
        assertThat(part.getBody()).isNotNull();
        assertThat(part.getBody().getFilename()).isEqualTo("recording.webm");
        assertThat(part.getBody().getByteArray()).containsExactly(webmBytes);
    }

    @Test
    @DisplayName("ECSM target contract: caller expectedText is never overwritten by unitId")
    void testCallerExpectedTextRemainsAuthoritative() {
        String callerText = "So I think what I'll do is just call you a storyteller.";

        String resolved = speakingService.resolveAuthoritativeExpectedText(callerText, 101L);

        assertThat(resolved).isEqualTo(callerText);
    }

    @Test
    @DisplayName("Content correspondence: only matched target regions are authorized for phonetic assessment")
    void testMatchedTargetRegionContract() {
        List<Map<String, Object>> alignment = speakingService.computeWordAlignment(
                "I think this is good.",
                "I think that is good."
        );

        assertThat(speakingService.extractMatchedTargetWordIndices(alignment))
                .containsExactly(0, 1, 3, 4);
        Map<String, Object> blockedThis = alignment.stream()
                .filter(row -> Integer.valueOf(2).equals(row.get("targetWordIndex")))
                .findFirst()
                .orElseThrow();
        assertThat(blockedThis.get("status")).isEqualTo("WRONG_WORD");
    }

    @Test
    @DisplayName("State Machine: Attempting to reopen a COMPLETED session throws 400 Bad Request")
    void testCannotReopenCompletedSession() {
        sampleSession.setStatus("COMPLETED");
        when(speakingSessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));

        SpeakingSessionUpdateRequest request = new SpeakingSessionUpdateRequest("ACTIVE", 60);

        assertThatThrownBy(() -> speakingService.updateSession(10L, 100L, request))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("Cannot alter state of an already completed session");
    }

    @Test
    @DisplayName("Security: Unauthorized user updating a session throws 403 Forbidden")
    void testUnauthorizedSessionUpdateThrowsForbidden() {
        when(speakingSessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));

        SpeakingSessionUpdateRequest request = new SpeakingSessionUpdateRequest("COMPLETED", 60);

        assertThatThrownBy(() -> speakingService.updateSession(999L, 100L, request))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("403 FORBIDDEN");
    }

    @Test
    @DisplayName("State Machine: Valid transition to COMPLETED updates duration and status")
    void testValidSessionStatusUpdate() {
        when(speakingSessionRepository.findById(100L)).thenReturn(Optional.of(sampleSession));
        when(speakingSessionRepository.save(sampleSession)).thenReturn(sampleSession);

        SpeakingSessionUpdateRequest request = new SpeakingSessionUpdateRequest("COMPLETED", 120);

        SpeakingSession updated = speakingService.updateSession(10L, 100L, request);

        assertThat(updated.getStatus()).isEqualTo("COMPLETED");
        assertThat(updated.getDurationSeconds()).isEqualTo(120);
    }

    @Test
    @DisplayName("createSession: Inaccessible or other user's scenario throws 404 NOT_FOUND")
    void testCreateSessionInaccessibleScenarioThrowsNotFound() {
        when(userRepository.findById(10L)).thenReturn(Optional.of(sampleUser));
        when(speakingScenarioRepository.findByIdAndAccessible(999L, 10L)).thenReturn(Optional.empty());

        var req = new com.englishcoach.speaking.dto.SpeakingSessionRequest("ROLEPLAY", 999L, null, null);

        assertThatThrownBy(() -> speakingService.createSession(10L, req))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("404 NOT_FOUND");
    }

    @Test
    @DisplayName("createSession: Accessible scenario binds successfully")
    void testCreateSessionAccessibleScenarioSuccess() {
        when(userRepository.findById(10L)).thenReturn(Optional.of(sampleUser));
        var scenario = com.englishcoach.speaking.entity.SpeakingScenario.builder()
                .id(1L)
                .title("Hotel")
                .isSystem(true)
                .build();
        when(speakingScenarioRepository.findByIdAndAccessible(1L, 10L)).thenReturn(Optional.of(scenario));
        when(speakingSessionRepository.save(any(SpeakingSession.class))).thenAnswer(inv -> inv.getArgument(0));

        var req = new com.englishcoach.speaking.dto.SpeakingSessionRequest("ROLEPLAY", 1L, null, null);
        SpeakingSession session = speakingService.createSession(10L, req);

        assertThat(session).isNotNull();
        assertThat(session.getScenario()).isEqualTo(scenario);
        assertThat(session.getMode()).isEqualTo("ROLEPLAY");
    }
}
