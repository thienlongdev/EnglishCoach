package com.englishcoach.exams.service;

import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.content.ExamBankOriginalPractice;
import com.englishcoach.exams.practice.ExamPracticeReadiness;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamProfileRecords.AttemptHistoryItemDto;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.validation.ExamAttemptEvidenceBasis;
import com.englishcoach.exams.validation.ExamContentValidationService;
import com.englishcoach.exams.validation.ExamFormValidationReport;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import com.englishcoach.exams.exception.ExamActiveSimulationConflictException;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamNotFoundException;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamForbiddenException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumUsageService;
import org.springframework.beans.factory.annotation.Autowired;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
public class ExamAttemptService {

    private final ExamAttemptRepository attemptRepository;
    private final ExamContentRepository contentRepository;
    private final ExamRightsService rightsService;
    private final ExamTimingService timingService;
    private final ExamManifestService manifestService;
    private final PremiumEntitlementService entitlementService;
    private final PremiumUsageService usageService;
    /** Authoritative content validation (Exams Phase 2). Null only in legacy constructors ⇒ every start is refused. */
    private final ExamContentValidationService validationService;

    @Autowired
    public ExamAttemptService(
            ExamAttemptRepository attemptRepository,
            ExamContentRepository contentRepository,
            ExamRightsService rightsService,
            ExamTimingService timingService,
            ExamManifestService manifestService,
            @Autowired(required = false) PremiumEntitlementService entitlementService,
            @Autowired(required = false) PremiumUsageService usageService,
            ExamContentValidationService validationService
    ) {
        this.attemptRepository = attemptRepository;
        this.contentRepository = contentRepository;
        this.rightsService = rightsService;
        this.timingService = timingService;
        this.manifestService = manifestService;
        this.entitlementService = entitlementService;
        this.usageService = usageService;
        this.validationService = validationService;
    }

    public ExamAttemptService(
            ExamAttemptRepository attemptRepository,
            ExamContentRepository contentRepository,
            ExamRightsService rightsService,
            ExamTimingService timingService,
            ExamManifestService manifestService,
            PremiumEntitlementService entitlementService,
            PremiumUsageService usageService
    ) {
        this(attemptRepository, contentRepository, rightsService, timingService, manifestService,
                entitlementService, usageService, null);
    }

    public ExamAttemptService(
            ExamAttemptRepository attemptRepository,
            ExamContentRepository contentRepository,
            ExamRightsService rightsService,
            ExamTimingService timingService,
            ExamManifestService manifestService
    ) {
        this(attemptRepository, contentRepository, rightsService, timingService, manifestService, null, null);
    }

