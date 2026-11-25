package com.englishcoach.exams.service;

import com.englishcoach.exams.exception.ExamConcurrencyException;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamForbiddenException;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamNotFoundException;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamMediaRecords.RecordingRecord;
import com.englishcoach.exams.model.ExamSpeakingRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamMediaRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.lang.Nullable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.*;

@Slf4j
@Service
public class ExamSpeakingRuntimeService {

    private final ExamAttemptRepository attemptRepository;
    private final ExamContentRepository contentRepository;
    private final ExamMediaRepository mediaRepository;

    @Autowired
    public ExamSpeakingRuntimeService(
            ExamAttemptRepository attemptRepository,
            ExamContentRepository contentRepository,
            @Nullable ExamMediaRepository mediaRepository
    ) {
        this.attemptRepository = attemptRepository;
        this.contentRepository = contentRepository;
        this.mediaRepository = mediaRepository;
    }

    public ExamSpeakingRuntimeService(
            ExamAttemptRepository attemptRepository,
            ExamContentRepository contentRepository
    ) {
        this(attemptRepository, contentRepository, null);
    }

    @Transactional(readOnly = true)
    public SpeakingTurnDto getSpeakingTurn(Long userId, UUID attemptId, String turnKey) {
        AttemptRecord attempt = attemptRepository.findAttemptById(attemptId)
                .orElseThrow(() -> new ExamNotFoundException("Attempt not found: " + attemptId));

        validateOwnership(attempt, userId);

        AttemptSectionRecord section = getSpeakingSectionOrThrow(attemptId, attempt.formId());
        List<ResponseRecord> turns = attemptRepository.findSpeakingResponsesByAttemptAndSection(attemptId, section.sectionId());
        if (turns.isEmpty()) {
            throw new ExamNotFoundException("Speaking turns not initialized for attempt: " + attemptId);
        }

        ResponseRecord targetTurn = turns.stream()
                .filter(t -> turnKey != null && turnKey.equalsIgnoreCase(t.turnKey()))
                .findFirst()
                .orElseThrow(() -> new ExamNotFoundException("Speaking turn not found: " + turnKey));

        int cursor = Math.max(1, section.turnCursor());
        if (targetTurn.turnSequence() != null && targetTurn.turnSequence() > cursor) {
            throw new ExamForbiddenException("Access to future turn is forbidden before unlocked by examiner: " + turnKey);
        }
        if ("LOCKED".equalsIgnoreCase(targetTurn.turnState())) {
            throw new ExamForbiddenException("Access to locked turn is forbidden: " + turnKey);
        }

        if (targetTurn.turnSequence() != null && targetTurn.turnSequence() == cursor) {
            SpeakingRuntimeStateDto state = projectSpeakingRuntimeState(attempt, section, turns);
            return state.currentTurn();
        }

        Map<String, Object> snap = targetTurn.sourceSnapshot();
        String mediaUrl = snap != null && snap.containsKey("mediaUrl") ? (String) snap.get("mediaUrl") : null;

        return new SpeakingTurnDto(
                targetTurn.turnKey(),
                targetTurn.turnSequence() != null ? targetTurn.turnSequence() : 0,
                derivePartCodeFromKeyOrPlacement(targetTurn),
                targetTurn.placementId(),
                targetTurn.itemId(),
                targetTurn.turnState(),
                null,
                null, null, null, null, null,
                targetTurn.recordingId(),
                null,
                null,
                mediaUrl
        );
    }

    @Transactional
    public SpeakingRuntimeStateDto getOrInitializeSpeakingState(Long userId, UUID attemptId) {
        AttemptRecord attempt = attemptRepository.findAttemptByIdForUpdate(attemptId)
                .orElseThrow(() -> new ExamNotFoundException("Attempt not found: " + attemptId));

        validateOwnership(attempt, userId);

        AttemptSectionRecord speakingSection = getSpeakingSectionOrThrow(attemptId, attempt.formId());
        List<ResponseRecord> existingTurns = attemptRepository.findSpeakingResponsesByAttemptAndSection(attemptId, speakingSection.sectionId());

        if (existingTurns.isEmpty()) {
            existingTurns = initializeSpeakingTurns(attempt, speakingSection);
            speakingSection = attemptRepository.findAttemptSection(attemptId, speakingSection.sectionId())
                    .orElse(speakingSection);
        }

        return projectSpeakingRuntimeState(attempt, speakingSection, existingTurns);
    }

