package com.englishcoach.exams.service;

import com.englishcoach.exams.exception.ExamWriteClosedException;
import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.SectionRecord;
import com.englishcoach.exams.model.ExamScoringRecords.JobRecord;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamScoringRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.*;

@Slf4j
@Service
public class ExamResponseService {

    private final ExamAttemptRepository attemptRepository;
    private final ExamScoringRepository scoringRepository;
    private final ExamContentRepository contentRepository;
    private final com.englishcoach.exams.job.ExamJobWorker jobWorker;
    private com.englishcoach.sentinel.SentinelService sentinel;
    private org.springframework.transaction.PlatformTransactionManager transactionManager;

    @Autowired(required = false)
    public void setSentinel(com.englishcoach.sentinel.SentinelService sentinel) {
        this.sentinel = sentinel;
    }

    @Autowired(required = false)
    public void setTransactionManager(org.springframework.transaction.PlatformTransactionManager transactionManager) {
        this.transactionManager = transactionManager;
    }

    @Autowired
    public ExamResponseService(
            ExamAttemptRepository attemptRepository,
            ExamScoringRepository scoringRepository,
            @Autowired(required = false) ExamContentRepository contentRepository,
            @Autowired(required = false) com.englishcoach.exams.job.ExamJobWorker jobWorker
    ) {
        this.attemptRepository = attemptRepository;
        this.scoringRepository = scoringRepository;
        this.contentRepository = contentRepository;
        this.jobWorker = jobWorker;
    }

    public ExamResponseService(
            ExamAttemptRepository attemptRepository,
            ExamScoringRepository scoringRepository,
            ExamContentRepository contentRepository
    ) {
        this(attemptRepository, scoringRepository, contentRepository, null);
    }

    public ExamResponseService(
            ExamAttemptRepository attemptRepository,
            ExamScoringRepository scoringRepository
    ) {
        this(attemptRepository, scoringRepository, null, null);
    }