    @Transactional
    public AttemptStateDto createAttempt(Long userId, CreateAttemptRequest req) {
        // Exams Phase 9D: a retried create (same client mutation id) returns the attempt it already created — never a
        // second attempt, never a unique-receipt 500.
        if (req.clientMutationId() != null && !req.clientMutationId().isBlank()) {
            Optional<CommandReceiptRecord> replay = attemptRepository.findCommandReceipt(userId, "CREATE_ATTEMPT", req.clientMutationId());
            if (replay.isPresent() && replay.get().resultReference() != null) {
                UUID existingId = UUID.fromString(replay.get().resultReference());
                log.info("Replay detected for createAttempt mutation {} → attempt {}", req.clientMutationId(), existingId);
                return getAttemptState(userId, existingId);
            }
        }

        // Enforce active simulation rule
        if (req.mode() == ExamAttemptMode.EXAM_SIMULATION) {
            attemptRepository.acquireUserSimulationLock(userId);
            Optional<AttemptRecord> activeSim = attemptRepository.findActiveSimulationAttempt(userId);
            if (activeSim.isPresent()) {
                AttemptRecord active = activeSim.get();
                if (active.scheduledEndAt() != null && Instant.now().isAfter(active.scheduledEndAt())) {
                    log.info("Active simulation {} has expired at {}. Transitioning to EXPIRED.", active.id(), active.scheduledEndAt());
                    attemptRepository.updateAttemptStatus(active.id(), ExamAttemptStatus.EXPIRED, active.revision());
                } else {
                    ActiveSimulationAttemptSummary summary = buildActiveSimulationSummary(active);
                    throw new ExamActiveSimulationConflictException(
                            "ACTIVE_SIMULATION_CONFLICT: You already have an active simulation attempt: " + active.id(),
                            summary
                    );
                }
            }
        }

        // Validate form
        Optional<FormVersionRecord> formOpt = contentRepository.findFormById(req.formId());
        if (formOpt.isEmpty()) {
            throw new IllegalArgumentException("Form not found: " + req.formId());
        }
        FormVersionRecord form = formOpt.get();

        if (form.lifecycleState() != LifecycleState.PUBLISHED && form.lifecycleState() != LifecycleState.PILOT) {
            throw new IllegalStateException("Form is not published or eligible for attempts: " + form.lifecycleState());
        }

        // Verify rights
        if (!rightsService.verifyFormRights(form.id())) {
            throw new IllegalStateException("RIGHTS_DENIED: Nội dung này hiện chưa được phép sử dụng trong môi trường phát hành công khai.");
        }

        // Determine selected skills
        List<String> rawSelectedSkills = req.selectedSkills();
        Set<SkillType> selectedSkillTypes = null;
        if (rawSelectedSkills != null && !rawSelectedSkills.isEmpty()) {
            selectedSkillTypes = rawSelectedSkills.stream()
                    .map(String::trim)
                    .map(String::toUpperCase)
                    .map(SkillType::valueOf)
                    .collect(Collectors.toSet());
        }

        // Validate Runnability
        List<SectionRecord> allFormSections = contentRepository.findSectionsByFormId(form.id());
        // Retired S/W forms (including suites) cannot create new attempts, even with selectedSkills=READING.
        ExamLearnerProductPolicy.require(form.family(), allFormSections.isEmpty()
                ? contentRepository.findSkillsByFormId(form.id()).stream().map(SkillType::valueOf).toList()
                : allFormSections.stream().map(SectionRecord::skill).toList());
        List<SectionRecord> sections = allFormSections;
        if (selectedSkillTypes != null) {
            final Set<SkillType> chosen = selectedSkillTypes;
            sections = allFormSections.stream().filter(s -> chosen.contains(s.skill())).toList();
            if (sections.isEmpty()) {
                throw new IllegalStateException("SCOPE_NOT_RUNNABLE: No matching sections found for selected skills: " + rawSelectedSkills);
            }
        }

        ExamAttemptMode attemptMode = req.mode() != null ? req.mode() : ExamAttemptMode.EXAM_SIMULATION;
        if (ExamBankOriginalPractice.practiceOnly(form.id(), form.lifecycleState(), form.logicalKey(), form.scope())) {
            if (attemptMode != ExamAttemptMode.PRACTICE || validationService == null)
                throw new IllegalStateException("SCOPE_NOT_RUNNABLE: This edition is available for Practice only.");
            var readyCodes = validationService.practiceScopes(form.id(), new ExamPracticeReadiness.FormFacts(true, true))
                    .stream().filter(ExamPracticeReadiness.ScopeReadiness::ready)
                    .map(s -> s.scope().scopeCode()).toList();
            if (!ExamBankOriginalPractice.wholePracticeReady(form.family(), form.scope(), readyCodes))
                throw new IllegalStateException("SCOPE_NOT_RUNNABLE: Select a ready Part, Passage or Task for this Practice edition.");
        }

        if (sections.isEmpty()) {
            throw new IllegalStateException("SCOPE_NOT_RUNNABLE: This form contains no sections.");
        }

        // Exams Phase 2: the authoritative content validation is re-checked server-side for the requested
        // mode (never trust catalog state from the browser). Fail closed: unknown validation refuses both modes.
        // EXAM_SIMULATION of the whole form needs fullSimulationEligible; a skill-scoped simulation needs every
        // selected skill simulation-grade; PRACTICE needs every skill in scope practice-runnable. Operator
        // restrictions (primary_health_status DISABLED/NEEDS_REVIEW, is_runnable=false) are validator inputs.
        ExamFormValidationReport validation = validationService != null
                ? validationService.evaluate(form.id())
                : ExamFormValidationReport.unknown(form.id(), "VALIDATION_SERVICE_UNAVAILABLE", Instant.now());
        Set<SkillType> scopeSkills = EnumSet.noneOf(SkillType.class);
        sections.forEach(s -> scopeSkills.add(s.skill()));
        boolean allowed;
        if (attemptMode == ExamAttemptMode.EXAM_SIMULATION) {
            allowed = selectedSkillTypes == null
                    ? validation.fullSimulationEligible()
                    : validation.simulationSkills().containsAll(scopeSkills);
        } else {
            allowed = validation.practiceSkills().containsAll(scopeSkills);
        }
        if (!allowed) {
            log.warn("[ExamsValidation] createAttempt rejected for form {} mode {} scope {}: status {} codes {}", form.id(),
                    attemptMode, scopeSkills, validation.status(), validation.blockingCodes());
            throw new IllegalStateException(ExamContentValidationService.UNDER_REVIEW_CODE + ": "
                    + ExamContentValidationService.UNDER_REVIEW_MESSAGE_VI);
        }

        // Entitlement Enforcement:
        // Productive skills (Writing & Speaking) require EXAM_AI_SCORING entitlement / trial check.
        // Objective skills (Listening & Reading) are free and require zero AI check.
        boolean isProductive = sections.stream().anyMatch(s ->
                s.skill() == SkillType.WRITING || s.skill() == SkillType.SPEAKING
        );

        Long reservationId = null;
        if (isProductive) {
            if (entitlementService == null || usageService == null) throw new IllegalStateException("EXAM_AI_UNAVAILABLE");
            boolean isPremium = entitlementService.isUserPremium(userId);
            String clientReqId = (req.clientMutationId() != null && !req.clientMutationId().isBlank())
                    ? req.clientMutationId()
                    : UUID.randomUUID().toString();
            reservationId = usageService.reserveUsage(userId, PremiumUsageService.EXAM_AI_SCORING, clientReqId, isPremium);
            if (!req.aiAssessmentConsent()) throw new IllegalArgumentException("EXAM_AI_CONSENT_REQUIRED");
            if (reservationId == null) throw new IllegalStateException("EXAM_AI_RESERVATION_REQUIRED");
        }

        // Serialize immutable form snapshot atomically
        ExamManifestService.FormSnapshotResult snapshotResult = manifestService.serializeFormSnapshot(form);
        if (snapshotResult == null || snapshotResult.snapshot() == null || snapshotResult.hash() == null) {
            throw new IllegalStateException("SNAPSHOT_CREATION_FAILED: Unable to create immutable form snapshot for form " + form.id());
        }

        // Exams Phase 4.1D: pin the validation basis that authorised THIS attempt next to its content snapshot, so
        // official evidence is later decided from the attempt's own truth, never from the form as it is then.
        Map<String, Object> pinnedSnapshot = pinEvidenceBasis(snapshotResult, validation, form, attemptMode, scopeSkills);

        String attemptScope = form.scope();
        if (selectedSkillTypes != null && selectedSkillTypes.stream().allMatch(s -> s == SkillType.LISTENING || s == SkillType.READING)) {
            attemptScope = "LR";
        }

        Map<String, Object> clientSessionMeta = new HashMap<>();
        clientSessionMeta.put("initialClientMutationId", req.clientMutationId() != null ? req.clientMutationId() : "");
        if (rawSelectedSkills != null && !rawSelectedSkills.isEmpty()) {
            clientSessionMeta.put("selectedSkills", rawSelectedSkills);
        } else if (!isProductive) {
            clientSessionMeta.put("selectedSkills", sections.stream().map(s -> s.skill().name()).toList());
        }
        if (reservationId != null) {
            clientSessionMeta.put("reservationId", reservationId);
            clientSessionMeta.put("aiAssessmentConsent", true);
        }

        Instant now = Instant.now();
        AttemptRecord attempt = new AttemptRecord(
                null,
                userId,
                form.id(),
                form.family(),
                form.variant(),
                attemptScope,
                attemptMode,
                req.parentSuiteId(),
                req.originalFullAttemptId(),
                ExamAttemptStatus.CREATED,
                1L,
                1L,
                null,
                null,
                snapshotResult.hash(),
                clientSessionMeta,
                null,
                null,
                null,
                null,
                null,
                List.of(),
                now,
                now,
                pinnedSnapshot,
                snapshotResult.version(),
                ExamSnapshotState.SNAPSHOTTED
        );

        UUID attemptId = attemptRepository.insertAttempt(attempt);

        if (req.clientMutationId() != null) {
            attemptRepository.insertCommandReceipt(new CommandReceiptRecord(
                    null, userId, attemptId, req.clientMutationId(), "CREATE_ATTEMPT",
                    req.formId().toString(), attemptId.toString(), "SUCCESS", now
            ));
        }

        log.info("Created exam attempt {} for user {} in mode {}", attemptId, userId, req.mode());
        return getAttemptState(userId, attemptId);
    }

