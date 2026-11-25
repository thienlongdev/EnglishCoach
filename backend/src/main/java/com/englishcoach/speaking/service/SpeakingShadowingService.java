package com.englishcoach.speaking.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.speaking.dto.*;
import com.englishcoach.speaking.entity.SpeakingSession;
import com.englishcoach.speaking.entity.SpeakingShadowingAttempt;
import com.englishcoach.speaking.entity.SpeakingShadowingUnit;
import com.englishcoach.speaking.repository.SpeakingSessionRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository;
import com.englishcoach.speaking.repository.SpeakingShadowingUnitRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.*;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
@Slf4j
public class SpeakingShadowingService {

    private final SpeakingShadowingAttemptRepository attemptRepository;
    private final SpeakingShadowingUnitRepository unitRepository;
    private final SpeakingSessionRepository sessionRepository;
    private final UserRepository userRepository;
    private final SpeakingShadowingUnitService unitService;
    private final ObjectMapper objectMapper;
    private final ShadowingAnalysisReceipts receipts;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.context.ApplicationEventPublisher eventPublisher;

    @Transactional
    public ShadowingSessionStateDto getOrCreateActiveSession(Long userId, Long materialId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required");
        }

        User user = userRepository.findById(userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found: " + userId));

        // 1. Look for existing active session for this user and material
        Optional<SpeakingSession> activeOpt = sessionRepository.findFirstByUserIdAndModeAndSourceIdAndStatusOrderByCreatedAtDesc(
                userId, "SHADOWING", materialId, "ACTIVE"
        );

        if (activeOpt.isPresent()) {
            log.info("Resuming existing active Shadowing session {} for user {} on material {}", activeOpt.get().getId(), userId, materialId);
            return getSessionState(userId, activeOpt.get().getId());
        }

        // 2. Fetch or generate authoritative units for the material
        List<SpeakingShadowingUnitDto> units = unitService.getOrGenerateUnits(materialId, userId);
        int totalUnits = units != null ? units.size() : 0;

        SpeakingSession newSession = SpeakingSession.builder()
                .user(user)
                .mode("SHADOWING")
                .status("ACTIVE")
                .sourceType("LISTENING")
                .sourceId(materialId)
                .currentUnitIndex(0)
                .completedUnitsCount(0)
                .totalUnitsCount(totalUnits)
                .build();

        SpeakingSession saved = sessionRepository.save(newSession);
        log.info("Created new durable Shadowing session {} for user {} with {} total units", saved.getId(), userId, totalUnits);
        return getSessionState(userId, saved.getId());
    }

    @Transactional(readOnly = true)
    public ShadowingSessionStateDto getSessionState(Long userId, Long sessionId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required");
        }

        SpeakingSession session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking session not found: " + sessionId));

        if (!session.getUser().getId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Session does not belong to the authenticated user");
        }

        List<SpeakingShadowingAttempt> attempts = attemptRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
        List<SpeakingShadowingAttemptDto> attemptDtos = attempts.stream().map(this::mapToDto).collect(Collectors.toList());

        // Find active unit ID based on currentUnitIndex
        Long activeUnitId = null;
        if (session.getSourceId() != null) {
            List<SpeakingShadowingUnitDto> units = unitService.getOrGenerateUnits(session.getSourceId(), userId);
            if (units != null && !units.isEmpty()) {
                int curIdx = session.getCurrentUnitIndex() != null ? session.getCurrentUnitIndex() : 0;
                if (curIdx < units.size()) {
                    activeUnitId = units.get(curIdx).id();
                } else if (!units.isEmpty()) {
                    activeUnitId = units.get(units.size() - 1).id();
                }
            }
        }

        // Reconstruct unit states from attempts and session progress
        Map<Long, String> unitStates = new HashMap<>();
        for (SpeakingShadowingAttempt a : attempts) {
            if (a.getShadowingUnit() != null) {
                Long uId = a.getShadowingUnit().getId();
                if (Boolean.TRUE.equals(a.getResolvedThisSession())) {
                    unitStates.put(uId, "RESOLVED_THIS_SESSION");
                } else if (!unitStates.containsKey(uId) || "NOT_STARTED".equals(unitStates.get(uId))) {
                    unitStates.put(uId, "IN_PROGRESS");
                }
            }
        }

