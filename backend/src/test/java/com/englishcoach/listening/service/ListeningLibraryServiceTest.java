package com.englishcoach.listening.service;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.listening.dto.ImportListeningMaterialRequest;
import com.englishcoach.listening.dto.ListeningCategoryDto;
import com.englishcoach.listening.dto.ListeningExerciseDto;
import com.englishcoach.listening.dto.ListeningLibraryItemDto;
import com.englishcoach.listening.dto.ListeningMaterialDetailDto;
import com.englishcoach.listening.dto.ListeningMaterialSummaryDto;
import com.englishcoach.listening.entity.enums.ExerciseType;
import com.englishcoach.listening.entity.ListeningExercise;
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
import org.springframework.http.ResponseEntity;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.util.Collections;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ListeningLibraryServiceTest {

    @Mock
    private ListeningMaterialRepository materialRepository;

    @Mock
    private TranscriptSegmentRepository segmentRepository;

    @Mock
    private ListeningExerciseRepository exerciseRepository;

    @Mock
    private ListeningSessionRepository sessionRepository;

    @Mock
    private ExerciseAttemptRepository attemptRepository;

    @Mock
    private UserRepository userRepository;

    @Mock
    private DictationScoringService scoringService;

    @Mock
    private AiDiagnosticAgentService diagnosticAgentService;

    @Mock
    private com.englishcoach.speaking.repository.SpeakingShadowingUnitRepository speakingShadowingUnitRepository;

    @Mock
    private com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository speakingShadowingAttemptRepository;

    @Mock
    private ListeningAnalyticsService analyticsService;

    @InjectMocks
    private ListeningServiceImpl listeningService;

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(ints = {0, 1, 3})
    void closingDictationCountsOnlyFullCoverage(int attempted) {
        var material = ListeningMaterial.builder().id(9L).build();
        var user = User.builder().id(7L).build();
        var session = com.englishcoach.listening.entity.ListeningSession.builder()
                .id(5L).listeningMaterial(material).user(user).build();
        when(sessionRepository.forUpdate(5L)).thenReturn(Optional.of(session));
        when(exerciseRepository.countDictationExercisesByMaterialId(9L)).thenReturn(3L);
        when(attemptRepository.countDistinctExercisesAttemptedBySessionId(5L)).thenReturn((long) attempted);
        listeningService.completeSession(5L, 7L);
        listeningService.completeSession(5L, 7L);
        assertThat(session.isClosed()).isTrue();
        assertThat(session.getEndedAt() != null).isEqualTo(attempted == 3);
        assertThat(session.getClosedEarlyAt() != null).isEqualTo(attempted < 3);
        verify(sessionRepository).save(session);
        verify(analyticsService, times(attempted == 3 ? 1 : 0)).recalculateUserProfileFromCompletedSessions(7L);
    }

    private ListeningMaterialRepository.LibraryMaterialRow createMockRow(
            Long id, String title, String channel, String topic, String level,
            String accent, Integer duration, String thumb, String ytId,
            long segCount, long exCount) {
        return new ListeningMaterialRepository.LibraryMaterialRow() {
            @Override public Long getId() { return id; }
            @Override public String getTitle() { return title; }
            @Override public String getChannel() { return channel; }
            @Override public String getTopic() { return topic; }
            @Override public String getCefrLevel() { return level; }
            @Override public String getAccent() { return accent; }
            @Override public Integer getDurationSeconds() { return duration; }
            @Override public String getThumbnail() { return thumb; }
            @Override public String getYoutubeVideoId() { return ytId; }
            @Override public String getAudioUrl() { return "https://www.youtube.com/watch?v=" + ytId; }
            @Override public Long getSegmentCount() { return segCount; }
            @Override public Long getExerciseCount() { return exCount; }
        };
    }

    @Test
    @DisplayName("Shared Library: returns system items only with correct practiceAvailable and hasTranscript flags")
    void testGetSharedLibrary_SystemOnlyAndFlags() {
        ListeningMaterialRepository.LibraryMaterialRow row1 = createMockRow(
                11L, "Lesson 11", "BBC Learning", "Everyday English", "B2", "British", 180, "thumb11.jpg", "eIho2S0ZahI", 50, 10
        );
        ListeningMaterialRepository.LibraryMaterialRow row2 = createMockRow(
                23L, "Watch Only Video", "TED", "Ideas & Talks", "B2", "American", null, "thumb23.jpg", "8KkKuTCFvzI", 0, 0
        );

        when(materialRepository.findSharedLibraryRows()).thenReturn(List.of(row1, row2));

        List<ListeningLibraryItemDto> library = listeningService.getSharedLibrary();

        assertThat(library).hasSize(2);

        ListeningLibraryItemDto item1 = library.get(0);
        assertThat(item1.getId()).isEqualTo(11L);
        assertThat(item1.getHasTranscript()).isTrue();
        assertThat(item1.getPracticeAvailable()).isTrue();
        assertThat(item1.getDurationSeconds()).isEqualTo(180);

        ListeningLibraryItemDto item2 = library.get(1);
        assertThat(item2.getId()).isEqualTo(23L);
        assertThat(item2.getHasTranscript()).isFalse();
        assertThat(item2.getPracticeAvailable()).isFalse();
        assertThat(item2.getDurationSeconds()).isNull();
    }

    @Test
    @DisplayName("Zero-Segment Safety: watch-only material returns 200, practiceAvailable=false, empty segments, no 500/NPE")
    void testZeroSegmentDetailSafety() {
        ListeningMaterial watchOnly = ListeningMaterial.builder()
                .id(30L)
                .title("Watch Only 30")
                .audioUrl("https://www.youtube.com/watch?v=0NPI9gDrgvs")
                .youtubeVideoId("0NPI9gDrgvs")
                .channel("English with Lucy")
                .cefrLevel("B1")
                .topic("Everyday English")
                .accent("American")
                .isSystem(true)
                .ownerUserId(null)
                .build();

        when(materialRepository.findByIdAndVisibleToUser(30L, 100L)).thenReturn(Optional.of(watchOnly));
        when(segmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(30L)).thenReturn(Collections.emptyList());
        when(exerciseRepository.countDictationExercisesByMaterialId(30L)).thenReturn(0L);

        ListeningMaterialDetailDto detail = listeningService.getMaterialById(30L, 100L);

        assertThat(detail).isNotNull();
        assertThat(detail.getId()).isEqualTo(30L);
        assertThat(detail.getSegments()).isEmpty();
        assertThat(detail.getHasTranscript()).isFalse();
        assertThat(detail.getPracticeAvailable()).isFalse();
        assertThat(detail.getYoutubeVideoId()).isEqualTo("0NPI9gDrgvs");
        assertThat(detail.getChannel()).isEqualTo("English with Lucy");
    }

    @Test
    @DisplayName("Zero-Segment Safety: getExercisesForMaterial on watch-only material returns empty list without error")
    void testZeroSegmentExercisesSafety() {
        ListeningMaterial watchOnly = ListeningMaterial.builder()
                .id(30L)
                .title("Watch Only 30")
                .isSystem(true)
                .build();

        when(materialRepository.findByIdAndVisibleToUser(30L, 100L)).thenReturn(Optional.of(watchOnly));
        when(segmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(30L)).thenReturn(Collections.emptyList());
        when(exerciseRepository.findByListeningMaterialId(30L)).thenReturn(Collections.emptyList());

        List<ListeningExerciseDto> exercises = listeningService.getExercisesForMaterial(30L, 100L);

        assertThat(exercises).isEmpty();
        verify(exerciseRepository, never()).save(any());
    }

    @Test
    @DisplayName("Three States PracticeAvailable: watch-only, segments-only, segments+exercises")
    void testThreeStatesPracticeAvailable() {
        ListeningMaterial material = ListeningMaterial.builder()
                .id(50L)
                .title("State Test")
                .audioUrl("https://www.youtube.com/watch?v=eIho2S0ZahI")
                .isSystem(true)
                .build();

        TranscriptSegment seg = TranscriptSegment.builder().id(501L).startTimeMs(0).endTimeMs(5000).text("Hello").build();

        when(materialRepository.findByIdAndVisibleToUser(eq(50L), any())).thenReturn(Optional.of(material));

        // State 1: Watch-only (0 segments, 0 exercises)
        when(segmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(50L)).thenReturn(Collections.emptyList());
        when(exerciseRepository.countDictationExercisesByMaterialId(50L)).thenReturn(0L);
        ListeningMaterialDetailDto dto1 = listeningService.getMaterialById(50L, 1L);
        assertThat(dto1.getHasTranscript()).isFalse();
        assertThat(dto1.getPracticeAvailable()).isFalse();

        // State 2: Segments-only (1+ segments, 0 exercises)
        when(segmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(50L)).thenReturn(List.of(seg));
        when(exerciseRepository.countDictationExercisesByMaterialId(50L)).thenReturn(0L);
        ListeningMaterialDetailDto dto2 = listeningService.getMaterialById(50L, 1L);
        assertThat(dto2.getHasTranscript()).isTrue();
        assertThat(dto2.getPracticeAvailable()).isFalse();

        // State 3: Segments + Exercises (1+ segments, 1+ exercises)
        when(segmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(50L)).thenReturn(List.of(seg));
        when(exerciseRepository.countDictationExercisesByMaterialId(50L)).thenReturn(5L);
        ListeningMaterialDetailDto dto3 = listeningService.getMaterialById(50L, 1L);
        assertThat(dto3.getHasTranscript()).isTrue();
        assertThat(dto3.getPracticeAvailable()).isTrue();
    }

    @Test
    @DisplayName("Private Isolation: User cannot view another user's private material")
    void testPrivateMaterialCrossUserIsolation() {
        when(materialRepository.findByIdAndVisibleToUser(99L, 100L)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> listeningService.getMaterialById(99L, 100L))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("404");
    }

    @Test
    @DisplayName("Write Protection: Non-admin user cannot delete system material (returns 404)")
    void testNonAdminCannotDeleteSystemMaterial() {
        ListeningMaterial systemMat = ListeningMaterial.builder()
                .id(11L)
                .title("System Material")
                .isSystem(true)
                .ownerUserId(null)
                .build();

        User normalUser = User.builder().id(200L).role(Role.ROLE_USER).build();

        when(materialRepository.findById(11L)).thenReturn(Optional.of(systemMat));
        when(userRepository.findById(200L)).thenReturn(Optional.of(normalUser));

        assertThatThrownBy(() -> listeningService.deleteMaterial(11L, 200L))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("404");

        verify(materialRepository, never()).deleteByIdNative(anyLong());
    }

    @Test
    @DisplayName("Write Protection: Non-owner cannot delete another user's private material (returns 404)")
    void testNonOwnerCannotDeletePrivateMaterial() {
        ListeningMaterial privateMat = ListeningMaterial.builder()
                .id(18L)
                .title("User 675 Material")
                .isSystem(false)
                .ownerUserId(675L)
                .build();

        User otherUser = User.builder().id(999L).role(Role.ROLE_USER).build();

        when(materialRepository.findById(18L)).thenReturn(Optional.of(privateMat));
        when(userRepository.findById(999L)).thenReturn(Optional.of(otherUser));

        assertThatThrownBy(() -> listeningService.deleteMaterial(18L, 999L))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("404");

        verify(materialRepository, never()).deleteByIdNative(anyLong());
    }

    @Test
    @DisplayName("Write Protection: Owner can delete their own private material")
    void testOwnerCanDeletePrivateMaterial() {
        ListeningMaterial privateMat = ListeningMaterial.builder()
                .id(18L)
                .title("User 675 Material")
                .isSystem(false)
                .ownerUserId(675L)
                .build();

        User ownerUser = User.builder().id(675L).role(Role.ROLE_USER).build();

        when(materialRepository.findById(18L)).thenReturn(Optional.of(privateMat));
        when(userRepository.findById(675L)).thenReturn(Optional.of(ownerUser));

        listeningService.deleteMaterial(18L, 675L);

        verify(materialRepository, times(1)).deleteByIdNative(18L);
    }

    @Test
    @DisplayName("Content Boxes: getLibraryCategories returns 6 controlled topics with counts and items")
    void testGetLibraryCategories_returnsControlledTopicsWithCounts() {
        ListeningMaterialRepository.LibraryMaterialRow row1 = createMockRow(
                1L, "Veritasium Physics", "Veritasium", "Science & Tech", "B2", "American", 600, "thumb1.jpg", "yt1", 10, 5
        );
        ListeningMaterialRepository.LibraryMaterialRow row2 = createMockRow(
                2L, "Kurzgesagt Evolution", "Kurzgesagt", "Science & Tech", "B1", "British", 400, "thumb2.jpg", "yt2", 8, 4
        );
        ListeningMaterialRepository.LibraryMaterialRow row3 = createMockRow(
                3L, "TED Talk Future", "TED", "Ideas & Talks", "C1", "American", 900, "thumb3.jpg", "yt3", 15, 10
        );

        when(materialRepository.findSharedLibraryRows()).thenReturn(List.of(row1, row2, row3));

        List<ListeningCategoryDto> categories = listeningService.getLibraryCategories();

        assertThat(categories).hasSize(6);

        // Controlled order: Ideas & Talks, Everyday English, Science & Tech, Work & Study, Culture & Travel, News & Podcasts
        assertThat(categories.stream().map(ListeningCategoryDto::getTopic).toList())
                .containsExactly(
                        "Ideas & Talks",
                        "Everyday English",
                        "Science & Tech",
                        "Work & Study",
                        "Culture & Travel",
                        "News & Podcasts"
                );

        ListeningCategoryDto science = categories.stream()
                .filter(c -> "Science & Tech".equals(c.getTopic()))
                .findFirst().orElseThrow();
        assertThat(science.getCount()).isEqualTo(2);
        assertThat(science.getItems()).hasSize(2);

        ListeningCategoryDto ideas = categories.stream()
                .filter(c -> "Ideas & Talks".equals(c.getTopic()))
                .findFirst().orElseThrow();
        assertThat(ideas.getCount()).isEqualTo(1);
        assertThat(ideas.getItems()).hasSize(1);

        ListeningCategoryDto everyday = categories.stream()
                .filter(c -> "Everyday English".equals(c.getTopic()))
                .findFirst().orElseThrow();
        assertThat(everyday.getCount()).isEqualTo(0);
        assertThat(everyday.getItems()).isEmpty();
    }

    @Test
    @DisplayName("Content Separation: Personal materials only include user personal content, never system content")
    void testGetPersonalMaterials_excludesSystemContent() {
        ListeningMaterial userMaterial = ListeningMaterial.builder()
                .id(101L)
                .title("My Personal Audio")
                .isSystem(false)
                .ownerUserId(42L)
                .build();

        when(materialRepository.findUserMaterialsByFilters(eq(42L), isNull(), isNull(), isNull()))
                .thenReturn(List.of(userMaterial));

        List<ListeningMaterialSummaryDto> personal = listeningService.getPersonalMaterials(42L);

        assertThat(personal).hasSize(1);
        assertThat(personal.get(0).getId()).isEqualTo(101L);
        assertThat(personal.get(0).getTitle()).isEqualTo("My Personal Audio");

        // Verify repository was queried with strict user isolation (findUserMaterialsByFilters)
        verify(materialRepository, times(1)).findUserMaterialsByFilters(42L, null, null, null);
    }

    @Test
    @DisplayName("Content Separation: getPersonalMaterials with null userId returns empty list safely")
    void testGetPersonalMaterials_nullUserReturnsEmpty() {
        List<ListeningMaterialSummaryDto> personal = listeningService.getPersonalMaterials(null);
        assertThat(personal).isEmpty();
        verify(materialRepository, never()).findUserMaterialsByFilters(any(), any(), any(), any());
    }

    @Test
    @DisplayName("System Import: importSystemMaterial produces real lesson with is_system=true, owner_user_id=null, transcript segments, and dictation exercises")
    void testImportSystemMaterial_createsSystemLessonWithTranscriptAndExercises() throws Exception {
        RestTemplate mockRestTemplate = mock(RestTemplate.class);
        listeningService.setRestTemplate(mockRestTemplate);

        String jsonResponse = """
            {
                "title": "Kurzgesagt - Quantum Computers",
                "durationSeconds": 480,
                "timing": {"alignment": "whisperx-wav2vec2"},
                "thumbnailUrl": "https://img.youtube.com/vi/jhXCTbFnK8o/hqdefault.jpg",
                "channel": "Kurzgesagt",
                "segments": [
                    {
                        "startTimeMs": 0,
                        "endTimeMs": 4000,
                        "speakerName": "Narrator",
                        "text": "What is a quantum computer?",
                        "words": [{"word": "What", "start": 0.0, "end": 0.5}]
                    },
                    {
                        "startTimeMs": 4000,
                        "endTimeMs": 8500,
                        "speakerName": "Narrator",
                        "text": "It uses qubits instead of regular bits.",
                        "words": [{"word": "It", "start": 4.0, "end": 4.5}]
                    }
                ]
            }
            """;
        JsonNode jsonNode = new ObjectMapper().readTree(jsonResponse);
        when(mockRestTemplate.postForEntity(anyString(), any(), eq(JsonNode.class)))
                .thenReturn(ResponseEntity.ok(jsonNode));

        when(materialRepository.save(any(ListeningMaterial.class))).thenAnswer(inv -> {
            ListeningMaterial m = inv.getArgument(0);
            m.setId(201L);
            return m;
        });

        when(segmentRepository.saveAll(anyList())).thenAnswer(inv -> {
            List<TranscriptSegment> segs = inv.getArgument(0);
            for (int i = 0; i < segs.size(); i++) {
                segs.get(i).setId(1001L + i);
            }
            return segs;
        });

        when(exerciseRepository.countDictationExercisesByMaterialId(201L)).thenReturn(2L);

        ImportListeningMaterialRequest request = ImportListeningMaterialRequest.builder()
                .youtubeUrl("https://www.youtube.com/watch?v=jhXCTbFnK8o")
                .topic("Science & Tech")
                .cefrLevel("B2")
                .accent("American")
                .channel("Kurzgesagt")
                .build();

        ListeningMaterialDetailDto result = listeningService.importSystemMaterial(request);

        assertThat(result).isNotNull();
        assertThat(result.getId()).isEqualTo(201L);
        assertThat(result.getTitle()).isEqualTo("Kurzgesagt - Quantum Computers");
        assertThat(result.getHasTranscript()).isTrue();
        assertThat(result.getPracticeAvailable()).isTrue();
        assertThat(result.getSegments()).hasSize(2);

        // Verify material saved with isSystem = true, ownerUserId = null
        ArgumentCaptor<ListeningMaterial> matCaptor = ArgumentCaptor.forClass(ListeningMaterial.class);
        verify(materialRepository).save(matCaptor.capture());
        ListeningMaterial savedMat = matCaptor.getValue();
        assertThat(savedMat.isSystem()).isTrue();
        assertThat(savedMat.getOwnerUserId()).isNull();
        assertThat(savedMat.getTopic()).isEqualTo("Science & Tech");
        assertThat(savedMat.getCefrLevel()).isEqualTo("B2");
        assertThat(savedMat.getChannel()).isEqualTo("Kurzgesagt");

        // Verify segments saved
        verify(segmentRepository, times(1)).saveAll(anyList());

        // Verify dictation exercises saved for each segment
        verify(exerciseRepository, times(2)).save(any(ListeningExercise.class));
    }

    @Test
    @DisplayName("User Import: importMaterialFromYouTube produces user lesson with is_system=false, owner_user_id=userId")
    void testImportUserMaterial_createsUserLessonWithOwnerId() throws Exception {
        RestTemplate mockRestTemplate = mock(RestTemplate.class);
        listeningService.setRestTemplate(mockRestTemplate);

        String jsonResponse = """
            {
                "title": "Daily English Conversation",
                "durationSeconds": 120,
                "timing": {"alignment": "whisperx-wav2vec2"},
                "thumbnailUrl": "https://img.youtube.com/vi/abc12345678/hqdefault.jpg",
                "channel": "BBC Learning English",
                "segments": [
                    {
                        "startTimeMs": 0,
                        "endTimeMs": 3000,
                        "speakerName": "Speaker 1",
                        "text": "How are you doing today?",
                        "words": [{"word": "How", "start": 0.05, "end": 0.23}, {"word": "are", "start": 0.27, "end": 0.51}, {"word": "you", "start": 0.55, "end": 0.85}, {"word": "doing", "start": 0.89, "end": 1.07}, {"word": "today?", "start": 1.11, "end": 1.35}]
                    }
                ]
            }
            """;
        JsonNode jsonNode = new ObjectMapper().readTree(jsonResponse);
        when(mockRestTemplate.postForEntity(anyString(), any(), eq(JsonNode.class)))
                .thenReturn(ResponseEntity.ok(jsonNode));

        when(materialRepository.save(any(ListeningMaterial.class))).thenAnswer(inv -> {
            ListeningMaterial m = inv.getArgument(0);
            m.setId(301L);
            return m;
        });

        when(segmentRepository.saveAll(anyList())).thenAnswer(inv -> {
            List<TranscriptSegment> segs = inv.getArgument(0);
            segs.get(0).setId(2001L);
            return segs;
        });

        when(exerciseRepository.countDictationExercisesByMaterialId(301L)).thenReturn(1L);

        ImportListeningMaterialRequest request = ImportListeningMaterialRequest.builder()
                .youtubeUrl("https://www.youtube.com/watch?v=abc12345678")
                .topic("Everyday English")
                .cefrLevel("A2")
                .accent("British")
                .build();

        ListeningMaterialDetailDto result = listeningService.importMaterialFromYouTube(request, 88L);

        assertThat(result).isNotNull();
        assertThat(result.getId()).isEqualTo(301L);
        assertThat(result.getHasTranscript()).isTrue();
        assertThat(result.getPracticeAvailable()).isTrue();

        ArgumentCaptor<ListeningMaterial> matCaptor = ArgumentCaptor.forClass(ListeningMaterial.class);
        verify(materialRepository).save(matCaptor.capture());
        ListeningMaterial savedMat = matCaptor.getValue();
        assertThat(savedMat.isSystem()).isFalse();
        assertThat(savedMat.getOwnerUserId()).isEqualTo(88L);
    }

    @Test
    @DisplayName("System Upgrade: Existing metadata-only SYSTEM row is upgraded in-place preserving curated metadata and backfilling duration")
    void testUpgradeExistingMetadataOnlySystemMaterial_preservesCuratedMetadataAndBackfillsDuration() throws Exception {
        RestTemplate mockRestTemplate = mock(RestTemplate.class);
        listeningService.setRestTemplate(mockRestTemplate);

        ListeningMaterial curatedV50Row = ListeningMaterial.builder()
                .id(23L)
                .title("How to Speak So That People Want to Listen | Julian Treasure | TED")
                .channel("TED")
                .thumbnail("https://i.ytimg.com/vi/eIho2S0ZahI/hqdefault.jpg")
                .cefrLevel("B2")
                .topic("Ideas & Talks")
                .accent("British")
                .durationSeconds(null) // metadata-only, duration null
                .youtubeVideoId("eIho2S0ZahI")
                .audioUrl("https://www.youtube.com/watch?v=eIho2S0ZahI")
                .isSystem(true)
                .ownerUserId(null)
                .build();

        when(materialRepository.findSystemMaterialsByVideoId("eIho2S0ZahI"))
                .thenReturn(List.of(curatedV50Row));
        when(materialRepository.findById(23L))
                .thenReturn(Optional.of(curatedV50Row));
        when(segmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(23L))
                .thenReturn(Collections.emptyList());
        when(exerciseRepository.countDictationExercisesByMaterialId(23L))
                .thenReturn(0L);

        String jsonResponse = """
            {
                "title": "Raw YouTube Video Title Not Authoritative",
                "durationSeconds": 598,
                "timing": {"alignment": "whisperx-wav2vec2"},
                "thumbnailUrl": "https://img.youtube.com/vi/eIho2S0ZahI/hqdefault.jpg",
                "channel": "Raw YouTube Channel",
                "segments": [
                    {
                        "startTimeMs": 0,
                        "endTimeMs": 3500,
                        "speakerName": "Julian",
                        "text": "The human voice: it's the instrument we all play.",
                        "words": [{"word": "The", "start": 0.05, "end": 0.23}, {"word": "human", "start": 0.27, "end": 0.51}, {"word": "voice:", "start": 0.55, "end": 0.85}, {"word": "it's", "start": 0.89, "end": 1.07}, {"word": "the", "start": 1.11, "end": 1.35}, {"word": "instrument", "start": 1.39, "end": 1.69}, {"word": "we", "start": 1.73, "end": 1.91}, {"word": "all", "start": 1.95, "end": 2.19}, {"word": "play.", "start": 2.23, "end": 2.53}]
                    },
                    {
                        "startTimeMs": 3500,
                        "endTimeMs": 7200,
                        "speakerName": "Julian",
                        "text": "It's the most powerful sound in the world, probably.",
                        "words": [{"word": "It's", "start": 3.55, "end": 3.73}, {"word": "the", "start": 3.77, "end": 4.01}, {"word": "most", "start": 4.05, "end": 4.35}, {"word": "powerful", "start": 4.39, "end": 4.57}, {"word": "sound", "start": 4.61, "end": 4.85}, {"word": "in", "start": 4.89, "end": 5.19}, {"word": "the", "start": 5.23, "end": 5.41}, {"word": "world,", "start": 5.45, "end": 5.69}, {"word": "probably.", "start": 5.73, "end": 6.03}]
                    }
                ]
            }
            """;
        JsonNode jsonNode = new ObjectMapper().readTree(jsonResponse);
        when(mockRestTemplate.postForEntity(anyString(), any(), eq(JsonNode.class)))
                .thenReturn(ResponseEntity.ok(jsonNode));

        when(materialRepository.save(any(ListeningMaterial.class))).thenAnswer(inv -> inv.getArgument(0));

        when(segmentRepository.saveAll(anyList())).thenAnswer(inv -> {
            List<TranscriptSegment> segs = inv.getArgument(0);
            for (int i = 0; i < segs.size(); i++) {
                segs.get(i).setId(5001L + i);
            }
            return segs;
        });

        when(exerciseRepository.countDictationExercisesByMaterialId(23L)).thenReturn(2L);

        ImportListeningMaterialRequest request = ImportListeningMaterialRequest.builder()
                .youtubeUrl("https://www.youtube.com/watch?v=eIho2S0ZahI")
                .build();

        ListeningMaterialDetailDto result = listeningService.importSystemMaterial(request);

        assertThat(result).isNotNull();
        // ID reused, no duplicate created
        assertThat(result.getId()).isEqualTo(23L);
        // Curated metadata strictly preserved (not overwritten by AI response)
        assertThat(result.getTitle()).isEqualTo("How to Speak So That People Want to Listen | Julian Treasure | TED");
        assertThat(result.getChannel()).isEqualTo("TED");
        assertThat(result.getThumbnail()).isEqualTo("https://i.ytimg.com/vi/eIho2S0ZahI/hqdefault.jpg");
        assertThat(result.getCefrLevel()).isEqualTo("B2");
        assertThat(result.getTopic()).isEqualTo("Ideas & Talks");
        assertThat(result.getAccent()).isEqualTo("British");
        // Duration was null, now backfilled from validated AI response
        assertThat(result.getDurationSeconds()).isEqualTo(598);
        // Practice availability and transcript reflect real data
        assertThat(result.getHasTranscript()).isTrue();
        assertThat(result.getPracticeAvailable()).isTrue();
        assertThat(result.getSegments()).hasSize(2);

        // Verify partial cleanup and real persistence
        verify(exerciseRepository, times(1)).deleteByListeningMaterialId(23L);
        verify(segmentRepository, times(1)).deleteByListeningMaterialId(23L);
        verify(segmentRepository, times(1)).saveAll(anyList());
        verify(exerciseRepository, times(2)).save(any(ListeningExercise.class));

        ArgumentCaptor<ListeningMaterial> captor = ArgumentCaptor.forClass(ListeningMaterial.class);
        verify(materialRepository).save(captor.capture());
        ListeningMaterial saved = captor.getValue();
        assertThat(saved.getId()).isEqualTo(23L);
        assertThat(saved.isSystem()).isTrue();
        assertThat(saved.getOwnerUserId()).isNull();
    }

    @Test
    @DisplayName("Idempotency ALREADY_COMPLETE: System material with existing segments and exercises skips re-extraction")
    void testSystemMaterialAlreadyComplete_skipsReimport() {
        RestTemplate mockRestTemplate = mock(RestTemplate.class);
        listeningService.setRestTemplate(mockRestTemplate);

        ListeningMaterial completeMaterial = ListeningMaterial.builder()
                .id(24L)
                .title("Complete Lesson")
                .channel("TED")
                .youtubeVideoId("8KkKuTCFvzI")
                .audioUrl("https://www.youtube.com/watch?v=8KkKuTCFvzI")
                .isSystem(true)
                .ownerUserId(null)
                .durationSeconds(800)
                .build();

        TranscriptSegment seg = TranscriptSegment.builder().id(99L).startTimeMs(0).endTimeMs(4000).text("Hello").build();

        when(materialRepository.findSystemMaterialsByVideoId("8KkKuTCFvzI"))
                .thenReturn(List.of(completeMaterial));
        when(segmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(24L))
                .thenReturn(List.of(seg));
        when(exerciseRepository.countDictationExercisesByMaterialId(24L))
                .thenReturn(5L);

        ImportListeningMaterialRequest request = ImportListeningMaterialRequest.builder()
                .youtubeUrl("https://www.youtube.com/watch?v=8KkKuTCFvzI")
                .build();

        ListeningMaterialDetailDto result = listeningService.importSystemMaterial(request);

        assertThat(result.getId()).isEqualTo(24L);
        assertThat(result.getHasTranscript()).isTrue();
        assertThat(result.getPracticeAvailable()).isTrue();

        // AI service client was never called
        verify(mockRestTemplate, never()).postForEntity(anyString(), any(), any());
        verify(segmentRepository, never()).deleteByListeningMaterialId(anyLong());
        verify(exerciseRepository, never()).deleteByListeningMaterialId(anyLong());
    }

    @Test
    @DisplayName("User Import with same YouTube ID creates private row and never mutates system row")
    void testUserImportWithSameYoutubeId_createsPrivateRowWithoutMutatingSystemRow() throws Exception {
        RestTemplate mockRestTemplate = mock(RestTemplate.class);
        listeningService.setRestTemplate(mockRestTemplate);

        String jsonResponse = """
            {
                "title": "Julian Treasure Speech",
                "durationSeconds": 598,
                "timing": {"alignment": "whisperx-wav2vec2"},
                "thumbnailUrl": "https://img.youtube.com/vi/eIho2S0ZahI/hqdefault.jpg",
                "channel": "TED",
                "segments": [
                    {
                        "startTimeMs": 0,
                        "endTimeMs": 3000,
                        "speakerName": "Speaker",
                        "text": "The human voice.",
                        "words": [{"word": "The", "start": 0.05, "end": 0.23}, {"word": "human", "start": 0.27, "end": 0.51}, {"word": "voice.", "start": 0.55, "end": 0.85}]
                    }
                ]
            }
            """;
        JsonNode jsonNode = new ObjectMapper().readTree(jsonResponse);
        when(mockRestTemplate.postForEntity(anyString(), any(), eq(JsonNode.class)))
                .thenReturn(ResponseEntity.ok(jsonNode));

        when(materialRepository.save(any(ListeningMaterial.class))).thenAnswer(inv -> {
            ListeningMaterial m = inv.getArgument(0);
            m.setId(901L);
            return m;
        });

        when(segmentRepository.saveAll(anyList())).thenAnswer(inv -> {
            List<TranscriptSegment> segs = inv.getArgument(0);
            segs.get(0).setId(6001L);
            return segs;
        });

        when(exerciseRepository.countDictationExercisesByMaterialId(901L)).thenReturn(1L);

        ImportListeningMaterialRequest request = ImportListeningMaterialRequest.builder()
                .youtubeUrl("https://www.youtube.com/watch?v=eIho2S0ZahI")
                .build();

        ListeningMaterialDetailDto result = listeningService.importMaterialFromYouTube(request, 675L);

        assertThat(result).isNotNull();
        assertThat(result.getId()).isEqualTo(901L);

        ArgumentCaptor<ListeningMaterial> captor = ArgumentCaptor.forClass(ListeningMaterial.class);
        verify(materialRepository).save(captor.capture());
        ListeningMaterial saved = captor.getValue();
        assertThat(saved.isSystem()).isFalse();
        assertThat(saved.getOwnerUserId()).isEqualTo(675L);
        verify(materialRepository, never()).findSystemMaterialsByVideoId(anyString());
    }
}
