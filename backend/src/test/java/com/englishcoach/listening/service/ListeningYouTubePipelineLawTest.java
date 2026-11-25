package com.englishcoach.listening.service;

import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.listening.dto.ImportListeningMaterialRequest;
import com.englishcoach.listening.dto.WordTimestampDto;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.listening.repository.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * SUPREME LISTENING YOUTUBE IMPORT LAW (rules 10 §BE): one local WhisperX pipeline, no paid / VPS / caption-scrape
 * fallback, no synthetic word timing, fail closed.
 */
@ExtendWith(MockitoExtension.class)
class ListeningYouTubePipelineLawTest {

    private static final String AI_ENDPOINT_SUFFIX = "/api/v1/listening/process-youtube";

    @Mock private ListeningMaterialRepository materialRepository;
    @Mock private TranscriptSegmentRepository segmentRepository;
    @Mock private ListeningExerciseRepository exerciseRepository;
    @Mock private ListeningSessionRepository sessionRepository;
    @Mock private ExerciseAttemptRepository attemptRepository;
    @Mock private UserRepository userRepository;
    @Mock private DictationScoringService scoringService;
    @Mock private AiDiagnosticAgentService diagnosticAgentService;
    @Mock private com.englishcoach.speaking.repository.SpeakingShadowingUnitRepository speakingShadowingUnitRepository;
    @Mock private com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository speakingShadowingAttemptRepository;
    @Mock private ListeningAnalyticsService analyticsService;

    @InjectMocks
    private ListeningServiceImpl service;

    private RestTemplate ai;
    private final ObjectMapper mapper = new ObjectMapper();

    @BeforeEach
    void setUp() {
        ai = mock(RestTemplate.class);
        service.setRestTemplate(ai);
    }

    // ---------------------------------------------------------------- fixtures

    /** A WhisperX-shaped transcript: varied word lengths, real pauses, one unaligned word (null bounds). */
    private static String alignedResponse(int durationSeconds) {
        return """
            {"title": "Real lesson", "durationSeconds": %d, "thumbnailUrl": "https://img.youtube.com/vi/BF3bXji-J7I/hqdefault.jpg",
             "timing": {"alignment": "whisperx-wav2vec2", "transcript": "local-asr:faster-whisper:large-v3"},
             "segments": [
               {"startTimeMs": 163, "endTimeMs": 2038, "text": "The Fox and the Crow",
                "words": [{"word":"The","start":0.283,"end":0.404},{"word":"Fox","start":0.464,"end":0.767},
                          {"word":"and","start":1.07,"end":1.211},{"word":"the","start":1.231,"end":1.575},
                          {"word":"Crow","start":1.595,"end":1.918}]},
               {"startTimeMs": 8844, "endTimeMs": 12390, "text": "Early one morning, a fox is walking.",
                "words": [{"word":"Early","start":8.964,"end":9.244},{"word":"one","start":9.385,"end":9.525},
                          {"word":"morning,","start":9.585,"end":9.906},{"word":"a","start":null,"end":null},
                          {"word":"fox","start":10.466,"end":10.79},{"word":"is","start":10.85,"end":10.97},
                          {"word":"walking.","start":11.01,"end":11.6}]}
             ]}
            """.formatted(durationSeconds);
    }

    /** The removed OpenRouter-fallback shape (lesson 67 / 168): 8-word chunks on an i * 2500 ms grid, even split. */
    private static String syntheticGridResponse() {
        StringBuilder segs = new StringBuilder();
        for (int i = 0; i < 8; i++) {
            int s = i * 2500;
            StringBuilder words = new StringBuilder();
            for (int w = 0; w < 8; w++) {
                double ws = (s + w * 400) / 1000.0;
                words.append(w == 0 ? "" : ",").append("{\"word\":\"w").append(w)
                        .append("\",\"start\":").append(ws).append(",\"end\":").append(ws + 0.4).append("}");
            }
            segs.append(i == 0 ? "" : ",").append("{\"startTimeMs\":").append(s).append(",\"endTimeMs\":").append(s + 3200)
                    .append(",\"text\":\"w0 w1 w2 w3 w4 w5 w6 w7\",\"words\":[").append(words).append("]}");
        }
        return "{\"title\":\"x\",\"durationSeconds\":180,\"timing\":{\"alignment\":\"whisperx-wav2vec2\"},\"segments\":[" + segs + "]}";
    }

    private void aiReturns(String json) throws Exception {
        JsonNode node = mapper.readTree(json);
        when(ai.postForEntity(anyString(), any(), eq(JsonNode.class))).thenReturn(ResponseEntity.ok(node));
    }