    @Transactional
    public SpeakingRuntimeStateDto startPreparation(Long userId, UUID attemptId, StartPreparationCommand cmd) {
        AttemptRecord attempt = attemptRepository.findAttemptByIdForUpdate(attemptId)
                .orElseThrow(() -> new ExamNotFoundException("Attempt not found: " + attemptId));

        validateOwnership(attempt, userId);

        String cmdId = cmd != null && cmd.clientMutationId() != null ? cmd.clientMutationId() : null;
        if (cmdId != null && !cmdId.isBlank()) {
            Optional<CommandReceiptRecord> receipt = attemptRepository.findCommandReceipt(userId, "SPEAKING_PREPARE", cmdId);
            if (receipt.isPresent()) {
                log.info("Replay detected for SPEAKING_PREPARE command {} on attempt {}", cmdId, attemptId);
                return getOrInitializeSpeakingState(userId, attemptId);
            }
        }

        AttemptSectionRecord section = getSpeakingSectionOrThrow(attemptId, attempt.formId());
        List<ResponseRecord> turns = attemptRepository.findSpeakingResponsesByAttemptAndSection(attemptId, section.sectionId());
        if (turns.isEmpty()) {
            turns = initializeSpeakingTurns(attempt, section);
            section = attemptRepository.findAttemptSection(attemptId, section.sectionId()).orElse(section);
        }

        if (cmd != null && cmd.expectedTurnRevision() != section.turnRevision()) {
            throw new ExamConcurrencyException(
                    "TURN_REVISION_CONFLICT",
                    "Expected turn revision " + cmd.expectedTurnRevision() + " but current is " + section.turnRevision(),
                    section.turnRevision(),
                    cmd.expectedTurnRevision()
            );
        }

        int cursor = section.turnCursor();
        ResponseRecord currentTurn = findTurnBySequence(turns, cursor);
        if (currentTurn == null) {
            throw new IllegalStateException("No current turn available at cursor " + cursor);
        }

        if (cmd != null && cmd.turnKey() != null && !cmd.turnKey().isBlank()) {
            if (!cmd.turnKey().equalsIgnoreCase(currentTurn.turnKey())) {
                throw new ExamForbiddenException("Turn " + cmd.turnKey() + " is not the current active turn: " + currentTurn.turnKey());
            }
        }
        if (cmd != null && cmd.transitionToken() != null && !cmd.transitionToken().isBlank()) {
            String expectedToken = generateTransitionToken(attempt.id(), currentTurn.turnKey(), section.turnRevision());
            if (!expectedToken.equals(cmd.transitionToken())) {
                throw new ExamForbiddenException("Invalid or stale transition token: " + cmd.transitionToken());
            }
        }

        Instant now = Instant.now();
        Instant deadline = now.plus(60, ChronoUnit.SECONDS);
        Map<String, Object> payload = currentTurn.answerPayload() != null
                ? new HashMap<>(currentTurn.answerPayload())
                : new HashMap<>();
        payload.put("preparationDeadline", deadline.toString());
        payload.put("preparationStartedAt", now.toString());

        attemptRepository.updateSpeakingTurnTiming(attemptId, currentTurn.turnKey(), payload, "PREPARING");
        attemptRepository.updateAttemptSectionSpeakingCursorOnly(attemptId, section.sectionId(), cursor, section.turnRevision());
        attemptRepository.incrementAttemptRevision(attemptId);

        if (cmdId != null && !cmdId.isBlank()) {
            attemptRepository.insertCommandReceipt(new CommandReceiptRecord(
                    null, userId, attemptId, cmdId, "SPEAKING_PREPARE",
                    currentTurn.turnKey(), attemptId.toString(), "SUCCESS", now
            ));
        }

        return getOrInitializeSpeakingState(userId, attemptId);
    }

    @Transactional
    public SpeakingRuntimeStateDto startRecording(Long userId, UUID attemptId, StartRecordingCommand cmd) {
        AttemptRecord attempt = attemptRepository.findAttemptByIdForUpdate(attemptId)
                .orElseThrow(() -> new ExamNotFoundException("Attempt not found: " + attemptId));

        validateOwnership(attempt, userId);

        String cmdId = cmd != null && cmd.clientMutationId() != null ? cmd.clientMutationId() : null;
        if (cmdId != null && !cmdId.isBlank()) {
            Optional<CommandReceiptRecord> receipt = attemptRepository.findCommandReceipt(userId, "SPEAKING_START_RECORD", cmdId);
            if (receipt.isPresent()) {
                log.info("Replay detected for SPEAKING_START_RECORD command {} on attempt {}", cmdId, attemptId);
                return getOrInitializeSpeakingState(userId, attemptId);
            }
        }

        AttemptSectionRecord section = getSpeakingSectionOrThrow(attemptId, attempt.formId());
        List<ResponseRecord> turns = attemptRepository.findSpeakingResponsesByAttemptAndSection(attemptId, section.sectionId());
        if (turns.isEmpty()) {
            turns = initializeSpeakingTurns(attempt, section);
            section = attemptRepository.findAttemptSection(attemptId, section.sectionId()).orElse(section);
        }

        if (cmd != null && cmd.expectedTurnRevision() != section.turnRevision()) {
            throw new ExamConcurrencyException(
                    "TURN_REVISION_CONFLICT",
                    "Expected turn revision " + cmd.expectedTurnRevision() + " but current is " + section.turnRevision(),
                    section.turnRevision(),
                    cmd.expectedTurnRevision()
            );
        }

        int cursor = section.turnCursor();
        ResponseRecord currentTurn = findTurnBySequence(turns, cursor);
        if (currentTurn == null) {
            throw new IllegalStateException("No current turn available at cursor " + cursor);
        }

        if (cmd != null && cmd.turnKey() != null && !cmd.turnKey().isBlank()) {
            if (!cmd.turnKey().equalsIgnoreCase(currentTurn.turnKey())) {
                throw new ExamForbiddenException("Turn " + cmd.turnKey() + " is not the current active turn: " + currentTurn.turnKey());
            }
        }
        if (cmd != null && cmd.transitionToken() != null && !cmd.transitionToken().isBlank()) {
            String expectedToken = generateTransitionToken(attempt.id(), currentTurn.turnKey(), section.turnRevision());
            if (!expectedToken.equals(cmd.transitionToken())) {
                throw new ExamForbiddenException("Invalid or stale transition token: " + cmd.transitionToken());
            }
        }

        String currentState = currentTurn.turnState();
        if ("COMPLETED".equals(currentState) || "LOCKED".equals(currentState)) {
            throw new IllegalStateException("Cannot start recording on turn in state: " + currentState);
        }

        Instant now = Instant.now();
        int maxSec = isPart2CueCard(currentTurn) ? 120 : 60;
        Instant deadline = now.plus(maxSec, ChronoUnit.SECONDS);

        Map<String, Object> payload = currentTurn.answerPayload() != null
                ? new HashMap<>(currentTurn.answerPayload())
                : new HashMap<>();
        payload.put("responseDeadline", deadline.toString());
        payload.put("recordingStartedAt", now.toString());

        attemptRepository.updateSpeakingTurnTiming(attemptId, currentTurn.turnKey(), payload, "RECORDING");
        attemptRepository.updateAttemptSectionSpeakingCursorOnly(attemptId, section.sectionId(), cursor, section.turnRevision());
        attemptRepository.incrementAttemptRevision(attemptId);

        if (cmdId != null && !cmdId.isBlank()) {
            attemptRepository.insertCommandReceipt(new CommandReceiptRecord(
                    null, userId, attemptId, cmdId, "SPEAKING_START_RECORD",
                    currentTurn.turnKey(), attemptId.toString(), "SUCCESS", now
            ));
        }

        return getOrInitializeSpeakingState(userId, attemptId);
    }

