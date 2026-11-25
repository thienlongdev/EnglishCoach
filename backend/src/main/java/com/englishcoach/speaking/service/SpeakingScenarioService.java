package com.englishcoach.speaking.service;

import com.englishcoach.speaking.dto.*;
import com.englishcoach.speaking.entity.SpeakingScenario;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.speaking.entity.SpeakingTurnFeedback;
import com.englishcoach.speaking.entity.enums.CefrLevel;
import com.englishcoach.speaking.entity.enums.ScenarioCategory;
import com.englishcoach.speaking.repository.SpeakingScenarioRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.util.*;

@Service
@RequiredArgsConstructor
@Slf4j
public class SpeakingScenarioService {

    private static final int MAX_TOPIC_LENGTH = 200;
    private static final int MAX_CONTEXT_LENGTH = 1000;
    private static final int MAX_ROLE_LENGTH = 120;
    private static final int MAX_MISSION_LENGTH = 500;
    private static final int MAX_TARGET_VOCAB_ITEMS = 30;
    private static final int MAX_TARGET_VOCAB_ITEM_LENGTH = 80;

    private final SpeakingScenarioRepository speakingScenarioRepository;
    private final com.englishcoach.speaking.repository.SpeakingSessionRepository speakingSessionRepository;
    private final com.englishcoach.speaking.repository.SpeakingTurnRepository speakingTurnRepository;
    private final com.englishcoach.speaking.repository.SpeakingTurnFeedbackRepository speakingTurnFeedbackRepository;
    private final com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository speakingShadowingAttemptRepository;
    private final SpeakingAudioStorageService speakingAudioStorageService;

    @Autowired(required = false)
    private PlatformTransactionManager transactionManager;

    private <T> T inTx(java.util.function.Supplier<T> work) {
        if (transactionManager == null) return work.get();
        return new TransactionTemplate(transactionManager).execute(s -> work.get());
    }

    @Value("${ai.base-url:http://localhost:8000}")
    private String aiBaseUrl;

    @Value("${ai.timeout.connect:10000}")
    private int connectTimeoutMs;

    @Value("${ai.timeout.read:45000}")
    private int readTimeoutMs;

    private RestTemplate createRestTemplateWithTimeout() {
        SimpleClientHttpRequestFactory factory = new com.englishcoach.common.ai.AiServiceRequestFactory();
        factory.setConnectTimeout(connectTimeoutMs);
        factory.setReadTimeout(readTimeoutMs);
        return new RestTemplate(factory);
    }

    @Transactional(readOnly = true)
    public List<SpeakingScenarioSummaryDto> getScenarios(CefrLevel cefrLevel, ScenarioCategory category) {
        List<SpeakingScenario> scenarios = speakingScenarioRepository.findByFilters(cefrLevel, category);
        return scenarios.stream()
                .map(SpeakingScenarioSummaryDto::fromEntity)
                .toList();
    }

    @Transactional(readOnly = true)
    public List<SpeakingScenarioSummaryDto> getScenarios(Long userId, CefrLevel cefrLevel, ScenarioCategory category) {
        List<SpeakingScenario> scenarios = speakingScenarioRepository.findByFilters(userId, cefrLevel, category);
        return scenarios.stream()
                .map(SpeakingScenarioSummaryDto::fromEntity)
                .toList();
    }

    @Transactional(readOnly = true)
    public ScenarioCatalogMetadataDto getCatalogMetadata(Long userId) {
        List<Object[]> levelCounts = speakingScenarioRepository.countByCefrLevel(userId);
        List<ScenarioCatalogMetadataDto.CefrLevelCountDto> availableLevels = new ArrayList<>();
        for (Object[] row : levelCounts) {
            if (row[0] != null) {
                String lvl = ((CefrLevel) row[0]).name();
                long count = ((Number) row[1]).longValue();
                availableLevels.add(new ScenarioCatalogMetadataDto.CefrLevelCountDto(lvl, count));
            }
        }
        // Sort CEFR standard order
        List<String> order = List.of("A1", "A2", "B1", "B2", "C1", "C2");
        availableLevels.sort(Comparator.comparingInt(a -> {
            int idx = order.indexOf(a.level());
            return idx != -1 ? idx : 99;
        }));

        List<Object[]> categoryCounts = speakingScenarioRepository.countByCategory(userId);
        List<ScenarioCatalogMetadataDto.CategoryCountDto> availableCategories = new ArrayList<>();
        for (Object[] row : categoryCounts) {
            if (row[0] != null) {
                ScenarioCategory cat = (ScenarioCategory) row[0];
                long count = ((Number) row[1]).longValue();
                String displayName = getCategoryDisplayName(cat);
                availableCategories.add(new ScenarioCatalogMetadataDto.CategoryCountDto(cat.name(), displayName, count));
            }
        }

        long total = speakingScenarioRepository.countVisibleScenarios(userId);
        return new ScenarioCatalogMetadataDto(availableLevels, availableCategories, total);
    }