    private void persistenceSucceeds() {
        when(materialRepository.save(any(ListeningMaterial.class))).thenAnswer(inv -> {
            ListeningMaterial m = inv.getArgument(0);
            m.setId(500L);
            return m;
        });
        when(segmentRepository.saveAll(anyList())).thenAnswer(inv -> {
            List<TranscriptSegment> segs = inv.getArgument(0);
            for (int i = 0; i < segs.size(); i++) segs.get(i).setId(9000L + i);
            return segs;
        });
    }

    private static ImportListeningMaterialRequest request() {
        return ImportListeningMaterialRequest.builder().youtubeUrl("https://www.youtube.com/watch?v=BF3bXji-J7I").build();
    }

    private void assertNothingStored() {
        verify(materialRepository, never()).save(any());
        verify(segmentRepository, never()).saveAll(anyList());
        verify(exerciseRepository, never()).save(any());
    }

    // ---------------------------------------------------------------- one pipeline, fail closed

    @Test
    @DisplayName("Personal import calls ONLY the PC AI service, stores real duration and keeps an unaligned word untimed")
    void personalImportUsesOnlyLocalPipeline() throws Exception {
        aiReturns(alignedResponse(198));
        persistenceSucceeds();

        service.importMaterialFromYouTube(request(), 7L);

        ArgumentCaptor<String> url = ArgumentCaptor.forClass(String.class);
        verify(ai, times(1)).postForEntity(url.capture(), any(), eq(JsonNode.class));
        assertThat(url.getValue()).endsWith(AI_ENDPOINT_SUFFIX);
        verifyNoMoreInteractions(ai);

        ArgumentCaptor<ListeningMaterial> material = ArgumentCaptor.forClass(ListeningMaterial.class);
        verify(materialRepository).save(material.capture());
        assertThat(material.getValue().getDurationSeconds()).isEqualTo(198);
        assertThat(material.getValue().getOwnerUserId()).isEqualTo(7L);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<TranscriptSegment>> segs = ArgumentCaptor.forClass(List.class);
        verify(segmentRepository).saveAll(segs.capture());
        String secondWords = segs.getValue().get(1).getWordsJson();
        assertThat(secondWords).contains("{\"word\":\"a\",\"start\":null,\"end\":null}");
    }

    @Test
    @DisplayName("SYSTEM import goes through the same single endpoint and gate")
    void systemImportUsesTheSamePipeline() throws Exception {
        aiReturns(alignedResponse(198));
        persistenceSucceeds();
        when(materialRepository.findSystemMaterialsByVideoId("BF3bXji-J7I")).thenReturn(List.of());

        service.importSystemMaterial(request());

        ArgumentCaptor<String> url = ArgumentCaptor.forClass(String.class);
        verify(ai, times(1)).postForEntity(url.capture(), any(), eq(JsonNode.class));
        assertThat(url.getValue()).endsWith(AI_ENDPOINT_SUFFIX);
        verifyNoMoreInteractions(ai);
    }

    @Test
    @DisplayName("Local pipeline 503 (PC down / WhisperX unavailable) => 503 with its message, no fallback, nothing stored")
    void pipelineUnavailableFailsClosed() {
        when(ai.postForEntity(anyString(), any(), eq(JsonNode.class))).thenThrow(HttpServerErrorException.create(
                HttpStatus.SERVICE_UNAVAILABLE, "Service Unavailable", null,
                "{\"detail\":\"Dịch vụ xử lý âm thanh cục bộ (WhisperX) đang tạm thời không khả dụng.\"}".getBytes(StandardCharsets.UTF_8),
                StandardCharsets.UTF_8));

        assertThatThrownBy(() -> service.importMaterialFromYouTube(request(), 7L))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(e -> {
                    ResponseStatusException r = (ResponseStatusException) e;
                    assertThat(r.getStatusCode().value()).isEqualTo(503);
                    assertThat(r.getReason()).contains("WhisperX");
                });
        verify(ai, times(1)).postForEntity(anyString(), any(), eq(JsonNode.class));
        assertNothingStored();
    }