    @Transactional
    public SpeakingRuntimeStateDto stopRecording(Long userId, UUID attemptId, StopRecordingCommand cmd) {
        AttemptRecord attempt = attemptRepository.findAttemptByIdForUpdate(attemptId)
                .orElseThrow(() -> new ExamNotFoundException("Attempt not found: " + attemptId));

        validateOwnership(attempt, userId);

        String cmdId = cmd != null && cmd.clientMutationId() != null ? cmd.clientMutationId() : null;
        if (cmdId != null && !cmdId.isBlank()) {
            Optional<CommandReceiptRecord> receipt = attemptRepository.findCommandReceipt(userId, "SPEAKING_STOP_RECORD", cmdId);
            if (receipt.isPresent()) {
                log.info("Replay detected for SPEAKING_STOP_RECORD command {} on attempt {}", cmdId, attemptId);
                return getOrInitializeSpeakingState(userId, attemptId);
            }
        }

        AttemptSectionRecord section = getSpeakingSectionOrThrow(attemptId, attempt.formId());
        List<ResponseRecord> turns = attemptRepository.findSpeakingResponsesByAttemptAndSection(attemptId, section.sectionId());

        if (cmd != null && cmd.expectedTurnRevision() != section.turnRevision()) {
            throw new ExamConcurrencyException(
                    "TURN_REVISION_CONFLICT",
                    "Expected turn revision " + cmd.expectedTurnRevision() + " but current is " + section.turnRevision(),
                    section.turnRevision(),
                    cmd.expectedTurnRevision()
            );
        }

        int cursor = section.turnCursor();
        ResponseRecord currentTurn = findTurnBySequence(turns, cursor);
        if (currentTurn == null) {
            throw new IllegalStateException("No current turn available at cursor " + cursor);
        }

        if (cmd != null && cmd.turnKey() != null && !cmd.turnKey().isBlank()) {
            if (!cmd.turnKey().equalsIgnoreCase(currentTurn.turnKey())) {
                throw new ExamForbiddenException("Turn " + cmd.turnKey() + " is not the current active turn: " + currentTurn.turnKey());
            }
        }
        if (cmd != null && cmd.transitionToken() != null && !cmd.transitionToken().isBlank()) {
            String expectedToken = generateTransitionToken(attempt.id(), currentTurn.turnKey(), section.turnRevision());
            if (!expectedToken.equals(cmd.transitionToken())) {
                throw new ExamForbiddenException("Invalid or stale transition token: " + cmd.transitionToken());
            }
        }

        attemptRepository.updateSpeakingTurnState(attemptId, currentTurn.turnKey(), "UPLOADING", null, cmdId);
        attemptRepository.updateAttemptSectionSpeakingCursorOnly(attemptId, section.sectionId(), cursor, section.turnRevision());
        attemptRepository.incrementAttemptRevision(attemptId);

        Instant now = Instant.now();
        if (cmdId != null && !cmdId.isBlank()) {
            attemptRepository.insertCommandReceipt(new CommandReceiptRecord(
                    null, userId, attemptId, cmdId, "SPEAKING_STOP_RECORD",
                    currentTurn.turnKey(), attemptId.toString(), "SUCCESS", now
            ));
        }

        return getOrInitializeSpeakingState(userId, attemptId);
    }

