package com.englishcoach.speaking.service;

import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.auth.entity.User;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingTurnRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class SpeakingTtsServiceTest {

    @Mock
    private SpeakingAudioStorageService speakingAudioStorageService;

    @Mock
    private SpeakingSessionRepository speakingSessionRepository;

    @Mock
    private SpeakingTurnRepository speakingTurnRepository;

    private SpeakingTtsService speakingTtsService;

    @BeforeEach
    void setUp() {
        speakingTtsService = new SpeakingTtsService(
                speakingAudioStorageService,
                speakingSessionRepository,
                speakingTurnRepository
        );
        ReflectionTestUtils.setField(speakingTtsService, "omnivoiceUrl", "http://127.0.0.1:8005/tts/omnivoice");
        ReflectionTestUtils.setField(speakingTtsService, "aiBaseUrl", "http://localhost:8000");
        ReflectionTestUtils.setField(speakingTtsService, "timeoutMs", 5000);
    }

    @Test
    void testComputeCacheKeyFormat() {
        String key1 = SpeakingTtsService.computeCacheKey("us_female", "Hello, how are you?");
        String key2 = SpeakingTtsService.computeCacheKey("us_female", "  Hello,   how are you?  ");
        String key3 = SpeakingTtsService.computeCacheKey("uk_male", "Hello, how are you?");

        assertNotNull(key1);
        assertEquals(64, key1.length()); // SHA-256 hex string length
        assertEquals(key1, key2, "Same text and same voice should have identical cache keys");
        assertNotEquals(key1, key3, "Same text and different voices MUST have distinct cache keys");
    }

    @Test
    void testVoicesListReturnsCanonicalFourVoices() {
        var voices = speakingTtsService.getVoices();
        assertEquals(4, voices.size());
        assertTrue(voices.stream().anyMatch(v -> "us_male".equals(v.voiceId())));
        assertTrue(voices.stream().anyMatch(v -> "us_female".equals(v.voiceId())));
        assertTrue(voices.stream().anyMatch(v -> "uk_male".equals(v.voiceId())));
        assertTrue(voices.stream().anyMatch(v -> "uk_female".equals(v.voiceId())));
    }

    @Test
    void testSynthesizeCacheHitReturnsPersistedResourceZeroGenerations() {
        String voiceId = "uk_female";
        String text = "Nice to meet you.";
        String hash = SpeakingTtsService.computeCacheKey(voiceId, text);

        when(speakingAudioStorageService.ttsAudioExists(voiceId, hash)).thenReturn(true);
        Resource mockResource = new ByteArrayResource(new byte[]{1, 2, 3});
        when(speakingAudioStorageService.loadTtsAudioResource(voiceId, hash)).thenReturn(mockResource);

        Resource result = speakingTtsService.synthesize(voiceId, text);

        assertNotNull(result);
        assertEquals(mockResource, result);
        verify(speakingAudioStorageService, never()).saveTtsAudio(anyString(), anyString(), any());
    }

    @Test
    void testGetOrSynthesizeTurnAudioReusesExistingTurnRef() {
        Long userId = 1L;
        Long sessionId = 10L;
        Long turnId = 100L;

        User user = new User();
        user.setId(userId);

        SpeakingSession session = SpeakingSession.builder()
                .id(sessionId)
                .user(user)
                .voiceId("us_male")
                .mode("ROLEPLAY")
                .build();

        SpeakingTurn turn = SpeakingTurn.builder()
                .id(turnId)
                .session(session)
                .speaker("ASSISTANT")
                .text("Welcome to our store!")
                .synthesizedAudioRef("tts/us_male/somehash.wav")
                .build();

        when(speakingSessionRepository.findById(sessionId)).thenReturn(Optional.of(session));
        when(speakingTurnRepository.findById(turnId)).thenReturn(Optional.of(turn));

        Resource mockResource = new ByteArrayResource(new byte[]{4, 5, 6});
        when(speakingAudioStorageService.loadTtsAudioResourceByRef("tts/us_male/somehash.wav")).thenReturn(mockResource);

        Resource result = speakingTtsService.getOrSynthesizeTurnAudio(userId, sessionId, turnId);

        assertNotNull(result);
        assertEquals(mockResource, result);
        // Verify 0 new model invocations or saves
        verify(speakingAudioStorageService, never()).saveTtsAudio(anyString(), anyString(), any());
    }
}
