package com.englishcoach.writing.service;

import com.englishcoach.writing.client.WritingAiClient;
import com.englishcoach.writing.config.WritingProperties;
import com.englishcoach.writing.dto.*;
import com.englishcoach.writing.entity.*;
import com.englishcoach.writing.enums.*;
import com.englishcoach.writing.exception.*;
import com.englishcoach.writing.repository.*;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class WritingSessionServiceImpl implements WritingSessionService {

    private final WritingProperties writingProperties;
    private final WritingProfileRepository profileRepository;
    private final WritingSessionRepository sessionRepository;
    private final WritingSubmissionRepository submissionRepository;
    private final WritingAssessmentRepository assessmentRepository;
    private final WritingFeedbackIssueRepository issueRepository;
    private final WritingAiClient writingAiClient;
    private final WritingErrorMemoryService errorMemoryService;
    private final WritingCatalogService catalogService;
    private final WritingLearningEvidenceRepository evidenceRepository;
    private final WritingErrorMemoryRepository errorMemoryRepository;
    private final WritingPracticeRepository practiceRepository;
    private final DeterministicGrammarValidator deterministicGrammarValidator;
    private final org.springframework.transaction.PlatformTransactionManager gradingTransactionManager;
    private static final ObjectMapper DEFAULT_OBJECT_MAPPER = new ObjectMapper();

    private final WritingGradingBudget gradingBudget;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private ObjectMapper objectMapper = DEFAULT_OBJECT_MAPPER;

    private ObjectMapper mapper() {
        return objectMapper != null ? objectMapper : DEFAULT_OBJECT_MAPPER;
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.context.ApplicationEventPublisher eventPublisher;

    private void checkEnabled() {
        if (!writingProperties.isEnabled()) {
            throw new WritingDisabledException("Writing module is currently disabled by administrator.");
        }
    }

    private void checkMutationsEnabled() {
        checkEnabled();
        if (!writingProperties.isMutationsEnabled()) {
            throw new WritingDisabledException("Writing mutations are currently paused.");
        }
    }

    @Override
    public WritingCapabilitiesDto getCapabilities() {
        return WritingCapabilitiesDto.builder()
                .enabled(writingProperties.isEnabled())
                .mutationsEnabled(writingProperties.isMutationsEnabled())
                .assessmentsEnabled(writingProperties.isAssessmentsEnabled())
                .workerEnabled(writingProperties.isWorkerEnabled())
                .maxSentenceChars(writingProperties.getMaxSentenceChars())
                .maxDraftWords(writingProperties.getMaxDraftWords())
                .maxDraftChars(writingProperties.getMaxDraftChars())
                .build();
    }

    @Override
    @Transactional
    public WritingProfileDto getProfile(Long userId) {
        checkEnabled();
        WritingProfileEntity profile = profileRepository.findByUserId(userId)
                .orElseGet(() -> {
                    WritingProfileEntity newProfile = WritingProfileEntity.builder()
                            .userId(userId)
                            .cefrLevel("B1")
                            .preferredRegister("neutral")
                            .goals("[]")
                            .interests("[]")
                            .explanationLocale("en")
                            .provenance("INITIAL_CHOICE")
                            .version(1L)
                            .build();
                    return profileRepository.save(newProfile);
                });
        return toProfileDto(profile);
    }

    @Override
    @Transactional
    public WritingProfileDto updateProfile(Long userId, WritingProfileDto dto) {
        checkMutationsEnabled();
        WritingProfileEntity profile = profileRepository.findByUserId(userId)
                .orElseGet(() -> WritingProfileEntity.builder().userId(userId).build());

        if (dto.getCefrLevel() != null) profile.setCefrLevel(dto.getCefrLevel());
        if (dto.getPreferredRegister() != null) profile.setPreferredRegister(dto.getPreferredRegister());
        if (dto.getExplanationLocale() != null) profile.setExplanationLocale(dto.getExplanationLocale());
        if (dto.getGoals() != null) {
            try {
                profile.setGoals(mapper().writeValueAsString(dto.getGoals()));
            } catch (Exception ignored) {}
        }
        if (dto.getInterests() != null) {
            try {
                profile.setInterests(mapper().writeValueAsString(dto.getInterests()));
            } catch (Exception ignored) {}
        }
        profile.setVersion(profile.getVersion() != null ? profile.getVersion() + 1 : 1L);
        profile = profileRepository.save(profile);
        return toProfileDto(profile);
    }

    @Override
    public List<Map<String, Object>> getTasks(String category, String level) {
        checkEnabled();
        List<Map<String, Object>> allTasks = catalogService.getTasks();
        List<Map<String, Object>> result = new ArrayList<>();
        for (Map<String, Object> t : allTasks) {
            String cat = (String) t.get("category");
            String id = (String) t.get("id");
            String family = (String) t.get("family");
            String subtype = (String) t.get("taskSubtype");

            boolean isTask1 = (id != null && id.startsWith("ielts-t1-")) ||
                    ("IELTS".equalsIgnoreCase(family) && subtype != null && isTask1Subtype(subtype));
            boolean isTask2 = (id != null && id.startsWith("ielts-t2-")) ||
                    ("IELTS".equalsIgnoreCase(family) && !isTask1);
            boolean isToeic = (id != null && id.startsWith("toeic-")) || "TOEIC".equalsIgnoreCase(family);
            boolean isGeneral = (id != null && id.startsWith("gen-")) || "GENERAL".equalsIgnoreCase(family);

            // Requirement 10: If a task has no required visual source: do NOT offer that task to the user
            if (isTask1 && t.get("visualData") == null) {
                continue;
            }

            if (category != null && !category.isBlank() && !category.equalsIgnoreCase("all")) {
                boolean matches = false;
                if ("IELTS_TASK_1".equalsIgnoreCase(category) || "IELTS_TASK1".equalsIgnoreCase(category)) {
                    matches = isTask1;
                } else if ("IELTS_TASK_2".equalsIgnoreCase(category) || "IELTS_TASK2".equalsIgnoreCase(category)) {
                    matches = isTask2;
                } else if ("TOEIC_WRITING".equalsIgnoreCase(category) || "TOEIC".equalsIgnoreCase(category)) {
                    matches = isToeic;
                } else if ("GENERAL_ACADEMIC".equalsIgnoreCase(category) || "GENERAL".equalsIgnoreCase(category)) {
                    matches = isGeneral;
                } else if (cat != null && cat.equalsIgnoreCase(category)) {
                    matches = true;
                }
                if (!matches) {
                    continue;
                }
            }

            Map<String, Object> taskMap = new LinkedHashMap<>(t);
            String canonicalFamily;
            if (isTask1) {
                canonicalFamily = "IELTS_TASK_1";
            } else if (isTask2) {
                canonicalFamily = "IELTS_TASK_2";
            } else if (isToeic) {
                canonicalFamily = "TOEIC_WRITING";
            } else {
                canonicalFamily = "GENERAL_ACADEMIC";
            }
            taskMap.put("family", canonicalFamily);
            taskMap.put("writingType", canonicalFamily);
            result.add(taskMap);
        }
        return result;
    }

    private boolean isTask1Subtype(String subtype) {
        return "line_chart".equalsIgnoreCase(subtype) ||
                "bar_chart".equalsIgnoreCase(subtype) ||
                "pie_chart".equalsIgnoreCase(subtype) ||
                "table".equalsIgnoreCase(subtype) ||
                "process".equalsIgnoreCase(subtype) ||
                "map".equalsIgnoreCase(subtype) ||
                "mixed_data".equalsIgnoreCase(subtype) ||
                "mixed_chart".equalsIgnoreCase(subtype);
    }

    @Override
    @Transactional
    public WritingSessionDto createSession(Long userId, CreateSessionRequest request) {
        checkMutationsEnabled();
        Map<String, Object> task = catalogService.getTaskById(userId, request.getTaskId())
                .orElseThrow(() -> new WritingValidationException("Task not found with ID: " + request.getTaskId()));

        String taskSnapshotJson;
        try {
            taskSnapshotJson = mapper().writeValueAsString(task);
        } catch (Exception e) {
            throw new RuntimeException("Failed to serialize task snapshot", e);
        }

        // Reuse existing in-progress session for this task if one already exists
        List<WritingSessionEntity> existingSessions = sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId);
        for (WritingSessionEntity existing : existingSessions) {
            if (Objects.equals(existing.getTaskId(), request.getTaskId()) && existing.getStage() != WritingSessionStage.COMPLETED) {
                log.info("Reusing existing active WritingSession {} for user {} and task {}", existing.getId(), userId, request.getTaskId());
                return toSessionDto(existing);
            }
        }

        String sessionId = UUID.randomUUID().toString();
        WritingSessionEntity session = WritingSessionEntity.builder()
                .id(sessionId)
                .userId(userId)
                .taskId(request.getTaskId())
                .taskSnapshot(taskSnapshotJson)
                .stage(WritingSessionStage.UNDERSTANDING)
                .workingPlan("")
                .workingText("")
                .currentRevision(1L)
                .isFavorite(false)
                .build();

        session = sessionRepository.save(session);
        log.info("Created WritingSession {} for user {}", sessionId, userId);
        return toSessionDto(session);
    }

    @Override
    @Transactional(readOnly = true)
    public WritingSessionDto getSession(Long userId, String sessionId) {
        checkEnabled();
        WritingSessionEntity session = sessionRepository.findByIdAndUserId(sessionId, userId)
                .orElseThrow(() -> new WritingNotFoundException("Session not found: " + sessionId));
        return toSessionDto(session);
    }

    @Override
    @Transactional
    public WritingSessionDto updateWorkingCopy(Long userId, String sessionId, UpdateWorkingCopyRequest request) {
        checkMutationsEnabled();
        WritingSessionEntity session = sessionRepository.findOwnedForCompletion(sessionId, userId)
                .orElseThrow(() -> new WritingNotFoundException("Session not found: " + sessionId));

        if (!Objects.equals(session.getCurrentRevision(), request.getExpectedRevision())) {
            log.warn("Conflict on session {}: expected rev {} but current rev is {}",
                    sessionId, request.getExpectedRevision(), session.getCurrentRevision());
            throw new WritingConflictException(
                    String.format("Conflict: current revision is %d, expected %d. Refresh and reconcile.",
                            session.getCurrentRevision(), request.getExpectedRevision()));
        }

        if (request.getWorkingText() != null) {
            if (request.getWorkingText().length() > writingProperties.getMaxDraftChars()) {
                throw new WritingValidationException("Working draft exceeds maximum character length.");
            }
            session.setWorkingText(request.getWorkingText());

            // If currently revising, keep the active revision draft snapshot synced with the latest text
            if (session.getStage() == WritingSessionStage.REVISING) {
                List<WritingSubmissionEntity> existingDrafts = submissionRepository.findBySessionIdOrderByOrdinalAsc(sessionId);
                if (!existingDrafts.isEmpty() && assessmentRepository.findBySubmissionId(existingDrafts.getLast().getId()).isEmpty()) {
                    WritingSubmissionEntity activeDraft = existingDrafts.get(existingDrafts.size() - 1);
                    activeDraft.setContent(request.getWorkingText());
                    int wc = request.getWorkingText().trim().isEmpty() ? 0 : request.getWorkingText().trim().split("\\s+").length;
                    activeDraft.setWordCount(wc);
                    activeDraft.setCharacterCount(request.getWorkingText().length());
                    submissionRepository.save(activeDraft);
                }
            }
        }

        if (request.getWorkingPlan() != null) {
            session.setWorkingPlan(request.getWorkingPlan());
        }

        session.setCurrentRevision(session.getCurrentRevision() + 1);
        session = sessionRepository.save(session);
        return toSessionDto(session);
    }

    @Override
    @Transactional
    public WritingSessionDto advanceStage(Long userId, String sessionId, AdvanceStageRequest request) {
        checkMutationsEnabled();
        WritingSessionEntity session = sessionRepository.findOwnedForCompletion(sessionId, userId)
                .orElseThrow(() -> new WritingNotFoundException("Session not found: " + sessionId));

        if (request.getExpectedRevision() != null && !Objects.equals(session.getCurrentRevision(), request.getExpectedRevision()) && !Objects.equals(session.getCurrentRevision() - 1, request.getExpectedRevision())) {
            log.warn("advanceStage conflict: session rev={}, request rev={}, current stage={}, target stage={}",
                    session.getCurrentRevision(), request.getExpectedRevision(), session.getStage(), request.getTargetStage());
            throw new WritingConflictException(
                    String.format("Conflict: current revision is %d, expected %d",
                            session.getCurrentRevision(), request.getExpectedRevision()));
        }

        if (!isValidStageTransition(session.getStage(), request.getTargetStage(), session)) {
            throw new WritingConflictException(
                    String.format("Illegal stage transition from %s to %s",
                            session.getStage(), request.getTargetStage()));
        }

        if (request.getTargetStage() == WritingSessionStage.REVISING) {
            // Persist a distinct revision snapshot so that compareDrafts has consecutive persisted drafts
            List<WritingSubmissionEntity> existingDrafts = submissionRepository.findBySessionIdOrderByOrdinalAsc(sessionId);
            int nextOrdinal = existingDrafts.size() + 1;
            String currentText = session.getWorkingText() != null ? session.getWorkingText() : "";
            int wordCount = currentText.trim().isEmpty() ? 0 : currentText.trim().split("\\s+").length;
            WritingSubmissionEntity revisionDraft = WritingSubmissionEntity.builder()
                    .id(UUID.randomUUID().toString())
                    .userId(userId)
                    .sessionId(sessionId)
                    .kind(SubmissionKind.COACH_DRAFT)
                    .ordinal(nextOrdinal)
                    .content(currentText)
                    .wordCount(wordCount)
                    .characterCount(currentText.length())
                    .build();
            submissionRepository.save(revisionDraft);
            log.info("Created revision draft #{} for session {}", nextOrdinal, sessionId);
        }

        if (request.getTargetStage() == WritingSessionStage.COMPLETED) {
            session.setCompletedAt(Instant.now());
            if (session.getFinalDraftId() == null && session.getActiveAssessmentId() != null) {
                Optional<WritingAssessmentEntity> a = assessmentRepository.findById(session.getActiveAssessmentId());
                if (a.isPresent()) {
                    session.setFinalDraftId(a.get().getSubmissionId());
                }
            }
        }

        session.setStage(request.getTargetStage());
        session.setCurrentRevision(session.getCurrentRevision() + 1);
        session = sessionRepository.save(session);
        return toSessionDto(session);
    }

    private boolean isValidStageTransition(WritingSessionStage current, WritingSessionStage target, WritingSessionEntity session) {
        if (current == target) return true;
        if (target == WritingSessionStage.COMPLETED && session.getActiveAssessmentId() == null && session.getFinalDraftId() == null) {
            return false;
        }
        return switch (current) {
            case UNDERSTANDING -> target == WritingSessionStage.PLANNING || target == WritingSessionStage.DRAFTING;
            case PLANNING -> target == WritingSessionStage.UNDERSTANDING || target == WritingSessionStage.DRAFTING;
            case DRAFTING -> target == WritingSessionStage.PLANNING || target == WritingSessionStage.ANALYZING || target == WritingSessionStage.FEEDBACK_READY;
            case ANALYZING -> target == WritingSessionStage.DRAFTING || target == WritingSessionStage.FEEDBACK_READY;
            case FEEDBACK_READY -> target == WritingSessionStage.REVISING || target == WritingSessionStage.DRAFTING || target == WritingSessionStage.COMPLETED;
            case REVISING -> target == WritingSessionStage.ANALYZING || target == WritingSessionStage.FEEDBACK_READY || target == WritingSessionStage.DRAFTING || target == WritingSessionStage.COMPLETED;
            case COMPLETED -> target == WritingSessionStage.REVISING || target == WritingSessionStage.FEEDBACK_READY;
        };
    }

    @Override
    @Transactional(readOnly = true)
    public List<WritingSessionDto> listSessions(Long userId, WritingSessionStage stage, Boolean completed) {
        checkEnabled();
        List<WritingSessionEntity> entities;
        if (stage != null) {
            entities = sessionRepository.findByUserIdAndStageOrderByUpdatedAtDesc(userId, stage);
        } else if (Boolean.TRUE.equals(completed)) {
            entities = sessionRepository.findByUserIdAndStageOrderByUpdatedAtDesc(userId, WritingSessionStage.COMPLETED);
        } else {
            entities = sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId);
        }

        List<WritingSessionDto> dtos = new ArrayList<>();
        for (WritingSessionEntity e : entities) {
            dtos.add(toSessionDto(e));
        }
        return dtos;
    }

    @Override
    @Transactional
    public void deleteSession(Long userId, String sessionId) {
        checkMutationsEnabled();
        WritingSessionEntity session = sessionRepository.findOwnedForCompletion(sessionId, userId)
                .orElseThrow(() -> new WritingNotFoundException("Session not found: " + sessionId));
        sessionRepository.delete(session);
        log.info("Deleted session {} for user {}", sessionId, userId);
    }

    private WritingSessionEntity getOwnedSession(String sessionId, Long userId) {
        return sessionRepository.findByIdAndUserId(sessionId, userId)
                .orElseThrow(() -> new WritingNotFoundException("Session not found: " + sessionId));
    }

    private Map<String, Object> parseTaskSnapshot(String taskSnapshotJson) {
        if (taskSnapshotJson == null || taskSnapshotJson.isBlank()) {
            return Collections.emptyMap();
        }
        try {
            return mapper().readValue(taskSnapshotJson, new TypeReference<>() {});
        } catch (Exception e) {
            log.warn("Failed to parse task snapshot: {}", e.getMessage());
            return Collections.emptyMap();
        }
    }

    private WritingSessionDto toSessionDto(WritingSessionEntity entity) {
        Map<String, Object> taskSnapshotMap = new HashMap<>(parseTaskSnapshot(entity.getTaskSnapshot()));
        if (entity.getTaskId() != null) {
            catalogService.getTaskById(entity.getUserId(), entity.getTaskId()).ifPresent(catalogTask -> {
                if (!taskSnapshotMap.containsKey("visualData") && catalogTask.containsKey("visualData")) {
                    taskSnapshotMap.put("visualData", catalogTask.get("visualData"));
                }
                if (!taskSnapshotMap.containsKey("family") && catalogTask.containsKey("family")) {
                    taskSnapshotMap.put("family", catalogTask.get("family"));
                }
                if (!taskSnapshotMap.containsKey("taskSubtype") && catalogTask.containsKey("taskSubtype")) {
                    taskSnapshotMap.put("taskSubtype", catalogTask.get("taskSubtype"));
                }
            });
        }

        return WritingSessionDto.builder()
                .id(entity.getId())
                .userId(entity.getUserId())
                .taskId(entity.getTaskId())
                .taskSnapshot(taskSnapshotMap)
                .stage(entity.getStage())
                .workingPlan(entity.getWorkingPlan())
                .workingText(entity.getWorkingText())
                .currentRevision(entity.getCurrentRevision())
                .activeAssessmentId(entity.getActiveAssessmentId())
                .finalDraftId(entity.getFinalDraftId())
                .isFavorite(entity.getIsFavorite())
                .completedAt(entity.getCompletedAt())
                .createdAt(entity.getCreatedAt())
                .updatedAt(entity.getUpdatedAt())
                .build();
    }

    private WritingProfileDto toProfileDto(WritingProfileEntity entity) {
        List<String> goals = Collections.emptyList();
        List<String> interests = Collections.emptyList();
        try {
            if (entity.getGoals() != null) {
                goals = mapper().readValue(entity.getGoals(), new TypeReference<>() {});
            }
            if (entity.getInterests() != null) {
                interests = mapper().readValue(entity.getInterests(), new TypeReference<>() {});
            }
        } catch (Exception ignored) {}

        return WritingProfileDto.builder()
                .userId(entity.getUserId())
                .cefrLevel(entity.getCefrLevel())
                .preferredRegister(entity.getPreferredRegister())
                .goals(goals)
                .interests(interests)
                .explanationLocale(entity.getExplanationLocale())
                .provenance(entity.getProvenance())
                .version(entity.getVersion())
                .updatedAt(entity.getUpdatedAt())
                .build();
    }

    @Override
    public PlanOrganizationResultDto organizePlan(Long userId, String sessionId) {
        checkMutationsEnabled();
        WritingSessionEntity session = getOwnedSession(sessionId, userId);

        String planText = session.getWorkingPlan() != null ? session.getWorkingPlan() : "";
        List<String> rawIdeas = new ArrayList<>();
        if (planText.trim().startsWith("{")) {
            try {
                Map<String, Object> map = mapper().readValue(planText, new TypeReference<>() {});
                for (String key : List.of("thesis", "propA", "propB", "propC", "counterargument", "rebuttal", "conclusion", "notes")) {
                    Object valObj = map.get(key);
                    if (valObj != null) {
                        String val = valObj.toString().trim();
                        if (!val.isEmpty()) {
                            for (String line : val.split("\\n+")) {
                                String cleanLine = line.replaceFirst("^[•\\-\\*\\s]+", "").trim();
                                if (!cleanLine.isEmpty() && !rawIdeas.contains(cleanLine)) {
                                    rawIdeas.add(cleanLine);
                                }
                            }
                        }
                    }
                }
                Object bodyArgs = map.get("bodyArguments");
                if (bodyArgs instanceof List<?> list) {
                    for (Object item : list) {
                        if (item != null) {
                            String clean = item.toString().replaceFirst("^[•\\-\\*\\s]+", "").trim();
                            if (!clean.isEmpty() && !rawIdeas.contains(clean)) {
                                rawIdeas.add(clean);
                            }
                        }
                    }
                }
                Object evList = map.get("evidence");
                if (evList instanceof List<?> list) {
                    for (Object item : list) {
                        if (item != null) {
                            String clean = item.toString().replaceFirst("^[•\\-\\*\\s]+", "").trim();
                            if (!clean.isEmpty() && !rawIdeas.contains(clean)) {
                                rawIdeas.add(clean);
                            }
                        }
                    }
                }
            } catch (Exception ignored) {}
        }
        if (rawIdeas.isEmpty()) {
            rawIdeas = Arrays.stream(planText.split("\\n+"))
                    .map(String::trim)
                    .map(s -> s.replaceFirst("^[•\\-\\*\\s]+", "").trim())
                    .filter(s -> !s.isEmpty() && !s.startsWith("{") && !s.endsWith("}") && !s.startsWith("["))
                    .distinct()
                    .toList();
        }

        Map<String, Object> task = parseTaskSnapshot(session.getTaskSnapshot());
        String taskTitle = (String) task.getOrDefault("title", "");
        String taskCategory = (String) task.getOrDefault("category", "");
        String taskPrompt = (String) task.getOrDefault("prompt", "Write a coherent essay.");
        String fullPrompt = (taskTitle.isBlank() ? "" : taskTitle + " - ") + taskPrompt + (taskCategory.isBlank() ? "" : " [" + taskCategory + "]");
        Object visualData = task.get("visualData") != null ? task.get("visualData") : task.get("visual_data");
        if (visualData != null) {
            try {
                fullPrompt += "\n[Chart/Visual Data]: " + (visualData instanceof String ? visualData : mapper().writeValueAsString(visualData));
            } catch (Exception ignored) {}
        }

        return writingAiClient.organizePlan(fullPrompt, rawIdeas);
    }

    private record PendingDraft(WritingSessionEntity snapshot, WritingSubmissionEntity draft,
                                WritingAssessmentEntity assessment, String lease, WritingGradingBudget.Charge charge) {}

    @Override
    public DocumentAssessmentResultDto submitDraft(Long userId, String sessionId, Long expectedRevision, String clientMutationId) {
        return gradeDraft(userId, sessionId, expectedRevision, clientMutationId, false);
    }

    private DocumentAssessmentResultDto gradeDraft(Long userId, String sessionId, Long expectedRevision,
                                                   String mutation, boolean completing) {
        var tx = new org.springframework.transaction.support.TransactionTemplate(gradingTransactionManager);
        var pending = tx.execute(status -> prepareDraft(userId, sessionId, expectedRevision, mutation, completing));
        if (pending.lease() == null) {
            return tx.execute(status -> getAssessment(userId, sessionId, pending.assessment().getId()));
        }
        var snapshot = pending.snapshot();
        var draft = pending.draft();
        Map<String, Object> task = parseTaskSnapshot(snapshot.getTaskSnapshot());
        boolean settled = false;
        try {
            var response = writingAiClient.analyzeDocument((String) task.getOrDefault("prompt", "Write a coherent essay."),
                    (String) task.getOrDefault("category", "Everyday"), (String) task.getOrDefault("guidance", ""),
                    snapshot.getWorkingPlan(), draft.getContent(), draft.getOrdinal());
            DocumentAssessmentResultDto result = tx.execute(status -> {
                var session = lockSession(sessionId, userId);
                var assessment = assessmentRepository.findById(pending.assessment().getId()).orElseThrow();
                if (!Objects.equals(assessment.getLeaseToken(), pending.lease())
                        || !Objects.equals(session.getCurrentRevision(), snapshot.getCurrentRevision())
                        || !Objects.equals(session.getWorkingText(), snapshot.getWorkingText())
                        || session.getStage() != snapshot.getStage()) {
                    throw new WritingConflictException("The draft changed during assessment.");
                }
                assessment = persistAssessment(session, draft, assessment, response, task);
                if (assessment.getOverallScore() == null) throw new WritingAiServiceException("The assessment returned no score.");
                if (completing || session.getStage() == WritingSessionStage.REVISING) {
                    session.setStage(WritingSessionStage.COMPLETED);
                    session.setCompletedAt(Instant.now());
                    session.setFinalDraftId(draft.getId());
                } else {
                    session.setStage(WritingSessionStage.FEEDBACK_READY);
                }
                session.setActiveAssessmentId(assessment.getId());
                session.setCurrentRevision(session.getCurrentRevision() + 1);
                sessionRepository.save(session);
                gradingBudget.settle(pending.charge(), true);
                var issues = issueRepository.findByAssessmentIdOrderByPriorityRankAsc(assessment.getId());
                return buildDocumentResultDto(draft, assessment, issues, response.getStrengths(), assessment.getCoverageSummary());
            });
            settled = true;
            return result;
        } catch (RuntimeException failure) {
            try {
                tx.executeWithoutResult(status -> {
                    sessionRepository.findOwnedForCompletion(sessionId, userId);
                    assessmentRepository.findById(pending.assessment().getId()).filter(a -> pending.lease().equals(a.getLeaseToken()))
                            .ifPresent(a -> {
                                a.setStatus(AssessmentStatus.FAILED_RETRYABLE);
                                a.setCompletedAt(Instant.now());
                                a.setLeaseToken(null);
                                a.setLeaseExpiresAt(null);
                                assessmentRepository.save(a);
                            });
                    gradingBudget.settle(pending.charge(), false);
                });
                settled = true;
            } catch (RuntimeException cleanupFailure) {
                log.warn("Cleanup transaction failed after grading failure on session {}: {}", sessionId, cleanupFailure.getMessage());
            } finally {
                // Guarantee reservation settlement even if cleanup DB transaction hit a conflict or missing row
                if (!settled && pending.charge() != null) {
                    try {
                        gradingBudget.settle(pending.charge(), false);
                    } catch (Exception settleFailure) {
                        log.error("Fallback reservation settlement failed for session {}: {}", sessionId, settleFailure.getMessage());
                    }
                }
            }
            if (failure instanceof WritingConflictException conflict) throw conflict;
            throw new WritingAiServiceException("Đánh giá chưa hoàn tất. Bản nháp đã được lưu.", failure);
        }
    }

    private WritingSessionEntity lockSession(String id, Long owner) {
        return sessionRepository.findOwnedForCompletion(id, owner)
                .orElseThrow(() -> new WritingNotFoundException("Writing session not found."));
    }

    private PendingDraft prepareDraft(Long userId, String sessionId, Long revision, String mutation, boolean completing) {
        checkMutationsEnabled();
        var session = lockSession(sessionId, userId);
        String content = Objects.toString(session.getWorkingText(), "").trim();
        if (content.isEmpty() || content.length() > writingProperties.getMaxDraftChars()) {
            throw new IllegalArgumentException("Invalid draft length.");
        }
        var drafts = submissionRepository.findBySessionIdOrderByOrdinalAsc(sessionId);
        WritingSubmissionEntity submission = null;
        WritingAssessmentEntity assessment = null;
        for (var existing : drafts.reversed()) {
            boolean sameKey = mutation != null && mutation.equals(existing.getIdempotencyKey());
            if (sameKey && !content.equals(existing.getContent())) throw new WritingConflictException("Draft request ID was reused.");
            if (!sameKey && !content.equals(existing.getContent())) continue;
            var prior = assessmentRepository.findBySubmissionId(existing.getId()).orElse(null);
            if (prior != null && prior.getStatus() == AssessmentStatus.RUNNING) {
                if (prior.getLeaseExpiresAt() != null && prior.getLeaseExpiresAt().isAfter(Instant.now())) {
                    throw new WritingConflictException("Draft assessment in progress.");
                }
                gradingBudget.settle(new WritingGradingBudget.Charge(prior.getGradingReservationId(), prior.getGradingVoucherUseId()), false);
                prior.setStatus(AssessmentStatus.FAILED_RETRYABLE);
                prior.setLeaseToken(null);
                prior.setLeaseExpiresAt(null);
                assessmentRepository.save(prior);
            }
            if (sameKey && prior != null && prior.getStatus() == AssessmentStatus.READY) {
                return new PendingDraft(session, existing, prior, null, null);
            }
            if (sameKey || (completing && existing == drafts.getLast() && prior == null)) {
                submission = existing;
                assessment = prior;
                break;
            }
        }
        if (session.getStage() == WritingSessionStage.COMPLETED
                || (revision != null && !revision.equals(session.getCurrentRevision()))) {
            throw new WritingConflictException("The writing session has changed.");
        }
        var charge = gradingBudget.reserve(userId);
        if (submission == null) {
            submission = submissionRepository.save(WritingSubmissionEntity.builder()
                    .id(UUID.randomUUID().toString()).userId(userId).sessionId(sessionId).kind(SubmissionKind.COACH_DRAFT)
                    .ordinal(drafts.size() + 1).content(content).characterCount(content.length())
                    .wordCount(content.split("\\s+").length).idempotencyKey(mutation).build());
        }
        if (assessment == null) {
            assessment = WritingAssessmentEntity.builder().id(UUID.randomUUID().toString())
                    .submissionId(submission.getId()).operation(AssessmentOperation.DOCUMENT_ANALYSIS).build();
        }
        String lease = UUID.randomUUID().toString();
        assessment.setStatus(AssessmentStatus.RUNNING);
        assessment.setGradingReservationId(charge.reservation());
        assessment.setGradingVoucherUseId(charge.voucher());
        assessment.setLeaseToken(lease);
        assessment.setLeaseExpiresAt(Instant.now().plusSeconds(300));
        return new PendingDraft(session, submission, assessmentRepository.save(assessment), lease, charge);
    }

    @Override
    @Transactional(readOnly = true)
    public DocumentAssessmentResultDto getAssessment(Long userId, String sessionId, String assessmentId) {
        WritingSessionEntity session = getOwnedSession(sessionId, userId);

        WritingAssessmentEntity assessment = assessmentRepository.findById(assessmentId)
                .orElseThrow(() -> new WritingNotFoundException("Assessment not found: " + assessmentId));

        WritingSubmissionEntity submission = submissionRepository.findById(assessment.getSubmissionId())
                .orElseThrow(() -> new WritingNotFoundException("Submission not found: " + assessment.getSubmissionId()));

        if (!submission.getSessionId().equals(sessionId) || !submission.getUserId().equals(userId)) {
            throw new WritingNotFoundException("Assessment not found: " + assessmentId);
        }

        List<WritingFeedbackIssueEntity> issues = issueRepository.findByAssessmentIdOrderByPriorityRankAsc(assessmentId);
        List<String> strengths = Collections.emptyList();
        try {
            strengths = mapper().readValue(assessment.getStrengths(), new TypeReference<>() {});
        } catch (Exception ignored) {}

        return buildDocumentResultDto(submission, assessment, issues, strengths, assessment.getCoverageSummary());
    }

    private DocumentAssessmentResultDto buildDocumentResultDto(
            WritingSubmissionEntity submission,
            WritingAssessmentEntity assessment,
            List<WritingFeedbackIssueEntity> issues,
            List<String> strengths,
            String summary
    ) {
        List<DimensionVerdictDto> verdicts = new ArrayList<>();
        try {
            verdicts = mapper().readValue(assessment.getDimensionVerdicts(), new TypeReference<>() {});
        } catch (Exception ignored) {}

        List<FeedbackIssueDto> allIssueDtos = new ArrayList<>();
        List<FeedbackIssueDto> prioritizedDtos = new ArrayList<>();

        for (WritingFeedbackIssueEntity e : issues) {
            FeedbackIssueDto dto = FeedbackIssueDto.builder()
                    .id(e.getId())
                    .kind(e.getKind())
                    .severity(e.getSeverity())
                    .category(e.getCategory())
                    .patternCode(e.getPatternCode())
                    .title(e.getTitle())
                    .explanation(e.getExplanation())
                    .sourceQuote(e.getSourceQuote())
                    .startOffset(e.getStartOffset())
                    .endOffset(e.getEndOffset())
                    .replacement(e.getReplacement())
                    .teachingRule(e.getTeachingRule())
                    .suggestedPracticeMode(e.getSuggestedPracticeMode())
                    .disposition(e.getDisposition())
                    .priorityRank(e.getPriorityRank())
                    .build();

            allIssueDtos.add(dto);
            if (e.getPriorityRank() != null && e.getPriorityRank() <= 4) {
                prioritizedDtos.add(dto);
            }
        }

        if (prioritizedDtos.isEmpty() && !allIssueDtos.isEmpty()) {
            prioritizedDtos = allIssueDtos.subList(0, Math.min(4, allIssueDtos.size()));
        }

        return DocumentAssessmentResultDto.builder()
                .assessmentId(assessment.getId())
                .submissionId(submission.getId())
                .draftOrdinal(submission.getOrdinal())
                .status(assessment.getStatus())
                .overallScore(assessment.getOverallScore())
                .dimensionVerdicts(verdicts)
                .prioritizedIssues(prioritizedDtos)
                .allIssues(allIssueDtos)
                .strengths(strengths != null ? strengths : Collections.emptyList())
                .summary(summary != null ? summary : assessment.getCoverageSummary())
                .createdAt(assessment.getCreatedAt())
                .build();
    }

    @Override
    @Transactional(readOnly = true)
    public DraftComparisonResultDto compareDrafts(Long userId, String sessionId, String draft1Id, String draft2Id) {
        WritingSessionEntity session = getOwnedSession(sessionId, userId);

        List<WritingSubmissionEntity> drafts = submissionRepository.findBySessionIdOrderByOrdinalAsc(sessionId);
        if (drafts.size() < 2) {
            throw new IllegalArgumentException("Session requires at least two drafts to perform comparison.");
        }

        WritingSubmissionEntity d1;
        WritingSubmissionEntity d2;

        if (draft1Id != null && draft2Id != null) {
            d1 = drafts.stream().filter(d -> d.getId().equals(draft1Id)).findFirst()
                    .orElseThrow(() -> new WritingNotFoundException("Draft 1 not found: " + draft1Id));
            d2 = drafts.stream().filter(d -> d.getId().equals(draft2Id)).findFirst()
                    .orElseThrow(() -> new WritingNotFoundException("Draft 2 not found: " + draft2Id));
        } else {
            d1 = drafts.get(drafts.size() - 2);
            d2 = drafts.get(drafts.size() - 1);
        }

        List<DraftDiffChunkDto> diffChunks = WritingDiffUtil.computeDiff(d1.getContent(), d2.getContent());
        int wordCountChange = (d2.getWordCount() != null ? d2.getWordCount() : 0) -
                              (d1.getWordCount() != null ? d1.getWordCount() : 0);

        int resolvedCount = 0;
        int unresolvedCount = 0;

        Optional<WritingAssessmentEntity> d1AssessmentOpt = assessmentRepository.findBySubmissionId(d1.getId());
        if (d1AssessmentOpt.isPresent()) {
            List<WritingFeedbackIssueEntity> d1Issues = issueRepository.findByAssessmentIdOrderByPriorityRankAsc(d1AssessmentOpt.get().getId());
            for (WritingFeedbackIssueEntity issue : d1Issues) {
                if (issue.getSourceQuote() != null && !issue.getSourceQuote().isBlank()) {
                    if (!d2.getContent().contains(issue.getSourceQuote().trim())) {
                        resolvedCount++;
                    } else {
                        unresolvedCount++;
                    }
                }
            }
        }

        return DraftComparisonResultDto.builder()
                .draft1Id(d1.getId())
                .draft2Id(d2.getId())
                .draft1Ordinal(d1.getOrdinal())
                .draft2Ordinal(d2.getOrdinal())
                .diffChunks(diffChunks)
                .resolvedIssueCount(resolvedCount)
                .unresolvedIssueCount(unresolvedCount)
                .wordCountChange(wordCountChange)
                .build();
    }

    private boolean isAssessmentValidForCurrentSubmission(
            WritingSessionEntity session,
            WritingAssessmentEntity assessment,
            WritingSubmissionEntity submission,
            String currentText
    ) {
        if (session == null || assessment == null || submission == null || currentText == null) {
            return false;
        }
        if (assessment.getStatus() != AssessmentStatus.READY || assessment.getOverallScore() == null) {
            return false;
        }
        if (!Objects.equals(assessment.getSubmissionId(), submission.getId())) {
            return false;
        }
        if (!Objects.equals(submission.getSessionId(), session.getId())) {
            return false;
        }
        if (!Objects.equals(submission.getUserId(), session.getUserId())) {
            return false;
        }
        String normalizedSubmissionText = submission.getContent() == null ? "" : submission.getContent().trim();
        String normalizedCurrentText = currentText.trim();
        return !normalizedCurrentText.isEmpty() && Objects.equals(normalizedSubmissionText, normalizedCurrentText);
    }

    private WritingAssessmentEntity persistAssessment(WritingSessionEntity session, WritingSubmissionEntity submission,
                                                       WritingAssessmentEntity assessment, DocumentAnalysisAiResponse aiResponse,
                                                       Map<String, Object> task) {
        String draftContent = submission.getContent();
        int draftOrdinal = submission.getOrdinal();
        // Canonical Long-Form Assessment: GPT-5.6 Luna structured assessment is the authoritative semantic source.
        // Normalize issues, align verbatim character offsets, and deduplicate without weak heuristic pollution.
        List<FeedbackIssueDto> rawAiIssues = aiResponse.getIssues() != null ? aiResponse.getIssues() : Collections.emptyList();
        List<FeedbackIssueDto> validatedIssuesList = new ArrayList<>();
        Set<String> seenIssueKeys = new HashSet<>();

        for (FeedbackIssueDto issueDto : rawAiIssues) {
            if (issueDto == null) continue;
            String quote = issueDto.getSourceQuote() != null ? issueDto.getSourceQuote().trim() : "";
            int start = issueDto.getStartOffset() != null ? issueDto.getStartOffset() : 0;
            int end = issueDto.getEndOffset() != null ? issueDto.getEndOffset() : start + quote.length();

            if (!quote.isEmpty()) {
                if (start < 0 || end > draftContent.length() || !draftContent.substring(Math.max(0, start), Math.min(draftContent.length(), end)).equals(quote)) {
                    int foundPos = draftContent.indexOf(quote);
                    if (foundPos != -1) {
                        start = foundPos;
                        end = foundPos + quote.length();
                    } else {
                        int lowerPos = draftContent.toLowerCase().indexOf(quote.toLowerCase());
                        if (lowerPos != -1) {
                            start = lowerPos;
                            end = lowerPos + quote.length();
                            quote = draftContent.substring(start, end);
                        } else {
                            start = 0;
                            end = 0;
                        }
                    }
                }
            }

            String rep = issueDto.getReplacement() != null ? issueDto.getReplacement().trim() : "";
            // Reject identical replacement
            if (!quote.isEmpty() && quote.equalsIgnoreCase(rep)) {
                continue;
            }

            // Canonical issue deduplication
            String cat = issueDto.getCategory() != null ? issueDto.getCategory().trim().toLowerCase() : "grammar";
            String dedupKey = start + ":" + end + ":" + cat + ":" + rep.toLowerCase();
            if (seenIssueKeys.contains(dedupKey)) {
                continue;
            }
            seenIssueKeys.add(dedupKey);

            issueDto.setStartOffset(start);
            issueDto.setEndOffset(end);
            issueDto.setSourceQuote(quote);
            validatedIssuesList.add(issueDto);
        }

        List<WritingFeedbackIssueEntity> savedIssues = new ArrayList<>();
        Set<Integer> prioritizedIndices = new HashSet<>(
                aiResponse.getPrioritizedIssueIndices() != null ? aiResponse.getPrioritizedIssueIndices() : Collections.emptyList()
        );

        for (int i = 0; i < validatedIssuesList.size(); i++) {
            FeedbackIssueDto issueDto = validatedIssuesList.get(i);
            int priorityRank = prioritizedIndices.contains(i) ? (savedIssues.size() + 1) : (i + 1);

            WritingFeedbackIssueEntity issueEntity = WritingFeedbackIssueEntity.builder()
                    .id(UUID.randomUUID().toString())
                    .assessmentId(assessment.getId())
                    .kind(issueDto.getKind() != null ? issueDto.getKind() : IssueKind.IMPROVEMENT)
                    .severity(issueDto.getSeverity() != null ? issueDto.getSeverity() : IssueSeverity.MINOR)
                    .category(issueDto.getCategory() != null ? issueDto.getCategory() : "Organization")
                    .patternCode(issueDto.getPatternCode())
                    .title(issueDto.getTitle() != null ? issueDto.getTitle() : "Improvement Suggestion")
                    .explanation(issueDto.getExplanation() != null ? issueDto.getExplanation() : "")
                    .sourceQuote(issueDto.getSourceQuote() != null ? issueDto.getSourceQuote() : "")
                    .startOffset(issueDto.getStartOffset() != null ? issueDto.getStartOffset() : 0)
                    .endOffset(issueDto.getEndOffset() != null ? issueDto.getEndOffset() : 0)
                    .replacement(issueDto.getReplacement())
                    .teachingRule(issueDto.getTeachingRule())
                    .suggestedPracticeMode(issueDto.getSuggestedPracticeMode())
                    .disposition(IssueDisposition.ACTIVE)
                    .priorityRank(priorityRank)
                    .build();

            WritingFeedbackIssueEntity saved = issueRepository.save(issueEntity);
            savedIssues.add(saved);

            if (saved.getKind() == IssueKind.ERROR && saved.getPatternCode() != null) {
                final Long errUserId = session.getUserId();
                final String errAssessmentId = assessment.getId();
                final String errIssueId = saved.getId();
                final String errPattern = saved.getPatternCode();
                final String errSessionId = session.getId();
                runOptionalWriteAfterCommit(
                        () -> errorMemoryService.recordMistakeObservation(
                                errUserId, errAssessmentId, errIssueId, errPattern, errSessionId),
                        "error-pattern:" + errPattern
                );
            }
        }

        // Finalize assessment score
        Integer finalScore = aiResponse.getOverallScore();
        if (finalScore == null && aiResponse.getDimensionVerdicts() != null && !aiResponse.getDimensionVerdicts().isEmpty()) {
            int dimSum = 0;
            int dimCount = 0;
            for (DimensionVerdictDto d : aiResponse.getDimensionVerdicts()) {
                if (d.getScore() != null) {
                    dimSum += d.getScore();
                    dimCount++;
                }
            }
            if (dimCount > 0) {
                finalScore = Math.round((float) dimSum / dimCount);
                log.info("Derived overall score {} from {} dimension scores", finalScore, dimCount);
            }
        }

        assessment.setStatus(AssessmentStatus.READY);
        assessment.setOverallScore(finalScore);
        assessment.setCoverageSummary(aiResponse.getSummary());
        assessment.setCompletedAt(Instant.now());
        assessment.setLeaseToken(null);
        assessment.setLeaseExpiresAt(null);

        try {
            assessment.setStrengths(mapper().writeValueAsString(
                    aiResponse.getStrengths() != null ? aiResponse.getStrengths() : Collections.emptyList()
            ));
            assessment.setDimensionVerdicts(mapper().writeValueAsString(
                    aiResponse.getDimensionVerdicts() != null ? aiResponse.getDimensionVerdicts() : Collections.emptyList()
            ));
        } catch (Exception e) {
            log.error("Failed to serialize document assessment metadata: {}", e.getMessage());
        }

        assessment = assessmentRepository.save(assessment);
        if (eventPublisher != null) eventPublisher.publishEvent(new com.englishcoach.leaderboard.activity.event.WritingAssessmentCompletedEvent(session.getUserId(), session.getId(), submission.getId(), assessment.getId(), session.getTaskId(), assessment.getOverallScore(), draftOrdinal, Instant.now()));

        // Productive use vocabulary evidence
        Object targetWordsObj = task.get("targetWords");
        if (targetWordsObj instanceof List<?> targetWordList) {
            String lowerDraft = draftContent.toLowerCase();
            for (Object item : targetWordList) {
                if (item instanceof String word && !word.isBlank()) {
                    if (lowerDraft.matches("(?s).*\\b" + java.util.regex.Pattern.quote(word.toLowerCase()) + "\\b.*")) {
                        WritingLearningEvidenceEntity evidence = WritingLearningEvidenceEntity.builder()
                                .id(UUID.randomUUID().toString())
                                .userId(session.getUserId())
                                .skillCode("VOCABULARY")
                                .patternCode("TARGET_WORD:" + word.toUpperCase())
                                .evidenceType(EvidenceType.INDEPENDENT_DRAFT)
                                .isPositive(true)
                                .weight(1.0)
                                .sourceAssessmentId(assessment.getId())
                                .contextId(session.getId())
                                .recordedAt(Instant.now())
                                .build();
                        final String matchedWord = word;
                        final String evidenceSessionId = session.getId();
                        runOptionalWriteAfterCommit(() -> {
                            evidenceRepository.save(evidence);
                            log.info("Recorded productive-use evidence for target word '{}' in session {}", matchedWord, evidenceSessionId);
                        }, "productive-use:" + matchedWord);
                    }
                }
            }
        }

        return assessment;
    }

    /**
     * Isolates optional side-effect writes (error memory / productive-use vocabulary evidence) from the primary
     * grading transaction so a constraint error or transient failure can NEVER abort PostgreSQL's transaction (25P02)
     * or roll back a paid essay assessment, while also avoiding nested REQUIRES_NEW pool deadlocks.
     */
    private void runOptionalWriteAfterCommit(Runnable work, String label) {
        Runnable isolated = () -> {
            try {
                if (gradingTransactionManager != null) {
                    org.springframework.transaction.support.TransactionTemplate isolatedTx =
                            new org.springframework.transaction.support.TransactionTemplate(gradingTransactionManager);
                    isolatedTx.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
                    isolatedTx.executeWithoutResult(status -> work.run());
                } else {
                    work.run();
                }
            } catch (Exception e) {
                log.warn("Optional writing side-effect failed ({}): {}", label, e.getMessage());
            }
        };
        if (org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()
                && org.springframework.transaction.support.TransactionSynchronizationManager.isSynchronizationActive()) {
            org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(
                    new org.springframework.transaction.support.TransactionSynchronization() {
                        @Override
                        public void afterCommit() {
                            isolated.run();
                        }
                    });
        } else {
            isolated.run();
        }
    }

    @Override
    public WritingSessionDto completeSession(Long userId, String sessionId, CompleteSessionRequest request) {
        var tx = new org.springframework.transaction.support.TransactionTemplate(gradingTransactionManager);
        Long revision = tx.execute(status -> {
            checkMutationsEnabled();
            var session = lockSession(sessionId, userId);
            return completeFromHistory(session, userId, sessionId, request) ? null : session.getCurrentRevision();
        });
        if (revision != null) gradeDraft(userId, sessionId, revision, null, true);
        return tx.execute(status -> toSessionDto(lockSession(sessionId, userId)));
    }

    private boolean completeFromHistory(WritingSessionEntity session, Long userId, String sessionId, CompleteSessionRequest request) {
        if (session.getStage() == WritingSessionStage.COMPLETED) {
            return true;
        }
        if (request != null && request.getExpectedRevision() != null &&
                !Objects.equals(session.getCurrentRevision(), request.getExpectedRevision()) &&
                !Objects.equals(session.getCurrentRevision() - 1, request.getExpectedRevision())) {
            throw new WritingConflictException("Revision conflict on session completion: current=" +
                    session.getCurrentRevision() + ", expected=" + request.getExpectedRevision());
        }

        String currentText = session.getWorkingText() == null ? "" : session.getWorkingText().trim();
        if (currentText.isEmpty()) {
            throw new IllegalArgumentException("Draft content cannot be empty.");
        }

        List<WritingSubmissionEntity> drafts = submissionRepository.findBySessionIdOrderByOrdinalAsc(sessionId);
        WritingSubmissionEntity targetSubmission = null;
        WritingAssessmentEntity targetAssessment = null;

        // Check if the latest submission already matches and has a valid assessment
        if (!drafts.isEmpty()) {
            WritingSubmissionEntity latestDraft = drafts.get(drafts.size() - 1);
            Optional<WritingAssessmentEntity> latestAssessOpt = assessmentRepository.findBySubmissionId(latestDraft.getId());
            if (latestAssessOpt.isPresent() && isAssessmentValidForCurrentSubmission(session, latestAssessOpt.get(), latestDraft, currentText)) {
                targetSubmission = latestDraft;
                targetAssessment = latestAssessOpt.get();
                log.info("Reusing valid assessment {} for latest submission {} in session {}",
                        targetAssessment.getId(), targetSubmission.getId(), sessionId);
            }
        }

        // If not found on latest draft, check any earlier draft that has identical content with a valid assessment
        if (targetAssessment == null) {
            for (int i = drafts.size() - 1; i >= 0; i--) {
                WritingSubmissionEntity draft = drafts.get(i);
                Optional<WritingAssessmentEntity> assessOpt = assessmentRepository.findBySubmissionId(draft.getId());
                if (assessOpt.isPresent() && isAssessmentValidForCurrentSubmission(session, assessOpt.get(), draft, currentText)) {
                    // Legitimate content reuse: text is completely identical to prior evaluated draft!
                    targetSubmission = draft;
                    targetAssessment = assessOpt.get();
                    break;
                }
            }
        }

        if (targetAssessment == null) return false;

        // Verify valid assessment identity before completion
        if (targetAssessment == null || targetAssessment.getStatus() != AssessmentStatus.READY || targetAssessment.getOverallScore() == null) {
            throw new WritingAiServiceException("Đánh giá bài viết chưa hoàn tất. Bản nháp đã được lưu; vui lòng thử lại.");
        }
        if (!Objects.equals(targetAssessment.getSubmissionId(), targetSubmission.getId())) {
            throw new IllegalStateException("Assessment submission ID mismatch: assessment=" +
                    targetAssessment.getSubmissionId() + ", submission=" + targetSubmission.getId());
        }

        session.setActiveAssessmentId(targetAssessment.getId());
        session.setFinalDraftId(targetSubmission.getId());
        session.setStage(WritingSessionStage.COMPLETED);
        session.setCompletedAt(Instant.now());
        session.setCurrentRevision(session.getCurrentRevision() + 1);
        session = sessionRepository.save(session);

        log.info("Successfully completed session {} with finalDraftId {} and assessmentId {}",
                sessionId, session.getFinalDraftId(), session.getActiveAssessmentId());

        return true;
    }

    @Override
    @Transactional
    public WritingSessionDto setFavorite(Long userId, String sessionId, boolean isFavorite) {
        checkMutationsEnabled();
        WritingSessionEntity session = getOwnedSession(sessionId, userId);
        session.setIsFavorite(isFavorite);
        session = sessionRepository.save(session);
        return toSessionDto(session);
    }

    @Override
    @Transactional(readOnly = true)
    public List<PortfolioSummaryItemDto> getPortfolio(Long userId, String stateFilter, Boolean favoriteOnly) {
        checkEnabled();
        List<WritingSessionEntity> sessions;
        if ("completed".equalsIgnoreCase(stateFilter)) {
            sessions = sessionRepository.findByUserIdAndStageOrderByUpdatedAtDesc(userId, WritingSessionStage.COMPLETED);
        } else if ("in-progress".equalsIgnoreCase(stateFilter)) {
            sessions = sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId).stream()
                    .filter(s -> s.getStage() != WritingSessionStage.COMPLETED)
                    .toList();
        } else {
            sessions = sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId);
        }

        if (Boolean.TRUE.equals(favoriteOnly)) {
            sessions = sessions.stream().filter(s -> Boolean.TRUE.equals(s.getIsFavorite())).toList();
        }
        if (sessions.isEmpty()) {
            return Collections.emptyList();
        }

        // Batch 1: All submissions across sessions in 1 query (instead of N per-session queries)
        List<String> sessionIds = sessions.stream().map(WritingSessionEntity::getId).toList();
        Map<String, List<WritingSubmissionEntity>> draftsBySession = new HashMap<>(sessionIds.size());
        List<WritingSubmissionEntity> allSubmissions =
                submissionRepository.findBySessionIdInOrderBySessionIdAscOrdinalAsc(sessionIds);
        if (allSubmissions != null) {
            for (WritingSubmissionEntity sub : allSubmissions) {
                if (sub != null && sub.getSessionId() != null) {
                    draftsBySession.computeIfAbsent(sub.getSessionId(), k -> new ArrayList<>()).add(sub);
                }
            }
        }

        // Collect all first/final draft submission IDs and active assessment IDs needed
        Set<String> neededSubmissionIds = new LinkedHashSet<>();
        Set<String> neededActiveAssessmentIds = new LinkedHashSet<>();
        for (WritingSessionEntity s : sessions) {
            List<WritingSubmissionEntity> drafts = draftsBySession.getOrDefault(s.getId(), Collections.emptyList());
            boolean hasWorkingText = s.getWorkingText() != null && !s.getWorkingText().isBlank();
            if (drafts.isEmpty() && !hasWorkingText && s.getStage() != WritingSessionStage.COMPLETED) {
                continue;
            }
            if (s.getActiveAssessmentId() != null) {
                neededActiveAssessmentIds.add(s.getActiveAssessmentId());
            }
            if (!drafts.isEmpty()) {
                neededSubmissionIds.add(drafts.get(0).getId());
                neededSubmissionIds.add(drafts.get(drafts.size() - 1).getId());
            }
        }

        // Batch 2: All relevant assessments by submissionId and by activeAssessmentId
        Map<String, WritingAssessmentEntity> assessmentBySubmissionId = new HashMap<>();
        Map<String, WritingAssessmentEntity> assessmentById = new HashMap<>();
        if (!neededSubmissionIds.isEmpty()) {
            List<WritingAssessmentEntity> subAssessments = assessmentRepository.findBySubmissionIdIn(neededSubmissionIds);
            if (subAssessments != null) {
                for (WritingAssessmentEntity a : subAssessments) {
                    if (a != null) {
                        if (a.getSubmissionId() != null) {
                            assessmentBySubmissionId.putIfAbsent(a.getSubmissionId(), a);
                        }
                        if (a.getId() != null) {
                            assessmentById.put(a.getId(), a);
                        }
                    }
                }
            }
        }
        Set<String> missingActiveIds = new LinkedHashSet<>();
        for (String activeId : neededActiveAssessmentIds) {
            if (!assessmentById.containsKey(activeId)) {
                missingActiveIds.add(activeId);
            }
        }
        if (!missingActiveIds.isEmpty()) {
            Iterable<WritingAssessmentEntity> activeAssessments = assessmentRepository.findAllById(missingActiveIds);
            if (activeAssessments != null) {
                for (WritingAssessmentEntity a : activeAssessments) {
                    if (a != null && a.getId() != null) {
                        assessmentById.put(a.getId(), a);
                    }
                }
            }
        }

        // Batch 3: Single GROUP BY assessment_id error issue count query
        Set<String> assessmentIdsForCounts = new LinkedHashSet<>();
        for (WritingSessionEntity s : sessions) {
            List<WritingSubmissionEntity> drafts = draftsBySession.getOrDefault(s.getId(), Collections.emptyList());
            if (!drafts.isEmpty()) {
                WritingAssessmentEntity firstAssess = assessmentBySubmissionId.get(drafts.get(0).getId());
                if (firstAssess != null && firstAssess.getId() != null) {
                    assessmentIdsForCounts.add(firstAssess.getId());
                }
                if (s.getActiveAssessmentId() != null) {
                    assessmentIdsForCounts.add(s.getActiveAssessmentId());
                } else {
                    WritingAssessmentEntity finalAssess = assessmentBySubmissionId.get(drafts.get(drafts.size() - 1).getId());
                    if (finalAssess != null && finalAssess.getId() != null) {
                        assessmentIdsForCounts.add(finalAssess.getId());
                    }
                }
            }
        }
        Map<String, Integer> errorCountByAssessmentId = new HashMap<>();
        if (!assessmentIdsForCounts.isEmpty()) {
            List<Object[]> countRows = issueRepository.countErrorIssuesByAssessmentIdIn(assessmentIdsForCounts);
            if (countRows != null) {
                for (Object[] row : countRows) {
                    if (row != null && row.length >= 2 && row[0] instanceof String aId && row[1] instanceof Number cnt) {
                        errorCountByAssessmentId.put(aId, cnt.intValue());
                    }
                }
            }
        }

        List<PortfolioSummaryItemDto> items = new ArrayList<>();
        for (WritingSessionEntity s : sessions) {
            List<WritingSubmissionEntity> drafts = draftsBySession.getOrDefault(s.getId(), Collections.emptyList());
            int draftCount = drafts.size();
            boolean hasWorkingText = s.getWorkingText() != null && !s.getWorkingText().isBlank();

            // Prevent abandoned empty sessions from polluting the portfolio as duplicate blank cards
            if (draftCount == 0 && !hasWorkingText && s.getStage() != WritingSessionStage.COMPLETED) {
                continue;
            }

            Map<String, Object> task = parseTaskSnapshot(s.getTaskSnapshot());
            String title = (String) task.getOrDefault("title", "Untitled Session");
            String cat = (String) task.getOrDefault("category", "General");

            Integer overallScore = null;
            if (s.getActiveAssessmentId() != null) {
                WritingAssessmentEntity activeAssess = assessmentById.get(s.getActiveAssessmentId());
                if (activeAssess != null) {
                    overallScore = activeAssess.getOverallScore();
                }
            }

            int wordCount = 0;
            if (hasWorkingText) {
                wordCount = s.getWorkingText().trim().split("\\s+").length;
            } else if (!drafts.isEmpty()) {
                WritingSubmissionEntity latestDraft = drafts.get(drafts.size() - 1);
                wordCount = latestDraft.getWordCount() != null ? latestDraft.getWordCount() :
                        (latestDraft.getContent() != null ? latestDraft.getContent().trim().split("\\s+").length : 0);
            }

            // Extract real persisted before / after evidence across drafts
            String firstDraftPreview = null;
            String finalDraftPreview = null;
            Integer firstDraftWordCount = null;
            Integer finalDraftWordCount = null;
            Integer firstDraftScore = null;
            Integer finalDraftScore = overallScore;
            Integer firstDraftIssueCount = null;
            Integer finalDraftIssueCount = null;

            if (!drafts.isEmpty()) {
                WritingSubmissionEntity firstDraft = drafts.get(0);
                firstDraftPreview = firstDraft.getContent();
                firstDraftWordCount = firstDraft.getWordCount() != null ? firstDraft.getWordCount() :
                        (firstDraft.getContent() != null ? firstDraft.getContent().trim().split("\\s+").length : 0);
                WritingAssessmentEntity firstAssess = assessmentBySubmissionId.get(firstDraft.getId());
                if (firstAssess != null) {
                    firstDraftScore = firstAssess.getOverallScore();
                    firstDraftIssueCount = errorCountByAssessmentId.getOrDefault(firstAssess.getId(), 0);
                }

                WritingSubmissionEntity finalDraft = drafts.get(drafts.size() - 1);
                finalDraftPreview = (s.getWorkingText() != null && !s.getWorkingText().isBlank()) ? s.getWorkingText() : finalDraft.getContent();
                finalDraftWordCount = wordCount;
                if (finalDraftScore == null) {
                    WritingAssessmentEntity finalAssess = assessmentBySubmissionId.get(finalDraft.getId());
                    if (finalAssess != null) {
                        finalDraftScore = finalAssess.getOverallScore();
                        finalDraftIssueCount = errorCountByAssessmentId.getOrDefault(finalAssess.getId(), 0);
                    }
                } else if (s.getActiveAssessmentId() != null) {
                    finalDraftIssueCount = errorCountByAssessmentId.getOrDefault(s.getActiveAssessmentId(), 0);
                }
            } else if (hasWorkingText) {
                firstDraftPreview = s.getWorkingText();
                finalDraftPreview = s.getWorkingText();
                firstDraftWordCount = wordCount;
                finalDraftWordCount = wordCount;
                finalDraftScore = overallScore;
            }

            items.add(PortfolioSummaryItemDto.builder()
                    .sessionId(s.getId())
                    .taskId(s.getTaskId())
                    .taskTitle(title)
                    .category(cat)
                    .stage(s.getStage())
                    .draftCount(draftCount)
                    .isFavorite(s.getIsFavorite())
                    .completedAt(s.getCompletedAt())
                    .updatedAt(s.getUpdatedAt())
                    .wordCount(wordCount)
                    .overallScore(overallScore)
                    .firstDraftPreview(firstDraftPreview)
                    .finalDraftPreview(finalDraftPreview)
                    .firstDraftWordCount(firstDraftWordCount)
                    .finalDraftWordCount(finalDraftWordCount)
                    .firstDraftScore(firstDraftScore)
                    .finalDraftScore(finalDraftScore)
                    .firstDraftIssueCount(firstDraftIssueCount)
                    .finalDraftIssueCount(finalDraftIssueCount)
                    .build());
        }
        return items;
    }

    @Override
    @Transactional(readOnly = true)
    public ForYouDashboardDto getForYou(Long userId) {
        checkEnabled();

        // 1. Resumable Session (most recent non-completed)
        WritingSessionDto continueSession = sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId).stream()
                .filter(s -> s.getStage() != WritingSessionStage.COMPLETED)
                .findFirst()
                .map(this::toSessionDto)
                .orElse(null);

        // 2. Recommended due practice from longitudinal error memory
        Map<String, Object> recommendedPractice = null;
        boolean isCurriculum = false;
        List<WritingErrorMemoryEntity> dueMemories = errorMemoryRepository.findByUserIdAndDueForPracticeTrueOrderByNextPracticeDueAtAsc(userId);
        if (!dueMemories.isEmpty()) {
            WritingErrorMemoryEntity due = dueMemories.get(0);
            recommendedPractice = Map.of(
                    "patternCode", due.getPatternCode(),
                    "patternTitle", due.getTitle(),
                    "suggestedMode", "REPAIR",
                    "dueReason", "Spaced repetition review due",
                    "isCurriculum", false
            );
        } else {
            List<WritingErrorMemoryEntity> topPatterns = errorMemoryRepository.findByUserIdAndIsMutedFalseOrderByOccurrenceCountDesc(userId);
            if (!topPatterns.isEmpty()) {
                WritingErrorMemoryEntity top = topPatterns.get(0);
                recommendedPractice = Map.of(
                        "patternCode", top.getPatternCode(),
                        "patternTitle", top.getTitle(),
                        "suggestedMode", "REPAIR",
                        "dueReason", "Strengthen key focus pattern",
                        "isCurriculum", false
                );
            } else {
                isCurriculum = true;
                recommendedPractice = Map.of(
                        "patternCode", "ARTICLE_MISSING_BEFORE_SINGULAR_COUNT_NOUN",
                        "patternTitle", "Missing Article Before Singular Count Noun",
                        "suggestedMode", "REPAIR",
                        "dueReason", "Essential starter practice",
                        "isCurriculum", true
                );
            }
        }

        // 3. Recommended Task from Catalog
        List<Map<String, Object>> tasks = catalogService.getTasks();
        Map<String, Object> recommendedTask = tasks.isEmpty() ? Collections.emptyMap() : tasks.get(0);

        // 4. Active Focus Patterns
        List<WritingErrorMemoryEntity> activeEntities = errorMemoryRepository.findByUserIdAndIsMutedFalseOrderByOccurrenceCountDesc(userId);
        List<ErrorMemoryDto> activeDtos = new ArrayList<>();
        for (int i = 0; i < Math.min(5, activeEntities.size()); i++) {
            WritingErrorMemoryEntity m = activeEntities.get(i);
            activeDtos.add(ErrorMemoryDto.builder()
                    .id(m.getId())
                    .patternCode(m.getPatternCode())
                    .category(m.getCategory())
                    .title(m.getTitle())
                    .occurrenceCount(m.getOccurrenceCount())
                    .contextCount(m.getContextCount())
                    .lastSeenAt(m.getLastSeenAt())
                    .estimatedMastery(m.getEstimatedMastery())
                    .hasSufficientEvidence(m.getHasSufficientEvidence())
                    .dueForPractice(m.getDueForPractice())
                    .nextPracticeDueAt(m.getNextPracticeDueAt())
                    .isMuted(m.getIsMuted())
                    .build());
        }

        // 5. Authentic Calendar Week Calculations (UTC Mon-Sun)
        java.time.ZonedDateTime nowZoned = java.time.ZonedDateTime.now(java.time.ZoneOffset.UTC);
        java.time.ZonedDateTime startOfWeekZoned = nowZoned.with(java.time.temporal.TemporalAdjusters.previousOrSame(java.time.DayOfWeek.MONDAY))
                .truncatedTo(java.time.temporal.ChronoUnit.DAYS);
        Instant startOfWeek = startOfWeekZoned.toInstant();
        Instant startOfToday = nowZoned.truncatedTo(java.time.temporal.ChronoUnit.DAYS).toInstant();
        int todayDowVal = nowZoned.getDayOfWeek().getValue(); // 1 = Mon, 7 = Sun

        // Actual words written in drafts this week
        List<WritingSubmissionEntity> allWeeklyDrafts = submissionRepository.findByUserIdAndKindOrderByCreatedAtDesc(userId, SubmissionKind.COACH_DRAFT).stream()
                .filter(sub -> sub.getCreatedAt() != null && !sub.getCreatedAt().isBefore(startOfWeek))
                .toList();

        int weeklyWords = 0;
        Map<Integer, Integer> dowWordCounts = new HashMap<>();
        Set<String> activeDays = new HashSet<>();
        java.time.format.DateTimeFormatter dayFormatter = java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(java.time.ZoneOffset.UTC);

        for (WritingSubmissionEntity sub : allWeeklyDrafts) {
            int words = sub.getWordCount() != null ? sub.getWordCount() :
                    (sub.getContent() != null && !sub.getContent().isBlank() ? sub.getContent().trim().split("\\s+").length : 0);
            weeklyWords += words;

            java.time.ZonedDateTime subTime = sub.getCreatedAt().atZone(java.time.ZoneOffset.UTC);
            int dow = subTime.getDayOfWeek().getValue();
            dowWordCounts.put(dow, dowWordCounts.getOrDefault(dow, 0) + words);
            activeDays.add(dayFormatter.format(sub.getCreatedAt()));
        }

        // Build authentic Mon-Sun daily breakdown
        String[] dayCodes = {"T2", "T3", "T4", "T5", "T6", "T7", "CN"};
        String[] dayNames = {"Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "Chủ nhật"};
        List<DailyWordCountDto> dailyBreakdown = new ArrayList<>();
        for (int i = 1; i <= 7; i++) {
            dailyBreakdown.add(DailyWordCountDto.builder()
                    .dayCode(dayCodes[i - 1])
                    .dayName(dayNames[i - 1])
                    .dayOfWeek(i)
                    .wordCount(dowWordCounts.getOrDefault(i, 0))
                    .isToday(i == todayDowVal)
                    .isPast(i < todayDowVal)
                    .build());
        }

        // Real practice episodes completed today
        long completedToday = practiceRepository.findByUserIdOrderByCreatedAtDesc(userId).stream()
                .filter(p -> Boolean.TRUE.equals(p.getIsCompleted()))
                .filter(p -> p.getUpdatedAt() != null && !p.getUpdatedAt().isBefore(startOfToday))
                .count();

        // Weekly evidence count (last 7 days)
        Instant weekAgo = Instant.now().minus(7, java.time.temporal.ChronoUnit.DAYS);
        long weeklyCount = evidenceRepository.countByUserIdAndRecordedAtAfter(userId, weekAgo);

        return ForYouDashboardDto.builder()
                .continueSession(continueSession)
                .recommendedDuePractice(recommendedPractice)
                .recommendedTask(recommendedTask)
                .activeFocusPatterns(activeDtos)
                .weeklyEvidenceCount(weeklyCount)
                .weeklyWordsWritten(weeklyWords)
                .weeklyTargetWords(1500)
                .daysCompletedThisWeek(activeDays.size())
                .completedPracticesToday((int) completedToday)
                .targetPracticesDaily(3)
                .dailyWordCounts(dailyBreakdown)
                .isCurriculumRecommendation(isCurriculum)
                .build();
    }

    @Override
    @Transactional(readOnly = true)
    public WritingSessionDetailDto getSessionDetail(Long userId, String sessionId) {
        checkEnabled();
        WritingSessionEntity session = getOwnedSession(sessionId, userId);
        Map<String, Object> task = parseTaskSnapshot(session.getTaskSnapshot());
        if (task.isEmpty()) {
            task = catalogService.getTaskById(userId, session.getTaskId()).orElse(Collections.emptyMap());
        }

        List<WritingSubmissionEntity> draftEntities = submissionRepository.findBySessionIdOrderByOrdinalAsc(sessionId);
        List<WritingSessionDetailDto.DraftSummaryDto> draftSummaries = new ArrayList<>();
        WritingAssessmentEntity latestAssessmentEntity = null;

        for (WritingSubmissionEntity draft : draftEntities) {
            Integer score = null;
            String aId = null;
            Optional<WritingAssessmentEntity> aOpt = assessmentRepository.findBySubmissionId(draft.getId());
            if (aOpt.isPresent()) {
                score = aOpt.get().getOverallScore();
                aId = aOpt.get().getId();
                latestAssessmentEntity = aOpt.get();
            }
            draftSummaries.add(WritingSessionDetailDto.DraftSummaryDto.builder()
                    .id(draft.getId())
                    .ordinal(draft.getOrdinal())
                    .content(draft.getContent())
                    .wordCount(draft.getWordCount())
                    .createdAt(draft.getCreatedAt())
                    .overallScore(score)
                    .assessmentId(aId)
                    .build());
        }

        if (session.getActiveAssessmentId() != null) {
            Optional<WritingAssessmentEntity> aOpt = assessmentRepository.findById(session.getActiveAssessmentId());
            if (aOpt.isPresent()) {
                latestAssessmentEntity = aOpt.get();
            }
        }

        DocumentAssessmentResultDto finalAssessmentDto = null;
        if (latestAssessmentEntity != null) {
            List<WritingFeedbackIssueEntity> issues = issueRepository.findByAssessmentIdOrderByPriorityRankAsc(latestAssessmentEntity.getId());
            List<String> strengths = Collections.emptyList();
            try {
                if (latestAssessmentEntity.getStrengths() != null) {
                    strengths = mapper().readValue(latestAssessmentEntity.getStrengths(), new TypeReference<>() {});
                }
            } catch (Exception ignored) {}

            WritingSubmissionEntity sub = submissionRepository.findById(latestAssessmentEntity.getSubmissionId()).orElse(null);
            if (sub != null) {
                finalAssessmentDto = buildDocumentResultDto(sub, latestAssessmentEntity, issues, strengths, latestAssessmentEntity.getCoverageSummary());
            }
        }

        return WritingSessionDetailDto.builder()
                .session(toSessionDto(session))
                .task(task)
                .drafts(draftSummaries)
                .finalAssessment(finalAssessmentDto)
                .build();
    }
}