    @Transactional
    public SpeakingRuntimeStateDto completeTurn(Long userId, UUID attemptId, CompleteTurnCommand cmd) {
        AttemptRecord attempt = attemptRepository.findAttemptByIdForUpdate(attemptId)
                .orElseThrow(() -> new ExamNotFoundException("Attempt not found: " + attemptId));

        validateOwnership(attempt, userId);

        String cmdId = cmd != null && cmd.clientMutationId() != null ? cmd.clientMutationId() : null;
        if (cmdId != null && !cmdId.isBlank()) {
            Optional<CommandReceiptRecord> receipt = attemptRepository.findCommandReceipt(userId, "SPEAKING_COMPLETE_TURN", cmdId);
            if (receipt.isPresent()) {
                log.info("Replay detected for SPEAKING_COMPLETE_TURN command {} on attempt {}", cmdId, attemptId);
                return getOrInitializeSpeakingState(userId, attemptId);
            }
        }

        AttemptSectionRecord section = getSpeakingSectionOrThrow(attemptId, attempt.formId());
        List<ResponseRecord> turns = attemptRepository.findSpeakingResponsesByAttemptAndSection(attemptId, section.sectionId());

        if (cmd != null && cmd.expectedTurnRevision() != section.turnRevision()) {
            throw new ExamConcurrencyException(
                    "TURN_REVISION_CONFLICT",
                    "Expected turn revision " + cmd.expectedTurnRevision() + " but current is " + section.turnRevision(),
                    section.turnRevision(),
                    cmd.expectedTurnRevision()
            );
        }

        int cursor = section.turnCursor();
        ResponseRecord currentTurn = findTurnBySequence(turns, cursor);
        if (currentTurn == null) {
            throw new IllegalStateException("No current turn available at cursor " + cursor);
        }

        if (cmd != null && cmd.turnKey() != null && !cmd.turnKey().isBlank()) {
            if (!cmd.turnKey().equalsIgnoreCase(currentTurn.turnKey())) {
                throw new ExamForbiddenException("Turn " + cmd.turnKey() + " is not the current active turn: " + currentTurn.turnKey());
            }
        }
        if (cmd != null && cmd.transitionToken() != null && !cmd.transitionToken().isBlank()) {
            String expectedToken = generateTransitionToken(attempt.id(), currentTurn.turnKey(), section.turnRevision());
            if (!expectedToken.equals(cmd.transitionToken())) {
                throw new ExamForbiddenException("Invalid or stale transition token: " + cmd.transitionToken());
            }
        }

        // =========================================================================
        // ACCEPTANCE GATE: No transition skips a recording/evidence prerequisite
        // =========================================================================
        UUID recordingId = (cmd != null && cmd.recordingId() != null) ? cmd.recordingId() : currentTurn.recordingId();
        if (recordingId == null) {
            throw new IllegalStateException("PREREQUISITE_EVIDENCE_MISSING: Cannot advance Speaking turn without completed recording evidence.");
        }
        if (cmd != null && cmd.durationMs() != null && cmd.durationMs() < 500) {
            throw new IllegalStateException("INSUFFICIENT_AUDIO_DURATION: Recorded audio duration is too short to advance Speaking turn.");
        }
        validateRecordingForTurn(attemptId, currentTurn, turns, recordingId);

        // Mark current turn COMPLETED with recording attached
        attemptRepository.updateSpeakingTurnState(attemptId, currentTurn.turnKey(), "COMPLETED", recordingId, cmdId);

        int nextCursor = cursor + 1;
        int totalTurns = turns.size();

        if (nextCursor <= totalTurns) {
            ResponseRecord nextTurn = findTurnBySequence(turns, nextCursor);
            if (nextTurn != null) {
                // Determine initial state for next turn: Part 2 cue card starts with PREPARING or READY_TO_RECORD
                String nextInitialState = isPart2CueCard(nextTurn) ? "PREPARING" : "CURRENT";
                attemptRepository.updateSpeakingTurnState(attemptId, nextTurn.turnKey(), nextInitialState, null, null);
                attemptRepository.updateAttemptSectionSpeakingCursor(
                        attemptId,
                        section.sectionId(),
                        nextCursor,
                        section.turnRevision(),
                        nextTurn.turnKey(),
                        nextTurn.placementId()
                );
                log.info("Advanced attempt {} Speaking from turn {} to turn {} ({})", attemptId, cursor, nextCursor, nextTurn.turnKey());
            }
        } else {
            // All Speaking turns completed! Mark section completed
            Instant now = Instant.now();
            attemptRepository.updateAttemptSection(
                    attemptId,
                    section.sectionId(),
                    ExamSectionState.COMPLETED,
                    section.startedAt(),
                    section.deadlineAt(),
                    now
            );
            attemptRepository.updateAttemptSectionSpeakingCursorOnly(
                    attemptId,
                    section.sectionId(),
                    nextCursor,
                    section.turnRevision()
            );
            log.info("Attempt {} Speaking section {} COMPLETED with all {} turns sealed", attemptId, section.sectionId(), totalTurns);
        }

        attemptRepository.incrementAttemptRevision(attemptId);

        Instant now = Instant.now();
        if (cmdId != null && !cmdId.isBlank()) {
            attemptRepository.insertCommandReceipt(new CommandReceiptRecord(
                    null, userId, attemptId, cmdId, "SPEAKING_COMPLETE_TURN",
                    currentTurn.turnKey(), attemptId.toString(), "SUCCESS", now
            ));
        }

        return getOrInitializeSpeakingState(userId, attemptId);
    }

    // ─── Private Helpers ──────────────────────────────────────────────────────

    private void validateOwnership(AttemptRecord attempt, Long userId) {
        if (!attempt.userId().equals(userId)) {
            throw new ExamForbiddenException("Access denied to attempt: " + attempt.id());
        }
    }