    @Transactional
    public SaveReceiptDto saveResponseBatch(Long userId, UUID attemptId, SaveResponseBatchRequest req) {
        if (req.responses() == null || req.responses().isEmpty()) {
            throw new IllegalArgumentException("Response batch is empty");
        }
        if (req.responses().size() > 50) {
            throw new IllegalArgumentException("Response batch exceeds maximum limit of 50 items");
        }

        AttemptRecord attempt = attemptRepository.findAttemptByIdForUpdate(attemptId)
                .orElseThrow(() -> new IllegalArgumentException("Attempt not found: " + attemptId));

        if (!attempt.userId().equals(userId)) {
            throw new IllegalArgumentException("Access denied to attempt: " + attemptId);
        }

        // Idempotency check via command receipts
        String reqHash = computeRequestHash(req.responses());
        if (req.clientMutationId() != null && !req.clientMutationId().isBlank()) {
            Optional<CommandReceiptRecord> receiptOpt = attemptRepository.findCommandReceipt(userId, "SAVE_RESPONSES", req.clientMutationId());
            if (receiptOpt.isPresent()) {
                CommandReceiptRecord receipt = receiptOpt.get();
                if (receipt.requestHash() != null && !receipt.requestHash().equals(reqHash)) {
                    throw new IllegalStateException("IDEMPOTENT_COMMAND_CONFLICT: Command ID " + req.clientMutationId()
                            + " has already been executed with a different request payload.");
                }
                log.info("Replay detected for saveResponseBatch mutation {} on attempt {}", req.clientMutationId(), attemptId);
                return new SaveReceiptDto(
                        req.clientMutationId(),
                        attempt.revision(),
                        Map.of(),
                        receipt.createdAt() != null ? receipt.createdAt() : Instant.now()
                );
            }
        }

        // Exams Phase 9C: a closed attempt (submitted / expired / invalidated) or a simulation past its server deadline
        // never accepts an answer write — checked before the revision so a delayed request gets the terminal reason.
        Instant writeTime = Instant.now();
        if (attempt.status() != ExamAttemptStatus.IN_PROGRESS) {
            throw new ExamWriteClosedException(ExamDeadlinePolicy.ATTEMPT_NOT_WRITABLE,
                    "Attempt is not IN_PROGRESS: " + attempt.status(), attempt.revision());
        }
        if (ExamDeadlinePolicy.attemptClosed(attempt, writeTime)) {
            throw new ExamWriteClosedException(ExamDeadlinePolicy.ATTEMPT_DEADLINE_PASSED,
                    "Attempt " + attemptId + " passed its server deadline", attempt.revision());
        }

        // Expected attempt revision check (a request built on an outdated revision is never applied — stale tab / late retry)
        if (req.expectedAttemptRevision() != attempt.revision()) {
            throw new com.englishcoach.exams.exception.ExamConcurrencyException(
                    "ATTEMPT_REVISION_CONFLICT",
                    "Expected attempt revision " + req.expectedAttemptRevision() + " but current is " + attempt.revision(),
                    attempt.revision(),
                    req.expectedAttemptRevision()
            );
        }

        // Active section lookup for responses
        List<AttemptSectionRecord> sections = attemptRepository.findSectionsByAttemptId(attemptId);
        AttemptSectionRecord activeSection = sections.stream()
                .filter(s -> s.state() == ExamSectionState.ACTIVE)
                .findFirst()
                .orElse(null);
        UUID activeSectionId = activeSection != null ? activeSection.sectionId() : null;
        if (ExamDeadlinePolicy.sectionClosed(attempt, activeSection, writeTime)) {
            throw new ExamWriteClosedException(ExamDeadlinePolicy.SECTION_DEADLINE_PASSED,
                    "Section " + activeSectionId + " passed its server deadline", attempt.revision());
        }

        if (activeSectionId == null) {
            throw new com.englishcoach.exams.exception.ExamConcurrencyException(
                    "SCOPE_NOT_RUNNABLE",
                    "No active section found for attempt: " + attemptId,
                    attempt.revision(),
                    req.expectedAttemptRevision()
            );
        }

        requirePlacementsInScope(attempt, req.responses(), req.expectedAttemptRevision());

        Map<String, Long> acceptedRevisions = new HashMap<>();
        for (ResponseItemCommand item : req.responses()) {
            UUID itemId = item.itemId();
            UUID targetSectionId = activeSectionId;
            Optional<ExamAttemptRepository.PlacementResolution> activeResolutionOpt =
                    attemptRepository.resolvePlacement(attemptId, activeSectionId, item.placementId());
            if (activeResolutionOpt.isPresent()) {
                itemId = activeResolutionOpt.get().itemId();
                targetSectionId = activeResolutionOpt.get().sectionId();
            } else {
                Optional<ExamAttemptRepository.PlacementResolution> anySectionOpt =
                        attemptRepository.resolvePlacement(attemptId, item.placementId());
                if (anySectionOpt.isPresent()) {
                    throw new com.englishcoach.exams.exception.ExamConcurrencyException(
                            "PLACEMENT_NOT_CURRENT",
                            "Placement " + item.placementId() + " belongs to section " + anySectionOpt.get().sectionId()
                                    + " which is not currently ACTIVE",
                            attempt.revision(),
                            req.expectedAttemptRevision()
                    );
                }
                throw new com.englishcoach.exams.exception.ExamConcurrencyException(
                        "PLACEMENT_NOT_FOUND",
                        "Placement " + item.placementId() + " cannot be resolved for attempt " + attemptId,
                        attempt.revision(),
                        req.expectedAttemptRevision()
                );
            }
            long rev = attemptRepository.upsertResponse(
                    attemptId,
                    targetSectionId,
                    item.placementId(),
                    itemId,
                    item.answerPayload(),
                    item.textResponse(),
                    item.recordingId(),
                    item.flagged(),
                    item.expectedRevision(),
                    req.clientMutationId()
            );
            acceptedRevisions.put(item.placementId(), rev);
        }

        // Atomically increment attempt revision
        attemptRepository.incrementAttemptRevision(attemptId);
        long newAttemptRevision = attempt.revision() + 1;

        Instant now = Instant.now();
        if (req.clientMutationId() != null) {
            attemptRepository.insertCommandReceipt(new CommandReceiptRecord(
                    null, userId, attemptId, req.clientMutationId(), "SAVE_RESPONSES",
                    reqHash, attemptId.toString(), "SUCCESS", now
            ));
        }

        return new SaveReceiptDto(
                req.clientMutationId(),
                newAttemptRevision,
                acceptedRevisions,
                now
        );
    }