    /**
     * Exams Phase 4.1D: the attempt snapshot with the evidence basis pinned next to the content (the ONE place the
     * basis is built; attempt creation and the import dry run use it).
     */
    public static Map<String, Object> pinEvidenceBasis(ExamManifestService.FormSnapshotResult snapshotResult,
                                                       ExamFormValidationReport validation, FormVersionRecord form,
                                                       ExamAttemptMode attemptMode, Set<SkillType> scopeSkills) {
        Map<String, Object> pinned = new LinkedHashMap<>(snapshotResult.snapshot());
        pinned.put(ExamAttemptEvidenceBasis.SNAPSHOT_KEY, ExamAttemptEvidenceBasis.pin(validation, form.id(),
                form.lifecycleState() == null ? null : form.lifecycleState().name(), attemptMode.name(), scopeSkills,
                snapshotResult.hash()).toMap());
        return pinned;
    }

    @Transactional
    public AttemptStateDto markReady(Long userId, UUID attemptId) {
        AttemptRecord attempt = getOwnedAttempt(userId, attemptId);
        if (attempt.status() != ExamAttemptStatus.CREATED && attempt.status() != ExamAttemptStatus.READY) {
            throw new IllegalStateException("Attempt cannot transition to READY from " + attempt.status());
        }

        if (attempt.status() == ExamAttemptStatus.CREATED) {
            attemptRepository.updateAttemptStatus(attemptId, ExamAttemptStatus.READY, attempt.revision());
        }

        return getAttemptState(userId, attemptId);
    }