    /**
     * AUTHZ-08: Verify that the recording attached to {@code completeTurn} belongs to this attempt/turn/part,
     * has been sealed (or verified), and is not reused from another turn or another learner's attempt.
     */
    private void validateRecordingForTurn(
            UUID attemptId,
            ResponseRecord currentTurn,
            List<ResponseRecord> turns,
            UUID recordingId
    ) {
        boolean usedByAnotherTurn = turns.stream()
                .anyMatch(t -> t.turnKey() != null
                        && !t.turnKey().equalsIgnoreCase(currentTurn.turnKey())
                        && recordingId.equals(t.recordingId()));
        if (usedByAnotherTurn) {
            throw new ExamForbiddenException("RECORDING_ALREADY_USED: Recording is already attached to another speaking turn.");
        }
        if (mediaRepository == null) {
            return;
        }
        RecordingRecord rec = mediaRepository.findRecordingById(recordingId)
                .orElseThrow(() -> new ExamForbiddenException("INVALID_RECORDING: Recording not found or not accessible."));
        if (!attemptId.equals(rec.attemptId())) {
            throw new ExamForbiddenException("RECORDING_ATTEMPT_MISMATCH: Recording does not belong to this attempt.");
        }
        if (rec.state() != RecordingState.SEALED && rec.state() != RecordingState.VERIFIED) {
            throw new IllegalArgumentException(
                    "RECORDING_NOT_SEALED: Recording must be SEALED before completing the speaking turn (state=" + rec.state() + ")."
            );
        }
        if (rec.responseId() != null && currentTurn.id() != null && !rec.responseId().equals(currentTurn.id())) {
            throw new ExamForbiddenException("RECORDING_TURN_MISMATCH: Recording belongs to a different speaking turn.");
        }
        if (rec.responseId() == null) {
            if (rec.placementId() == null || currentTurn.placementId() == null
                    || !rec.placementId().equalsIgnoreCase(currentTurn.placementId())) {
                throw new ExamForbiddenException("RECORDING_PLACEMENT_MISMATCH: Recording placement does not match active speaking turn.");
            }
        }
        Integer recPart = extractSpeakingPartNumber(rec.placementId());
        Integer turnPart = extractSpeakingPartNumber(currentTurn.placementId());
        if (recPart != null && turnPart != null && !recPart.equals(turnPart)) {
            throw new ExamForbiddenException("RECORDING_PART_MISMATCH: Recording part does not match active speaking part.");
        }
    }

    private static Integer extractSpeakingPartNumber(String placementId) {
        if (placementId == null || placementId.isBlank()) {
            return null;
        }
        String lower = placementId.toLowerCase(Locale.ROOT);
        if (lower.contains("part_1") || lower.contains("part1") || lower.contains("_p1_")) return 1;
        if (lower.contains("part_2") || lower.contains("part2") || lower.contains("_p2_")) return 2;
        if (lower.contains("part_3") || lower.contains("part3") || lower.contains("_p3_")) return 3;
        return null;
    }

    private AttemptSectionRecord getSpeakingSectionOrThrow(UUID attemptId, UUID formId) {
        List<AttemptSectionRecord> attemptSections = attemptRepository.findSectionsByAttemptId(attemptId);
        List<SectionRecord> formSections = contentRepository.findSectionsByFormId(formId);

        for (AttemptSectionRecord asr : attemptSections) {
            Optional<SectionRecord> match = formSections.stream()
                    .filter(fs -> fs.id().equals(asr.sectionId()) && fs.skill() == SkillType.SPEAKING)
                    .findFirst();
            if (match.isPresent()) {
                return asr;
            }
        }
        throw new IllegalStateException("Speaking section not found for attempt: " + attemptId);
    }

