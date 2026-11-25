package com.englishcoach.speaking.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.speaking.dto.*;
import com.englishcoach.speaking.entity.SpeakingQuickCheck;
import com.englishcoach.speaking.repository.SpeakingQuickCheckRepository;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import jakarta.persistence.Table;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.server.ResponseStatusException;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.AdditionalMatchers.aryEq;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SpeakingQuickCheckServiceTest {
    @Mock SpeakingService speakingService;
    @Mock SpeakingAudioStorageService speakingAudioStorageService;
    @Mock SpeakingQuickCheckRepository speakingQuickCheckRepository;
    @Mock SpeakingSessionRepository speakingSessionRepository;
    @Mock UserRepository userRepository;
    @InjectMocks SpeakingQuickCheckService service;

    private final User user = User.builder().id(10L).build();
    private final MockMultipartFile audio = new MockMultipartFile(
            "file", "speech.webm", "audio/webm", new byte[]{0x1A, 0x45, (byte) 0xDF, (byte) 0xA3, 1, 2, 3});

    @Test
    void entityUsesTheFlywaySchema() {
        assertThat(SpeakingQuickCheck.class.getAnnotation(Table.class).schema()).isEqualTo("exams");
    }

    @Test
    void emptySpeechSkipsBothDownstreamModels() {
        when(userRepository.findById(10L)).thenReturn(Optional.of(user));
        when(speakingService.forwardAudioForAnalysis(any(byte[].class), eq("speech.webm"), isNull()))
                .thenReturn(Map.of("transcription", ""));
        assertThat(service.analyzeQuickCheck(10L, audio, "empty", null).getSttStatus()).isEqualTo("FAILED");
        verify(speakingService, never()).analyzePronunciationV2(any(byte[].class), anyString(), anyString(), anyString(), anyString(), anyString());
        verify(speakingQuickCheckRepository, never()).save(any());
    }

    @Test
    void mockedSpeechIsNotSuccess() {
        when(userRepository.findById(10L)).thenReturn(Optional.of(user));
        when(speakingService.forwardAudioForAnalysis(any(byte[].class), eq("speech.webm"), isNull()))
                .thenReturn(Map.of("transcription", "Recorded audio analyzed", "isMocked", true));
        assertThatThrownBy(() -> service.analyzeQuickCheck(10L, audio, "mock", null))
                .isInstanceOf(ResponseStatusException.class);
        verify(speakingQuickCheckRepository, never()).save(any());
    }

    @Test
    void freshAttemptCallsEachModelOnceAndRejectsMockedLanguage() throws Exception {
        runAttempt(true);
    }

    @Test
    void freshAttemptPersistsRealFeedbackAndReplayDoesNotCallModels() throws Exception {
        runAttempt(false);
    }

    private void runAttempt(boolean mocked) throws Exception {
        AtomicInteger languageCalls = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/speaking/quick-check/language-check", exchange -> {
            languageCalls.incrementAndGet();
            byte[] body = ("{\"status\":\"CORRECT\",\"corrections\":[],\"positive_feedback\":\"Good\",\"is_mocked\":" + mocked + "}").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            ObjectMapper mapper = new ObjectMapper();
            ReflectionTestUtils.setField(service, "objectMapper", mapper);
            ReflectionTestUtils.setField(service, "aiBaseUrl", "http://127.0.0.1:" + server.getAddress().getPort());
            when(userRepository.findById(10L)).thenReturn(Optional.of(user));
            when(speakingService.forwardAudioForAnalysis(aryEq(audio.getBytes()), eq("speech.webm"), isNull()))
                    .thenReturn(Map.of("transcription", "Hello world"));
            when(speakingService.analyzePronunciationV2(aryEq(audio.getBytes()), eq("speech.webm"), eq("Hello world"), eq("Hello world"), eq("session_qc_once"), eq("once")))
                    .thenReturn(PronunciationV2ResponseDto.builder()
                            .status("COMPLETED")
                            .overall(PronunciationV2ResponseDto.OverallScoreDto.builder().overallScore(86).build())
                            .build());
            when(speakingSessionRepository.save(any())).thenAnswer(call -> call.getArgument(0));
            when(speakingQuickCheckRepository.save(any())).thenAnswer(call -> call.getArgument(0));
            QuickCheckResponseDto result = service.analyzeQuickCheck(10L, audio, "once", null);
            assertThat(result.getLanguageStatus()).isEqualTo(mocked ? "UNAVAILABLE" : "SUCCESS");
            if (mocked) assertThat(result.getLanguageFeedback()).isNull();
            else assertThat(mapper.writeValueAsString(result.getLanguageFeedback())).contains("\"positiveFeedback\":\"Good\"");
            when(speakingQuickCheckRepository.findByUserIdAndClientAttemptId(10L, "once")).thenReturn(Optional.of(
                    SpeakingQuickCheck.builder().user(user).clientAttemptId("once").build()));
            service.analyzeQuickCheck(10L, audio, "once", null);
            assertThat(languageCalls.get()).isEqualTo(1);
            verify(speakingService, times(1)).forwardAudioForAnalysis(aryEq(audio.getBytes()), eq("speech.webm"), isNull());
            verify(speakingService, times(1)).analyzePronunciationV2(aryEq(audio.getBytes()), eq("speech.webm"), eq("Hello world"), eq("Hello world"), eq("session_qc_once"), eq("once"));
            verify(speakingAudioStorageService, times(1)).saveAttemptAudio(eq(10L), eq("once"), aryEq(audio.getBytes()), eq("speech.webm"));
        } finally {
            server.stop(0);
        }
    }
}
