package com.englishcoach.speaking.service;

import com.englishcoach.auth.service.LoginThrottleService;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingTurnRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.server.ResponseStatusException;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.Semaphore;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/** Everything a learner's synthesis request is refused for, and that each refusal happens before any GPU work. */
@ExtendWith(MockitoExtension.class)
class SpeakingTtsAdmissionTest {

    @Mock
    private SpeakingAudioStorageService storage;
    @Mock
    private SpeakingSessionRepository sessions;
    @Mock
    private SpeakingTurnRepository turns;
    @Mock
    private LoginThrottleService throttle;

    private SpeakingTtsService service;

    @BeforeEach
    void setUp() {
        service = new SpeakingTtsService(storage, sessions, turns);
        ReflectionTestUtils.setField(service, "throttleService", throttle);
        ReflectionTestUtils.setField(service, "synthesizeMaxChars", 1200);
        ReflectionTestUtils.setField(service, "synthesizeMaxConcurrent", 2);
        ReflectionTestUtils.setField(service, "synthesizeUserNewPer10Min", 40);
        // an address nothing listens on: reaching the provider would fail loudly instead of passing by accident
        ReflectionTestUtils.setField(service, "omnivoiceUrl", "http://127.0.0.1:9/tts/omnivoice");
        ReflectionTestUtils.setField(service, "aiBaseUrl", "http://127.0.0.1:9");
        ReflectionTestUtils.setField(service, "timeoutMs", 500);
    }

    @Test
    @DisplayName("No learner: refused, nothing read, nothing counted")
    void anonymousIsRefused() {
        assertThatThrownBy(() -> service.synthesizeForLearner(null, "us_female", "Hello"))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED));
        verifyNoInteractions(storage, throttle);
    }

    @Test
    @DisplayName("A text over the limit is refused before the cache, the counter and the provider")
    void tooLongIsRefused() {
        assertThatThrownBy(() -> service.synthesizeForLearner(7L, "us_female", "a".repeat(1201)))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE));
        verifyNoInteractions(storage, throttle);
    }

    @Test
    @DisplayName("A text synthesized before is served from the cache and counts against nobody")
    void cacheHitIsFreeOfCharge() {
        String hash = SpeakingTtsService.computeCacheKey("uk_female", "Nice to meet you.");
        Resource cached = new ByteArrayResource(new byte[]{1, 2, 3});
        when(storage.ttsAudioExists("uk_female", hash)).thenReturn(true);
        when(storage.loadTtsAudioResource("uk_female", hash)).thenReturn(cached);

        assertThat(service.synthesizeForLearner(7L, "uk_female", "  Nice to   meet you. ")).isSameAs(cached);
        verifyNoInteractions(throttle);
        verify(storage, never()).saveTtsAudio(anyString(), anyString(), any());
    }

    @Test
    @DisplayName("A learner over the new-synthesis count gets 429 with Retry-After and the provider is not called")
    void perLearnerCountRefuses() {
        when(storage.ttsAudioExists(anyString(), anyString())).thenReturn(false);
        when(throttle.countRequest(eq("TTS_SYNTH_USER"), eq("7"), eq(40), eq(10))).thenReturn(false);

        assertThatThrownBy(() -> service.synthesizeForLearner(7L, "us_male", "A brand new sentence."))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                    assertThat(e.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
                    assertThat(e.getHeaders().getFirst(HttpHeaders.RETRY_AFTER)).isEqualTo("60");
                });
        verify(storage, never()).saveTtsAudio(anyString(), anyString(), any());
    }

    @Test
    @DisplayName("The count is per learner: one learner's limit is keyed by that learner only")
    void countIsKeyedByLearner() {
        when(storage.ttsAudioExists(anyString(), anyString())).thenReturn(false);
        when(throttle.countRequest(eq("TTS_SYNTH_USER"), eq("8"), anyInt(), anyInt())).thenReturn(false);

        assertThatThrownBy(() -> service.synthesizeForLearner(8L, "us_male", "Another new sentence."))
                .isInstanceOf(ResponseStatusException.class);
        verify(throttle).countRequest("TTS_SYNTH_USER", "8", 40, 10);
    }

    @Test
    @DisplayName("A busy worker answers 503 with Retry-After within the short wait instead of queueing the request")
    void busyWorkerShedsLoad() {
        when(storage.ttsAudioExists(anyString(), anyString())).thenReturn(false);
        when(throttle.countRequest(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
        ReflectionTestUtils.setField(service, "synthesizeSlots", new Semaphore(0, true));

        long started = System.nanoTime();
        assertThatThrownBy(() -> service.synthesizeForLearner(7L, "us_male", "A sentence nobody cached."))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                    assertThat(e.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                    assertThat(e.getHeaders().getFirst(HttpHeaders.RETRY_AFTER)).isEqualTo("5");
                });
        assertThat((System.nanoTime() - started) / 1_000_000).isLessThan(4000);
        verify(storage, never()).saveTtsAudio(anyString(), anyString(), any());
    }

    @Test
    @DisplayName("A failed synthesis gives its slot back")
    void slotIsReleasedAfterFailure() {
        when(storage.ttsAudioExists(anyString(), anyString())).thenReturn(false);
        when(throttle.countRequest(anyString(), anyString(), anyInt(), anyInt())).thenReturn(true);
        Semaphore slots = new Semaphore(1, true);
        ReflectionTestUtils.setField(service, "synthesizeSlots", slots);

        assertThatThrownBy(() -> service.synthesizeForLearner(7L, "us_male", "The provider is unreachable."))
                .isInstanceOf(RuntimeException.class);
        assertThat(slots.availablePermits()).isEqualTo(1);
    }

    @Test
    @DisplayName("A TTS reference never reaches a learner's own recording stored beside the cache")
    void ttsRefCannotReadLearnerRecordings(@TempDir Path dir) throws Exception {
        SpeakingAudioStorageService real = new SpeakingAudioStorageService(dir.toString());
        Files.createDirectories(dir.resolve("42"));
        Files.write(dir.resolve("42").resolve("attempt-1.bin"), new byte[]{9, 9, 9});
        String ttsRef = real.saveTtsAudio("us_female", "abc123", new byte[]{1, 2, 3});

        assertThat(real.loadTtsAudioResourceByRef(ttsRef).contentLength()).isEqualTo(3);
        for (String ref : new String[]{"42/attempt-1.bin", "tts/../42/attempt-1.bin", "../outside.bin", "tts", "tts/us_female"}) {
            assertThatThrownBy(() -> real.loadTtsAudioResourceByRef(ref)).as(ref)
                    .isInstanceOfSatisfying(ResponseStatusException.class,
                            e -> assertThat(e.getStatusCode().value()).isIn(403, 404));
        }
        assertThatThrownBy(() -> real.loadTtsAudioResourceByRef("42/attempt-1.bin"))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN));
    }
}
