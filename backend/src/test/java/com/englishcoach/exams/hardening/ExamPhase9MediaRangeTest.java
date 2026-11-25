package com.englishcoach.exams.hardening;

import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.controller.ExamMediaController;
import com.englishcoach.exams.exception.ExamExceptionHandler;
import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.media.ExamObjectStorage;
import com.englishcoach.exams.media.LocalExamObjectStorage;
import com.englishcoach.exams.model.ExamContentRecords.AssetRecord;
import com.englishcoach.exams.model.ExamMediaRecords.MediaGrantRecord;
import com.englishcoach.exams.model.ExamTypes.MediaPurpose;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.security.ExamRateLimiter;
import com.englishcoach.exams.service.ExamRightsService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * Exams Phase 9E — media grants + HTTP Range (security matrix 44–52). A real {@link LocalExamObjectStorage} in a temp
 * directory holds a 1 MiB asset; the REAL {@link ExamMediaService#openGrantedMedia} resolves the grant (repositories
 * mocked). Proves: authorization (unknown / expired token) happens before any byte, 206 + Content-Range for valid ranges,
 * 416 for unsatisfiable ones, 200 without Range, and the whole object is never read into memory ({@code getObject} is
 * never called).
 */
class ExamPhase9MediaRangeTest {

    static final int SIZE = 1024 * 1024;
    @TempDir
    Path dir;

    ExamMediaRepository mediaRepository;
    ExamObjectStorage storage;
    ExamMediaService service;
    MockMvc mvc;
    byte[] bytes;
    final UUID assetId = UUID.randomUUID();
    String validToken, expiredToken;

    @BeforeEach
    void setUp() throws Exception {
        ExamsProperties props = new ExamsProperties();
        props.getStorage().getLocal().setBaseDir(dir.toString());
        storage = spy(new LocalExamObjectStorage(props));
        bytes = new byte[SIZE];
        for (int i = 0; i < SIZE; i++) bytes[i] = (byte) (i % 251);
        Files.createDirectories(dir.resolve("assets"));
        Files.write(dir.resolve("assets/audio.mp3"), bytes);
        mediaRepository = mock(ExamMediaRepository.class);
        AssetRecord asset = new AssetRecord(assetId, null, "assets/audio.mp3", null, "sha", "audio/mpeg", SIZE, 1000, null,
                "VALIDATED", Instant.now());
        when(mediaRepository.findAssetById(assetId)).thenReturn(Optional.of(asset));
        validToken = UUID.randomUUID() + "-1";
        expiredToken = UUID.randomUUID() + "-2";
        grant(validToken, Instant.now().plus(2, ChronoUnit.HOURS));
        grant(expiredToken, Instant.now().minusSeconds(1));
        when(mediaRepository.findMediaGrantByTokenHash(anyString())).thenAnswer(inv -> Optional.ofNullable(grants.get(inv.<String>getArgument(0))));
        service = new ExamMediaService(mediaRepository, mock(ExamAttemptRepository.class), mock(ExamRightsService.class), storage);
        mvc = MockMvcBuilders.standaloneSetup(new ExamMediaController(service, null, ExamRateLimiter.disabled()))
                .setControllerAdvice(new ExamExceptionHandler()).build();
    }

    final Map<String, MediaGrantRecord> grants = new HashMap<>();

    void grant(String token, Instant expiresAt) {
        String hash = ExamMediaService.computeSha256(token.getBytes(StandardCharsets.UTF_8));
        grants.put(hash, new MediaGrantRecord(UUID.randomUUID(), UUID.randomUUID(), assetId, MediaPurpose.SIMULATION_LISTENING,
                "s", 0, expiresAt, hash, null, Instant.now()));
    }

    @Test
    @DisplayName("44/48/49: a valid grant serves the asset; Range ⇒ 206 with exact Content-Range / Content-Length / bytes")
    void validRange() throws Exception {
        MvcResult full = mvc.perform(get("/api/v1/exams/media/" + validToken)).andReturn();
        assertEquals(200, full.getResponse().getStatus());
        assertEquals("bytes", full.getResponse().getHeader("Accept-Ranges"));
        assertArrayEquals(bytes, full.getResponse().getContentAsByteArray());
        assertTrue(full.getResponse().getHeader("Cache-Control").contains("no-store"));

        MvcResult part = mvc.perform(get("/api/v1/exams/media/" + validToken).header("Range", "bytes=100-1123")).andReturn();
        assertEquals(206, part.getResponse().getStatus());
        assertEquals("bytes 100-1123/" + SIZE, part.getResponse().getHeader("Content-Range"));
        assertEquals("1024", part.getResponse().getHeader("Content-Length"));
        assertArrayEquals(Arrays.copyOfRange(bytes, 100, 1124), part.getResponse().getContentAsByteArray());
        assertTrue(part.getResponse().getContentType().startsWith("audio/mpeg"));

        MvcResult tail = mvc.perform(get("/api/v1/exams/media/" + validToken).header("Range", "bytes=-10")).andReturn();
        assertEquals(206, tail.getResponse().getStatus());
        assertEquals("bytes " + (SIZE - 10) + "-" + (SIZE - 1) + "/" + SIZE, tail.getResponse().getHeader("Content-Range"));
        assertArrayEquals(Arrays.copyOfRange(bytes, SIZE - 10, SIZE), tail.getResponse().getContentAsByteArray());
    }