    @Test
    @DisplayName("PC unreachable (connection refused) => 503 local pipeline unavailable, nothing stored")
    void pcUnreachableFailsClosed() {
        when(ai.postForEntity(anyString(), any(), eq(JsonNode.class)))
                .thenThrow(new ResourceAccessException("I/O error: Connection refused"));

        assertThatThrownBy(() -> service.importSystemMaterial(request()))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode().value()).isEqualTo(503));
        assertNothingStored();
    }

    @Test
    @DisplayName("Read timeout => bounded 503 'too slow', never a late lesson")
    void readTimeoutIsBounded() {
        when(ai.postForEntity(anyString(), any(), eq(JsonNode.class)))
                .thenThrow(new ResourceAccessException("I/O error: Read timed out"));

        assertThatThrownBy(() -> service.importMaterialFromYouTube(request(), 7L))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(e -> assertThat(((ResponseStatusException) e).getReason())
                        .isEqualTo(ListeningServiceImpl.LOCAL_PIPELINE_TOO_SLOW));
        assertNothingStored();
    }

    @Test
    @DisplayName("Response without WhisperX provenance (old AI build / other provider) is refused")
    void missingProvenanceRefused() throws Exception {
        aiReturns(alignedResponse(198).replace("\"alignment\": \"whisperx-wav2vec2\"", "\"alignment\": \"openrouter-whisper-1\""));

        assertThatThrownBy(() -> service.importMaterialFromYouTube(request(), 7L))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode().value()).isEqualTo(400));
        assertNothingStored();
    }

    @Test
    @DisplayName("Lesson-67 shape (i * 2500 grid, even split, past the media end) can never be published")
    void syntheticGridRefused() throws Exception {
        aiReturns(syntheticGridResponse());

        assertThatThrownBy(() -> service.importSystemMaterial(request()))
                .isInstanceOf(ResponseStatusException.class);
        assertNothingStored();
    }

    @Test
    @DisplayName("Missing duration is refused (no 180 s default)")
    void missingDurationRefused() throws Exception {
        aiReturns(alignedResponse(198).replace("\"durationSeconds\": 198,", ""));

        assertThatThrownBy(() -> service.importMaterialFromYouTube(request(), 7L))
                .isInstanceOf(ResponseStatusException.class);
        assertNothingStored();
    }

    // ---------------------------------------------------------------- gate rules

    private static WordTimestampDto w(String word, Double s, Double e) {
        return WordTimestampDto.builder().word(word).start(s).end(e).build();
    }

    private static ListeningTranscriptTimingGate.Segment seg(int s, int e, WordTimestampDto... words) {
        return new ListeningTranscriptTimingGate.Segment(s, e, List.of(words));
    }

    @Test
    @DisplayName("Gate: words past the media end, reversed words, out-of-order segments and too few aligned words are refused")
    void gateRules() {
        var ok = seg(100, 2000, w("a", 0.2, 0.5), w("b", 0.6, 1.1), w("c", 1.2, 1.9));
        ListeningTranscriptTimingGate.validate("whisperx-wav2vec2", 10, List.of(ok));

        assertThatThrownBy(() -> ListeningTranscriptTimingGate.validate("whisperx-wav2vec2", 3,
                List.of(seg(100, 5000, w("a", 0.2, 0.5), w("b", 3.6, 4.1), w("c", 4.2, 4.9)))))
                .isInstanceOf(ListeningTranscriptTimingGate.Rejected.class);
        assertThatThrownBy(() -> ListeningTranscriptTimingGate.validate("whisperx-wav2vec2", 10,
                List.of(seg(0, 2000, w("a", 0.9, 0.5)))))
                .isInstanceOf(ListeningTranscriptTimingGate.Rejected.class);
        assertThatThrownBy(() -> ListeningTranscriptTimingGate.validate("whisperx-wav2vec2", 10,
                List.of(seg(3000, 4000, w("a", 3.1, 3.5)), seg(1000, 2000, w("b", 1.1, 1.5)))))
                .isInstanceOf(ListeningTranscriptTimingGate.Rejected.class);
        assertThatThrownBy(() -> ListeningTranscriptTimingGate.validate("whisperx-wav2vec2", 10,
                List.of(seg(0, 2000, w("a", 0.1, 0.4), w("b", null, null), w("c", null, null)))))
                .isInstanceOf(ListeningTranscriptTimingGate.Rejected.class);
        assertThatThrownBy(() -> ListeningTranscriptTimingGate.validate(null, 10, List.of(ok)))
                .isInstanceOf(ListeningTranscriptTimingGate.Rejected.class);
    }

    @Test
    @DisplayName("Gate: evenly split words are recognised as synthetic")
    void gateDetectsEvenSplit() {
        List<WordTimestampDto> even = new ArrayList<>();
        for (int i = 0; i < 6; i++) even.add(w("w" + i, i * 0.4, (i + 1) * 0.4));
        assertThat(ListeningTranscriptTimingGate.uniformSpacing(even)).isTrue();
        assertThat(ListeningTranscriptTimingGate.uniformSpacing(List.of(
                w("a", 0.2, 0.5), w("b", 0.6, 1.1), w("c", 1.2, 1.9), w("d", 2.0, 2.2)))).isFalse();
    }

    // ---------------------------------------------------------------- display + repair

    @Test
    @DisplayName("Untimed stored words are shown as zero-length markers (never highlighted, never invented)")
    void untimedWordsAreZeroLengthMarkers() {
        List<WordTimestampDto> shown = ListeningServiceImpl.displayWords(List.of(
                w("a", null, null), w("fox", 10.47, 10.79), w("is", null, null), w("here", 11.0, 11.4)), 9000);
        assertThat(shown.get(0).getStart()).isEqualTo(10.47).isEqualTo(shown.get(0).getEnd());
        assertThat(shown.get(2).getStart()).isEqualTo(10.79).isEqualTo(shown.get(2).getEnd());
        assertThat(shown.get(1)).isEqualTo(w("fox", 10.47, 10.79));
    }

    @Test
    @DisplayName("Repair is refused when learners have records on the lesson; nothing is deleted or fetched")
    void repairRefusedWithLearnerRecords() {
        ListeningMaterial m = ListeningMaterial.builder().id(84L).youtubeVideoId("BF3bXji-J7I").isSystem(true).build();
        when(materialRepository.findById(84L)).thenReturn(Optional.of(m));
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.queryForObject(anyString(), eq(Long.class), any(), any(), any(), any(), any())).thenReturn(3L);
        service.setJdbcTemplate(jdbc);

        assertThatThrownBy(() -> service.reprocessYouTubeMaterial(84L))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode().value()).isEqualTo(409));
        verifyNoInteractions(ai);
        verify(segmentRepository, never()).deleteByListeningMaterialId(anyLong());
        verify(exerciseRepository, never()).deleteByListeningMaterialId(anyLong());
    }

    @Test
    @DisplayName("Repair replaces segments of the SAME lesson id and sets the real duration")
    void repairKeepsLessonIdentity() throws Exception {
        ListeningMaterial m = ListeningMaterial.builder().id(67L).youtubeVideoId("BF3bXji-J7I").isSystem(true)
                .durationSeconds(180).title("Curated title").build();
        when(materialRepository.findById(67L)).thenReturn(Optional.of(m));
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.queryForObject(anyString(), eq(Long.class), any(), any(), any(), any(), any())).thenReturn(0L);
        service.setJdbcTemplate(jdbc);
        aiReturns(alignedResponse(198));
        when(materialRepository.save(any(ListeningMaterial.class))).thenAnswer(inv -> inv.getArgument(0));
        when(segmentRepository.saveAll(anyList())).thenAnswer(inv -> inv.getArgument(0));

        service.reprocessYouTubeMaterial(67L);

        verify(exerciseRepository).deleteByListeningMaterialId(67L);
        verify(segmentRepository).deleteByListeningMaterialId(67L);
        ArgumentCaptor<ListeningMaterial> saved = ArgumentCaptor.forClass(ListeningMaterial.class);
        verify(materialRepository).save(saved.capture());
        assertThat(saved.getValue().getId()).isEqualTo(67L);
        assertThat(saved.getValue().getDurationSeconds()).isEqualTo(198);
        assertThat(saved.getValue().getTitle()).isEqualTo("Curated title");
    }

    // ---------------------------------------------------------------- source guard (regression)

    private static String read(String path) throws Exception {
        return Files.readString(Path.of(path), StandardCharsets.UTF_8);
    }

    @Test
    @DisplayName("Source guard: no paid ASR, VPS worker, caption scrape or invented timing in the Listening import code")
    void sourceGuard() throws Exception {
        String java = read("src/main/java/com/englishcoach/listening/service/ListeningServiceImpl.java");
        for (String forbidden : List.of("ProcessBuilder", "asr_worker", "timedtext", "captionTracks", "openrouter",
                "generateFallbackWords", "fetchViaPythonAsrWorker", "fetchViaYouTubeSubtitles", ": 180")) {
            assertThat(java.toLowerCase(Locale.ROOT)).as("ListeningServiceImpl must not contain " + forbidden)
                    .doesNotContain(forbidden.toLowerCase(Locale.ROOT));
        }

        Path aiRoot = Path.of("../ai-service/app");
        if (!Files.isDirectory(aiRoot)) {
            return; // backend built alone (image build): the Java half of the guard still ran
        }
        String yt = read("../ai-service/app/services/listening_youtube_service.py");
        String asr = read("../ai-service/app/services/listening_local_asr.py");
        String route = read("../ai-service/app/api/routes/listening.py");
        for (String src : List.of(yt, asr, route)) {
            String lower = src.toLowerCase(Locale.ROOT);
            assertThat(lower).doesNotContain("speech_service");
            assertThat(lower).doesNotContain("transcribe_detailed_audio_bytes");
            assertThat(lower).doesNotContain("openrouter.ai");
            assertThat(lower).doesNotContain("openai_api_key");
            assertThat(lower).doesNotContain("repair_unaligned_words");
            assertThat(lower).doesNotContain("* 2500");
            assertThat(lower).doesNotContain("chunk_size");
        }
        assertThat(asr).contains("local_files_only=True");
        assertThat(yt).contains("assess_transcript_timing");
    }
}