        // Get latest active attempt & rehydrate ECSM result without re-inference
        SpeakingShadowingAttemptDto activeAttemptDto = null;
        EcsmAnalysisResponseDto rehydratedResult = null;
        if (!attempts.isEmpty()) {
            SpeakingShadowingAttempt latest = attempts.get(attempts.size() - 1);
            activeAttemptDto = mapToDto(latest);
            String contractVersion = latest.getProductContractVersion();
            boolean isEcsmPayload = contractVersion == null || contractVersion.startsWith("ECSM_");
            if (isEcsmPayload && latest.getProductSafeResultJson() != null && !latest.getProductSafeResultJson().isBlank()) {
                try {
                    rehydratedResult = objectMapper.readValue(latest.getProductSafeResultJson(), EcsmAnalysisResponseDto.class);
                } catch (Exception e) {
                    log.warn("Failed to deserialize productSafeResultJson for attempt {}: {}", latest.getId(), e.getMessage());
                }
            }
        }

        return new ShadowingSessionStateDto(
                session.getId(),
                session.getStatus(),
                session.getMode(),
                session.getSourceType(),
                session.getSourceId(),
                session.getCurrentUnitIndex() != null ? session.getCurrentUnitIndex() : 0,
                session.getCompletedUnitsCount() != null ? session.getCompletedUnitsCount() : 0,
                session.getTotalUnitsCount() != null ? session.getTotalUnitsCount() : 0,
                activeUnitId,
                session.getActiveTargetId(),
                activeAttemptDto,
                unitStates,
                rehydratedResult,
                attemptDtos,
                session.getCreatedAt(),
                session.getUpdatedAt()
        );
    }

    @Transactional
    public SpeakingShadowingAttemptDto recordEcsmAttempt(
            Long userId,
            Long sessionId,
            Long unitId,
            String clientAttemptId,
            String parentAttemptId,
            String activeTargetId,
            EcsmAnalysisResponseDto ecsmResponse) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required");
        }

        SpeakingSession session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking session not found: " + sessionId));

        if (session.getUser() == null || !session.getUser().getId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Session does not belong to the authenticated user");
        }

        // Idempotency check: if clientAttemptId already recorded, return existing
        Optional<SpeakingShadowingAttempt> existing = attemptRepository.findBySessionIdAndClientAttemptId(sessionId, clientAttemptId);
        if (existing.isPresent()) {
            log.info("Idempotent ECSM attempt hit for session {} and clientAttemptId {}", sessionId, clientAttemptId);
            return mapToDto(existing.get());
        }

        SpeakingShadowingUnit unit = null;
        if (unitId != null) {
            unit = unitRepository.findById(unitId).orElse(null);
        }

        // Calculate retryIndex based on parent attempt
        int retryIndex = 0;
        if (parentAttemptId != null && !parentAttemptId.isBlank()) {
            Optional<SpeakingShadowingAttempt> parentOpt = attemptRepository.findBySessionIdAndClientAttemptId(sessionId, parentAttemptId);
            if (parentOpt.isPresent()) {
                retryIndex = (parentOpt.get().getRetryIndex() != null ? parentOpt.get().getRetryIndex() : 0) + 1;
            }
        }

        // Extract P9 target & retry comparison metadata
        String primaryIssueType = null;
        String targetWord = null;
        if (ecsmResponse.getRetryPlan() != null) {
            Object primaryTargetObj = ecsmResponse.getRetryPlan().get("primary_target");
            if (primaryTargetObj instanceof Map<?, ?> ptMap) {
                if (ptMap.get("issue_type") != null) {
                    primaryIssueType = ptMap.get("issue_type").toString();
                }
                if (ptMap.get("word") != null) {
                    targetWord = ptMap.get("word").toString();
                }
            }
        }

        String retryComparisonState = null;
        boolean resolvedThisSession = false;
        if (ecsmResponse.getRetryComparison() != null) {
            Object compStateObj = ecsmResponse.getRetryComparison().get("comparison_state");
            if (compStateObj != null) {
                retryComparisonState = compStateObj.toString();
            }
            Object resObj = ecsmResponse.getRetryComparison().get("resolved_this_session");
            if (resObj instanceof Boolean b) {
                resolvedThisSession = b;
            } else if (resObj != null) {
                resolvedThisSession = Boolean.parseBoolean(resObj.toString());
            }
        }

        String artifactSetId = "ECSM_SET_763dbff94d6483d9";
        if (ecsmResponse.getProvenance() != null && ecsmResponse.getProvenance().get("artifact_set_id") != null) {
            artifactSetId = ecsmResponse.getProvenance().get("artifact_set_id").toString();
        }

        String productSafeJson = null;
        try {
            productSafeJson = objectMapper.writeValueAsString(ecsmResponse);
        } catch (Exception e) {
            log.warn("Failed to serialize product safe response for attempt {}: {}", clientAttemptId, e.getMessage());
        }

        SpeakingShadowingAttempt attempt = SpeakingShadowingAttempt.builder()
                .user(session.getUser())
                .session(session)
                .shadowingUnit(unit)
                .clientAttemptId(clientAttemptId)
                .parentAttemptId(parentAttemptId)
                .retryIndex(retryIndex)
                .activeTargetId(activeTargetId)
                .primaryIssueType(primaryIssueType)
                .targetWord(targetWord)
                .retryComparisonState(retryComparisonState)
                .resolvedThisSession(resolvedThisSession)
                .analysisStatus(ecsmResponse.getAssessmentStatus() != null ? ecsmResponse.getAssessmentStatus() : "COMPLETED")
                .productSafeResultJson(productSafeJson)
                .productContractVersion("ECSM_PRODUCT_CONTRACT_v1.0")
                .artifactSetId(artifactSetId)
                .isMocked(false)
                .build();

        SpeakingShadowingAttempt saved = attemptRepository.save(attempt);

        // Update session state
        session.setActiveAttemptId(clientAttemptId);
        if (activeTargetId != null) {
            session.setActiveTargetId(activeTargetId);
        }
        sessionRepository.save(session);

        log.info("Durable ECSM attempt {} saved for session {} (retryIndex={}, resolvedThisSession={})",
                saved.getClientAttemptId(), sessionId, retryIndex, resolvedThisSession);

        return mapToDto(saved);
    }

    @Transactional
    public ShadowingSessionStateDto advanceSessionUnit(Long userId, Long sessionId, Long unitId, String action) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required");
        }

        SpeakingSession session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking session not found: " + sessionId));

        if (!session.getUser().getId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Session does not belong to the authenticated user");
        }

        if (!"SHADOWING".equalsIgnoreCase(session.getMode())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Session is not in SHADOWING mode");
        }

        if (!"ACTIVE".equalsIgnoreCase(session.getStatus())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Shadowing session is not active");
        }

        int curIdx = session.getCurrentUnitIndex() != null ? session.getCurrentUnitIndex() : 0;
        int completed = session.getCompletedUnitsCount() != null ? session.getCompletedUnitsCount() : 0;
        int total = session.getTotalUnitsCount() != null ? session.getTotalUnitsCount() : 0;

        if (total <= 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Shadowing session has no units to advance");
        }
        if (curIdx >= total || completed >= total) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "All units in this shadowing session are already completed");
        }

        boolean hasPersistedAttempt;
        if (unitId != null) {
            hasPersistedAttempt = attemptRepository.countBySessionIdAndShadowingUnitId(sessionId, unitId) > 0;
        } else {
            List<SpeakingShadowingAttempt> sessionAttempts = attemptRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
            hasPersistedAttempt = sessionAttempts != null && !sessionAttempts.isEmpty();
        }
        if (!hasPersistedAttempt) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Record at least one attempt before advancing this unit");
        }

        int nextCompleted = Math.min(total, completed + 1);
        int nextIdx = Math.min(total, curIdx + 1);
        session.setCompletedUnitsCount(nextCompleted);
        session.setCurrentUnitIndex(nextIdx);
        session.setActiveTargetId(null);
        session.setActiveAttemptId(null);

        if (nextIdx >= total || nextCompleted >= total) {
            session.setStatus("COMPLETED");
            log.info("Shadowing session {} marked as COMPLETED for user {} (completedUnits={})", sessionId, userId, session.getCompletedUnitsCount());
        }

        sessionRepository.save(session);
        return getSessionState(userId, sessionId);
    }

    @Transactional(readOnly = true)
    public String referenceForAnalysis(Long userId, Long sessionId, Long unitId) {
        SpeakingSession session = sessionRepository.findById(sessionId)
                .filter(s -> Objects.equals(s.getUser().getId(), userId))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Session not found"));
        return requireAnalysisUnit(session, unitId, userId).getDisplayText();
    }

    private SpeakingShadowingUnit requireAnalysisUnit(SpeakingSession session, Long unitId, Long userId) {
        if (!"ACTIVE".equalsIgnoreCase(session.getStatus())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Speaking session is not active");
        }
        if (unitId == null) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "unitId is required");
        var unit = unitRepository.findById(unitId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Unit not found"));
        Long materialId = unit.getMaterial().getId();
        unitService.verifyMaterialVisible(materialId, userId);
        if (!"SHADOWING".equals(session.getMode()) || !Objects.equals(session.getSourceId(), materialId)
                || !unitService.isActiveUnit(unit)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Select an active unit for this session");
        }
        return unit;
    }

    @Transactional
    public SpeakingShadowingAttemptDto recordAttempt(Long userId, Long sessionId, SpeakingShadowingAttemptRequest request) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required");
        }

        SpeakingSession session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking session not found: " + sessionId));

        if (!session.getUser().getId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Session does not belong to the authenticated user");
        }

        if (!"ACTIVE".equalsIgnoreCase(session.getStatus())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Speaking session is not active");
        }

        if (request == null || request.unitId() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "unitId is required");
        }
        if (request.clientAttemptId() == null || request.clientAttemptId().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "clientAttemptId is required");
        }
        SpeakingShadowingUnit unit = requireAnalysisUnit(session, request.unitId(), userId);
        var existing = attemptRepository.findBySessionIdAndClientAttemptId(sessionId, request.clientAttemptId());
        if (existing.isPresent()) {
            if (existing.get().getShadowingUnit() == null || !Objects.equals(existing.get().getShadowingUnit().getId(), unit.getId())) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "Attempt already recorded for a different unit");
            }
            return mapToDto(existing.get());
        }

        ShadowingAnalysisReceipts.Receipt receipt;
        try {
            receipt = receipts.forRecording(userId, request.clientAttemptId(), sessionId, unit.getId());
        } catch (ResponseStatusException rse) {
            if (rse.getStatusCode().value() == HttpStatus.CONFLICT.value()
                    && "RECEIPT_ALREADY_CONSUMED".equals(rse.getReason())) {
                var replayed = attemptRepository.findBySessionIdAndClientAttemptId(sessionId, request.clientAttemptId());
                if (replayed.isPresent()) {
                    if (replayed.get().getShadowingUnit() == null || !Objects.equals(replayed.get().getShadowingUnit().getId(), unit.getId())) {
                        throw new ResponseStatusException(HttpStatus.CONFLICT, "Attempt already recorded for a different unit");
                    }
                    return mapToDto(replayed.get());
                }
            }
            throw rse;
        }
        if (receipt == null || receipt.result() == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Analyze this recording first");
        }
        ShadowingAnalysisResponseDto analysis = receipt.result();

        int retryIndex = attemptRepository.countBySessionIdAndShadowingUnitId(sessionId, unit.getId());
        String acousticJson = null;
        var acoustic = analysis.getPronunciationV2();
        if (acoustic != null) {
            try {
                acousticJson = objectMapper.writeValueAsString(acoustic);
            } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
                throw new IllegalStateException("Cannot store pronunciation feedback", e);
            }
        }
        var priority = acoustic != null && acoustic.getPriorities() != null && !acoustic.getPriorities().isEmpty()
                ? acoustic.getPriorities().getFirst() : null;

        int serverDurationSeconds = resolveAuthoritativeDurationSeconds(analysis, request.durationSeconds());
        String contractVersion = resolveAttemptContractVersion(acoustic, receipt.engineVersion());

        SpeakingShadowingAttempt attempt = SpeakingShadowingAttempt.builder()
                .user(session.getUser())
                .session(session)
                .shadowingUnit(unit)
                .segment(null)
                .clientAttemptId(request.clientAttemptId())
                .learnerTranscript(analysis.getLearnerTranscript())
                .accuracyScore(analysis.getAccuracyScore())
                .pronunciationScore(analysis.getPronunciationScore())
                .fluencyScore(analysis.getFluencyScore())
                .durationSeconds(serverDurationSeconds)
                .audioRef(analysis.getAudioRef())
                .audioSha256(receipt.audioSha256())
                .isMocked(analysis.getIsMocked())
                .retryIndex(retryIndex)
                .primaryIssueType(priority != null ? priority.getTargetUnit() : null)
                .targetWord(priority != null ? priority.getWord() : null)
                .analysisStatus(acoustic != null && acoustic.getStatus() != null ? acoustic.getStatus() : "COMPLETED")
                .productSafeResultJson(acousticJson)
                .productContractVersion(contractVersion)
                .build();

        SpeakingShadowingAttempt saved = attemptRepository.save(attempt);
        receipts.markConsumed(userId, request.clientAttemptId());
        if (eventPublisher != null) eventPublisher.publishEvent(new com.englishcoach.leaderboard.activity.event.ShadowingAttemptRecordedEvent(userId, saved.getId(), sessionId, unit.getId(), unit.getMaterial() != null ? unit.getMaterial().getId() : null, unit.getMaterial() != null ? unit.getMaterial().getCefrLevel() : null, saved.getPronunciationScore(), saved.getAccuracyScore(), saved.getFluencyScore(), saved.getIsMocked(), saved.getRetryIndex(), java.time.Instant.now()));
        return mapToDto(saved);
    }

    private static int resolveAuthoritativeDurationSeconds(ShadowingAnalysisResponseDto analysis, Integer requestedDuration) {
        if (analysis != null && analysis.getPronunciationV2() != null
                && analysis.getPronunciationV2().getAudioQuality() != null) {
            Double measuredSec = analysis.getPronunciationV2().getAudioQuality().getDurationSec();
            if (measuredSec != null && Double.isFinite(measuredSec) && measuredSec >= 0.0) {
                return (int) Math.max(0L, Math.min(180L, Math.round(measuredSec)));
            }
        }
        if (analysis != null && analysis.getDurationSeconds() != null) {
            return Math.max(0, Math.min(180, analysis.getDurationSeconds()));
        }
        if (requestedDuration != null) {
            return Math.max(0, Math.min(180, requestedDuration));
        }
        return 0;
    }

    private static String resolveAttemptContractVersion(PronunciationV2ResponseDto acoustic, String receiptEngineVersion) {
        if (acoustic == null) {
            return "ASR_ONLY";
        }
        String candidate = (receiptEngineVersion != null && !receiptEngineVersion.isBlank())
                ? receiptEngineVersion.trim()
                : (acoustic.getEngineVersion() != null && !acoustic.getEngineVersion().isBlank()
                    ? acoustic.getEngineVersion().trim()
                    : "PRONUNCIATION_V2_2");
        return candidate.length() > 50 ? candidate.substring(0, 50) : candidate;
    }

    @Transactional(readOnly = true)
    public List<ShadowingSegmentProgressDto> getMaterialProgress(Long userId, Long materialId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required");
        }
        return attemptRepository.getUnitProgressByMaterial(
                userId,
                materialId,
                SpeakingShadowingUnitService.LATEST_GENERATION_VERSION
        );
    }

    @Transactional(readOnly = true)
    public List<ShadowingSegmentProgressDto> getSessionProgress(Long userId, Long sessionId) {
        if (userId == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "User authentication required");
        }
        SpeakingSession session = sessionRepository.findById(sessionId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Speaking session not found: " + sessionId));

        if (!session.getUser().getId().equals(userId)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Session does not belong to the authenticated user");
        }
        return attemptRepository.getUnitProgressBySession(
                sessionId,
                SpeakingShadowingUnitService.LATEST_GENERATION_VERSION
        );
    }

    public SpeakingShadowingAttemptDto mapToDto(SpeakingShadowingAttempt attempt) {
        Long uId = attempt.getShadowingUnit() != null ? attempt.getShadowingUnit().getId() : null;
        Long sId = attempt.getSegment() != null ? attempt.getSegment().getId() : null;

        return new SpeakingShadowingAttemptDto(
                attempt.getId(),
                attempt.getSession().getId(),
                uId,
                sId,
                attempt.getClientAttemptId(),
                attempt.getLearnerTranscript(),
                attempt.getAccuracyScore(),
                attempt.getPronunciationScore(),
                attempt.getFluencyScore(),
                attempt.getDurationSeconds(),
                attempt.getIsMocked(),
                attempt.getParentAttemptId(),
                attempt.getRetryIndex() != null ? attempt.getRetryIndex() : 0,
                attempt.getActiveTargetId(),
                attempt.getPrimaryIssueType(),
                attempt.getTargetWord(),
                attempt.getRetryComparisonState(),
                attempt.getResolvedThisSession(),
                attempt.getAnalysisStatus(),
                attempt.getProductSafeResultJson(),
                attempt.getProductContractVersion(),
                attempt.getArtifactSetId(),
                attempt.getAudioRef(),
                attempt.getCreatedAt()
        );
    }
}