    @Test
    @DisplayName("50: an unsatisfiable Range is answered 416 with 'bytes */size' and no body")
    void invalidRange() throws Exception {
        MvcResult r = mvc.perform(get("/api/v1/exams/media/" + validToken).header("Range", "bytes=" + (SIZE + 10) + "-" + (SIZE + 20)))
                .andReturn();
        assertEquals(416, r.getResponse().getStatus());
        assertEquals("bytes */" + SIZE, r.getResponse().getHeader("Content-Range"));
        assertEquals(0, r.getResponse().getContentAsByteArray().length);
    }

    @Test
    @DisplayName("45/51: an expired or unknown grant is refused (403) BEFORE any byte, with or without a Range header")
    void unauthorizedRangeRefused() throws Exception {
        for (String token : List.of(expiredToken, "not-a-grant", UUID.randomUUID().toString())) {
            for (String range : List.of("", "bytes=0-99")) {
                var req = get("/api/v1/exams/media/" + token);
                if (!range.isEmpty()) req = req.header("Range", range);
                MvcResult r = mvc.perform(req).andReturn();
                assertEquals(403, r.getResponse().getStatus(), token + " " + range);
                assertEquals(0, r.getResponse().getContentAsByteArray().length);
                assertNull(r.getResponse().getHeader("Content-Range"));
            }
        }
        verify(storage, never()).getObjectStream(anyString());
        verify(storage, never()).getObject(anyString());
    }

    @Test
    @DisplayName("52: streaming — the object size comes from metadata and the whole object is never read into memory")
    void streamingNotWholeFile() throws Exception {
        mvc.perform(get("/api/v1/exams/media/" + validToken).header("Range", "bytes=0-15")).andReturn();
        mvc.perform(get("/api/v1/exams/media/" + validToken)).andReturn();
        verify(storage, never()).getObject(anyString());
        verify(storage, atLeastOnce()).contentLength("assets/audio.mp3");
        ExamMediaService.GrantedMedia m = service.openGrantedMedia(validToken);
        assertEquals(SIZE, m.resource().contentLength());
        assertFalse(m.resource().getDescription().contains("assets/"), "the storage key never leaves the server");
    }

    @Test
    @DisplayName("46/47: a grant is created only for the owner of the attempt (foreign ⇒ refused) and only for an asset in scope")
    void grantCreationScope() {
        ExamAttemptRepository attempts = mock(ExamAttemptRepository.class);
        ExamRightsService rights = mock(ExamRightsService.class);
        ExamMediaService s = new ExamMediaService(mediaRepository, attempts, rights, storage);
        UUID attemptId = UUID.randomUUID();
        com.englishcoach.exams.model.ExamAttemptRecords.AttemptRecord owned = mock(com.englishcoach.exams.model.ExamAttemptRecords.AttemptRecord.class);
        when(owned.userId()).thenReturn(5L);
        when(owned.snapshotState()).thenReturn(com.englishcoach.exams.model.ExamTypes.ExamSnapshotState.SNAPSHOTTED);
        when(owned.manifestSnapshot()).thenReturn(Map.of("sections", List.of()));
        when(attempts.findAttemptById(attemptId)).thenReturn(Optional.of(owned));
        assertThrows(IllegalArgumentException.class, () -> s.createPlaybackGrant(6L, attemptId, assetId, MediaPurpose.SIMULATION_LISTENING),
                "a foreign user never obtains a grant");
        IllegalStateException out = assertThrows(IllegalStateException.class,
                () -> s.createPlaybackGrant(5L, attemptId, assetId, MediaPurpose.SIMULATION_LISTENING));
        assertTrue(out.getMessage().startsWith("ASSET_NOT_IN_ATTEMPT_SCOPE"), "an asset outside the attempt snapshot is refused");
        verify(mediaRepository, never()).insertMediaGrant(any());
    }
}