    @SuppressWarnings("unchecked")
    private List<ResponseRecord> initializeSpeakingTurns(AttemptRecord attempt, AttemptSectionRecord section) {
        log.info("Initializing Speaking multi-turn simulation for attempt {} section {}", attempt.id(), section.sectionId());

        String part1PlacementId = "speaking_part_1";
        String part2PlacementId = "speaking_part_2";
        String part3PlacementId = "speaking_part_3";
        UUID part1ItemId = UUID.randomUUID();
        UUID part2ItemId = UUID.randomUUID();
        UUID part3ItemId = UUID.randomUUID();
        Map<Integer, List<String>> pinnedPrompts = new HashMap<>();
        Set<Integer> corpusParts = new HashSet<>();
        Map<Integer, List<UUID>> corpusItemIds = new HashMap<>();

        // Attempt to extract genuine parent placement and item IDs from attempt snapshot
        Map<String, Object> snapshot = attempt.manifestSnapshot();
        boolean originalBank = snapshot != null && snapshot.get("form") instanceof Map<?, ?> f
                && String.valueOf(f.get("logicalKey")).startsWith("EC_ORIGINAL_IELTS_SPEAKING_");
        if (snapshot != null && snapshot.containsKey("sections")) {
            List<Map<String, Object>> sections = (List<Map<String, Object>>) snapshot.get("sections");
            for (Map<String, Object> sec : sections) {
                if ("SPEAKING".equalsIgnoreCase((String) sec.get("skill"))) {
                    List<Map<String, Object>> parts = (List<Map<String, Object>>) sec.get("parts");
                    if (parts != null) {
                        for (Map<String, Object> part : parts) {
                            String code = (String) part.get("partCode");
                            int ord = code != null && code.matches("SPEAKING_PART_[123]")
                                    ? Integer.parseInt(code.substring(code.length() - 1))
                                    : part.containsKey("ordinal") ? ((Number) part.get("ordinal")).intValue() : 1;
                            List<Map<String, Object>> groups = (List<Map<String, Object>>) part.get("groups");
                            if (groups != null && !groups.isEmpty()) {
                                List<Map<String, Object>> items = (List<Map<String, Object>>) groups.get(0).get("items");
                                var allItems = groups.stream().flatMap(g -> ((List<Map<String, Object>>) g.get("items")).stream()).toList();
                                if (ExamPinnedSpeakingPrompts.corpusItems(allItems)) items = allItems;
                                if (items != null && !items.isEmpty()) {
                                    // Original banks store every turn as an immutable item. A scoped
                                    // attempt uses only its own pinned Part, never the live form.
                                    List<String> prompts = items.stream().map(i -> (String) i.get("prompt"))
                                            .filter(Objects::nonNull).filter(p -> !p.isBlank()).toList();
                                    boolean corpus = ExamPinnedSpeakingPrompts.corpusItems(items);
                                    if (corpus || (originalBank && prompts.size() == (ord == 2 ? 1 : 4))) pinnedPrompts.put(ord, prompts);
                                    if (corpus) {
                                        corpusParts.add(ord);
                                        corpusItemIds.put(ord, items.stream().map(i -> UUID.fromString((String) i.get("id"))).toList());
                                    }
                                    Map<String, Object> firstItem = items.get(0);
                                    UUID itId = UUID.fromString((String) firstItem.get("id"));
                                    String itPrompt = (String) firstItem.get("prompt");
                                    String plcId = code != null ? code.toLowerCase() : "speaking_part_" + ord;

                                    if (ord == 1 || (code != null && code.contains("1"))) {
                                        part1PlacementId = plcId;
                                        part1ItemId = itId;
                                    } else if (ord == 2 || (code != null && code.contains("2"))) {
                                        part2PlacementId = plcId;
                                        part2ItemId = itId;
                                    } else if (ord == 3 || (code != null && code.contains("3"))) {
                                        part3PlacementId = plcId;
                                        part3ItemId = itId;
                                    }
                                }
                            }
                        }
                    }
                    break;
                }
            }
        }

        // Child turns definition aligned with official IELTS format and recent topics:
        // Part 1: 4 familiar questions (Hometown, Neighbourhood, Daily Routine, Free Time)
        // Part 2: 1 cue card with 60s prep, 120s long turn
        // Part 3: 4 analytical discussion turns connected to learning & modern technology
        // Generate deterministic, form-specific 9-turn plan (P1=4, P2=1, P3=4)
        ExamSpeakingTurnGenerator.SpeakingTurnPlan plan = ExamSpeakingTurnGenerator.generatePlan(attempt.formId(), null);

        List<TurnBlueprint> blueprints = new ArrayList<>();

        // Part 1: 4 familiar-topic questions
        String[] p1Prompts = pinnedPrompts.containsKey(1) ? pinnedPrompts.get(1).toArray(String[]::new) : plan.part1Prompts();
        String[] p1Media = pinnedPrompts.containsKey(1) ? null : plan.part1MediaUrls();
        for (int i = 0; i < p1Prompts.length; i++) {
            Map<String, Object> snap = new HashMap<>();
            snap.put("prompt", p1Prompts[i]);
            if (p1Media != null && i < p1Media.length && p1Media[i] != null) {
                snap.put("mediaUrl", p1Media[i]);
            }
            snap.put("provenance", corpusParts.contains(1) ? "PINNED_CORPUS_SOURCE" : pinnedPrompts.containsKey(1) ? "PINNED_ORIGINAL_PRACTICE" : plan.provenance());
            if (!corpusParts.contains(1)) snap.put("topicFamily", plan.topicFamily());
            snap.put("parentPlacementId", part1PlacementId);
            snap.put("generatedAt", Instant.now().toString());
            blueprints.add(new TurnBlueprint(
                    "SPEAKING_PART_1",
                    1,
                    part1PlacementId,
                    "g0",
                    corpusParts.contains(1) ? corpusItemIds.get(1).get(i) : part1ItemId,
                    i + 1,
                    p1Prompts[i],
                    snap
            ));
        }

        // Part 2: 1 cue card with 60s prep, 120s long turn
        // All three parts use the same pinned topic plan; an unrelated form cue card
        // must not be paired with discussion questions about another topic.
        String p2Prompt = pinnedPrompts.containsKey(2) ? pinnedPrompts.get(2).getFirst() : plan.part2CuePrompt();
        Map<String, Object> p2Snap = new HashMap<>();
        p2Snap.put("prompt", p2Prompt);
        if (!pinnedPrompts.containsKey(2) && plan.part2MediaUrl() != null) {
            p2Snap.put("mediaUrl", plan.part2MediaUrl());
        }
        p2Snap.put("provenance", corpusParts.contains(2) ? "PINNED_CORPUS_SOURCE" : pinnedPrompts.containsKey(2) ? "PINNED_ORIGINAL_PRACTICE" : plan.provenance());
        if (!corpusParts.contains(2)) p2Snap.put("topicFamily", plan.topicFamily());
        p2Snap.put("parentPlacementId", part2PlacementId);
        p2Snap.put("generatedAt", Instant.now().toString());
        blueprints.add(new TurnBlueprint(
                "SPEAKING_PART_2",
                2,
                part2PlacementId,
                "g0",
                corpusParts.contains(2) ? corpusItemIds.get(2).getFirst() : part2ItemId,
                1,
                p2Prompt,
                p2Snap
        ));
        if (corpusParts.contains(2)) {
            for (int i = 1; i < pinnedPrompts.get(2).size(); i++) {
                String prompt = pinnedPrompts.get(2).get(i);
                var followUp = new HashMap<>(p2Snap);
                followUp.put("prompt", prompt);
                followUp.put("followUp", true);
                blueprints.add(new TurnBlueprint("SPEAKING_PART_2", 2, part2PlacementId, "g0",
                        corpusItemIds.get(2).get(i), i + 1, prompt, followUp));
            }
        }

        // Part 3: 4 analytical discussion turns logically connected to Part 2
        String[] p3Prompts = pinnedPrompts.containsKey(3) ? pinnedPrompts.get(3).toArray(String[]::new) : plan.part3Prompts();
        String[] p3Media = pinnedPrompts.containsKey(3) ? null : plan.part3MediaUrls();
        for (int i = 0; i < p3Prompts.length; i++) {
            Map<String, Object> snap = new HashMap<>();
            snap.put("prompt", p3Prompts[i]);
            if (p3Media != null && i < p3Media.length && p3Media[i] != null) {
                snap.put("mediaUrl", p3Media[i]);
            }
            snap.put("provenance", corpusParts.contains(3) ? "PINNED_CORPUS_SOURCE" : pinnedPrompts.containsKey(3) ? "PINNED_ORIGINAL_PRACTICE" : plan.provenance());
            if (!corpusParts.contains(3)) snap.put("topicFamily", plan.topicFamily());
            snap.put("parentPlacementId", part3PlacementId);
            snap.put("generatedAt", Instant.now().toString());
            blueprints.add(new TurnBlueprint(
                    "SPEAKING_PART_3",
                    3,
                    part3PlacementId,
                    "g0",
                    corpusParts.contains(3) ? corpusItemIds.get(3).get(i) : part3ItemId,
                    i + 1,
                    p3Prompts[i],
                    snap
            ));
        }

        blueprints.sort(Comparator
                .comparingInt(TurnBlueprint::partOrdinal)
                .thenComparingInt(TurnBlueprint::itemOrdinal));

        // A practice attempt owns only the Part pinned at creation. Never initialize
        // unrelated turns, recordings or completion requirements for that attempt.
        com.englishcoach.exams.practice.ExamPracticeScope.pinned(snapshot).ifPresent(scope -> {
            if ("IELTS_SPEAKING_PART".equals(scope.get("scopeType")) && scope.get("number") instanceof Number n) {
                blueprints.removeIf(bp -> bp.partOrdinal() != n.intValue());
            }
        });

        int sequence = 1;
        String firstTurnKey = null;
        String firstPlacementId = null;

        for (TurnBlueprint bp : blueprints) {
            String pStr = formatPartCode(bp.partCode());
            String gStr = bp.logicalGroupKey() != null ? bp.logicalGroupKey().replace("GRP_", "").toLowerCase() : "g0";
            String turnKey = String.format("speak_%s_g_%s_i_%02d", pStr, gStr, bp.itemOrdinal());

            String turnState = sequence == 1 ? "CURRENT" : "LOCKED";
            attemptRepository.insertSpeakingTurnResponse(
                    attempt.id(),
                    section.sectionId(),
                    bp.placementId(),
                    bp.itemId(),
                    turnKey,
                    sequence,
                    turnState,
                    bp.itemSnapshot()
            );

            if (sequence == 1) {
                firstTurnKey = turnKey;
                firstPlacementId = bp.placementId();
            }
            sequence++;
        }

        // Initialize attempt_sections cursor to Turn 1
        attemptRepository.updateAttemptSectionSpeakingCursor(
                attempt.id(),
                section.sectionId(),
                1,
                section.turnRevision(),
                firstTurnKey,
                firstPlacementId
        );

        return attemptRepository.findSpeakingResponsesByAttemptAndSection(attempt.id(), section.sectionId());
    }

