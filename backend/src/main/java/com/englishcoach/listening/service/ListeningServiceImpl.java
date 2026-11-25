package com.englishcoach.listening.service;

import com.englishcoach.common.cache.BoundedTtlCache;
import com.englishcoach.listening.dto.CreateListeningMaterialRequest;
import com.englishcoach.listening.dto.CreateTranscriptSegmentRequest;
import com.englishcoach.listening.dto.ListeningMaterialDetailDto;
import com.englishcoach.listening.dto.ListeningMaterialSummaryDto;
import com.englishcoach.listening.dto.TranscriptSegmentDto;
import com.englishcoach.listening.dto.WordTimestampDto;
import com.englishcoach.listening.dto.ImportListeningMaterialRequest;
import com.englishcoach.listening.dto.ExerciseAttemptRequest;
import com.englishcoach.listening.dto.ExerciseAttemptResponse;
import com.englishcoach.listening.dto.ListeningExerciseDto;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.listening.entity.ExerciseAttempt;
import com.englishcoach.listening.entity.ListeningExercise;
import com.englishcoach.listening.entity.ListeningSession;
import com.englishcoach.listening.entity.enums.ExerciseType;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.listening.repository.TranscriptSegmentRepository;
import com.englishcoach.listening.repository.ExerciseAttemptRepository;
import com.englishcoach.listening.repository.ListeningExerciseRepository;
import com.englishcoach.listening.repository.ListeningSessionRepository;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class ListeningServiceImpl implements ListeningService {

        private static final long SHARED_CACHE_TTL_MS = java.util.concurrent.TimeUnit.MINUTES.toMillis(10);

        /** Bounded caches strictly for shared system rows (is_system = true AND owner_user_id IS NULL). */
        private final BoundedTtlCache<Long, ListeningMaterialDetailDto> sharedMaterialCache =
                        new BoundedTtlCache<>(64, SHARED_CACHE_TTL_MS);
        private final BoundedTtlCache<String, List<com.englishcoach.listening.dto.ListeningLibraryItemDto>> sharedLibraryCache =
                        new BoundedTtlCache<>(4, SHARED_CACHE_TTL_MS);

        @org.springframework.beans.factory.annotation.Autowired(required = false)
        private PlatformTransactionManager transactionManager;

        private <T> T inTx(java.util.function.Supplier<T> work) {
                if (transactionManager == null) return work.get();
                return new TransactionTemplate(transactionManager).execute(s -> work.get());
        }

        private <T> T inReadTx(java.util.function.Supplier<T> work) {
                if (transactionManager == null) return work.get();
                TransactionTemplate tpl = new TransactionTemplate(transactionManager);
                tpl.setReadOnly(true);
                return tpl.execute(s -> work.get());
        }

        private void evictSharedCacheAfterCommit(Long materialId) {
                Runnable evict = () -> {
                        sharedLibraryCache.clear();
                        if (materialId != null) {
                                sharedMaterialCache.invalidate(materialId);
                        } else {
                                sharedMaterialCache.clear();
                        }
                };
                if (TransactionSynchronizationManager.isSynchronizationActive()) {
                        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                                @Override
                                public void afterCommit() {
                                        evict.run();
                                }
                        });
                } else {
                        evict.run();
                }
        }

        private final ListeningMaterialRepository materialRepository;
        private final TranscriptSegmentRepository segmentRepository;
        private final ListeningExerciseRepository exerciseRepository;
        private final ExerciseAttemptRepository attemptRepository;
        private final ListeningSessionRepository sessionRepository;
        private final DictationScoringService scoringService;
        private final ListeningAnalyticsService analyticsService;
        private final AiDiagnosticAgentService diagnosticAgentService;
        private final com.englishcoach.auth.repository.UserRepository userRepository;
        private final com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository speakingShadowingAttemptRepository;
        private final com.englishcoach.speaking.repository.SpeakingShadowingUnitRepository speakingShadowingUnitRepository;

        @org.springframework.beans.factory.annotation.Autowired(required = false)
        private org.springframework.context.ApplicationEventPublisher eventPublisher;
        private final ObjectMapper objectMapper = new ObjectMapper();

        @Value("${ai.base-url:http://localhost:8000}")
        private String aiBaseUrl;

        @Value("${ai.timeout.connect:10000}")
        private int aiConnectTimeout;

        @Value("${ai.timeout.read:120000}")
        private int aiReadTimeout;

        /**
         * Whole YouTube import on the PC (download + local transcription + WhisperX alignment). Kept below the
         * edge's 100 s request limit so the learner always gets the real outcome, never a gateway timeout while the
         * server keeps working.
         */
        @Value("${ai.listening.import-read-timeout:90000}")
        private int listeningImportReadTimeout;

        @org.springframework.beans.factory.annotation.Autowired(required = false)
        private ListeningTranscriptWriter transcriptWriter;

        @org.springframework.beans.factory.annotation.Autowired(required = false)
        private com.englishcoach.auth.policy.AdminIdentityService adminIdentityService;

        public void setAdminIdentityService(com.englishcoach.auth.policy.AdminIdentityService adminIdentityService) {
                this.adminIdentityService = adminIdentityService;
        }

        private boolean isOfficialAdmin(Long userId) {
                if (userId == null) return false;
                if (adminIdentityService != null) {
                        return adminIdentityService.isOfficialAdmin(userId);
                }
                var session = com.englishcoach.common.security.AuthSessionContext.current();
                if (session != null && userId.equals(session.userId()) && session.adminAuthorityWithheld()) {
                        return false;
                }
                return userRepository.findById(userId)
                                .map(u -> com.englishcoach.auth.policy.OfficialAdminPolicy.isOfficialAdmin(u.getEmail(), u.getRole()))
                                .orElse(false);
        }

        private RestTemplate restTemplate;

        public void setRestTemplate(RestTemplate restTemplate) {
                this.restTemplate = restTemplate;
        }

        @Override
        public List<com.englishcoach.listening.dto.ListeningLibraryItemDto> getSharedLibrary() {
                return sharedLibraryCache.get("shared-library", ignored -> inReadTx(() -> {
                        List<ListeningMaterialRepository.LibraryMaterialRow> rows = materialRepository.findSharedLibraryRows();
                        return List.copyOf(rows.stream().map(r -> {
                                String videoId = r.getYoutubeVideoId();
                                if (videoId == null || videoId.isBlank()) {
                                        videoId = com.englishcoach.content.service.ContentServiceImpl.extractYouTubeVideoId(r.getAudioUrl());
                                }
                                String thumb = r.getThumbnail();
                                if ((thumb == null || thumb.isBlank()) && videoId != null) {
                                        thumb = "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg";
                                }
                                long segCount = r.getSegmentCount() != null ? r.getSegmentCount() : 0L;
                                long exCount = r.getExerciseCount() != null ? r.getExerciseCount() : 0L;
                                boolean hasTranscript = segCount > 0;
                                boolean practiceAvailable = segCount > 0 && exCount > 0;

                                return com.englishcoach.listening.dto.ListeningLibraryItemDto.builder()
                                                .id(r.getId())
                                                .title(r.getTitle())
                                                .channel(r.getChannel() != null && !r.getChannel().isBlank() ? r.getChannel() : "English Coach Studio")
                                                .topic(r.getTopic() != null ? r.getTopic() : "General")
                                                .level(r.getCefrLevel() != null ? r.getCefrLevel() : "B1")
                                                .accent(r.getAccent() != null ? r.getAccent() : "International")
                                                .durationSeconds(r.getDurationSeconds())
                                                .thumbnail(thumb)
                                                .youtubeVideoId(videoId)
                                                .hasTranscript(hasTranscript)
                                                .practiceAvailable(practiceAvailable)
                                                .build();
                        }).collect(Collectors.toList()));
                }));
        }

        public static final List<String> CONTROLLED_TOPICS = List.of(
                "Ideas & Talks",
                "Everyday English",
                "Science & Tech",
                "Work & Study",
                "Culture & Travel",
                "News & Podcasts"
        );

        @Override
        public List<com.englishcoach.listening.dto.ListeningCategoryDto> getLibraryCategories() {
                List<com.englishcoach.listening.dto.ListeningLibraryItemDto> allSharedItems = getSharedLibrary();
                Map<String, List<com.englishcoach.listening.dto.ListeningLibraryItemDto>> grouped = allSharedItems.stream()
                                .collect(Collectors.groupingBy(
                                                item -> item.getTopic() != null ? item.getTopic() : "General",
                                                java.util.LinkedHashMap::new,
                                                Collectors.toList()
                                ));

                List<com.englishcoach.listening.dto.ListeningCategoryDto> categories = new ArrayList<>();
                for (String topic : CONTROLLED_TOPICS) {
                        List<com.englishcoach.listening.dto.ListeningLibraryItemDto> items = grouped.getOrDefault(topic, Collections.emptyList());
                        categories.add(com.englishcoach.listening.dto.ListeningCategoryDto.builder()
                                        .topic(topic)
                                        .count(items.size())
                                        .items(items)
                                        .build());
                }

                for (Map.Entry<String, List<com.englishcoach.listening.dto.ListeningLibraryItemDto>> entry : grouped.entrySet()) {
                        if (!CONTROLLED_TOPICS.contains(entry.getKey())) {
                                categories.add(com.englishcoach.listening.dto.ListeningCategoryDto.builder()
                                                .topic(entry.getKey())
                                                .count(entry.getValue().size())
                                                .items(entry.getValue())
                                                .build());
                        }
                }

                return categories;
        }

        @Override
        @Transactional(readOnly = true)
        public List<ListeningMaterialSummaryDto> getAllMaterials(String cefrLevel, String topic, String accent, Long userId) {
                List<ListeningMaterial> materials = materialRepository.findVisibleByFilters(userId, cefrLevel, topic, accent);
                return materials.stream().map(this::mapToSummaryDto).collect(Collectors.toList());
        }

        @Override
        @Transactional(readOnly = true)
        public List<ListeningMaterialSummaryDto> getPersonalMaterials(String cefrLevel, String topic, String accent, Long userId) {
                if (userId == null) {
                        return Collections.emptyList();
                }
                List<ListeningMaterial> materials = materialRepository.findUserMaterialsByFilters(userId, cefrLevel, topic, accent);
                return materials.stream().map(this::mapToSummaryDto).collect(Collectors.toList());
        }

        @Override
        @Transactional(readOnly = true)
        public List<ListeningMaterialSummaryDto> getAllMaterials(String cefrLevel, String topic, String accent) {
                return getAllMaterials(cefrLevel, topic, accent, null);
        }

        @Override
        public ListeningMaterialDetailDto getMaterialById(Long id, Long userId) {
                ListeningMaterialDetailDto cached = id != null ? sharedMaterialCache.getIfPresent(id) : null;
                if (cached != null) {
                        return cached;
                }
                return inReadTx(() -> {
                        ListeningMaterial material = materialRepository.findByIdAndVisibleToUser(id, userId)
                                        .orElseThrow(() -> new ResponseStatusException(
                                                        HttpStatus.NOT_FOUND,
                                                        "Material not found with id: " + id
                                        ));
                        List<TranscriptSegment> segments = segmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(id);
                        ListeningMaterialDetailDto dto = mapToDetailDto(material, segments);
                        // Strictly cache ONLY complete shared system rows (AGENTS §21: is_system = true AND owner_user_id IS NULL)
                        if (material.isSystem() && material.getOwnerUserId() == null
                                        && Boolean.TRUE.equals(dto.getHasTranscript())
                                        && Boolean.TRUE.equals(dto.getPracticeAvailable())) {
                                sharedMaterialCache.put(id, dto);
                        }
                        return dto;
                });
        }

        @Override
        public ListeningMaterialDetailDto getMaterialById(Long id) {
                return getMaterialById(id, null);
        }

        @Override
        @Transactional
        public ListeningMaterialDetailDto createMaterial(CreateListeningMaterialRequest request, Long userId) {
                ListeningMaterial material = ListeningMaterial.builder()
                                .title(request.getTitle())
                                .audioUrl(request.getAudioUrl())
                                .durationSeconds(request.getDurationSeconds())
                                .cefrLevel(request.getCefrLevel())
                                .topic(request.getTopic())
                                .accent(request.getAccent())
                                .speechRate(request.getSpeechRate())
                                .speakerCount(request.getSpeakerCount())
                                .backgroundNoiseLevel(request.getBackgroundNoiseLevel())
                                .vocabularyDifficulty(request.getVocabularyDifficulty())
                                .connectedSpeechDifficulty(request.getConnectedSpeechDifficulty())
                                .inferenceDifficulty(request.getInferenceDifficulty())
                                .ownerUserId(userId)
                                .isSystem(false)
                                .segments(new ArrayList<>())
                                .sessions(new ArrayList<>())
                                .build();

                if (request.getSegments() != null && !request.getSegments().isEmpty()) {
                        for (CreateTranscriptSegmentRequest segReq : request.getSegments()) {
                                // No word timing is invented for typed text (rules 10 §BE): the row stays sentence-level.
                                String wordsJson = null;

                                TranscriptSegment segment = TranscriptSegment.builder()
                                                .listeningMaterial(material)
                                                .startTimeMs(segReq.getStartTimeMs())
                                                .endTimeMs(segReq.getEndTimeMs())
                                                .speakerName(segReq.getSpeakerName())
                                                .text(segReq.getText())
                                                .wordsJson(wordsJson)
                                                .difficultyScore(segReq.getDifficultyScore())
                                                .build();
                                material.getSegments().add(segment);
                        }
                }

                material = materialRepository.save(material);
                return mapToDetailDto(material, material.getSegments());
        }

        @Override
        @Transactional
        public ListeningMaterialDetailDto createMaterial(CreateListeningMaterialRequest request) {
                return createMaterial(request, null);
        }

        @Override
        public ListeningMaterialDetailDto importMaterialFromYouTube(ImportListeningMaterialRequest request, Long userId) {
                return doImportMaterial(request, userId, false);
        }

        @Override
        public ListeningMaterialDetailDto importMaterialFromYouTube(ImportListeningMaterialRequest request) {
                return doImportMaterial(request, null, false);
        }

        @Override
        public ListeningMaterialDetailDto importSystemMaterial(ImportListeningMaterialRequest request) {
                return doImportMaterial(request, null, true);
        }

        private record SystemPrecheck(ListeningMaterialDetailDto alreadyComplete, Long existingMaterialId) {}

        private ListeningMaterialDetailDto doImportMaterial(ImportListeningMaterialRequest request, Long userId, boolean isSystem) {
                String videoId = extractYouTubeVideoId(request.getYoutubeUrl());
                String audioUrl = "https://www.youtube.com/watch?v=" + videoId;

                log.info("Importing YouTube listening material (isSystem={}) for videoId: {} by user: {}", isSystem, videoId, userId);

                // Phase 1 (short read TX, system imports only): check if an existing system row exists and is ALREADY_COMPLETE
                Long existingSystemMaterialId = null;
                if (isSystem) {
                        SystemPrecheck precheck = inReadTx(() -> {
                                List<ListeningMaterial> existingList = materialRepository.findSystemMaterialsByVideoId(videoId);
                                if (!existingList.isEmpty()) {
                                        ListeningMaterial existingSystemMaterial = existingList.get(0);
                                        List<TranscriptSegment> existingSegments = segmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(existingSystemMaterial.getId());
                                        long existingExercises = exerciseRepository.countDictationExercisesByMaterialId(existingSystemMaterial.getId());
                                        if (!existingSegments.isEmpty() && existingExercises > 0) {
                                                log.info("System material id={} for videoId={} is ALREADY_COMPLETE (segments={}, exercises={}). Returning existing.",
                                                                existingSystemMaterial.getId(), videoId, existingSegments.size(), existingExercises);
                                                return new SystemPrecheck(mapToDetailDto(existingSystemMaterial, existingSegments), existingSystemMaterial.getId());
                                        }
                                        return new SystemPrecheck(null, existingSystemMaterial.getId());
                                }
                                return new SystemPrecheck(null, null);
                        });
                        if (precheck.alreadyComplete() != null) {
                                return precheck.alreadyComplete();
                        }
                        existingSystemMaterialId = precheck.existingMaterialId();
                }

                // External WhisperX HTTP + timing gate completely OUTSIDE any DB transaction (up to 90s)
                ImportedMaterialData data = fetchVerifiedTranscript(videoId, request.getYoutubeUrl());

                // Phase 2 (one short atomic commit TX, AGENTS §18.6): persist material + segments + exercises and build DTO inside TX
                final Long targetExistingId = existingSystemMaterialId;
                return inTx(() -> {
                        ListeningMaterial existingSystemMaterial = null;
                        if (isSystem && targetExistingId != null) {
                                existingSystemMaterial = lockMaterialById(targetExistingId).orElse(null);
                                if (existingSystemMaterial != null) {
                                        List<TranscriptSegment> recheckSegs = segmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(existingSystemMaterial.getId());
                                        long recheckEx = exerciseRepository.countDictationExercisesByMaterialId(existingSystemMaterial.getId());
                                        if (!recheckSegs.isEmpty() && recheckEx > 0) {
                                                return mapToDetailDto(existingSystemMaterial, recheckSegs);
                                        }
                                }
                        }
                        ListeningMaterialDetailDto dto = saveImportedMaterial(
                                        request, userId, isSystem, videoId, audioUrl, existingSystemMaterial, data);
                        if (isSystem) {
                                evictSharedCacheAfterCommit(dto.getId());
                        }
                        return dto;
                });
        }

        private java.util.Optional<ListeningMaterial> lockMaterialById(Long materialId) {
                if (transactionManager != null) {
                        return materialRepository.findByIdForShadowingGeneration(materialId);
                }
                return materialRepository.findByIdForShadowingGeneration(materialId)
                                .or(() -> materialRepository.findById(materialId));
        }

        private ListeningMaterialDetailDto saveImportedMaterial(ImportListeningMaterialRequest request, Long userId,
                        boolean isSystem, String videoId, String audioUrl, ListeningMaterial existingSystemMaterial, ImportedMaterialData data) {
                ListeningMaterial material;
                if (existingSystemMaterial != null) {
                        // Clean any previous partial segments or exercises before re-ingesting
                        exerciseRepository.deleteByListeningMaterialId(existingSystemMaterial.getId());
                        segmentRepository.deleteByListeningMaterialId(existingSystemMaterial.getId());

                        material = materialRepository.findById(existingSystemMaterial.getId()).orElse(existingSystemMaterial);
                        if (material.getYoutubeVideoId() == null || material.getYoutubeVideoId().isBlank()) {
                                material.setYoutubeVideoId(videoId);
                        }
                        if (material.getAudioUrl() == null || material.getAudioUrl().isBlank()) {
                                material.setAudioUrl(audioUrl);
                        }
                        if (material.getDurationSeconds() == null && data.durationSeconds > 0) {
                                material.setDurationSeconds(data.durationSeconds);
                        }
                        material.setSystem(true);
                        material.setOwnerUserId(null);
                } else {
                        // Title behavior: use custom title if provided; otherwise use real YouTube video title from metadata
                        String finalTitle = (request.getTitle() != null && !request.getTitle().isBlank())
                                        ? request.getTitle().trim()
                                        : (data.title != null && !data.title.isBlank() ? data.title : "YouTube Audio: " + videoId);

                        String cefr = request.getCefrLevel() != null && !request.getCefrLevel().isBlank() ? request.getCefrLevel() : "B1";
                        String topic = request.getTopic() != null && !request.getTopic().isBlank() ? request.getTopic() : "General English";
                        String accent = request.getAccent() != null && !request.getAccent().isBlank() ? request.getAccent() : "American";
                        String channel = (request.getChannel() != null && !request.getChannel().isBlank())
                                        ? request.getChannel().trim()
                                        : (data.channel != null && !data.channel.isBlank() ? data.channel : "YouTube");
                        String thumbnail = (data.thumbnail != null && !data.thumbnail.isBlank())
                                        ? data.thumbnail
                                        : "https://img.youtube.com/vi/" + videoId + "/hqdefault.jpg";
                        int duration = data.durationSeconds; // real media duration (gate: > 0), never a default

                        material = ListeningMaterial.builder()
                                        .title(finalTitle)
                                        .audioUrl(audioUrl)
                                        .durationSeconds(duration)
                                        .cefrLevel(cefr)
                                        .topic(topic)
                                        .accent(accent)
                                        .channel(channel)
                                        .thumbnail(thumbnail)
                                        .youtubeVideoId(videoId)
                                        .speakerCount(1)
                                        .speechRate(140.0)
                                        .backgroundNoiseLevel(1.0)
                                        .vocabularyDifficulty(2.5)
                                        .connectedSpeechDifficulty(2.5)
                                        .inferenceDifficulty(2.0)
                                        .ownerUserId(isSystem ? null : userId)
                                        .isSystem(isSystem)
                                        .segments(new ArrayList<>())
                                        .sessions(new ArrayList<>())
                                        .build();
                }

                material = materialRepository.save(material);
                List<TranscriptSegment> segmentEntities = persistTranscript(material, data);
                if (existingSystemMaterial == null && transcriptWriter == null) {
                        material.setSegments(segmentEntities);
                }
                return mapToDetailDto(material, segmentEntities);
        }

        /**
         * The ONE pipeline (rules 10 §BE): the owner's PC AI service — captions or local transcription, then WhisperX
         * acoustic alignment — followed by the backend timing gate. No VPS worker, no caption-page scrape, no paid ASR,
         * no fallback: anything else is a refusal or a 503 and nothing is stored.
         */
        private ImportedMaterialData fetchVerifiedTranscript(String videoId, String originalUrl) {
                ImportedMaterialData data = fetchViaAiService(videoId, originalUrl);
                if (data.segments.isEmpty()) {
                        log.error("Local pipeline returned no segments for videoId: {}", videoId);
                        throw new ResponseStatusException(
                                        HttpStatus.BAD_REQUEST,
                                        "Không thể trích xuất video YouTube. Vui lòng kiểm tra lại URL hợp lệ và video có sẵn phụ đề/âm thanh rõ ràng."
                        );
                }
                try {
                        ListeningTranscriptTimingGate.validate(data.alignment, data.durationSeconds,
                                        data.segments.stream()
                                                        .map(s -> new ListeningTranscriptTimingGate.Segment(s.startTimeMs, s.endTimeMs, s.words))
                                                        .toList());
                } catch (ListeningTranscriptTimingGate.Rejected e) {
                        log.warn("Import of videoId {} refused by the timing gate: {}", videoId, e.code);
                        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
                }
                return data;
        }

        @Transactional
        public ListeningMaterialDetailDto persistVerifiedJob(ImportListeningMaterialRequest request, Long userId, JsonNode result) {
                String videoId = extractYouTubeVideoId(request.getYoutubeUrl());
                ImportedMaterialData data = parseAiServiceResponse(result, videoId);
                if (data.segments.isEmpty()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Không có lời thoại phù hợp.");
                ListeningTranscriptTimingGate.validate(data.alignment, data.durationSeconds,
                        data.segments.stream().map(s -> new ListeningTranscriptTimingGate.Segment(s.startTimeMs, s.endTimeMs, s.words)).toList());
                return saveImportedMaterial(request, userId, false, videoId, "https://www.youtube.com/watch?v="+videoId, null, data);
        }

        private List<TranscriptSegment> persistTranscript(ListeningMaterial material, ImportedMaterialData data) {
                List<TranscriptSegment> segmentEntities = new ArrayList<>();
                for (int i = 0; i < data.segments.size(); i++) {
                        ImportedSegment seg = data.segments.get(i);
                        String wordsJson = null;
                        try {
                                wordsJson = objectMapper.writeValueAsString(seg.words);
                        } catch (Exception e) {
                                log.warn("Error serializing wordsJson: {}", e.getMessage());
                        }

                        TranscriptSegment segment = TranscriptSegment.builder()
                                        .listeningMaterial(material)
                                        .startTimeMs(seg.startTimeMs)
                                        .endTimeMs(seg.endTimeMs)
                                        .speakerName(seg.speakerName != null ? seg.speakerName : "Speaker")
                                        .text(seg.text)
                                        .wordsJson(wordsJson)
                                        .difficultyScore(1.0 + (i * 0.05))
                                        .build();
                        segmentEntities.add(segment);
                }

                if (transcriptWriter != null) {
                        long started = System.nanoTime();
                        transcriptWriter.write(material.getId(), segmentEntities);
                        log.info("listening_timing stage=persistence material={} segments={} elapsedMs={}",
                                        material.getId(), segmentEntities.size(), (System.nanoTime()-started)/1_000_000);
                        return segmentEntities;
                }
                segmentEntities = segmentRepository.saveAll(segmentEntities);

                // Automatically generate dictation exercises for all real segments (no 10-cap)
                for (int i = 0; i < segmentEntities.size(); i++) {
                        TranscriptSegment seg = segmentEntities.get(i);
                        ListeningExercise exercise = ListeningExercise.builder()
                                        .listeningMaterial(material)
                                        .transcriptSegment(seg)
                                        .exerciseType(ExerciseType.DICTATION)
                                        .questionText("Type the sentence exactly as spoken.")
                                        .expectedAnswer(seg.getText())
                                        .difficultyScore(seg.getDifficultyScore())
                                        .build();
                        exerciseRepository.save(exercise);
                }
                return segmentEntities;
        }

        @org.springframework.beans.factory.annotation.Autowired(required = false)
        private org.springframework.jdbc.core.JdbcTemplate jdbcTemplate;

        void setJdbcTemplate(org.springframework.jdbc.core.JdbcTemplate jdbcTemplate) {
                this.jdbcTemplate = jdbcTemplate;
        }

        /** Learner records that hang off a material's segments / exercises (a re-segmentation would detach them). */
        long countLearnerRecords(Long materialId) {
                if (jdbcTemplate == null) {
                        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Không kiểm tra được dữ liệu học tập của bài nghe.");
                }
                Long n = jdbcTemplate.queryForObject("""
                                SELECT (SELECT count(*) FROM exercise_attempts a JOIN listening_exercises e ON e.id = a.listening_exercise_id
                                         WHERE e.listening_material_id = ?)
                                     + (SELECT count(*) FROM listening_sessions WHERE listening_material_id = ?)
                                     + (SELECT count(*) FROM listening_checkpoints WHERE material_id = ?)
                                     + (SELECT count(*) FROM speaking_shadowing_units WHERE material_id = ?)
                                     + (SELECT count(*) FROM speaking_shadowing_attempts y JOIN transcript_segments t ON t.id = y.segment_id
                                         WHERE t.listening_material_id = ?)
                                """, Long.class, materialId, materialId, materialId, materialId, materialId);
                return n == null ? 0 : n;
        }

        /**
         * Repairs an EXISTING YouTube lesson whose transcript timing is invalid (rules 10 §BE): the same lesson id is
         * re-processed through the one authorized pipeline and gate, its segments / Dictation exercises are replaced and
         * its duration set to the real media duration. Refused (409) when learners already have attempts, sessions,
         * checkpoints or Shadowing records on it — progress is never deleted or re-attached to other sentences.
         * Curated fields (title, topic, level, accent, channel, owner, visibility) are kept.
         */
        @Override
        public ListeningMaterialDetailDto reprocessYouTubeMaterial(Long materialId) {
                // Phase 1 (short read TX): verify material exists, is a YouTube lesson, and has 0 learner records
                String videoId = inReadTx(() -> {
                        ListeningMaterial existing = materialRepository.findById(materialId)
                                        .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Không tìm thấy bài nghe."));
                        if ("DOCUMENT".equals(existing.getSourceType())) {
                                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Chỉ bài nghe nhập từ YouTube mới được xử lý lại.");
                        }
                        String vid = existing.getYoutubeVideoId();
                        if (vid == null || vid.isBlank()) {
                                vid = com.englishcoach.content.service.ContentServiceImpl.extractYouTubeVideoId(existing.getAudioUrl());
                        }
                        if (vid == null || !STRICT_YOUTUBE_VIDEO_ID.matcher(vid.trim()).matches()) {
                                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Bài nghe không gắn với video YouTube.");
                        }
                        vid = vid.trim();
                        long learnerRecords = countLearnerRecords(materialId);
                        if (learnerRecords > 0) {
                                log.warn("Reprocess of material {} refused: {} learner records attached", materialId, learnerRecords);
                                throw new ResponseStatusException(HttpStatus.CONFLICT,
                                                "Bài nghe đã có " + learnerRecords + " bản ghi học tập; không xử lý lại để không tách rời tiến độ của học viên.");
                        }
                        return vid;
                });

                log.info("Reprocessing YouTube listening material {} (videoId {}) through the local WhisperX pipeline", materialId, videoId);
                // External WhisperX HTTP + timing gate completely OUTSIDE any DB transaction
                ImportedMaterialData data = fetchVerifiedTranscript(videoId, "https://www.youtube.com/watch?v=" + videoId);

                // Phase 2 (short atomic commit TX): lock material row (PESSIMISTIC_WRITE), re-verify countLearnerRecords == 0,
                // replace segments + exercises atomically, evict shared cache AFTER_COMMIT, build DTO inside TX.
                return inTx(() -> {
                        ListeningMaterial material = lockMaterialById(materialId)
                                        .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Không tìm thấy bài nghe."));
                        long recheckedLearnerRecords = countLearnerRecords(materialId);
                        if (recheckedLearnerRecords > 0) {
                                log.warn("Reprocess of material {} refused under lock: {} learner records attached", materialId, recheckedLearnerRecords);
                                throw new ResponseStatusException(HttpStatus.CONFLICT,
                                                "Bài nghe đã có " + recheckedLearnerRecords + " bản ghi học tập; không xử lý lại để không tách rời tiến độ của học viên.");
                        }

                        exerciseRepository.deleteByListeningMaterialId(materialId);
                        segmentRepository.deleteByListeningMaterialId(materialId);
                        material.setDurationSeconds(data.durationSeconds);
                        material = materialRepository.save(material);
                        List<TranscriptSegment> segmentEntities = persistTranscript(material, data);
                        if (material.isSystem()) {
                                evictSharedCacheAfterCommit(materialId);
                        }
                        return mapToDetailDto(material, segmentEntities);
                });
        }

        private static final Pattern STRICT_YOUTUBE_VIDEO_ID = Pattern.compile("^[A-Za-z0-9_-]{11}$");
        private static final Pattern YOUTUBE_URL_ID_PATTERN = Pattern.compile(
                        "^(?:https?://)?(?:(?:www|m|music)\\.)?(?:youtube(?:-nocookie)?\\.com/(?:(?:v|e(?:mbed)?|shorts|live)/|watch\\?(?:[^#\\s]*&)?v=)|youtu\\.be/)([A-Za-z0-9_-]{11})(?:[?&#/]|$)",
                        Pattern.CASE_INSENSITIVE
        );

        public static String extractYouTubeVideoId(String url) {
                if (url == null || url.isBlank()) {
                        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid YouTube URL or video ID");
                }
                String cleanUrl = url.trim();
                if (STRICT_YOUTUBE_VIDEO_ID.matcher(cleanUrl).matches()) {
                        return cleanUrl;
                }
                Matcher matcher = YOUTUBE_URL_ID_PATTERN.matcher(cleanUrl);
                if (matcher.find()) {
                        String candidate = matcher.group(1);
                        if (STRICT_YOUTUBE_VIDEO_ID.matcher(candidate).matches()) {
                                return candidate;
                        }
                }
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid YouTube URL or video ID");
        }

        private static class ImportedSegment {
                int startTimeMs;
                int endTimeMs;
                String speakerName;
                String text;
                List<WordTimestampDto> words = new ArrayList<>();
        }

        private static class ImportedMaterialData {
                String title;
                int durationSeconds;
                String thumbnail;
                String channel;
                /** Origin of the word timing reported by the AI service (must be WhisperX). */
                String alignment;
                List<ImportedSegment> segments = new ArrayList<>();
        }

        static final String LOCAL_PIPELINE_UNAVAILABLE =
                        "Dịch vụ xử lý âm thanh cục bộ (WhisperX) đang tạm thời không khả dụng. Bài nghe chưa được tạo — vui lòng thử lại sau.";
        static final String LOCAL_PIPELINE_TOO_SLOW =
                        "Máy xử lý WhisperX chưa hoàn tất kịp thời (video quá dài hoặc máy đang bận). Bài nghe chưa được tạo — vui lòng thử lại sau hoặc chọn video ngắn hơn.";

        /**
         * The ONLY extraction path: the AI service on the owner's PC (/api/v1/listening/process-youtube).
         * Never returns null and never falls back: 4xx = definitive refusal for the learner (400 with the AI
         * service's own message); 5xx, network failure or timeout = the local pipeline is unavailable (503).
         */
        private ImportedMaterialData fetchViaAiService(String videoId, String originalUrl) {
                String baseUrl = (aiBaseUrl != null && !aiBaseUrl.isBlank())
                                ? aiBaseUrl.replaceAll("/+$", "") : "http://localhost:8000";
                String endpoint = baseUrl + "/api/v1/listening/process-youtube";

                SimpleClientHttpRequestFactory factory = new com.englishcoach.common.ai.AiServiceRequestFactory();
                factory.setConnectTimeout(aiConnectTimeout > 0 ? aiConnectTimeout : 10000);
                factory.setReadTimeout(listeningImportReadTimeout > 0 ? listeningImportReadTimeout : 90000);
                RestTemplate client = (this.restTemplate != null) ? this.restTemplate : new RestTemplate(factory);

                HttpHeaders headers = new HttpHeaders();
                headers.setContentType(MediaType.APPLICATION_JSON);

                // Send canonical YouTube URL and validated 11-character videoId only
                Map<String, String> body = Map.of(
                                "youtubeUrl", "https://www.youtube.com/watch?v=" + videoId,
                                "videoId", videoId
                );
                HttpEntity<Map<String, String>> requestEntity = new HttpEntity<>(body, headers);

                JsonNode root;
                try {
                        long started = System.nanoTime();
                        ResponseEntity<JsonNode> response = client.postForEntity(endpoint, requestEntity, JsonNode.class);
                        log.info("listening_timing stage=gpu_request video={} elapsedMs={}", videoId, (System.nanoTime()-started)/1_000_000);
                        root = response.getBody();
                } catch (HttpClientErrorException e) {
                        // 4xx from AI service = definitive user-facing error; propagate directly
                        String aiDetail = aiErrorDetail(e.getResponseBodyAsString());
                        log.warn("AI service returned {} for videoId {}: {}", e.getStatusCode(), videoId, aiDetail);
                        throw new ResponseStatusException(
                                        HttpStatus.BAD_REQUEST,
                                        aiDetail.isBlank() ? "Không thể trích xuất video YouTube. Vui lòng kiểm tra lại URL." : aiDetail
                        );
                } catch (HttpServerErrorException e) {
                        // 5xx: the local pipeline (or YouTube's answer to it) is unavailable — fail closed
                        String aiDetail = aiErrorDetail(e.getResponseBodyAsString());
                        log.warn("AI service returned {} for videoId {}: {}", e.getStatusCode(), videoId, aiDetail);
                        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                                        aiDetail.isBlank() ? LOCAL_PIPELINE_UNAVAILABLE : aiDetail);
                } catch (ResourceAccessException e) {
                        boolean timedOut = String.valueOf(e.getMessage()).toLowerCase().contains("read timed out");
                        log.warn("AI service unreachable for videoId {}: {}", videoId, e.getMessage());
                        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                                        timedOut ? LOCAL_PIPELINE_TOO_SLOW : LOCAL_PIPELINE_UNAVAILABLE);
                } catch (Exception e) {
                        log.warn("Unexpected error calling AI service for videoId {}: {}", videoId, e.getMessage());
                        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, LOCAL_PIPELINE_UNAVAILABLE);
                }
                if (root == null) {
                        log.warn("AI service returned empty body for videoId: {}", videoId);
                        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, LOCAL_PIPELINE_UNAVAILABLE);
                }
                return parseAiServiceResponse(root, videoId);
        }

        private String aiErrorDetail(String body) {
                if (body == null || body.isBlank()) return "";
                try {
                        JsonNode err = objectMapper.readTree(body);
                        return err.has("detail") && err.get("detail").isTextual() ? err.get("detail").asText() : "";
                } catch (Exception ignored) {
                        return "";
                }
        }

        private static Double wordTime(JsonNode wNode, String key) {
                JsonNode v = wNode.get(key);
                return v != null && v.isNumber() ? v.asDouble() : null;
        }

        private ImportedMaterialData parseAiServiceResponse(JsonNode root, String videoId) {
                ImportedMaterialData data = new ImportedMaterialData();
                data.title = root.has("title") ? root.get("title").asText() : "YouTube Audio: " + videoId;
                data.durationSeconds = root.path("durationSeconds").asInt(0);
                data.alignment = root.path("timing").path("alignment").asText(null);
                data.thumbnail = root.has("thumbnailUrl") ? root.get("thumbnailUrl").asText() 
                                : (root.has("thumbnail") ? root.get("thumbnail").asText() : "https://img.youtube.com/vi/" + videoId + "/hqdefault.jpg");
                data.channel = root.has("channel") ? root.get("channel").asText() : null;

                if (root.has("segments") && root.get("segments").isArray()) {
                        for (JsonNode segNode : root.get("segments")) {
                                ImportedSegment seg = new ImportedSegment();
                                seg.startTimeMs = segNode.has("startTimeMs") ? segNode.get("startTimeMs").asInt() : 0;
                                seg.endTimeMs = segNode.has("endTimeMs") ? segNode.get("endTimeMs").asInt() : 0;
                                seg.speakerName = segNode.has("speakerName") ? segNode.get("speakerName").asText() : "Speaker";
                                seg.text = segNode.has("text") ? segNode.get("text").asText() : "";
                                if (segNode.has("words") && segNode.get("words").isArray()) {
                                        for (JsonNode wNode : segNode.get("words")) {
                                                // An unaligned word stays untimed (null): never 0.0, never invented
                                                seg.words.add(WordTimestampDto.builder()
                                                                .word(wNode.has("word") ? wNode.get("word").asText() : "")
                                                                .start(wordTime(wNode, "start"))
                                                                .end(wordTime(wNode, "end"))
                                                                .build());
                                        }
                                }
                                if (!seg.text.isBlank()) {
                                        data.segments.add(seg);
                                }
                        }
                }
                return data;
        }

        /**
         * Display form of stored words. A word WhisperX could not time is stored with null bounds; it is sent as a
         * zero-length marker at its neighbour's acoustic boundary, so it is never highlighted (start == end), the
         * player's ordered lookup stays valid and a click seeks to where the sentence's speech is. Nothing is
         * interpolated and no duration is invented.
         */
        static List<WordTimestampDto> displayWords(List<WordTimestampDto> stored, Integer segmentStartMs) {
                if (stored == null || stored.isEmpty()) return stored;
                Double firstTimed = null;
                for (WordTimestampDto w : stored) {
                        if (w.getStart() != null && w.getEnd() != null) {
                                firstTimed = w.getStart();
                                break;
                        }
                }
                double cursor = firstTimed != null ? firstTimed : (segmentStartMs != null ? segmentStartMs / 1000.0 : 0.0);
                List<WordTimestampDto> out = new ArrayList<>(stored.size());
                for (WordTimestampDto w : stored) {
                        if (w.getStart() != null && w.getEnd() != null) {
                                out.add(w);
                                cursor = w.getEnd();
                        } else {
                                out.add(WordTimestampDto.builder().word(w.getWord()).start(cursor).end(cursor).build());
                        }
                }
                return out;
        }

        @org.springframework.beans.factory.annotation.Autowired(required = false)
        private ListeningDocumentService documentService;

        private ListeningMaterialSummaryDto mapToSummaryDto(ListeningMaterial material) {
                return ListeningMaterialSummaryDto.builder()
                                .id(material.getId())
                                .title(material.getTitle())
                                .audioUrl(material.getAudioUrl())
                                .sourceType(material.getSourceType())
                                .voiceId(material.getVoiceId())
                                .durationSeconds(material.getDurationSeconds())
                                .cefrLevel(material.getCefrLevel())
                                .topic(material.getTopic())
                                .accent(material.getAccent())
                                .speakerCount(material.getSpeakerCount())
                                .ownerUserId(material.getOwnerUserId())
                                .isSystem(material.isSystem())
                                .build();
        }

        private ListeningMaterialDetailDto mapToDetailDto(ListeningMaterial material,
                        List<TranscriptSegment> segments) {
                List<TranscriptSegmentDto> segmentDtos = segments.stream().map(s -> {
                        List<WordTimestampDto> words = null;
                        if (s.getWordsJson() != null && !s.getWordsJson().isBlank()) {
                                try {
                                        words = objectMapper.readValue(s.getWordsJson(), new TypeReference<List<WordTimestampDto>>() {});
                                } catch (Exception e) {
                                        log.warn("Failed to parse wordsJson for segment {}: {}", s.getId(), e.getMessage());
                                }
                        }
                        // No stored words: the transcript renders the sentence untimed (never an even split).
                        words = displayWords(words, s.getStartTimeMs());

                        return TranscriptSegmentDto.builder()
                                        .id(s.getId())
                                        .startTimeMs(s.getStartTimeMs())
                                        .endTimeMs(s.getEndTimeMs())
                                        .speakerName(s.getSpeakerName())
                                        .text(s.getText())
                                        .difficultyScore(s.getDifficultyScore())
                                        .words(words)
                                        .build();
                }).collect(Collectors.toList());

                String videoId = material.getYoutubeVideoId();
                if ((videoId == null || videoId.isBlank()) && !"DOCUMENT".equals(material.getSourceType())) {
                        videoId = com.englishcoach.content.service.ContentServiceImpl.extractYouTubeVideoId(material.getAudioUrl());
                }
                String thumb = material.getThumbnail();
                if ((thumb == null || thumb.isBlank()) && videoId != null) {
                        thumb = "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg";
                }
                boolean hasTranscript = segments != null && !segments.isEmpty();
                long exerciseCount = exerciseRepository.countDictationExercisesByMaterialId(material.getId());
                boolean practiceAvailable = hasTranscript && exerciseCount > 0;

                return ListeningMaterialDetailDto.builder()
                                .id(material.getId())
                                .title(material.getTitle())
                                .channel(material.getChannel() != null && !material.getChannel().isBlank() ? material.getChannel() : "English Coach Studio")
                                .thumbnail(thumb)
                                .youtubeVideoId(videoId)
                                .hasTranscript(hasTranscript)
                                .practiceAvailable(practiceAvailable)
                                .audioUrl(material.getAudioUrl())
                                .sourceType(material.getSourceType())
                                .voiceId(material.getVoiceId())
                                .durationSeconds(material.getDurationSeconds())
                                .cefrLevel(material.getCefrLevel())
                                .topic(material.getTopic())
                                .accent(material.getAccent())
                                .speakerCount(material.getSpeakerCount())
                                .speechRate(material.getSpeechRate())
                                .backgroundNoiseLevel(material.getBackgroundNoiseLevel())
                                .vocabularyDifficulty(material.getVocabularyDifficulty())
                                .connectedSpeechDifficulty(material.getConnectedSpeechDifficulty())
                                .inferenceDifficulty(material.getInferenceDifficulty())
                                .segments(segmentDtos)
                                .build();
        }

        @Override
        @Transactional
        public List<ListeningExerciseDto> getExercisesForMaterial(Long materialId, Long userId) {
                ListeningMaterial material = materialRepository.findByIdAndVisibleToUser(materialId, userId)
                                .orElseThrow(() -> new org.springframework.web.server.ResponseStatusException(
                                                org.springframework.http.HttpStatus.NOT_FOUND,
                                                "Listening material not found with id: " + materialId
                                ));
                List<TranscriptSegment> segments = segmentRepository.findByListeningMaterialIdOrderByStartTimeMsAsc(materialId);
                List<ListeningExercise> exercises = new ArrayList<>(exerciseRepository.findByListeningMaterialId(materialId));

                // Idempotent backfill: If material has transcript segments without dictation exercises, create them
                boolean backfilled = false;
                if (!segments.isEmpty()) {
                        Set<Long> existingSegmentIds = exercises.stream()
                                        .map(ex -> ex.getTranscriptSegment() != null ? ex.getTranscriptSegment().getId() : null)
                                        .filter(Objects::nonNull)
                                        .collect(Collectors.toSet());

                        for (TranscriptSegment seg : segments) {
                                if (!existingSegmentIds.contains(seg.getId())) {
                                        ListeningExercise newEx = ListeningExercise.builder()
                                                        .listeningMaterial(material)
                                                        .transcriptSegment(seg)
                                                        .exerciseType(ExerciseType.DICTATION)
                                                        .questionText("Type the sentence exactly as spoken.")
                                                        .expectedAnswer(seg.getText())
                                                        .difficultyScore(seg.getDifficultyScore())
                                                        .build();
                                        exercises.add(exerciseRepository.save(newEx));
                                        backfilled = true;
                                }
                        }
                }
                if (backfilled && material.isSystem() && material.getOwnerUserId() == null) {
                        evictSharedCacheAfterCommit(materialId);
                }

                // Strictly sort exercises chronologically by segment start time
                exercises.sort(Comparator.comparingInt(ex -> ex.getTranscriptSegment() != null ? ex.getTranscriptSegment().getStartTimeMs() : 0));

                return exercises.stream().map(ex -> ListeningExerciseDto.builder()
                                .id(ex.getId())
                                .listeningMaterialId(ex.getListeningMaterial().getId())
                                .transcriptSegmentId(
                                                ex.getTranscriptSegment() != null ? ex.getTranscriptSegment().getId()
                                                                : null)
                                .exerciseType(ex.getExerciseType())
                                .questionText(ex.getQuestionText())
                                .difficultyScore(ex.getDifficultyScore())
                                .build()).collect(Collectors.toList());
        }

        @Override
        @Transactional
        public List<ListeningExerciseDto> getExercisesForMaterial(Long materialId) {
                return getExercisesForMaterial(materialId, null);
        }

        @Override
        @Transactional
        public ExerciseAttemptResponse submitExerciseAttempt(Long exerciseId, ExerciseAttemptRequest request) {
                return submitExerciseAttempt(exerciseId, request, null);
        }

        @Override
        @Transactional
        public ExerciseAttemptResponse submitExerciseAttempt(Long exerciseId, ExerciseAttemptRequest request, Long userId) {
                ListeningExercise exercise = exerciseRepository.findById(exerciseId)
                                .orElseThrow(() -> new RuntimeException("Exercise not found"));
                
                materialRepository.findByIdAndVisibleToUser(exercise.getListeningMaterial().getId(), userId)
                                .orElseThrow(() -> new org.springframework.web.server.ResponseStatusException(
                                                org.springframework.http.HttpStatus.NOT_FOUND,
                                                "Listening material not found"
                                ));

                com.englishcoach.auth.entity.User user = userId != null ? userRepository.findById(userId).orElse(null) : null;
                ListeningSession session = null;
                if (request.getListeningSessionId() != null) {
                        session = sessionRepository.forUpdate(request.getListeningSessionId()).orElse(null);
                        if (session != null && session.getUser() != null && userId != null && !session.getUser().getId().equals(userId)) {
                                throw new org.springframework.security.access.AccessDeniedException("Unauthorized: listening session belongs to another user");
                        }
                        if (session != null && !session.getListeningMaterial().getId().equals(exercise.getListeningMaterial().getId())) {
                                throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.BAD_REQUEST,
                                                "Listening session belongs to another material");
                        }
                        // Do not reuse an already ended/completed session for a new run
                        if (session != null && session.isClosed()) {
                                session = null;
                        }
                }
                if (session == null) {
                        session = sessionRepository.save(ListeningSession.builder()
                                        .user(user)
                                        .listeningMaterial(exercise.getListeningMaterial())
                                        .startedAt(java.time.LocalDateTime.now())
                                        .playbackSpeedUsed(1.0)
                                        .build());
                } else if (session.getUser() == null && user != null) {
                        session.setUser(user);
                        sessionRepository.save(session);
                }

                DictationScoringService.ScoringResult result = scoringService.scoreDictation(request.getRawUserAnswer(),
                                exercise.getExpectedAnswer());

                ExerciseAttempt attempt = ExerciseAttempt.builder()
                                .listeningSession(session)
                                .listeningExercise(exercise)
                                .rawUserAnswer(request.getRawUserAnswer())
                                .isCorrect(result.isCorrect)
                                .accuracyPercentage(result.accuracyPercentage)
                                .primaryErrorCategory(result.primaryErrorCategory)
                                .build();

                attempt = attemptRepository.save(attempt);
                if (eventPublisher != null) eventPublisher.publishEvent(new com.englishcoach.common.event.DictationAttemptSubmittedEvent(userId, attempt.getId(), exerciseId, exercise.getListeningMaterial().getId(), session.getId(), exercise.getListeningMaterial().getCefrLevel(), attempt.getAccuracyPercentage(), attempt.getIsCorrect(), java.time.Instant.now()));

                // Check if all eligible questions for this material have been completed in this session
                finishIfComplete(session);

                com.englishcoach.listening.dto.AiDiagnosticResponse aiDiag = diagnosticAgentService
                                .analyzeListeningFailure(attempt);
                if (aiDiag != null) {
                        try {
                                attempt.setDiagnosticFeedback(objectMapper.writeValueAsString(aiDiag));
                                attemptRepository.save(attempt);
                        } catch (Exception e) {
                        }
                }

                return ExerciseAttemptResponse.builder()
                                .id(attempt.getId())
                                .listeningSessionId(session.getId())
                                .isCorrect(attempt.getIsCorrect())
                                .accuracyPercentage(attempt.getAccuracyPercentage())
                                .primaryErrorCategory(attempt.getPrimaryErrorCategory())
                                .expectedAnswer(exercise.getExpectedAnswer())
                                .rawUserAnswer(attempt.getRawUserAnswer())
                                .diagnosticFeedback(aiDiag)
                                .build();
        }

        @Override
        @Transactional
        public void completeSession(Long sessionId, Long userId) {
                ListeningSession session = sessionRepository.forUpdate(sessionId)
                                .filter(s -> s.getUser() != null && s.getUser().getId().equals(userId))
                                .orElseThrow(() -> new org.springframework.web.server.ResponseStatusException(
                                                org.springframework.http.HttpStatus.NOT_FOUND, "Listening session not found"));
                if (!session.isClosed() && !finishIfComplete(session)) {
                        session.setClosedEarlyAt(java.time.LocalDateTime.now());
                        sessionRepository.save(session);
                }
        }

        private boolean finishIfComplete(ListeningSession session) {
                Long materialId = session.getListeningMaterial().getId();
                long total = exerciseRepository.countDictationExercisesByMaterialId(materialId);
                if (total == 0) total = exerciseRepository.findByListeningMaterialId(materialId).size();
                if (total == 0 || attemptRepository.countDistinctExercisesAttemptedBySessionId(session.getId()) < total) {
                        return false;
                }
                session.setEndedAt(java.time.LocalDateTime.now());
                sessionRepository.save(session);
                if (session.getUser() != null) {
                        analyticsService.recalculateUserProfileFromCompletedSessions(session.getUser().getId());
                }
                return true;
        }

        @Override
        @Transactional
        public void deleteMaterial(Long id, Long userId) {
                log.info("Deleting listening material with id: {} by userId: {}", id, userId);
                ListeningMaterial material = materialRepository.findById(id)
                                .orElseThrow(() -> new org.springframework.web.server.ResponseStatusException(
                                                org.springframework.http.HttpStatus.NOT_FOUND,
                                                "Listening material not found with id: " + id
                                ));

                boolean isAdmin = isOfficialAdmin(userId);

                if (!isAdmin && (material.getOwnerUserId() == null || !material.getOwnerUserId().equals(userId))) {
                        throw new org.springframework.web.server.ResponseStatusException(
                                        org.springframework.http.HttpStatus.NOT_FOUND,
                                        "Listening material not found with id: " + id
                        );
                }

                if (material.isSystem() && !isAdmin) {
                        throw new org.springframework.web.server.ResponseStatusException(
                                        org.springframework.http.HttpStatus.NOT_FOUND,
                                        "Listening material not found with id: " + id
                        );
                }

                if (documentService != null && "DOCUMENT".equals(material.getSourceType())) documentService.deleteAudioAfterCommit(id);

                // 1. Delete speaking shadowing attempts referencing units or segments of this material
                speakingShadowingAttemptRepository.deleteByMaterialId(id);

                // 2. Delete speaking shadowing units of this material
                speakingShadowingUnitRepository.deleteByMaterialId(id);

                // 3. Delete listening exercise attempts
                attemptRepository.deleteByListeningMaterialId(id);

                // 4. Delete listening exercises
                exerciseRepository.deleteByListeningMaterialId(id);

                // 5. Delete listening sessions
                sessionRepository.deleteByListeningMaterialId(id);

                // 6. Delete transcript segments
                segmentRepository.deleteByListeningMaterialId(id);

                // 7. Delete listening material directly via native query without triggering lazy collection loading
                materialRepository.deleteByIdNative(id);
                if (material.isSystem()) {
                        evictSharedCacheAfterCommit(id);
                }
                log.info("Successfully deleted listening material with id: {}", id);
        }

        @Override
        @Transactional
        public void deleteMaterial(Long id) {
                deleteMaterial(id, null);
        }
}