    @Transactional
    public AttemptStateDto startAttempt(Long userId, UUID attemptId, String clientSessionId) {
        AttemptRecord attempt = attemptRepository.findAttemptByIdForUpdate(attemptId)
                .orElseThrow(() -> new ExamNotFoundException("Attempt not found: " + attemptId));

        if (!attempt.userId().equals(userId)) {
            throw new ExamForbiddenException("Access denied to attempt: " + attemptId);
        }

        if (attempt.status() == ExamAttemptStatus.IN_PROGRESS) {
            // Idempotent retry of start
            return getAttemptState(userId, attemptId);
        }

        if (attempt.status() != ExamAttemptStatus.READY && attempt.status() != ExamAttemptStatus.CREATED) {
            throw new IllegalStateException("Attempt cannot be started from state: " + attempt.status());
        }

        ExamLearnerProductPolicy.require(attempt.family(), contentRepository.findSkillsByFormId(attempt.formId()).stream()
                .map(SkillType::valueOf).toList());

        // Initialize schedule & sections
        timingService.initializeSchedule(attempt);

        // Generate writer session
        String sessionToken = UUID.randomUUID().toString();
        String tokenHash = ExamMediaService.computeSha256(sessionToken.getBytes());
        Instant leaseExpiresAt = Instant.now().plus(45, ChronoUnit.SECONDS);

        attemptRepository.updateWriterSession(attemptId, 1L, tokenHash, leaseExpiresAt, attempt.revision() + 1);

        log.info("Started attempt {} for user {}", attemptId, userId);
        return getAttemptState(userId, attemptId);
    }

    @Transactional
    public AttemptStateDto takeoverSession(Long userId, UUID attemptId) {
        AttemptRecord attempt = attemptRepository.findAttemptByIdForUpdate(attemptId)
                .orElseThrow(() -> new ExamNotFoundException("Attempt not found: " + attemptId));

        if (!attempt.userId().equals(userId)) {
            throw new ExamForbiddenException("Access denied to attempt: " + attemptId);
        }

        long nextEpoch = attempt.writerEpoch() + 1;
        String sessionToken = UUID.randomUUID().toString();
        String tokenHash = ExamMediaService.computeSha256(sessionToken.getBytes());
        Instant leaseExpiresAt = Instant.now().plus(45, ChronoUnit.SECONDS);

        attemptRepository.updateWriterSession(attemptId, nextEpoch, tokenHash, leaseExpiresAt, attempt.revision());
        log.info("Session takeover on attempt {}: new writer epoch is {}", attemptId, nextEpoch);
        return getAttemptState(userId, attemptId);
    }

