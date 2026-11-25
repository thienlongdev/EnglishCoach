package com.englishcoach.exams;

import com.englishcoach.auth.policy.AdminIdentityService;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.controller.ExamMediaController;
import com.englishcoach.exams.exception.ExamExceptionHandler;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamForbiddenException;
import com.englishcoach.exams.measurement.controller.ExamMeasurementController;
import com.englishcoach.exams.measurement.model.ExamMeasurementRecords.RaterRecordingAccess;
import com.englishcoach.exams.measurement.repository.ExamMeasurementRepository;
import com.englishcoach.exams.measurement.service.ExamCalibrationService;
import com.englishcoach.exams.measurement.service.ExamMeasurementAuthorizationService;
import com.englishcoach.exams.measurement.service.ExamMeasurementService;
import com.englishcoach.exams.measurement.service.ExamRaterService;
import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.media.ExamObjectStorage;
import com.englishcoach.exams.model.ExamAttemptRecords.AttemptRecord;
import com.englishcoach.exams.model.ExamAttemptRecords.AttemptSectionRecord;
import com.englishcoach.exams.model.ExamAttemptRecords.ResponseRecord;
import com.englishcoach.exams.model.ExamContentRecords.SectionRecord;
import com.englishcoach.exams.model.ExamMediaRecords.InitiateRecordingRequest;
import com.englishcoach.exams.model.ExamMediaRecords.RecordingChunkRecord;
import com.englishcoach.exams.model.ExamMediaRecords.RecordingRecord;
import com.englishcoach.exams.model.ExamSpeakingRecords.CompleteTurnCommand;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.security.ExamRateLimiter;
import com.englishcoach.exams.service.ExamRightsService;
import com.englishcoach.exams.service.ExamSpeakingRuntimeService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;
import org.springframework.core.MethodParameter;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.support.WebDataBinderFactory;
import org.springframework.web.context.request.NativeWebRequest;
import org.springframework.web.method.support.HandlerMethodArgumentResolver;
import org.springframework.web.method.support.ModelAndViewContainer;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * Security regression tests for Exam Media & Speaking Runtime:
 * - EC-SEC-2026-001: Stored Same-Origin XSS via exam recording codec / playback / chunk / rater endpoints
 * - EC-SEC-2026-013: Unbounded chunk upload sizes, chunk counts, cumulative sizes, and playback token maps
 * - AUTHZ-14: Playback grant / recording playback token ownership & state checks
 * - AUTHZ-08: ExamSpeakingRuntimeService#completeTurn recording ownership, state, and turn/part binding
 */
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class ExamMediaSecurityRegressionTest {

    private static final Long USER_A = 101L;
    private static final Long USER_B = 202L;
    private static final Long RATER_ID = 303L;

    @Mock
    private ExamMediaRepository mediaRepository;
    @Mock
    private ExamAttemptRepository attemptRepository;
    @Mock
    private ExamContentRepository contentRepository;
    @Mock
    private ExamRightsService rightsService;
    @Mock
    private ExamObjectStorage objectStorage;
    @Mock
    private ExamMeasurementRepository measurementRepository;
    @Mock
    private ExamMeasurementAuthorizationService measurementAuthorization;

    private ExamMediaService mediaService;
    private ExamRaterService raterService;
    private ExamSpeakingRuntimeService speakingService;

    private UserDetailsImpl currentUser;
    private MockMvc mediaMvc;
    private MockMvc measurementMvc;

    @BeforeEach
    void setUp() {
        ExamsProperties props = new ExamsProperties();
        props.getLimits().setMaxUploadChunkBytes(2048);

        mediaService = new ExamMediaService(mediaRepository, attemptRepository, rightsService, objectStorage, props);
        raterService = new ExamRaterService(measurementRepository, mediaRepository, objectStorage);
        speakingService = new ExamSpeakingRuntimeService(attemptRepository, contentRepository, mediaRepository);

        HandlerMethodArgumentResolver principalResolver = new HandlerMethodArgumentResolver() {
            @Override
            public boolean supportsParameter(MethodParameter parameter) {
                return parameter.hasParameterAnnotation(AuthenticationPrincipal.class);
            }

            @Override
            public Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mavContainer,
                                          NativeWebRequest webRequest, WebDataBinderFactory binderFactory) {
                return currentUser;
            }
        };

        AdminIdentityService adminIdentity = mock(AdminIdentityService.class);
        mediaMvc = MockMvcBuilders.standaloneSetup(new ExamMediaController(mediaService, adminIdentity, ExamRateLimiter.disabled()))
                .setControllerAdvice(new ExamExceptionHandler())
                .setCustomArgumentResolvers(principalResolver)
                .build();

        measurementMvc = MockMvcBuilders.standaloneSetup(
                        new ExamMeasurementController(
                                measurementAuthorization,
                                mock(ExamMeasurementService.class),
                                mock(ExamCalibrationService.class),
                                raterService
                        ))
                .setControllerAdvice(new ExamExceptionHandler())
                .setCustomArgumentResolvers(principalResolver)
                .build();
    }

    private AttemptRecord attempt(UUID attemptId, Long userId, ExamAttemptStatus status) {
        return new AttemptRecord(
                attemptId, userId, UUID.randomUUID(), ExamFamily.IELTS, "ACADEMIC", "SPEAKING",
                ExamAttemptMode.EXAM_SIMULATION, null, null, status,
                1L, 1L, null, null, "manifest-hash", Map.of(),
                Instant.now(), Instant.now(), Instant.now().plusSeconds(3600),
                null, null, List.of(), Instant.now(), Instant.now()
        );
    }

    private RecordingRecord recording(UUID recId, UUID attemptId, UUID responseId, String placementId, String codec, RecordingState state) {
        return new RecordingRecord(
                recId, attemptId, responseId, placementId,
                Instant.now(), Instant.now().plusSeconds(600),
                codec, Map.of(), state, 1, 16L, List.of(),
                null, null, Map.of(), Instant.now()
        );
    }

    // ─── EC-SEC-2026-001: Stored Same-Origin XSS via Recording Codec ─────────

    @Test
    @DisplayName("EC-SEC-2026-001: initiateRecording rejects text/html, image/svg+xml, and header injection codecs")
    void initiateRecordingRejectsDangerousCodecs() {
        UUID attemptId = UUID.randomUUID();
        when(attemptRepository.findAttemptById(attemptId))
                .thenReturn(Optional.of(attempt(attemptId, USER_A, ExamAttemptStatus.IN_PROGRESS)));

        for (String badCodec : List.of(
                "text/html",
                "text/html; charset=utf-8",
                "image/svg+xml",
                "application/javascript",
                "text/xml",
                "audio/webm\r\nX-Injected: 1",
                "audio/webm; bad=<script>"
        )) {
            InitiateRecordingRequest req = new InitiateRecordingRequest(attemptId, "speaking_part_1", badCodec, Map.of());
            IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                    () -> mediaService.initiateRecording(USER_A, attemptId, req),
                    "Expected rejection for codec: " + badCodec);
            assertTrue(ex.getMessage().contains("INVALID_AUDIO_CODEC"), "codec=" + badCodec);
        }
        verify(mediaRepository, never()).insertRecording(any());
    }

    @Test
    @DisplayName("EC-SEC-2026-001: initiateRecording accepts allowlisted audio codecs with ;codecs= parameters and normalizes them")
    void initiateRecordingAcceptsAllowlistedAudioCodecs() {
        UUID attemptId = UUID.randomUUID();
        when(attemptRepository.findAttemptById(attemptId))
                .thenReturn(Optional.of(attempt(attemptId, USER_A, ExamAttemptStatus.IN_PROGRESS)));
        when(attemptRepository.findSectionsByAttemptId(attemptId)).thenReturn(List.of());
        when(mediaRepository.insertRecording(any())).thenReturn(UUID.randomUUID());

        InitiateRecordingRequest req = new InitiateRecordingRequest(
                attemptId, "speaking_part_1", "audio/webm;codecs=opus", Map.of()
        );
        mediaService.initiateRecording(USER_A, attemptId, req);

        ArgumentCaptor<RecordingRecord> captor = ArgumentCaptor.forClass(RecordingRecord.class);
        verify(mediaRepository).insertRecording(captor.capture());
        assertEquals("audio/webm", captor.getValue().codec());
    }

    @Test
    @DisplayName("EC-SEC-2026-001: saveChunk rejects HTML/SVG/script/XML active document payloads")
    void saveChunkRejectsActiveMarkupPayloads() {
        UUID recId = UUID.randomUUID();

        for (String payload : List.of(
                "<html><body><script>alert(1)</script></body></html>",
                "  <!DOCTYPE html><script>alert(document.cookie)</script>",
                "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>",
                "<?xml version='1.0'?><svg/>"
        )) {
            byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
            IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                    () -> mediaService.saveChunk(USER_A, recId, 0, ExamMediaService.computeSha256(bytes), bytes),
                    "Expected markup payload rejection: " + payload);
            assertTrue(ex.getMessage().contains("INVALID_AUDIO_PAYLOAD"));
        }
        verify(objectStorage, never()).putObject(any(), any(), any());
    }

    @Test
    @DisplayName("EC-SEC-2026-001: Playback, chunk, and rater endpoints downgrade poisoned DB codecs to octet-stream + attachment + sandbox CSP + nosniff + no-store")
    void poisonedDbCodecsNeverServedAsHtmlOrSvg() throws Exception {
        UUID attemptId = UUID.randomUUID();
        UUID responseId = UUID.randomUUID();
        UUID recHtmlId = UUID.randomUUID();
        UUID recSvgId = UUID.randomUUID();
        UUID recAudioId = UUID.randomUUID();

        byte[] payload = "<html><script>alert(1)</script></html>".getBytes(StandardCharsets.UTF_8);
        String chunkKey = "recordings/" + recHtmlId + "/chunk_0000.bin";
        String svgKey = "recordings/" + recSvgId + "/chunk_0000.bin";
        String audioKey = "recordings/" + recAudioId + "/chunk_0000.bin";

        when(attemptRepository.findAttemptById(attemptId))
                .thenReturn(Optional.of(attempt(attemptId, USER_A, ExamAttemptStatus.SUBMITTED)));

        RecordingRecord poisonedHtml = recording(recHtmlId, attemptId, responseId, "speaking_part_1", "text/html", RecordingState.SEALED);
        RecordingRecord poisonedSvg = recording(recSvgId, attemptId, responseId, "speaking_part_1", "image/svg+xml", RecordingState.SEALED);
        RecordingRecord validAudio = recording(recAudioId, attemptId, responseId, "speaking_part_1", "audio/webm;codecs=opus", RecordingState.SEALED);

        when(mediaRepository.findRecordingById(recHtmlId)).thenReturn(Optional.of(poisonedHtml));
        when(mediaRepository.findRecordingById(recSvgId)).thenReturn(Optional.of(poisonedSvg));
        when(mediaRepository.findRecordingById(recAudioId)).thenReturn(Optional.of(validAudio));

        RecordingChunkRecord htmlChunk = new RecordingChunkRecord(UUID.randomUUID(), recHtmlId, 0, chunkKey, "h1", payload.length, Instant.now());
        RecordingChunkRecord svgChunk = new RecordingChunkRecord(UUID.randomUUID(), recSvgId, 0, svgKey, "h2", payload.length, Instant.now());
        RecordingChunkRecord audioChunk = new RecordingChunkRecord(UUID.randomUUID(), recAudioId, 0, audioKey, "h3", 16L, Instant.now());

        when(mediaRepository.findChunksByRecordingId(recHtmlId)).thenReturn(List.of(htmlChunk));
        when(mediaRepository.findChunksByRecordingId(recSvgId)).thenReturn(List.of(svgChunk));
        when(mediaRepository.findChunksByRecordingId(recAudioId)).thenReturn(List.of(audioChunk));

        when(objectStorage.getObjectStream(chunkKey)).thenAnswer(inv -> new ByteArrayInputStream(payload));
        when(objectStorage.getObjectStream(svgKey)).thenAnswer(inv -> new ByteArrayInputStream(payload));
        when(objectStorage.getObjectStream(audioKey)).thenAnswer(inv -> new ByteArrayInputStream(new byte[16]));
        when(objectStorage.getObject(chunkKey)).thenReturn(payload);

        currentUser = new UserDetailsImpl(USER_A, "a@test.local", "pw", List.of());

        // 1. Authenticated playback of poisoned text/html recording
        MvcResult htmlPlayback = mediaMvc.perform(get("/api/v1/exams/recordings/" + recHtmlId + "/playback")).andReturn();
        assertEquals(200, htmlPlayback.getResponse().getStatus());
        assertEquals("application/octet-stream", htmlPlayback.getResponse().getContentType());
        assertEquals("attachment; filename=\"recording.bin\"", htmlPlayback.getResponse().getHeader("Content-Disposition"));
        assertRecordingSecurityHeaders(htmlPlayback);

        // 2. Signed playback (?token=) of poisoned image/svg+xml recording
        String signedToken = mediaService.createRecordingPlaybackToken(USER_A, attemptId, recSvgId);
        currentUser = null;
        MvcResult svgSignedPlayback = mediaMvc.perform(get("/api/v1/exams/media/recordings/" + recSvgId + "/playback")
                .param("token", signedToken)).andReturn();
        assertEquals(200, svgSignedPlayback.getResponse().getStatus());
        assertEquals("application/octet-stream", svgSignedPlayback.getResponse().getContentType());
        assertEquals("attachment; filename=\"recording.bin\"", svgSignedPlayback.getResponse().getHeader("Content-Disposition"));
        assertRecordingSecurityHeaders(svgSignedPlayback);

        // 3. Direct chunk download of poisoned text/html recording
        currentUser = new UserDetailsImpl(USER_A, "a@test.local", "pw", List.of());
        MvcResult chunkResp = mediaMvc.perform(get("/api/v1/exams/recordings/" + recHtmlId + "/chunks/0")).andReturn();
        assertEquals(200, chunkResp.getResponse().getStatus());
        assertEquals("application/octet-stream", chunkResp.getResponse().getContentType());
        assertEquals("attachment; filename=\"recording.bin\"", chunkResp.getResponse().getHeader("Content-Disposition"));
        assertRecordingSecurityHeaders(chunkResp);

        // 4. Valid audio/webm recording keeps inline disposition + audio/webm + sandbox headers + Range support
        MvcResult audioPlayback = mediaMvc.perform(get("/api/v1/exams/recordings/" + recAudioId + "/playback")
                .header("Range", "bytes=0-7")).andReturn();
        assertEquals(206, audioPlayback.getResponse().getStatus());
        assertTrue(audioPlayback.getResponse().getContentType().startsWith("audio/webm"));
        assertEquals("inline", audioPlayback.getResponse().getHeader("Content-Disposition"));
        assertEquals("bytes 0-7/16", audioPlayback.getResponse().getHeader("Content-Range"));
        assertRecordingSecurityHeaders(audioPlayback);
        verify(objectStorage, never()).getObject(audioKey);

        // 5. Rater recording stream endpoint for poisoned text/html recording
        UUID assignmentId = UUID.randomUUID();
        when(measurementRepository.findRaterRecordingAccess(assignmentId, RATER_ID))
                .thenReturn(Optional.of(new RaterRecordingAccess(assignmentId, UUID.randomUUID(), attemptId, responseId, recHtmlId)));
        currentUser = new UserDetailsImpl(RATER_ID, "rater@test.local", "pw", List.of());

        MvcResult raterResp = measurementMvc.perform(
                get("/api/v1/admin/exams/measurement/raters/assignments/" + assignmentId + "/recording")).andReturn();
        assertEquals(200, raterResp.getResponse().getStatus());
        assertEquals("application/octet-stream", raterResp.getResponse().getContentType());
        assertEquals("attachment; filename=\"recording.bin\"", raterResp.getResponse().getHeader("Content-Disposition"));
        assertRecordingSecurityHeaders(raterResp);
    }

    private static void assertRecordingSecurityHeaders(MvcResult result) {
        String csp = result.getResponse().getHeader("Content-Security-Policy");
        assertNotNull(csp, "Content-Security-Policy must be present");
        assertTrue(csp.contains("default-src 'none'"), "CSP must contain default-src 'none': " + csp);
        assertTrue(csp.contains("sandbox"), "CSP must contain sandbox: " + csp);
        assertEquals("nosniff", result.getResponse().getHeader("X-Content-Type-Options"));
        String cacheControl = result.getResponse().getHeader("Cache-Control");
        assertNotNull(cacheControl, "Cache-Control must be present");
        assertTrue(cacheControl.contains("private"), "Cache-Control must be private: " + cacheControl);
        assertTrue(cacheControl.contains("no-store"), "Cache-Control must be no-store: " + cacheControl);
    }

    // ─── EC-SEC-2026-013: Chunk Size, Chunk Count, Cumulative Size & Token Map Bounds ─

    @Test
    @DisplayName("EC-SEC-2026-013: saveChunk enforces maxUploadChunkBytes, sequenceNo cap (<1000), and cumulative 50 MB cap")
    void saveChunkEnforcesSizeAndCountBounds() {
        UUID attemptId = UUID.randomUUID();
        UUID recId = UUID.randomUUID();

        // 1. Oversized single chunk (> 2048 bytes configured in setUp)
        byte[] oversized = new byte[2049];
        Arrays.fill(oversized, (byte) 0x41);
        IllegalArgumentException sizeEx = assertThrows(IllegalArgumentException.class,
                () -> mediaService.saveChunk(USER_A, recId, 0, ExamMediaService.computeSha256(oversized), oversized));
        assertTrue(sizeEx.getMessage().contains("CHUNK_TOO_LARGE"));

        // 2. Sequence number >= 1000 rejected
        byte[] small = new byte[64];
        Arrays.fill(small, (byte) 0x41);
        IllegalArgumentException seqEx = assertThrows(IllegalArgumentException.class,
                () -> mediaService.saveChunk(USER_A, recId, 1000, ExamMediaService.computeSha256(small), small));
        assertTrue(seqEx.getMessage().contains("INVALID_CHUNK_SEQUENCE"));

        // 3. Cumulative recording size exceeding 50 MB rejected
        RecordingRecord rec = recording(recId, attemptId, null, "speaking_part_1", "audio/webm", RecordingState.RECORDING);
        when(mediaRepository.findRecordingById(recId)).thenReturn(Optional.of(rec));
        when(attemptRepository.findAttemptById(attemptId))
                .thenReturn(Optional.of(attempt(attemptId, USER_A, ExamAttemptStatus.IN_PROGRESS)));
        when(mediaRepository.findChunkByRecordingAndSequence(recId, 10)).thenReturn(Optional.empty());
        RecordingChunkRecord hugeExisting = new RecordingChunkRecord(
                UUID.randomUUID(), recId, 0, "k0", "h0", ExamMediaService.MAX_RECORDING_TOTAL_BYTES, Instant.now());
        when(mediaRepository.findChunksByRecordingId(recId)).thenReturn(List.of(hugeExisting));

        IllegalArgumentException totalEx = assertThrows(IllegalArgumentException.class,
                () -> mediaService.saveChunk(USER_A, recId, 10, ExamMediaService.computeSha256(small), small));
        assertTrue(totalEx.getMessage().contains("RECORDING_SIZE_LIMIT_EXCEEDED"));
        verify(objectStorage, never()).putObject(any(), any(), any());
    }

    @Test
    @DisplayName("EC-SEC-2026-013 & AUTHZ-14: Playback token map is bounded with eviction and validates recording/attempt ownership")
    void playbackTokenMapBoundedAndOwnershipChecked() {
        ReflectionTestUtils.setField(mediaService, "maxPlaybackTokens", 4);

        UUID attemptA = UUID.randomUUID();
        UUID attemptB = UUID.randomUUID();
        when(attemptRepository.findAttemptById(attemptA))
                .thenReturn(Optional.of(attempt(attemptA, USER_A, ExamAttemptStatus.SUBMITTED)));

        // Cross-attempt recording rejected
        UUID recOfB = UUID.randomUUID();
        when(mediaRepository.findRecordingById(recOfB))
                .thenReturn(Optional.of(recording(recOfB, attemptB, null, "speaking_part_1", "audio/webm", RecordingState.SEALED)));
        assertThrows(SecurityException.class, () -> mediaService.createRecordingPlaybackToken(USER_A, attemptA, recOfB));

        // FAILED recording rejected
        UUID failedRec = UUID.randomUUID();
        when(mediaRepository.findRecordingById(failedRec))
                .thenReturn(Optional.of(recording(failedRec, attemptA, null, "speaking_part_1", "audio/webm", RecordingState.FAILED)));
        assertThrows(IllegalStateException.class, () -> mediaService.createRecordingPlaybackToken(USER_A, attemptA, failedRec));

        // Inserting 7 distinct tokens into cap-4 map stays bounded <= 4
        for (int i = 0; i < 7; i++) {
            UUID recId = UUID.randomUUID();
            when(mediaRepository.findRecordingById(recId))
                    .thenReturn(Optional.of(recording(recId, attemptA, null, "speaking_part_1", "audio/webm", RecordingState.SEALED)));
            assertNotNull(mediaService.createRecordingPlaybackToken(USER_A, attemptA, recId));
        }
        Map<?, ?> tokenMap = (Map<?, ?>) ReflectionTestUtils.getField(mediaService, "recordingPlaybackTokens");
        assertNotNull(tokenMap);
        assertTrue(tokenMap.size() <= 4, "Playback token map must be bounded to cap=4, got " + tokenMap.size());

        // createPlaybackGrant rejects INVALIDATED / EXPIRED attempts
        UUID invalidatedAttempt = UUID.randomUUID();
        when(attemptRepository.findAttemptById(invalidatedAttempt))
                .thenReturn(Optional.of(attempt(invalidatedAttempt, USER_A, ExamAttemptStatus.INVALIDATED)));
        assertThrows(IllegalStateException.class, () ->
                mediaService.createPlaybackGrant(USER_A, invalidatedAttempt, UUID.randomUUID(), MediaPurpose.SIMULATION_LISTENING));
    }

    // ─── AUTHZ-08: ExamSpeakingRuntimeService#completeTurn Recording Binding ─

    @Test
    @DisplayName("AUTHZ-08: completeTurn rejects cross-user/cross-attempt, unsealed, and wrong-turn/part recordings")
    void completeTurnEnforcesRecordingOwnershipStateAndBinding() {
        UUID attemptId = UUID.randomUUID();
        UUID otherAttemptId = UUID.randomUUID();
        UUID formId = UUID.randomUUID();
        UUID sectionId = UUID.randomUUID();
        UUID turn1ResponseId = UUID.randomUUID();
        UUID turn2ResponseId = UUID.randomUUID();

        AttemptRecord att = new AttemptRecord(
                attemptId, USER_A, formId, ExamFamily.IELTS, "ACADEMIC", "SPEAKING",
                ExamAttemptMode.EXAM_SIMULATION, null, null, ExamAttemptStatus.IN_PROGRESS,
                1L, 1L, "tok", Instant.now().plusSeconds(600), "mh",
                Map.of(), Instant.now(), Instant.now(), Instant.now().plusSeconds(3600),
                null, null, List.of(), Instant.now(), Instant.now()
        );
        AttemptSectionRecord sec = new AttemptSectionRecord(
                UUID.randomUUID(), attemptId, sectionId, ExamSectionState.ACTIVE, "MAIN",
                Instant.now(), Instant.now().plusSeconds(900), null, Map.of(), Instant.now(),
                "speaking_part_1", "speak_p1_g_intro_i_01", 1, 1L
        );
        SectionRecord secDef = new SectionRecord(sectionId, formId, SkillType.SPEAKING, 4, "speaking", null, 900, Map.of());
        ResponseRecord turn1 = new ResponseRecord(
                turn1ResponseId, attemptId, sectionId, "speaking_part_1", UUID.randomUUID(),
                Map.of(), null, null, false, 1L, null, Instant.now(),
                "speak_p1_g_intro_i_01", 1, "SPEAKING_TURN", "RECORDED",
                Map.of("prompt", "Tell me about your hometown."), null
        );
        ResponseRecord turn2 = new ResponseRecord(
                turn2ResponseId, attemptId, sectionId, "speaking_part_2", UUID.randomUUID(),
                Map.of(), null, null, false, 1L, null, Instant.now(),
                "speak_p2_g_cue_i_01", 2, "SPEAKING_TURN", "LOCKED",
                Map.of("prompt", "Describe a book."), null
        );

        when(attemptRepository.findAttemptByIdForUpdate(attemptId)).thenReturn(Optional.of(att));
        when(attemptRepository.findAttemptById(attemptId)).thenReturn(Optional.of(att));
        when(attemptRepository.findSectionsByAttemptId(attemptId)).thenReturn(List.of(sec));
        when(contentRepository.findSectionsByFormId(formId)).thenReturn(List.of(secDef));
        when(attemptRepository.findSpeakingResponsesByAttemptAndSection(attemptId, sectionId))
                .thenReturn(List.of(turn1, turn2));

        // 1. Cross-user / cross-attempt recording rejected with 403 ExamForbiddenException
        UUID foreignRecId = UUID.randomUUID();
        when(mediaRepository.findRecordingById(foreignRecId))
                .thenReturn(Optional.of(recording(foreignRecId, otherAttemptId, turn1ResponseId, "speaking_part_1", "audio/webm", RecordingState.SEALED)));
        assertThrows(ExamForbiddenException.class, () ->
                speakingService.completeTurn(USER_A, attemptId, new CompleteTurnCommand("cmd-foreign", 1L, foreignRecId, 5000)));

        // 2. Unsealed (RECORDING) recording rejected with 400 IllegalArgumentException
        UUID unsealedRecId = UUID.randomUUID();
        when(mediaRepository.findRecordingById(unsealedRecId))
                .thenReturn(Optional.of(recording(unsealedRecId, attemptId, turn1ResponseId, "speaking_part_1", "audio/webm", RecordingState.RECORDING)));
        IllegalArgumentException unsealedEx = assertThrows(IllegalArgumentException.class, () ->
                speakingService.completeTurn(USER_A, attemptId, new CompleteTurnCommand("cmd-unsealed", 1L, unsealedRecId, 5000)));
        assertTrue(unsealedEx.getMessage().contains("RECORDING_NOT_SEALED"));

        // 3. Recording bound to a different turn/part rejected with 403 ExamForbiddenException
        UUID wrongTurnRecId = UUID.randomUUID();
        when(mediaRepository.findRecordingById(wrongTurnRecId))
                .thenReturn(Optional.of(recording(wrongTurnRecId, attemptId, turn2ResponseId, "speaking_part_2", "audio/webm", RecordingState.SEALED)));
        assertThrows(ExamForbiddenException.class, () ->
                speakingService.completeTurn(USER_A, attemptId, new CompleteTurnCommand("cmd-wrong-turn", 1L, wrongTurnRecId, 5000)));

        // 4. Non-existent recording rejected with 403 ExamForbiddenException
        UUID missingRecId = UUID.randomUUID();
        when(mediaRepository.findRecordingById(missingRecId)).thenReturn(Optional.empty());
        assertThrows(ExamForbiddenException.class, () ->
                speakingService.completeTurn(USER_A, attemptId, new CompleteTurnCommand("cmd-missing", 1L, missingRecId, 5000)));

        verify(attemptRepository, never()).updateSpeakingTurnState(eq(attemptId), eq("speak_p1_g_intro_i_01"), eq("COMPLETED"), any(), any());

        // 5. Valid SEALED recording matching (attemptId, turn1ResponseId, speaking_part_1) succeeds
        UUID validRecId = UUID.randomUUID();
        when(mediaRepository.findRecordingById(validRecId))
                .thenReturn(Optional.of(recording(validRecId, attemptId, turn1ResponseId, "speaking_part_1", "audio/webm", RecordingState.SEALED)));
        speakingService.completeTurn(USER_A, attemptId, new CompleteTurnCommand("cmd-valid", 1L, validRecId, 5000));
        verify(attemptRepository).updateSpeakingTurnState(attemptId, "speak_p1_g_intro_i_01", "COMPLETED", validRecId, "cmd-valid");
    }
}