    private String getCategoryDisplayName(ScenarioCategory cat) {
        if (cat == null) return "Chủ đề khác";
        return switch (cat) {
            case TRAVEL -> "Du lịch và Khách sạn";
            case DAILY_LIFE -> "Đời sống hàng ngày";
            case BUSINESS -> "Kinh doanh và Phỏng vấn";
            case WORK -> "Công sở và Đồng nghiệp";
            case ACADEMIC -> "Học thuật và Trường học";
            case CASUAL -> "Giao tiếp bạn bè";
        };
    }

    @Transactional(readOnly = true)
    public SpeakingScenarioDto getScenarioById(Long userId, Long id) {
        SpeakingScenario scenario = speakingScenarioRepository.findByIdAndAccessible(id, userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking scenario not found with id: " + id));

        // Safely trigger collection loading within the read-only transaction boundary
        if (scenario.getTargetVocabulary() != null) scenario.getTargetVocabulary().size();
        if (scenario.getTargetGrammar() != null) scenario.getTargetGrammar().size();
        if (scenario.getSuccessCriteria() != null) scenario.getSuccessCriteria().size();
        if (scenario.getOptionalHints() != null) scenario.getOptionalHints().size();

        return SpeakingScenarioDto.fromEntity(scenario);
    }

    @Transactional(readOnly = true)
    public SpeakingScenarioDto getScenarioById(Long id) {
        return getScenarioById(null, id);
    }

    private List<String> validateCustomScenarioRequest(CreateCustomScenarioRequestDto req, boolean requireAllMandatory) {
        if (req == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Request payload is required");
        }
        if (requireAllMandatory && (req.topic() == null || req.topic().trim().isBlank())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Topic is required");
        }
        if (req.topic() != null && req.topic().trim().length() > MAX_TOPIC_LENGTH) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Topic must not exceed " + MAX_TOPIC_LENGTH + " characters");
        }
        if (req.context() != null && req.context().trim().length() > MAX_CONTEXT_LENGTH) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Context must not exceed " + MAX_CONTEXT_LENGTH + " characters");
        }
        if (requireAllMandatory && (req.learnerRole() == null || req.learnerRole().trim().isBlank())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Learner role is required");
        }
        if (req.learnerRole() != null && req.learnerRole().trim().length() > MAX_ROLE_LENGTH) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Learner role must not exceed " + MAX_ROLE_LENGTH + " characters");
        }
        if (requireAllMandatory && (req.aiRole() == null || req.aiRole().trim().isBlank())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "AI role is required");
        }
        if (req.aiRole() != null && req.aiRole().trim().length() > MAX_ROLE_LENGTH) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "AI role must not exceed " + MAX_ROLE_LENGTH + " characters");
        }
        if (requireAllMandatory && (req.mission() == null || req.mission().trim().isBlank())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Mission goal is required");
        }
        if (req.mission() != null && req.mission().trim().length() > MAX_MISSION_LENGTH) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Mission goal must not exceed " + MAX_MISSION_LENGTH + " characters");
        }
        if (req.cefrLevel() != null && !req.cefrLevel().trim().isBlank()) {
            try {
                CefrLevel.fromString(req.cefrLevel());
            } catch (IllegalArgumentException e) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid CEFR level");
            }
        }
        if (req.estimatedDuration() != null && req.estimatedDuration().trim().length() > 50) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Estimated duration must not exceed 50 characters");
        }
        if (req.voiceId() != null && req.voiceId().trim().length() > 50) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Voice ID must not exceed 50 characters");
        }
        if (req.targetVocabulary() != null) {
            if (req.targetVocabulary().size() > MAX_TARGET_VOCAB_ITEMS) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Target vocabulary must not exceed " + MAX_TARGET_VOCAB_ITEMS + " items");
            }
            List<String> sanitizedVocab = new ArrayList<>();
            for (String item : req.targetVocabulary()) {
                if (item == null) continue;
                String trimmed = item.trim();
                if (trimmed.isEmpty()) continue;
                if (trimmed.length() > MAX_TARGET_VOCAB_ITEM_LENGTH) {
                    throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Each target vocabulary item must not exceed " + MAX_TARGET_VOCAB_ITEM_LENGTH + " characters");
                }
                sanitizedVocab.add(trimmed);
            }
            return sanitizedVocab;
        }
        return null;
    }

    @Transactional
    public SpeakingScenarioDto updateCustomScenario(Long userId, Long id, CreateCustomScenarioRequestDto req) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required to update custom scenario");
        }
        List<String> sanitizedVocab = validateCustomScenarioRequest(req, false);
        SpeakingScenario scenario = speakingScenarioRepository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking scenario not found with id: " + id));

        if (Boolean.TRUE.equals(scenario.getIsSystem()) || scenario.getOwnerUserId() == null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Cannot update system scenario");
        }
        if (!scenario.getOwnerUserId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking scenario not found with id: " + id);
        }

        if (req.topic() != null && !req.topic().trim().isBlank()) {
            scenario.setTitle(req.topic().trim());
        }
        if (req.context() != null) {
            scenario.setDescription(req.context().trim());
        }
        if (req.learnerRole() != null && !req.learnerRole().trim().isBlank()) {
            scenario.setLearnerRole(req.learnerRole().trim());
        }
        if (req.aiRole() != null && !req.aiRole().trim().isBlank()) {
            scenario.setAiRole(req.aiRole().trim());
        }
        if (req.mission() != null && !req.mission().trim().isBlank()) {
            scenario.setLearnerGoal(req.mission().trim());
        }
        if (req.cefrLevel() != null && !req.cefrLevel().trim().isBlank()) {
            CefrLevel lvl = CefrLevel.fromString(req.cefrLevel());
            if (lvl != null) scenario.setCefrLevel(lvl);
        }
        if (sanitizedVocab != null) {
            scenario.setTargetVocabulary(new ArrayList<>(sanitizedVocab));
        }
        if (req.voiceId() != null && !req.voiceId().trim().isBlank()) {
            String v = req.voiceId().trim().toLowerCase();
            if (List.of("us_male", "us_female", "uk_male", "uk_female").contains(v)) {
                scenario.setDefaultVoiceId(v);
            }
        }
        SpeakingScenario updated = speakingScenarioRepository.save(scenario);
        log.info("Updated custom scenario id={} by owner userId={}", id, userId);
        return SpeakingScenarioDto.fromEntity(updated);
    }

    @Transactional
    public void deleteCustomScenario(Long userId, Long id) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Authentication required to delete custom scenario");
        }
        SpeakingScenario scenario = speakingScenarioRepository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking scenario not found with id: " + id));

        if (Boolean.TRUE.equals(scenario.getIsSystem()) || scenario.getOwnerUserId() == null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Cannot delete system scenario");
        }
        if (!scenario.getOwnerUserId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking scenario not found with id: " + id);
        }

        // 1. Transactionally find and remove all sessions belonging to this scenario
        List<SpeakingSession> sessions = speakingSessionRepository.findByScenarioId(scenario.getId());
        if (sessions != null && !sessions.isEmpty()) {
            List<Long> sessionIds = sessions.stream().map(SpeakingSession::getId).toList();

            // 1a. Clean up any shadowing attempts if any session had attempts
            for (Long sessionId : sessionIds) {
                var attempts = speakingShadowingAttemptRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
                if (attempts != null && !attempts.isEmpty()) {
                    for (var attempt : attempts) {
                        if (attempt.getClientAttemptId() != null) {
                            String audioRef = userId + "/" + speakingAudioStorageService.sanitizeIdentifier(attempt.getClientAttemptId()) + ".bin";
                            speakingAudioStorageService.deleteAttemptAudioByRef(audioRef);
                        }
                    }
                    speakingShadowingAttemptRepository.deleteAll(attempts);
                }
            }

            // 1b. Clean up turns and their turn feedbacks
            List<SpeakingTurn> turns = speakingTurnRepository.findBySessionIdIn(sessionIds);
            if (turns != null && !turns.isEmpty()) {
                // Delete turn audio files on disk
                for (SpeakingTurn turn : turns) {
                    if (turn.getAudioRef() != null && !turn.getAudioRef().isBlank()) {
                        speakingAudioStorageService.deleteAttemptAudioByRef(turn.getAudioRef());
                    }
                }

                List<Long> turnIds = turns.stream().map(SpeakingTurn::getId).toList();
                List<SpeakingTurnFeedback> feedbacks = speakingTurnFeedbackRepository.findByTurnIdIn(turnIds);
                if (feedbacks != null && !feedbacks.isEmpty()) {
                    speakingTurnFeedbackRepository.deleteAll(feedbacks);
                }

                speakingTurnRepository.deleteAll(turns);
            }

            speakingSessionRepository.deleteAll(sessions);
            log.info("Deleted {} practice sessions and associated turns/feedbacks/audio for custom scenario id={}", sessions.size(), id);
        }

        speakingScenarioRepository.delete(scenario);
        log.info("Deleted custom scenario id={} by owner userId={}", id, userId);
    }

    public SpeakingScenarioDto createCustomScenario(Long userId, CreateCustomScenarioRequestDto req) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User must be authenticated to create custom scenarios");
        }
        List<String> validatedVocab = validateCustomScenarioRequest(req, true);

        int estMinutes = 5;
        if (req.estimatedDuration() != null && !req.estimatedDuration().isBlank()) {
            try {
                String numOnly = req.estimatedDuration().replaceAll("[^0-9]", "").trim();
                if (!numOnly.isEmpty()) {
                    int parsed = Integer.parseInt(numOnly);
                    if (parsed > 0) {
                        estMinutes = Math.min(parsed, 120);
                    }
                }
            } catch (Exception ignored) {}
        }

        // HTTP Phase (OUTSIDE any DB transaction — zero Hikari connection held during AI wait)
        String targetUrl = aiBaseUrl + "/api/v1/speaking/roleplay/generate-scenario";
        Map<String, Object> payload = new HashMap<>();
        payload.put("topic", req.topic().trim());
        payload.put("cefr_level", (req.cefrLevel() != null && !req.cefrLevel().isBlank()) ? req.cefrLevel().trim() : "B1");
        payload.put("context", req.context() != null ? req.context().trim() : "");
        payload.put("learner_role", req.learnerRole().trim());
        payload.put("ai_role", req.aiRole().trim());
        payload.put("mission", req.mission().trim());
        payload.put("target_vocabulary", validatedVocab != null ? validatedVocab : List.of());
        payload.put("target_turns", req.targetTurns());
        payload.put("estimated_duration", req.estimatedDuration());
        payload.put("estimated_minutes", estMinutes);

        String title = req.topic().trim();
        String description = req.context() != null && !req.context().isBlank() ? req.context().trim() : ("Tình huống luyện tập: " + title);
        ScenarioCategory category = ScenarioCategory.DAILY_LIFE;
        CefrLevel cefrLevel = CefrLevel.fromString(req.cefrLevel());
        if (cefrLevel == null) cefrLevel = CefrLevel.B1;
        String learnerGoal = req.mission().trim();
        List<String> targetVocab = validatedVocab != null && !validatedVocab.isEmpty()
                ? new ArrayList<>(validatedVocab)
                : new ArrayList<>(List.of("introduce", "collaborate", "experience", "solution", "deliver"));
        boolean isCasual = req.topic().toLowerCase().matches(".*(friend|coffee|party|weekend|chat|casual|neighbor|hobbies|dinner).*");
        List<String> targetGrammar = isCasual
                ? new ArrayList<>(List.of("Have you ever...", "I'm thinking of...", "How about we..."))
                : new ArrayList<>(List.of("Could you please explain...", "I would like to...", "In my previous experience..."));
        String initialAiMessage = isCasual
                ? ("Hey there! Great to see you. How have you been?")
                : ("Hello! Let's begin our conversation about " + title + ". How can I assist you today?");
        List<String> successCriteria = new ArrayList<>(List.of(
                "Nêu rõ thông tin và vai trò của bạn bằng tiếng Anh",
                "Hoàn thành mục tiêu: " + req.mission().trim()
        ));
        List<String> hints = new ArrayList<>(List.of("Nói câu hoàn chỉnh và phát âm rõ ràng bằng tiếng Anh."));

        try {
            RestTemplate restTemplate = createRestTemplateWithTimeout();
            ResponseEntity<Map> response = restTemplate.postForEntity(targetUrl, payload, Map.class);
            Map body = response.getBody();
            if (body != null) {
                if (body.get("title") != null && !String.valueOf(body.get("title")).isBlank()) {
                    title = String.valueOf(body.get("title")).trim();
                }
                if (body.get("description") != null && !String.valueOf(body.get("description")).isBlank()) {
                    description = String.valueOf(body.get("description")).trim();
                }
                if (body.get("category") != null) {
                    try {
                        category = ScenarioCategory.valueOf(String.valueOf(body.get("category")).trim().toUpperCase());
                    } catch (Exception ignored) {}
                }
                if (body.get("learner_goal") != null && !String.valueOf(body.get("learner_goal")).isBlank()) {
                    learnerGoal = String.valueOf(body.get("learner_goal")).trim();
                }
                if (body.get("target_vocabulary") instanceof List list && !list.isEmpty()) {
                    targetVocab = (List<String>) list;
                }
                if (body.get("target_grammar") instanceof List list && !list.isEmpty()) {
                    targetGrammar = (List<String>) list;
                }
                if (body.get("initial_ai_message") != null && !String.valueOf(body.get("initial_ai_message")).isBlank()) {
                    initialAiMessage = String.valueOf(body.get("initial_ai_message")).trim();
                }
                if (body.get("success_criteria") instanceof List list && !list.isEmpty()) {
                    successCriteria = (List<String>) list;
                }
                if (body.get("optional_hints") instanceof List list && !list.isEmpty()) {
                    hints = (List<String>) list;
                }
                if (body.get("estimated_minutes") instanceof Number num && num.intValue() > 0) {
                    estMinutes = num.intValue();
                }
            }
        } catch (Exception e) {
            log.warn("AI service custom scenario generation call failed at {}: {}. Using direct fallback parameters.", targetUrl, e.getMessage());
        }

        String customVoiceId = "us_female";
        if (req.voiceId() != null && !req.voiceId().trim().isBlank()) {
            String v = req.voiceId().trim().toLowerCase();
            if (List.of("us_male", "us_female", "uk_male", "uk_female").contains(v)) {
                customVoiceId = v;
            }
        }

        final String finalTitle = title;
        final String finalDescription = description;
        final ScenarioCategory finalCategory = category;
        final CefrLevel finalCefrLevel = cefrLevel;
        final String finalLearnerGoal = learnerGoal;
        final List<String> finalTargetVocab = new ArrayList<>(targetVocab);
        final List<String> finalTargetGrammar = new ArrayList<>(targetGrammar);
        final String finalInitialAiMessage = initialAiMessage;
        final List<String> finalSuccessCriteria = new ArrayList<>(successCriteria);
        final List<String> finalHints = new ArrayList<>(hints);
        final int finalEstMinutes = estMinutes;
        final String finalVoiceId = customVoiceId;

        // Write Phase (short TX): persist custom scenario and materialize DTO inside TX
        return inTx(() -> {
            SpeakingScenario scenario = SpeakingScenario.builder()
                    .title(finalTitle)
                    .description(finalDescription)
                    .category(finalCategory)
                    .cefrLevel(finalCefrLevel)
                    .learnerRole(req.learnerRole().trim())
                    .aiRole(req.aiRole().trim())
                    .learnerGoal(finalLearnerGoal)
                    .targetVocabulary(finalTargetVocab)
                    .targetGrammar(finalTargetGrammar)
                    .initialAiMessage(finalInitialAiMessage)
                    .successCriteria(finalSuccessCriteria)
                    .optionalHints(finalHints)
                    .estimatedMinutes(finalEstMinutes)
                    .ownerUserId(userId)
                    .isSystem(false)
                    .defaultVoiceId(finalVoiceId)
                    .build();

            SpeakingScenario saved = speakingScenarioRepository.save(scenario);
            log.info("Saved custom scenario id={} title='{}' for userId={}", saved.getId(), saved.getTitle(), userId);
            return SpeakingScenarioDto.fromEntity(saved);
        });
    }
}