    private String computeRequestHash(List<ResponseItemCommand> responses) {
        if (responses == null) return "empty";
        StringBuilder sb = new StringBuilder();
        for (ResponseItemCommand item : responses) {
            sb.append(item.placementId()).append(":")
              .append(item.textResponse() != null ? item.textResponse() : "")
              .append(":")
              .append(item.answerPayload() != null ? item.answerPayload().toString() : "")
              .append(":")
              .append(item.recordingId() != null ? item.recordingId().toString() : "")
              .append(";");
        }
        return ExamMediaService.computeSha256(sb.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private String computeSubmitRequestHash(SubmitAttemptRequest req) {
        StringBuilder sb = new StringBuilder();
        sb.append(req.reason() != null ? req.reason().name() : "MANUAL").append(";");
        sb.append(req.expectedAttemptRevision()).append(";");
        sb.append(req.flushToken() != null ? req.flushToken() : "").append(";");
        if (req.finalResponses() != null) {
            sb.append(computeRequestHash(req.finalResponses()));
        }
        return ExamMediaService.computeSha256(sb.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    @Transactional
    public UUID submitAttempt(Long userId, UUID attemptId, SubmitAttemptRequest req) {
        return submitAttemptWithOutcome(userId, attemptId, req).submissionId();
    }

    @Transactional
    public SubmitOutcome submitAttemptWithOutcome(Long userId, UUID attemptId, SubmitAttemptRequest req) {
        AttemptRecord attempt = attemptRepository.findAttemptByIdForUpdate(attemptId)
                .orElseThrow(() -> new IllegalArgumentException("Attempt not found: " + attemptId));

        if (!attempt.userId().equals(userId)) {
            throw new IllegalArgumentException("Access denied to attempt: " + attemptId);
        }

        // Idempotency check via command receipts
        String reqHash = computeSubmitRequestHash(req);
        if (req.clientMutationId() != null && !req.clientMutationId().isBlank()) {
            Optional<CommandReceiptRecord> receiptOpt = attemptRepository.findCommandReceipt(userId, "SUBMIT_ATTEMPT", req.clientMutationId());
            if (receiptOpt.isPresent()) {
                CommandReceiptRecord receipt = receiptOpt.get();
                if (receipt.requestHash() != null && !receipt.requestHash().equals(reqHash)) {
                    throw new IllegalStateException("IDEMPOTENT_COMMAND_CONFLICT: Command ID " + req.clientMutationId()
                            + " has already been executed with a different request payload.");
                }
                log.info("Replay detected for submitAttempt mutation {} on attempt {}", req.clientMutationId(), attemptId);
                Optional<SubmissionRecord> existing = attemptRepository.findSubmissionByAttemptId(attemptId);
                if (existing.isPresent()) {
                    return new SubmitOutcome(existing.get().id(), true, 0, null);
                }
            }
        }

        // Idempotent duplicate submission protection if already submitted (Exams Phase 9D: checked BEFORE the revision,
        // so a retried / duplicated submit — whose revision is necessarily outdated — gets the SAME submission back and
        // nothing is written, scored, enqueued or evidenced twice; its final responses are never applied).
        if (attempt.status() == ExamAttemptStatus.SUBMITTED) {
            Optional<SubmissionRecord> existing = attemptRepository.findSubmissionByAttemptId(attemptId);
            if (existing.isPresent()) {
                log.info("Attempt {} is already submitted; returning existing submission ID {}", attemptId, existing.get().id());
                return new SubmitOutcome(existing.get().id(), true, 0, null);
            }
        }

        // Expected revision check
        if (req.expectedAttemptRevision() != attempt.revision()) {
            throw new com.englishcoach.exams.exception.ExamConcurrencyException(
                    "ATTEMPT_REVISION_CONFLICT",
                    "Expected attempt revision " + req.expectedAttemptRevision() + " but current is " + attempt.revision(),
                    attempt.revision(),
                    req.expectedAttemptRevision()
            );
        }

        if (attempt.status() != ExamAttemptStatus.IN_PROGRESS && attempt.status() != ExamAttemptStatus.READY) {
            throw new IllegalStateException("Attempt cannot be submitted from status: " + attempt.status());
        }

        // Exams Phase 9C: a simulation past its server hard end is finalized with the answers saved before the closure —
        // final responses of the late request are not applied, the remaining non-speaking sections are sealed, and the
        // reason becomes TIME_LIMIT. (Incomplete Speaking is still never finalized — the invariant below.)
        Instant submitTime = Instant.now();
        boolean closedByDeadline = ExamDeadlinePolicy.attemptClosed(attempt, submitTime);
        if (closedByDeadline) {
            sealOpenSectionsAfterDeadline(attempt, submitTime);
        }

        // =========================================================================
        // HARD SUBMISSION INVARIANT FOR FULL IELTS MOCK / MULTI-SECTION EXAMS:
        // 1. Intermediate sections (Listening, Reading, Writing) must be COMPLETED.
        // 2. Speaking must be COMPLETED with ALL required child turns completed.
        // 3. Time limit expiry or reload must NEVER finalize incomplete Speaking.
        // =========================================================================
        List<AttemptSectionRecord> attemptSections = attemptRepository.findSectionsByAttemptId(attemptId);
        if (attemptSections.size() > 1) {
            // Find section skills if content repository is available
            Map<UUID, SkillType> sectionSkillMap = new HashMap<>();
            if (contentRepository != null) {
                try {
                    List<SectionRecord> formSections = contentRepository.findSectionsByFormId(attempt.formId());
                    for (SectionRecord fs : formSections) {
                        sectionSkillMap.put(fs.id(), fs.skill());
                    }
                } catch (Exception e) {
                    log.warn("Failed to load form sections for attempt {}: {}", attemptId, e.getMessage());
                }
            }

            // Check if there is a speaking section
            Optional<AttemptSectionRecord> speakingSecOpt = attemptSections.stream()
                    .filter(s -> sectionSkillMap.get(s.sectionId()) == SkillType.SPEAKING
                            || s.turnCursor() > 0
                            || (s.currentTurnKey() != null && !s.currentTurnKey().isBlank()))
                    .findFirst();

            if (speakingSecOpt.isPresent()) {
                AttemptSectionRecord speakingSec = speakingSecOpt.get();
                if (speakingSec.state() != ExamSectionState.COMPLETED) {
                    throw new IllegalStateException("INCOMPLETE_SPEAKING_SUBMISSION_BLOCKED: Cannot finalize exam attempt. Speaking section is not COMPLETED.");
                }
                List<ResponseRecord> speakingTurns = attemptRepository.findSpeakingResponsesByAttemptAndSection(attemptId, speakingSec.sectionId());
                List<ResponseRecord> childTurns = speakingTurns.stream()
                        .filter(r -> "SPEAKING_TURN".equalsIgnoreCase(r.responseKind()) || (r.turnKey() != null && !r.turnKey().isBlank()))
                        .toList();

                if (childTurns.isEmpty()) {
                    throw new IllegalStateException("INCOMPLETE_SPEAKING_SUBMISSION_BLOCKED: Cannot finalize exam attempt. Speaking child turns have not been initialized or completed.");
                }

                long completedCount = childTurns.stream()
                        .filter(r -> "COMPLETED".equalsIgnoreCase(r.turnState()) && r.recordingId() != null)
                        .count();
                int scopedPart = com.englishcoach.exams.practice.ExamPracticeScope.pinned(attempt.manifestSnapshot())
                        .filter(s -> "IELTS_SPEAKING_PART".equals(s.get("scopeType")))
                        .map(s -> ((Number) s.get("number")).intValue()).orElse(0);
                int requiredP1 = scopedPart == 0 || scopedPart == 1 ? ExamPinnedSpeakingPrompts.requiredTurns(attempt.manifestSnapshot(), 1, 4) : 0;
                int requiredP2 = scopedPart == 0 || scopedPart == 2 ? ExamPinnedSpeakingPrompts.requiredTurns(attempt.manifestSnapshot(), 2, 1) : 0;
                int requiredP3 = scopedPart == 0 || scopedPart == 3 ? ExamPinnedSpeakingPrompts.requiredTurns(attempt.manifestSnapshot(), 3, 4) : 0;
                int expectedTurns = requiredP1 + requiredP2 + requiredP3;
                long p1Count = childTurns.stream()
                        .filter(r -> ("speaking_part_1".equalsIgnoreCase(r.placementId()) || (r.turnKey() != null && r.turnKey().contains("p1")))
                                && "COMPLETED".equalsIgnoreCase(r.turnState()) && r.recordingId() != null)
                        .count();
                long p2Count = childTurns.stream()
                        .filter(r -> ("speaking_part_2".equalsIgnoreCase(r.placementId()) || (r.turnKey() != null && r.turnKey().contains("p2")))
                                && "COMPLETED".equalsIgnoreCase(r.turnState()) && r.recordingId() != null)
                        .count();
                long p3Count = childTurns.stream()
                        .filter(r -> ("speaking_part_3".equalsIgnoreCase(r.placementId()) || (r.turnKey() != null && r.turnKey().contains("p3")))
                                && "COMPLETED".equalsIgnoreCase(r.turnState()) && r.recordingId() != null)
                        .count();

                if (completedCount < expectedTurns || p1Count < requiredP1 || p2Count < requiredP2 || p3Count < requiredP3) {
                    throw new IllegalStateException("INCOMPLETE_SPEAKING_SUBMISSION_BLOCKED: Cannot finalize exam attempt. Speaking has only "
                            + completedCount + "/" + expectedTurns + " completed child turns with sealed recordings "
                            + "(Part 1: " + p1Count + "/" + requiredP1 + ", Part 2: " + p2Count + "/" + requiredP2
                            + ", Part 3: " + p3Count + "/" + requiredP3 + ").");
                }
            }

            // Every section in the attempt must be COMPLETED
            boolean anySectionIncomplete = attemptSections.stream()
                    .anyMatch(s -> s.state() != ExamSectionState.COMPLETED);
            if (anySectionIncomplete) {
                throw new IllegalStateException("PREMATURE_SUBMISSION_REJECTED: All examination sections must be completed before final submission.");
            }
        }

        // Save any final responses in request
        int finalResponsesNotApplied = 0;
        if (req.finalResponses() != null && !req.finalResponses().isEmpty()) {
            requirePlacementsInScope(attempt, req.finalResponses(), req.expectedAttemptRevision());
            List<AttemptSectionRecord> sections = attemptRepository.findSectionsByAttemptId(attemptId);
            UUID defaultSecId = sections.isEmpty() ? null : sections.get(0).sectionId();
            for (ResponseItemCommand item : req.finalResponses()) {
                if (closedByDeadline) {
                    finalResponsesNotApplied++;
                    continue;
                }
                UUID itemId = item.itemId();
                UUID targetSectionId = defaultSecId;
                Optional<ExamAttemptRepository.PlacementResolution> resolutionOpt =
                        attemptRepository.resolvePlacement(attemptId, item.placementId());
                if (resolutionOpt.isPresent()) {
                    itemId = resolutionOpt.get().itemId();
                    targetSectionId = resolutionOpt.get().sectionId();
                } else if (itemId == null) {
                    itemId = attemptRepository.resolveItemIdByPlacement(attemptId, item.placementId()).orElse(null);
                }
                if (itemId == null) {
                    continue;
                }
                // Exams Phase 9C: a simulation answer is written only into its OPEN section (never into a sealed section
                // or one past its deadline) — the same rule autosave applies.
                if (ExamDeadlinePolicy.enforced(attempt) && !sectionWritable(attempt, sections, targetSectionId, submitTime)) {
                    finalResponsesNotApplied++;
                    continue;
                }
                attemptRepository.upsertResponse(
                        attemptId, targetSectionId, item.placementId(), itemId,
                        item.answerPayload(), item.textResponse(), item.recordingId(),
                        item.flagged(), item.expectedRevision(), req.clientMutationId()
                );
            }
        }

        Instant now = Instant.now();
        List<ResponseRecord> allResponses = attemptRepository.findResponsesByAttemptId(attemptId);

        // Build response snapshot
        Map<String, Object> snapshot = new HashMap<>();
        for (ResponseRecord r : allResponses) {
            Map<String, Object> entry = new HashMap<>();
            entry.put("placementId", r.placementId());
            entry.put("itemId", r.itemId());
            entry.put("answerPayload", r.answerPayload());
            entry.put("textResponse", r.textResponse());
            entry.put("recordingId", r.recordingId());
            entry.put("flagged", r.flagged());
            snapshot.put(r.placementId(), entry);
        }

        SubmissionReason reason = closedByDeadline ? SubmissionReason.TIME_LIMIT
                : (req.reason() != null ? req.reason() : SubmissionReason.MANUAL);
        String subHash = ExamMediaService.computeSha256((attemptId.toString() + ":" + now.toString()).getBytes());

        SubmissionRecord submission = new SubmissionRecord(
                null,
                attemptId,
                reason,
                now,
                snapshot,
                attempt.pinnedManifestHash(),
                Map.of(),
                subHash,
                now
        );

        UUID submissionId = attemptRepository.insertSubmission(submission);

        // Update attempt status to SUBMITTED and increment revision atomically
        boolean updated = attemptRepository.updateAttemptStatus(attemptId, ExamAttemptStatus.SUBMITTED, attempt.revision());
        if (!updated) {
            throw new com.englishcoach.exams.exception.ExamConcurrencyException(
                    "ATTEMPT_REVISION_CONFLICT",
                    "Failed to update attempt status due to concurrent revision modification",
                    attempt.revision(),
                    req.expectedAttemptRevision()
            );
        }
        long finalRevision = attempt.revision() + 1;

        if (req.clientMutationId() != null) {
            attemptRepository.insertCommandReceipt(new CommandReceiptRecord(
                    null, userId, attemptId, req.clientMutationId(), "SUBMIT_ATTEMPT",
                    reqHash, submissionId.toString(), "SUCCESS", now
            ));
        }

        // Echo Sentinel (EC-SEC-2026-019): complete strict attempt ONLY after ownership, revision, deadline,
        // required-section validation, submission insert, and SUBMITTED status transition have all succeeded —
        // and immediately before direct objective scoring / job enqueue so scoring sees COMPLETED_VERIFIED.
        if (sentinel != null && attempt.attemptMode() == ExamAttemptMode.EXAM_SIMULATION) {
            sentinel.completeSubject(userId, com.englishcoach.sentinel.SentinelPolicy.EXAM_SIMULATION, attemptId.toString());
        }

        // Evaluate submission:
        // Option A (Objective-only: Listening & Reading): score deterministically via ExamObjectiveScorer immediately; NO AI job queued.
        // Option B (Productive: Writing & Speaking): enqueue SUBMISSION_SCORING for AI worker.
        boolean objectiveOnly = isObjectiveOnly(attempt);
        if (objectiveOnly && jobWorker != null) {
            try {
                SubmissionRecord savedSubmission = attemptRepository.findSubmissionById(submissionId).orElse(submission);
                if (transactionManager != null) {
                    var nested = new org.springframework.transaction.support.TransactionTemplate(transactionManager);
                    nested.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_NESTED);
                    nested.executeWithoutResult(status -> jobWorker.scoreObjectiveSubmissionDirectly(savedSubmission, attempt));
                } else {
                    jobWorker.scoreObjectiveSubmissionDirectly(savedSubmission, attempt);
                }
                log.info("Attempt {} is objective-only. Scored directly with deterministic ExamObjectiveScorer. No AI worker job queued.", attemptId);
            } catch (Exception e) {
                log.error("Direct objective scoring failed for attempt {}: {}. Falling back to job queue.", attemptId, e.getMessage(), e);
                enqueueScoringJobs(attempt, submissionId);
            }
        } else {
            enqueueScoringJobs(attempt, submissionId);
        }

        log.info("Successfully submitted attempt {} with submission {} at revision {} (closedByDeadline={}, finalResponsesNotApplied={})",
                attemptId, submissionId, finalRevision, closedByDeadline, finalResponsesNotApplied);
        return new SubmitOutcome(submissionId, false, finalResponsesNotApplied,
                closedByDeadline ? ExamDeadlinePolicy.ATTEMPT_DEADLINE_PASSED : null);
    }

    /**
     * Exams Phase 9D: outcome of a submit. {@code replayed} = the attempt was already submitted (the existing submission is
     * returned, nothing written). {@code finalResponsesNotApplied} = final answers refused because their section / the
     * attempt was closed by the server deadline ({@code closure} names the rule).
     */
    public record SubmitOutcome(UUID submissionId, boolean replayed, int finalResponsesNotApplied, String closure) {}

    private boolean sectionWritable(AttemptRecord attempt, List<AttemptSectionRecord> sections, UUID sectionId, Instant now) {
        AttemptSectionRecord target = sections.stream().filter(s -> s.sectionId().equals(sectionId)).findFirst().orElse(null);
        if (target == null) return false;
        if (target.state() == ExamSectionState.COMPLETED) return false;
        return !ExamDeadlinePolicy.sectionClosed(attempt, target, now);
    }

    /** Seals every still-open non-speaking section of a simulation whose hard end has passed (Exams Phase 9C). */
    private void sealOpenSectionsAfterDeadline(AttemptRecord attempt, Instant now) {
        Set<UUID> speakingSections = new HashSet<>();
        if (contentRepository != null) {
            try {
                for (SectionRecord fs : contentRepository.findSectionsByFormId(attempt.formId())) {
                    if (fs.skill() == SkillType.SPEAKING) speakingSections.add(fs.id());
                }
            } catch (Exception e) {
                log.warn("Failed to load form sections for deadline sealing of attempt {}: {}", attempt.id(), e.getMessage());
            }
        }
        for (AttemptSectionRecord s : attemptRepository.findSectionsByAttemptId(attempt.id())) {
            if (s.state() == ExamSectionState.COMPLETED || speakingSections.contains(s.sectionId())
                    || s.turnCursor() > 0 || (s.currentTurnKey() != null && !s.currentTurnKey().isBlank())) {
                continue;
            }
            attemptRepository.updateAttemptSection(attempt.id(), s.sectionId(), ExamSectionState.COMPLETED,
                    s.startedAt(), s.deadlineAt(), now);
        }
    }

    /**
     * Exams Phase 6: a practice-scoped attempt accepts answers ONLY for the placements of its pinned scope snapshot.
     * A placement of another part of the same form (or any arbitrary id) is refused, so a client can never widen the
     * server-resolved scope.
     */
    private void requirePlacementsInScope(AttemptRecord attempt, List<ResponseItemCommand> items, long expectedRevision) {
        if (!com.englishcoach.exams.practice.ExamPracticeScope.isScoped(attempt.manifestSnapshot())) return;
        Set<String> allowed = com.englishcoach.exams.practice.ExamPracticeScope.placementIdsOf(attempt.manifestSnapshot());
        for (ResponseItemCommand item : items) {
            if (item.placementId() == null || !allowed.contains(item.placementId())) {
                throw new com.englishcoach.exams.exception.ExamConcurrencyException(
                        "PLACEMENT_NOT_IN_SCOPE",
                        "Placement " + item.placementId() + " is not part of this practice scope",
                        attempt.revision(),
                        expectedRevision
                );
            }
        }
    }

    private boolean isObjectiveOnly(AttemptRecord attempt) {
        // Exams Phase 6: every practice scope is scored without AI (objective raw metrics, or a writing response kept
        // unscored), so it never enqueues an AI scoring job nor commits an AI premium reservation.
        if (com.englishcoach.exams.practice.ExamPracticeScope.isScoped(attempt.manifestSnapshot())) {
            return true;
        }
        if ("LR".equalsIgnoreCase(attempt.scope())) {
            return true;
        }
        if (attempt.clientSessionMeta() != null && attempt.clientSessionMeta().containsKey("selectedSkills")) {
            Object raw = attempt.clientSessionMeta().get("selectedSkills");
            if (raw instanceof List<?> list && !list.isEmpty()) {
                boolean hasProductive = list.stream().anyMatch(item -> {
                    if (item == null) return false;
                    String s = item.toString().trim().toUpperCase();
                    return "WRITING".equals(s) || "SPEAKING".equals(s);
                });
                return !hasProductive;
            }
        }
        if (contentRepository != null) {
            try {
                List<AttemptSectionRecord> attemptSections = attemptRepository.findSectionsByAttemptId(attempt.id());
                List<SectionRecord> formSections = contentRepository.findSectionsByFormId(attempt.formId());
                Map<UUID, SkillType> map = new HashMap<>();
                for (SectionRecord fs : formSections) {
                    map.put(fs.id(), fs.skill());
                }
                for (AttemptSectionRecord asr : attemptSections) {
                    SkillType skill = map.get(asr.sectionId());
                    if (skill == SkillType.WRITING || skill == SkillType.SPEAKING) {
                        return false;
                    }
                }
                return true;
            } catch (Exception e) {
                log.warn("Failed to check section skills for attempt {}: {}", attempt.id(), e.getMessage());
            }
        }
        return false;
    }

    private void enqueueScoringJobs(AttemptRecord attempt, UUID submissionId) {
        Instant now = Instant.now();
        JobRecord scoringJob = new JobRecord(
                null,
                submissionId,
                "SUBMISSION_SCORING",
                "v1.0",
                1,
                JobStatus.PENDING,
                now,
                null,
                null,
                0,
                3,
                null,
                now,
                now
        );
        scoringRepository.insertJob(scoringJob);
        if (jobWorker != null) {
            if (org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()) {
                org.springframework.transaction.support.TransactionSynchronizationManager.registerSynchronization(
                        new org.springframework.transaction.support.TransactionSynchronization() {
                            @Override
                            public void afterCommit() {
                                jobWorker.wakePoller();
                            }
                        });
            } else {
                jobWorker.wakePoller();
            }
        }
    }
}