    private SpeakingRuntimeStateDto projectSpeakingRuntimeState(
            AttemptRecord attempt,
            AttemptSectionRecord section,
            List<ResponseRecord> turns
    ) {
        int cursor = Math.max(1, section.turnCursor());
        int totalTurns = turns.size();
        int lockedTurnCount = Math.max(0, totalTurns - cursor);
        boolean sectionCompleted = section.state() == ExamSectionState.COMPLETED || cursor > totalTurns;

        SpeakingTurnDto currentTurnDto = null;
        String activePartCode = null;
        String transitionToken = null;

        if (!sectionCompleted) {
            ResponseRecord currentTurnRecord = findTurnBySequence(turns, cursor);
            if (currentTurnRecord != null) {
                transitionToken = generateTransitionToken(attempt.id(), currentTurnRecord.turnKey(), section.turnRevision());
                String promptText = extractPromptFromSnapshot(currentTurnRecord.sourceSnapshot());
                boolean isPart2 = isPart2CueCard(currentTurnRecord);

                Integer prepSec = isPart2 ? 60 : null;
                Integer respSec = isPart2 ? 120 : 60;

                Instant prepDeadline = null;
                Instant respDeadline = null;
                Long remainingSec = null;
                Instant now = Instant.now();

                Map<String, Object> payload = currentTurnRecord.answerPayload();
                if (payload != null) {
                    if (payload.containsKey("preparationDeadline")) {
                        prepDeadline = Instant.parse((String) payload.get("preparationDeadline"));
                        if ("PREPARING".equals(currentTurnRecord.turnState())) {
                            remainingSec = Math.max(0, Duration.between(now, prepDeadline).getSeconds());
                        }
                    }
                    if (payload.containsKey("responseDeadline")) {
                        respDeadline = Instant.parse((String) payload.get("responseDeadline"));
                        if ("RECORDING".equals(currentTurnRecord.turnState())) {
                            remainingSec = Math.max(0, Duration.between(now, respDeadline).getSeconds());
                        }
                    }
                }

                Map<String, Object> snap = currentTurnRecord.sourceSnapshot();
                String mediaUrl = snap != null && snap.containsKey("mediaUrl")
                        ? (String) snap.get("mediaUrl")
                        : null;

                currentTurnDto = new SpeakingTurnDto(
                        currentTurnRecord.turnKey(),
                        currentTurnRecord.turnSequence() != null ? currentTurnRecord.turnSequence() : cursor,
                        derivePartCodeFromKeyOrPlacement(currentTurnRecord),
                        currentTurnRecord.placementId(),
                        currentTurnRecord.itemId(),
                        currentTurnRecord.turnState(),
                        promptText,
                        prepSec,
                        respSec,
                        prepDeadline,
                        respDeadline,
                        remainingSec,
                        currentTurnRecord.recordingId(),
                        null,
                        transitionToken,
                        mediaUrl
                );
                activePartCode = currentTurnDto.partCode();
            }
        }

        // Completed turns list: summaries only, ZERO future prompts, ZERO completed prompts
        List<SpeakingTurnSummaryDto> completedTurns = new ArrayList<>();
        for (ResponseRecord turn : turns) {
            if ("COMPLETED".equals(turn.turnState()) || (turn.turnSequence() != null && turn.turnSequence() < cursor)) {
                completedTurns.add(new SpeakingTurnSummaryDto(
                        turn.turnKey(),
                        turn.turnSequence() != null ? turn.turnSequence() : 0,
                        derivePartCodeFromKeyOrPlacement(turn),
                        turn.recordingId(),
                        turn.turnState()
                ));
            }
        }

        return new SpeakingRuntimeStateDto(
                attempt.id(),
                section.sectionId(),
                cursor,
                section.turnRevision(),
                currentTurnDto,
                totalTurns,
                lockedTurnCount,
                completedTurns,
                sectionCompleted,
                activePartCode,
                transitionToken
        );
    }