    @Transactional(readOnly = true)
    public AttemptStateDto getAttemptState(Long userId, UUID attemptId) {
        AttemptRecord attempt = getOwnedAttempt(userId, attemptId);
        List<AttemptSectionRecord> sections = attemptRepository.findSectionsByAttemptId(attemptId);
        List<ResponseRecord> responses = attemptRepository.findResponsesByAttemptId(attemptId);

        Instant now = Instant.now();
        UUID currentSectionId = null;
        List<SectionStateDto> sectionDtos = new ArrayList<>();

        for (AttemptSectionRecord sec : sections) {
            Long rem = null;
            if (sec.deadlineAt() != null) {
                rem = Math.max(0, Duration.between(now, sec.deadlineAt()).getSeconds());
            }
            if (sec.state() == ExamSectionState.ACTIVE) {
                currentSectionId = sec.sectionId();
            }

            // Find skill from section record
            Optional<SectionRecord> sectionDef = contentRepository.findSectionsByFormId(attempt.formId()).stream()
                    .filter(s -> s.id().equals(sec.sectionId()))
                    .findFirst();
            SkillType skill = sectionDef.map(SectionRecord::skill).orElse(SkillType.READING);
            int ordinal = sectionDef.map(SectionRecord::ordinal).orElse(1);

            sectionDtos.add(new SectionStateDto(
                    sec.sectionId(),
                    skill,
                    ordinal,
                    sec.state(),
                    sec.phase(),
                    sec.startedAt(),
                    sec.deadlineAt(),
                    rem
            ));
        }

        Map<String, SavedResponseDto> responseMap = new HashMap<>();
        for (ResponseRecord r : responses) {
            responseMap.put(r.placementId(), new SavedResponseDto(
                    r.placementId(),
                    r.itemId(),
                    r.answerPayload(),
                    r.textResponse(),
                    r.recordingId(),
                    r.flagged(),
                    r.revision(),
                    r.updatedAt()
            ));
        }

        return new AttemptStateDto(
                attempt.id(),
                attempt.formId(),
                attempt.family(),
                attempt.variant(),
                attempt.scope(),
                attempt.attemptMode(),
                attempt.status(),
                attempt.revision(),
                attempt.writerEpoch(),
                null,
                now,
                attempt.startedAt(),
                attempt.scheduledEndAt(),
                currentSectionId,
                sectionDtos,
                responseMap,
                attempt.integrityFlags()
        );
    }

    @Transactional(readOnly = true)
    public List<AttemptHistoryItemDto> getHistory(Long userId, ExamFamily family, String variant,
                                                  ExamAttemptMode mode, int limit, int offset) {
        int safeLimit = Math.min(Math.max(limit, 1), 50);
        int safeOffset = Math.max(offset, 0);
        return attemptRepository.findHistoryByUserId(userId, family, variant, mode, safeLimit, safeOffset);
    }

    @Transactional
    public PublicAttemptManifestDto getAttemptManifest(Long userId, UUID attemptId) {
        AttemptRecord attempt = getOwnedAttempt(userId, attemptId);
        return manifestService.compileAttemptManifest(attempt);
    }

    @Transactional
    public AttemptStateDto completeSectionAndAdvance(Long userId, UUID attemptId, UUID sectionId) {
        return completeSectionAndAdvance(userId, attemptId, sectionId, null);
    }