    private static String generateTransitionToken(UUID attemptId, String turnKey, long turnRevision) {
        return sha256(attemptId + ":" + turnKey + ":" + turnRevision + ":speaking_transition_token_v4");
    }

    private static String sha256(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder hexString = new StringBuilder();
            for (byte b : hash) {
                String hex = Integer.toHexString(0xff & b);
                if (hex.length() == 1) hexString.append('0');
                hexString.append(hex);
            }
            return hexString.toString();
        } catch (Exception e) {
            return "token_" + Math.abs(text.hashCode());
        }
    }

    private ResponseRecord findTurnBySequence(List<ResponseRecord> turns, int seq) {
        for (ResponseRecord t : turns) {
            if (t.turnSequence() != null && t.turnSequence() == seq) {
                return t;
            }
        }
        return null;
    }

    private boolean isPart2CueCard(ResponseRecord turn) {
        if (turn.sourceSnapshot() != null && Boolean.TRUE.equals(turn.sourceSnapshot().get("followUp"))) return false;
        if (turn.placementId() != null && turn.placementId().toLowerCase().contains("part_2")) {
            return true;
        }
        if (turn.turnKey() != null && turn.turnKey().contains("_p2_")) {
            return true;
        }
        return false;
    }

    private String derivePartCodeFromKeyOrPlacement(ResponseRecord turn) {
        if (turn.placementId() != null && turn.placementId().toLowerCase().contains("part_1")) return "SPEAKING_PART_1";
        if (turn.placementId() != null && turn.placementId().toLowerCase().contains("part_2")) return "SPEAKING_PART_2";
        if (turn.placementId() != null && turn.placementId().toLowerCase().contains("part_3")) return "SPEAKING_PART_3";
        if (turn.turnKey() != null && turn.turnKey().contains("_p1_")) return "SPEAKING_PART_1";
        if (turn.turnKey() != null && turn.turnKey().contains("_p2_")) return "SPEAKING_PART_2";
        if (turn.turnKey() != null && turn.turnKey().contains("_p3_")) return "SPEAKING_PART_3";
        return "SPEAKING_PART_1";
    }

    private String extractPromptFromSnapshot(Map<String, Object> snapshot) {
        if (snapshot == null) return null;
        if (snapshot.containsKey("prompt")) return (String) snapshot.get("prompt");
        if (snapshot.containsKey("promptText")) return (String) snapshot.get("promptText");
        return null;
    }

    private String formatPartCode(String partCode) {
        if (partCode == null) return "p1";
        String lower = partCode.toLowerCase();
        if (lower.contains("part_1") || lower.contains("part1")) return "p1";
        if (lower.contains("part_2") || lower.contains("part2")) return "p2";
        if (lower.contains("part_3") || lower.contains("part3")) return "p3";
        return lower.replace("speaking_", "").replace("part_", "p");
    }

    private record TurnBlueprint(
            String partCode,
            int partOrdinal,
            String placementId,
            String logicalGroupKey,
            UUID itemId,
            int itemOrdinal,
            String prompt,
            Map<String, Object> itemSnapshot
    ) {}
}