    @Transactional
    public AttemptStateDto completeSectionAndAdvance(Long userId, UUID attemptId, UUID sectionId, CompleteSectionRequest req) {
        // Row-level lock on attempt
        AttemptRecord attempt = attemptRepository.findAttemptByIdForUpdate(attemptId)
                .orElseThrow(() -> new ExamNotFoundException("Attempt not found: " + attemptId));

        if (!attempt.userId().equals(userId)) {
            throw new ExamForbiddenException("Access denied to attempt: " + attemptId);
        }

        // Idempotency check
        String cmdId = (req != null && req.commandId() != null && !req.commandId().isBlank()) ? req.commandId() : null;
        if (cmdId != null) {
            Optional<CommandReceiptRecord> receiptOpt = attemptRepository.findCommandReceipt(userId, "COMPLETE_SECTION", cmdId);
            if (receiptOpt.isPresent()) {
                log.info("Replay detected for completeSection command {} on attempt {}", cmdId, attemptId);
                return getAttemptState(userId, attemptId);
            }
        }

        // Expected revision check
        if (req != null && req.expectedAttemptRevision() != null) {
            if (req.expectedAttemptRevision() != attempt.revision()) {
                throw new com.englishcoach.exams.exception.ExamConcurrencyException(
                        "ATTEMPT_REVISION_CONFLICT",
                        "Expected attempt revision " + req.expectedAttemptRevision() + " but current is " + attempt.revision(),
                        attempt.revision(),
                        req.expectedAttemptRevision()
                );
            }
        }

        if (attempt.status() != ExamAttemptStatus.IN_PROGRESS) {
            throw new IllegalStateException("Attempt is not in progress: " + attempt.status());
        }

        List<AttemptSectionRecord> sections = attemptRepository.findSectionsByAttemptId(attemptId);
        Optional<AttemptSectionRecord> targetSecOpt = sections.stream()
                .filter(s -> s.sectionId().equals(sectionId))
                .findFirst();

        if (targetSecOpt.isEmpty()) {
            throw new IllegalArgumentException("Section not found on attempt: " + sectionId);
        }

        AttemptSectionRecord targetSec = targetSecOpt.get();

        // Idempotency: if section is already completed, return current state without error
        if (targetSec.state() == ExamSectionState.COMPLETED) {
            log.info("Section {} on attempt {} is already COMPLETED. Returning current state.", sectionId, attemptId);
            return getAttemptState(userId, attemptId);
        }

        if (targetSec.state() != ExamSectionState.ACTIVE) {
            throw new IllegalStateException("Cannot complete section that is not ACTIVE. Current state: " + targetSec.state());
        }
        Instant now = Instant.now();

        // Seal current section
        attemptRepository.updateAttemptSection(attemptId, sectionId, ExamSectionState.COMPLETED, targetSec.startedAt(), targetSec.deadlineAt(), now);

        // Advance to next pending section
        boolean foundCurrent = false;
        AttemptSectionRecord nextSection = null;
        for (AttemptSectionRecord s : sections) {
            if (foundCurrent && s.state() == ExamSectionState.PENDING) {
                nextSection = s;
                break;
            }
            if (s.sectionId().equals(sectionId)) {
                foundCurrent = true;
            }
        }

        if (nextSection != null) {
            final UUID nextSecId = nextSection.sectionId();
            Optional<SectionRecord> secOpt = contentRepository.findSectionsByFormId(attempt.formId()).stream()
                    .filter(sec -> sec.id().equals(nextSecId))
                    .findFirst();
            int durationSec = secOpt.map(timingService::getEffectiveSectionDuration).orElse(1800);
            // Exams Phase 9C: a simulation section never ends after the attempt's server hard end
            Instant nextDeadline = ExamDeadlinePolicy.capNextDeadline(attempt, now.plus(durationSec, ChronoUnit.SECONDS));
            attemptRepository.updateAttemptSection(attemptId, nextSecId, ExamSectionState.ACTIVE, now, nextDeadline, null);
            log.info("Advanced attempt {} from section {} to {}", attemptId, sectionId, nextSecId);
        } else {
            log.info("All sections completed for attempt {}", attemptId);
        }

        // Increment attempt revision
        attemptRepository.incrementAttemptRevision(attemptId);

        if (cmdId != null) {
            attemptRepository.insertCommandReceipt(new CommandReceiptRecord(
                    null, userId, attemptId, cmdId, "COMPLETE_SECTION",
                    sectionId.toString(), attemptId.toString(), "SUCCESS", now
            ));
        }

        return getAttemptState(userId, attemptId);
    }

    public AttemptRecord getOwnedAttempt(Long userId, UUID attemptId) {
        Optional<AttemptRecord> attemptOpt = attemptRepository.findAttemptById(attemptId);
        if (attemptOpt.isEmpty()) {
            throw new ExamNotFoundException("Attempt not found: " + attemptId);
        }
        if (!attemptOpt.get().userId().equals(userId)) {
            throw new ExamForbiddenException("Access denied to attempt: " + attemptId);
        }
        return attemptOpt.get();
    }

    @Transactional
    public Optional<ActiveSimulationAttemptSummary> getActiveSimulationSummary(Long userId) {
        Optional<AttemptRecord> activeSim = attemptRepository.findActiveSimulationAttempt(userId);
        if (activeSim.isEmpty()) {
            return Optional.empty();
        }
        AttemptRecord active = activeSim.get();
        if (active.scheduledEndAt() != null && Instant.now().isAfter(active.scheduledEndAt())) {
            log.info("Active simulation {} has expired at {}. Marking EXPIRED.", active.id(), active.scheduledEndAt());
            attemptRepository.updateAttemptStatus(active.id(), ExamAttemptStatus.EXPIRED, active.revision());
            return Optional.empty();
        }
        return Optional.of(buildActiveSimulationSummary(active));
    }

    public ActiveSimulationAttemptSummary buildActiveSimulationSummary(AttemptRecord attempt) {
        UUID attemptId = attempt.id();
        UUID formId = attempt.formId();
        ExamFamily family = attempt.family();
        String variant = attempt.variant();
        ExamAttemptMode mode = attempt.attemptMode();
        ExamAttemptStatus status = attempt.status();
        Instant startedAt = attempt.startedAt() != null ? attempt.startedAt() : attempt.createdAt();

        // Get Form Title
        Optional<FormVersionRecord> formOpt = contentRepository.findFormById(formId);
        String formTitle = formOpt.map(FormVersionRecord::title).orElse("Bài thi mô phỏng");

        // Determine current skill from active or pending section
        List<AttemptSectionRecord> attemptSections = attemptRepository.findSectionsByAttemptId(attemptId);
        List<SectionRecord> formSections = contentRepository.findSectionsByFormId(formId);

        String currentSkill = "LISTENING";
        AttemptSectionRecord currentSec = attemptSections.stream()
                .filter(s -> s.state() == ExamSectionState.ACTIVE)
                .findFirst()
                .orElseGet(() -> attemptSections.stream()
                        .filter(s -> s.state() == ExamSectionState.PENDING)
                        .findFirst()
                        .orElse(attemptSections.isEmpty() ? null : attemptSections.get(0)));

        if (currentSec != null) {
            Optional<SectionRecord> secRecord = formSections.stream()
                    .filter(s -> s.id().equals(currentSec.sectionId()))
                    .findFirst();
            if (secRecord.isPresent()) {
                currentSkill = secRecord.get().skill().name();
            }
        }

        boolean resumable = (status == ExamAttemptStatus.READY || status == ExamAttemptStatus.IN_PROGRESS || status == ExamAttemptStatus.CREATED)
                && attempt.submittedAt() == null
                && attempt.invalidatedAt() == null
                && (attempt.scheduledEndAt() == null || Instant.now().isBefore(attempt.scheduledEndAt()));

        return new ActiveSimulationAttemptSummary(
                attemptId,
                formId,
                family,
                variant,
                formTitle,
                mode,
                status,
                currentSkill,
                startedAt,
                resumable
        );
    }

    @Transactional
    public void abandonAttempt(Long userId, UUID attemptId) {
        AttemptRecord attempt = getOwnedAttempt(userId, attemptId);
        if (attempt.status() == ExamAttemptStatus.SUBMITTED) {
            throw new IllegalStateException("Cannot abandon an attempt that has already been submitted: " + attemptId);
        }
        if (attempt.status() == ExamAttemptStatus.INVALIDATED || attempt.status() == ExamAttemptStatus.EXPIRED) {
            log.info("Attempt {} is already in terminal state {}", attemptId, attempt.status());
            return;
        }
        if (usageService != null && attempt.clientSessionMeta() != null && attempt.clientSessionMeta().containsKey("reservationId")) {
            Object resIdObj = attempt.clientSessionMeta().get("reservationId");
            if (resIdObj instanceof Number num) {
                usageService.releaseReservation(num.longValue());
                log.info("Released reservation {} for abandoned attempt {}", num.longValue(), attemptId);
            }
        }
        attemptRepository.invalidateAttempt(attemptId);
        log.info("User {} successfully abandoned attempt {}. Status set to INVALIDATED.", userId, attemptId);
    }
}
