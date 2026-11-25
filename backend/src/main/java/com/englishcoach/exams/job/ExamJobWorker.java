package com.englishcoach.exams.job;

import com.englishcoach.exams.client.ExamAiClient;
import com.englishcoach.exams.config.ExamsProperties;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamProfileRecords.ProfileEvidenceRecord;
import com.englishcoach.exams.model.ExamScoringRecords.*;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamProfileRepository;
import com.englishcoach.exams.repository.ExamScoringRepository;
import com.englishcoach.exams.scoring.ExamAttemptSnapshotContent;
import com.englishcoach.exams.validation.ExamAttemptEvidenceBasis;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.scoring.ExamObjectiveScorer.ItemScoreResult;
import com.englishcoach.exams.scoring.ExamObjectiveScorer.SectionObjectiveScoreResult;
import com.englishcoach.exams.scoring.ExamScoreAggregator;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import com.englishcoach.exams.model.ExamMediaRecords.RecordingRecord;

import java.time.Instant;
import java.util.*;

@Slf4j
@Component
@RequiredArgsConstructor
public class ExamJobWorker {

    private final ExamScoringRepository scoringRepository;
    private final ExamAttemptRepository attemptRepository;
    private final ExamContentRepository contentRepository;
    private final ExamProfileRepository profileRepository;
    private final ExamObjectiveScorer objectiveScorer;
    private final ExamScoreAggregator scoreAggregator;
    private final ExamAiClient aiClient;
    private final com.englishcoach.exams.media.ExamMediaService mediaService;
    private final ExamsProperties properties;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.englishcoach.premium.service.PremiumUsageService usageService;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.context.ApplicationEventPublisher eventPublisher;

    public void setUsageService(com.englishcoach.premium.service.PremiumUsageService usageService) {
        this.usageService = usageService;
    }

    public void setEventPublisher(org.springframework.context.ApplicationEventPublisher eventPublisher) {
        this.eventPublisher = eventPublisher;
    }

    /** Authoritative content validation (Exams Phase 2); absent ⇒ no official evidence (fail closed). */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private com.englishcoach.exams.validation.ExamContentValidationService validationService;

    public void setValidationService(com.englishcoach.exams.validation.ExamContentValidationService validationService) {
        this.validationService = validationService;
    }

    private final java.util.concurrent.atomic.AtomicInteger consecutiveIdlePolls = new java.util.concurrent.atomic.AtomicInteger(0);
    private volatile long nextPollEarliestMs = 0L;
    private volatile long lastLeaseReapMs = 0L;

    /** Signals the worker to poll immediately on the next tick when a new scoring job is enqueued. */
    public void wakePoller() {
        consecutiveIdlePolls.set(0);
        nextPollEarliestMs = 0L;
    }

    // Own scheduler (performance release 2026-11-16, PERF-10): a slow AI-judged job no longer delays the default scheduler's
    // jobs (Card Blast PvP ticks, payment webhook sweep). Adaptive idle backoff (1s -> 15s) eliminates idle Azure PG RTTs
    // while wakePoller() keeps active submission latency immediate.
    @Scheduled(fixedDelayString = "${app.exams.worker.poll-interval-ms:1000}",
            scheduler = com.englishcoach.common.scheduling.SlowJobsSchedulerConfig.SCHEDULER_BEAN)
    public void pollAndProcessJobs() {
        if (!properties.getWorker().isEnabled()) {
            return;
        }
        long nowMs = System.currentTimeMillis();
        if (nowMs < nextPollEarliestMs) {
            return;
        }
        if (nowMs - lastLeaseReapMs >= 60_000L) {
            lastLeaseReapMs = nowMs;
            try {
                int reaped = scoringRepository.reapExpiredRunningLeases();
                if (reaped > 0) {
                    log.warn("Reclaimed {} expired exam scoring job lease(s)", reaped);
                }
            } catch (Exception ex) {
                log.debug("Lease reap skipped: {}", ex.getMessage());
            }
        }

        String leaseToken = UUID.randomUUID().toString();
        int leaseSec = properties.getWorker().getLeaseDurationSeconds();

        Optional<JobRecord> jobOpt = scoringRepository.claimNextReadyJob(leaseToken, leaseSec,
                List.of("SUBMISSION_SCORING", "RESCORE", "IELTS_OBJECTIVE", "TOEIC_OBJECTIVE", "IELTS_WRITING", "IELTS_SPEAKING", "TOEIC_WRITING", "TOEIC_SPEAKING"));
        if (jobOpt.isEmpty()) {
            int idle = consecutiveIdlePolls.incrementAndGet();
            long backoffMs = Math.min(15_000L, 1_000L << Math.min(idle, 4));
            nextPollEarliestMs = nowMs + backoffMs;
            return;
        }
        consecutiveIdlePolls.set(0);
        nextPollEarliestMs = 0L;

        JobRecord job = jobOpt.get();
        log.info("Worker claimed job {} (target {}, submission {})", job.id(), job.target(), job.submissionId());

        try {
            // Deduplication: If this submission already has a COMPLETED artifact produced for this run or higher, mark redundant jobs completed
            Optional<ScoreArtifactRecord> existingArtifact = scoringRepository.findLatestArtifactBySubmissionId(job.submissionId());
            if (existingArtifact.isPresent()
                    && existingArtifact.get().resultStatus() == ResultStatus.COMPLETED
                    && existingArtifact.get().runOrdinal() >= job.runOrdinal()
                    && !"RESCORE".equalsIgnoreCase(job.target())) {
                log.info("Submission {} already scored with COMPLETED artifact {}, completing job {}",
                        job.submissionId(), existingArtifact.get().id(), job.id());
                scoringRepository.completeJob(job.id(), leaseToken);
                return;
            }

            processSubmissionJob(job, leaseToken);
            scoringRepository.completeJob(job.id(), leaseToken);
            log.info("Job {} completed successfully", job.id());
        } catch (ExamAiClient.ExamAiException e) {
            log.warn("AI service error processing job {}: retryable={}, msg={}", job.id(), e.isRetryable(), e.getMessage());
            boolean failed = scoringRepository.failJob(job.id(), leaseToken, e.getMessage(), e.isRetryable(), 15);
            if (failed && (!e.isRetryable() || job.attemptCount() >= job.maxAttempts())) {
                releaseReservationIfPresent(job);
            }
        } catch (Exception e) {
            log.error("Fatal error processing job {}: {}", job.id(), e.getMessage(), e);
            scoringRepository.failJob(job.id(), leaseToken, "Internal error: " + e.getMessage(), false, 60);
            releaseReservationIfPresent(job);
        }
    }

    private void releaseReservationIfPresent(JobRecord job) {
        if (usageService == null || job == null || job.submissionId() == null) return;
        try {
            attemptRepository.findSubmissionById(job.submissionId())
                    .flatMap(sub -> attemptRepository.findAttemptById(sub.attemptId()))
                    .ifPresent(att -> {
                        if (att.clientSessionMeta() != null && att.clientSessionMeta().containsKey("reservationId")) {
                            Object resIdObj = att.clientSessionMeta().get("reservationId");
                            if (resIdObj instanceof Number num) {
                                usageService.releaseReservation(num.longValue());
                                log.info("Released reservation {} after job failure for attempt {}", num.longValue(), att.id());
                            }
                        }
                    });
        } catch (Exception ex) {
            log.warn("Failed to release reservation on job failure: {}", ex.getMessage());
        }
    }

    private void processSubmissionJob(JobRecord job, String leaseToken) {
        SubmissionRecord submission = attemptRepository.findSubmissionById(job.submissionId())
                .orElseThrow(() -> new IllegalStateException("Submission not found: " + job.submissionId()));

        AttemptRecord attempt = attemptRepository.findAttemptById(submission.attemptId())
                .orElseThrow(() -> new IllegalStateException("Attempt not found: " + submission.attemptId()));

        executeSubmissionScoring(submission, attempt, job, false);
    }

    public ScoreArtifactRecord scoreObjectiveSubmissionDirectly(SubmissionRecord submission, AttemptRecord attempt) {
        return executeSubmissionScoring(submission, attempt, null, true);
    }

    public ScoreArtifactRecord executeSubmissionScoring(SubmissionRecord submission, AttemptRecord attempt, JobRecord job, boolean objectiveOnly) {
        FormVersionRecord form = contentRepository.findFormById(attempt.formId())
                .orElseThrow(() -> new IllegalStateException("Form not found: " + attempt.formId()));

        ScoringSchemeVersionRecord scheme = form.scoringSchemeId() != null ?
                contentRepository.findScoringSchemeById(form.scoringSchemeId()).orElse(null) : null;

        List<SectionRecord> formSections = contentRepository.findSectionsByFormId(attempt.formId());
        Map<UUID, SkillType> sectionSkillMap = new HashMap<>();
        for (SectionRecord fs : formSections) {
            sectionSkillMap.put(fs.id(), fs.skill());
        }

        List<AttemptSectionRecord> sections = attemptRepository.findSectionsByAttemptId(attempt.id());
        List<ResponseRecord> responses = attemptRepository.findResponsesByAttemptId(attempt.id());
        Map<UUID, AnswerSpecRecord> answerSpecs = contentRepository.findAnswerSpecsByFormId(attempt.formId());
        List<ItemVersionRecord> formItems = contentRepository.findItemsByFormId(attempt.formId());
        Map<UUID, ItemVersionRecord> itemMap = new HashMap<>();
        for (ItemVersionRecord it : formItems) {
            itemMap.put(it.id(), it);
        }

        // Map response by item placement
        Map<UUID, ResponseRecord> responseByItem = new HashMap<>();
        for (ResponseRecord r : responses) {
            if (r.itemId() != null) {
                responseByItem.put(r.itemId(), r);
            }
        }

        UUID artifactId = UUID.randomUUID();
        Optional<ScoreArtifactRecord> existingArtifact = scoringRepository.findLatestArtifactBySubmissionId(submission.id());
        Map<ScoreMetric, Double> metricScores = new EnumMap<>(ScoreMetric.class);
        List<ScoreComponentRecord> componentRecords = new ArrayList<>();
        List<CriterionScoreRecord> criterionRecords = new ArrayList<>();
        boolean requiresReview = false;
        Map<String, Object> practiceRawScores = new LinkedHashMap<>();
        Optional<ExamAttemptSnapshotContent> snapshotContent =
                attempt.snapshotState() == ExamSnapshotState.SNAPSHOTTED && attempt.manifestSnapshot() != null
                        ? ExamAttemptSnapshotContent.parse(attempt.manifestSnapshot()) : Optional.empty();
        // Exams Phase 6: a practice scope (one part / passage / section / task) is never a standardized scoring unit and
        // is never AI-scored: raw metrics only, whatever path (direct scoring or a fallback job) reaches here.
        boolean practiceScoped = attempt.attemptMode() == ExamAttemptMode.PRACTICE
                && com.englishcoach.exams.practice.ExamPracticeScope.isScoped(attempt.manifestSnapshot());

        // 1. Process each section
        for (AttemptSectionRecord sec : sections) {
            SkillType skill = sectionSkillMap.getOrDefault(sec.sectionId(), SkillType.READING);
            if (sec.state() == ExamSectionState.PENDING) {
                log.info("Section {} ({}) was never started (PENDING); omitting from scored components to avoid fake 0.0", sec.sectionId(), skill);
                requiresReview = true;
                continue;
            }
            if (skill == SkillType.LISTENING || skill == SkillType.READING) {
                // Objective section scoring
                ScoreMetric metric = (skill == SkillType.LISTENING) ? ScoreMetric.LISTENING : ScoreMetric.READING;
                List<ExamObjectiveScorer.ObjectiveItemInput> inputs = new ArrayList<>();
                String contentSource;

                // Exams Phase 4C.5 (EXAM-AUD-024): a SNAPSHOTTED attempt is scored ONLY against the items and answer
                // specs it pinned at creation; content edited or re-imported later never changes its score.
                if (snapshotContent.isPresent()) {
                    contentSource = "ATTEMPT_SNAPSHOT";
                    List<ExamAttemptSnapshotContent.SnapshotItem> snapItems = snapshotContent.get().section(sec.sectionId())
                            .map(ExamAttemptSnapshotContent.SnapshotSection::items).orElse(List.of());
                    for (ExamAttemptSnapshotContent.SnapshotItem it : snapItems) {
                        if (it.answerSpec() == null) continue;
                        inputs.add(new ExamObjectiveScorer.ObjectiveItemInput(it.itemId(), it.questionNumber(),
                                learnerAnswer(responseByItem.get(it.itemId())), it.answerSpec(), it.numbersExempt()));
                    }
                } else {
                    // Legacy attempts created before snapshots existed: live tables (historical behaviour kept).
                    contentSource = "LIVE_CONTENT_LEGACY_UNSNAPSHOTTED";
                    Map<UUID, AnswerSpecRecord> sectionSpecs = contentRepository.findAnswerSpecsBySectionId(sec.sectionId());
                    if (sectionSpecs.isEmpty()) {
                        sectionSpecs = answerSpecs;
                    }
                    for (Map.Entry<UUID, AnswerSpecRecord> entry : sectionSpecs.entrySet()) {
                        ItemVersionRecord iv = itemMap.get(entry.getKey());
                        Map<String, Object> defs = iv != null ? iv.optionDefinitions() : null;
                        Integer qn = defs != null && defs.get("questionNumber") instanceof Number n ? n.intValue()
                                : (iv != null ? iv.ordinal() : null);
                        inputs.add(new ExamObjectiveScorer.ObjectiveItemInput(entry.getKey(), qn,
                                learnerAnswer(responseByItem.get(entry.getKey())), entry.getValue(),
                                ExamAttemptSnapshotContent.wordLimitAllowsNumber(defs)));
                    }
                }

                List<ItemScoreResult> itemResults = objectiveScorer.scoreItems(inputs);

                SectionObjectiveScoreResult secResult = objectiveScorer.scoreSection(
                        sec.sectionId(),
                        attempt.family(),
                        metric,
                        itemResults,
                        scheme,
                        attempt.variant()
                );

                long attempted = itemResults.stream()
                        .filter(r -> !ExamObjectiveScorer.OUTCOME_BLANK.equals(r.outcome())).count();
                ExamObjectiveScorer.ScaleApplicability scale = practiceScoped
                        ? ExamObjectiveScorer.ScaleApplicability.PARTIAL_UNSCALED
                        : ExamObjectiveScorer.scaleApplicability(attempt.family(), metric, secResult.maxRawScore());
                boolean unscaled = !Double.isFinite(secResult.scaledScore());
                if (scale == ExamObjectiveScorer.ScaleApplicability.PARTIAL_UNSCALED || unscaled) {
                    // Exams Phase 4C.6: an incomplete / partial section never claims an IELTS band or a TOEIC scaled
                    // score. Raw practice metrics only (artifact version bundle); no component, no metric score ⇒ no
                    // overall, no scaled-score consumer (Activity / Proficiency) can read a fake scale.
                    Map<String, Object> raw = new LinkedHashMap<>();
                    raw.put("correct", secResult.rawScore());
                    raw.put("attempted", attempted);
                    raw.put("maxRaw", secResult.maxRawScore());
                    raw.put("percent", secResult.maxRawScore() > 0
                            ? Math.round(secResult.rawScore() * 1000.0 / secResult.maxRawScore()) / 10.0 : 0.0);
                    raw.put("scale", scale == ExamObjectiveScorer.ScaleApplicability.PARTIAL_UNSCALED ? "UNSCALED_PARTIAL" : "NO_FORM_CONVERSION");
                    raw.put("contentSource", contentSource);
                    practiceRawScores.put(metric.name(), raw);
                    log.info("Section {} ({}) scored raw only: {} items is not a complete standard section",
                            sec.sectionId(), skill, (long) secResult.maxRawScore());
                    continue;
                }

                metricScores.put(metric, secResult.scaledScore());

                Map<String, Object> componentMeta = new LinkedHashMap<>();
                componentMeta.put("rawTotal", secResult.rawScore());
                componentMeta.put("maxRaw", secResult.maxRawScore());
                componentMeta.put("attempted", attempted);
                componentMeta.put("contentSource", contentSource);
                ScoreComponentRecord comp = new ScoreComponentRecord(
                        UUID.randomUUID(),
                        artifactId,
                        attempt.family(),
                        metric,
                        sec.sectionId(),
                        null,
                        secResult.rawScore(),
                        secResult.scaledScore(),
                        secResult.scaleName(),
                        componentMeta,
                        scheme != null ? scheme.calibrationId() : null,
                        Instant.now()
                );
                componentRecords.add(comp);

                // Stage record
                if (job != null) {
                    scoringRepository.insertJobStage(new JobStageRecord(
                            UUID.randomUUID(),
                            job.id(),
                            "OBJECTIVE_" + skill.name(),
                            1,
                            "obj-input-hash",
                            "obj-output-hash",
                            Map.of("rawScore", secResult.rawScore(), "scaledScore", secResult.scaledScore()),
                            null,
                            Map.of("scorer", "ExamObjectiveScorer", "version", "1.0"),
                            50,
                            JobStageStatus.SUCCESS,
                            Instant.now()
                    ));
                }

            } else if (practiceScoped && (skill == SkillType.WRITING || skill == SkillType.SPEAKING)) {
                // Writing task practice keeps the learner response; no band, no AI call, no heuristic fallback score.
                practiceRawScores.put(skill.name(), Map.of("scale", "NOT_SCORED", "reason", "PRACTICE_SCOPE_RESPONSE_ONLY"));
            } else if (!objectiveOnly && (skill == SkillType.WRITING || skill == SkillType.SPEAKING)) {
                Map<String, Object> consent = attempt.clientSessionMeta();
                if (consent == null || !Boolean.TRUE.equals(consent.get("aiAssessmentConsent"))
                        || !(consent.get("reservationId") instanceof Number reserved) || usageService == null
                        || !usageService.hasExamReservation(attempt.userId(), reserved.longValue())) {
                    requiresReview = true;
                    continue;
                }
                // Productive section scoring via AI judge
                ScoreMetric metric = (skill == SkillType.WRITING) ? ScoreMetric.WRITING : ScoreMetric.SPEAKING;
                Set<UUID> sectionItemIds = contentRepository.findItemIdsBySectionId(sec.sectionId());

                String learnerText = "";
                String promptText = "";
                String audioBase64 = null;

                Map<String, Object> rubric = Map.of("rubric", "standard");
                if (skill == SkillType.WRITING && attempt.family() == ExamFamily.IELTS) {
                    var tasks = com.englishcoach.exams.scoring.IeltsWritingTasks.from(attempt.manifestSnapshot(),
                            sec.sectionId(), responseByItem, attempt.variant());
                    if (tasks.isEmpty()) { requiresReview = true; continue; }
                    rubric = Map.of("tasks", tasks);
                } else if (skill == SkillType.WRITING) {
                    StringBuilder writingText = new StringBuilder();
                    StringBuilder promptBuilder = new StringBuilder();
                    int taskNum = 1;
                    for (ResponseRecord r : responses) {
                        boolean belongs = (r.sectionId() != null && r.sectionId().equals(sec.sectionId()))
                                || (r.itemId() != null && sectionItemIds.contains(r.itemId()));
                        if (belongs) {
                            String txt = r.textResponse();
                            if ((txt == null || txt.isBlank()) && r.answerPayload() != null) {
                                if (r.answerPayload().containsKey("value")) {
                                    txt = String.valueOf(r.answerPayload().get("value"));
                                } else if (r.answerPayload().containsKey("text")) {
                                    txt = String.valueOf(r.answerPayload().get("text"));
                                }
                            }
                            if (txt != null && !txt.isBlank()) {
                                if (writingText.length() > 0) writingText.append("\n\n---\n\n");
                                writingText.append(txt);

                                if (r.itemId() != null && itemMap.containsKey(r.itemId())) {
                                    ItemVersionRecord iv = itemMap.get(r.itemId());
                                    if (promptBuilder.length() > 0) promptBuilder.append("\n\n---\n\n");
                                    promptBuilder.append("Task ").append(taskNum).append(" Instructions:\n");
                                    if (iv.prompt() != null && !iv.prompt().isBlank()) {
                                        promptBuilder.append(iv.prompt()).append("\n");
                                    }
                                    try {
                                        List<StimulusVersionRecord> stimuli = contentRepository.findStimuliByGroupId(iv.groupId());
                                        for (StimulusVersionRecord stim : stimuli) {
                                            if (stim.bodyPayload() != null && stim.bodyPayload().containsKey("text")) {
                                                promptBuilder.append("Task Stimulus/Topic:\n").append(stim.bodyPayload().get("text")).append("\n");
                                            }
                                        }
                                    } catch (Exception ignored) {}
                                }
                                taskNum++;
                            }
                        }
                    }
                    learnerText = writingText.toString();
                    promptText = promptBuilder.length() > 0 ? promptBuilder.toString() : "Official " + attempt.family() + " Writing Tasks";
                } else if (skill == SkillType.SPEAKING) {
                    StringBuilder speakingText = new StringBuilder();
                    StringBuilder promptBuilder = new StringBuilder();
                    long sessionBytes = 0;
                    List<ExamAiClient.SpeakingTurnEvidenceDto> turnEvidenceList = new ArrayList<>();

                    List<ResponseRecord> speakingResponses = responses.stream()
                            .filter(r -> "SPEAKING_TURN".equalsIgnoreCase(r.responseKind()) || (r.turnKey() != null && !r.turnKey().isBlank()))
                            .sorted(Comparator.comparingInt(r -> r.turnSequence() != null ? r.turnSequence() : 0))
                            .toList();

                    // Hard gate: Speaking scoring requires ALL required child turns completed
                    boolean hasIncompleteTurns = speakingResponses.isEmpty() || speakingResponses.stream().anyMatch(r ->
                            !"COMPLETED".equalsIgnoreCase(r.turnState()) || r.recordingId() == null);
                    if (hasIncompleteTurns) {
                        log.warn("Speaking scoring gate withheld: Attempt {} has incomplete speaking child turns (total={}, completed={}). Remaining PENDING/REVIEW.",
                                attempt.id(), speakingResponses.size(),
                                speakingResponses.stream().filter(r -> "COMPLETED".equalsIgnoreCase(r.turnState()) && r.recordingId() != null).count());
                        requiresReview = true;
                        continue;
                    }

                    int seqCounter = 1;
                    for (ResponseRecord r : speakingResponses) {
                        String txt = r.textResponse();
                        if (txt != null && !txt.isBlank()) {
                            if (speakingText.length() > 0) speakingText.append(" ");
                            speakingText.append(txt);
                        }

                        byte[] recBytes = null;
                        Integer durMs = null;
                        Map<String, Object> acoustic = new HashMap<>();
                        String turnAudioB64 = null;

                        if (r.recordingId() != null) {
                            RecordingRecord recording = mediaService.findRecordingById(r.recordingId()).orElse(null);
                            if (recording == null || !attempt.id().equals(recording.attemptId())
                                    || (recording.state() != RecordingState.SEALED && recording.state() != RecordingState.VERIFIED)
                                    || recording.totalBytes() <= 0 || recording.totalBytes() > 10_000_000
                                    || sessionBytes + recording.totalBytes() > 30_000_000) break;
                            recBytes = mediaService.getRecordingBytes(recording.id());
                            if (recBytes.length != recording.totalBytes()) break;
                            sessionBytes += recBytes.length;
                            turnAudioB64 = Base64.getEncoder().encodeToString(recBytes);
                            acoustic.put("totalBytes", recBytes.length);
                            durMs = recording.durationMs() == null ? null : recording.durationMs().intValue();
                        }

                        String itemPrompt = "";
                        if (r.itemId() != null && itemMap.containsKey(r.itemId())) {
                            ItemVersionRecord iv = itemMap.get(r.itemId());
                            if (iv.prompt() != null && !iv.prompt().isBlank()) {
                                itemPrompt = iv.prompt();
                                if (promptBuilder.length() > 0) promptBuilder.append("\n\n---\n\n");
                                promptBuilder.append("Speaking Part Prompt:\n").append(iv.prompt());
                            }
                        }

                        String turnKey = r.turnKey() != null ? r.turnKey() : ("speak_turn_" + r.id());
                        int turnSeq = (r.turnSequence() != null && r.turnSequence() > 0) ? r.turnSequence() : seqCounter;
                        seqCounter = Math.max(seqCounter + 1, turnSeq + 1);
                        String partKey = "Part 1";
                        if (turnKey.contains("p2") || turnKey.contains("part2") || (r.placementId() != null && r.placementId().toString().contains("part_2"))) {
                            partKey = "Part 2";
                        } else if (turnKey.contains("p3") || turnKey.contains("part3") || (r.placementId() != null && r.placementId().toString().contains("part_3"))) {
                            partKey = "Part 3";
                        }

                        String transcript = (txt != null) ? txt.trim() : "";
                        String transcriptStatus = (!transcript.isBlank()) ? "READY" : "NOT_REQUESTED";

                        turnEvidenceList.add(new ExamAiClient.SpeakingTurnEvidenceDto(
                                turnKey,
                                turnSeq,
                                partKey,
                                r.itemId() != null ? r.itemId().toString() : null,
                                itemPrompt,
                                r.recordingId(),
                                durMs != null ? durMs : 0,
                                transcript,
                                transcriptStatus,
                                turnAudioB64,
                                acoustic,
                                Map.of("responseId", r.id().toString()),
                                null,
                                null
                        ));
                    }

                    learnerText = speakingText.toString();
                    promptText = promptBuilder.toString();
                    boolean allRecordingsValid = sessionBytes > 0 && turnEvidenceList.size() == speakingResponses.size();
                    if (!allRecordingsValid) {
                        log.warn("Speaking scoring gate withheld: Attempt {} has missing or unsealed audio evidence. Remaining PENDING/REVIEW.", attempt.id());
                        requiresReview = true;
                        continue;
                    }

                    try {
                        ExamAiClient.AiScoringRequest aiReq = new ExamAiClient.AiScoringRequest(
                                "STAGE_" + skill.name(),
                                attempt.family(),
                                skill,
                                skill.name(),
                                promptText,
                                learnerText,
                                null,
                                turnEvidenceList.isEmpty() ? audioBase64 : null,
                                Map.of("rubric", "standard"),
                                Map.of("calibration", "v1"),
                                attempt.pinnedManifestHash(),
                                turnEvidenceList.isEmpty() ? null : turnEvidenceList,
                                "rubric-v4",
                                "judge-v4",
                                null
                        );

                        ExamAiClient.AiScoringResponse aiResp = aiClient.evaluateProductiveStage(aiReq);
                        boolean hasValidScore = isAuthoritativeAiScore(aiResp);

                        if (hasValidScore) {
                            metricScores.put(metric, aiResp.overallBand());

                            // Persist speaking transcripts and update recording status
                            if (aiResp.turnDiagnostics() != null) {
                                for (Map.Entry<String, Object> entry : aiResp.turnDiagnostics().entrySet()) {
                                    String turnKey = entry.getKey();
                                    if (entry.getValue() instanceof Map<?, ?> diagMap) {
                                        Object transObj = diagMap.get("transcriptText");
                                        String transcript = (transObj instanceof String s) ? s.trim() : "";
                                        if (!transcript.isBlank()) {
                                            for (ExamAiClient.SpeakingTurnEvidenceDto te : turnEvidenceList) {
                                                if (turnKey.equals(te.turnKey()) && te.recordingId() != null) {
                                                    try {
                                                        mediaService.updateRecordingTranscript(te.recordingId(), "READY", transcript);
                                                    } catch (Exception ex) {
                                                        log.warn("Failed to update recording transcript for {}: {}", te.recordingId(), ex.getMessage());
                                                    }
                                                    break;
                                                }
                                            }
                                            try {
                                                attemptRepository.updateSpeakingTurnTranscript(attempt.id(), turnKey, transcript);
                                            } catch (Exception ex) {
                                                log.debug("Response record is immutable post-submission: {}", ex.getMessage());
                                            }
                                        } else {
                                            for (ExamAiClient.SpeakingTurnEvidenceDto te : turnEvidenceList) {
                                                if (turnKey.equals(te.turnKey()) && te.recordingId() != null) {
                                                    try {
                                                        mediaService.updateRecordingTranscript(te.recordingId(), "ABSTAINED", "");
                                                    } catch (Exception ex) {
                                                        log.warn("Failed to update recording transcript for {}: {}", te.recordingId(), ex.getMessage());
                                                    }
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            Map<String, Object> speakingMeta = new HashMap<>();
                            if (aiResp.telemetry() != null) {
                                speakingMeta.putAll(aiResp.telemetry());
                            }
                            if (aiResp.turnDiagnostics() != null) {
                                speakingMeta.put("turnDiagnostics", aiResp.turnDiagnostics());
                            }
                            speakingMeta.put("artifactId", artifactId.toString());

                            ScoreComponentRecord comp = new ScoreComponentRecord(
                                    UUID.randomUUID(),
                                    artifactId,
                                    attempt.family(),
                                    metric,
                                    sec.sectionId(),
                                    null,
                                    null,
                                    aiResp.overallBand(),
                                    (attempt.family() == ExamFamily.IELTS) ? "IELTS_AI_PRACTICE_ESTIMATE" : "TOEIC_SCALE_0_200",
                                    speakingMeta,
                                    scheme != null ? scheme.calibrationId() : null,
                                    Instant.now()
                                );
                            componentRecords.add(comp);

                            if (aiResp.criteria() != null) {
                                for (ExamAiClient.CriterionScoreDto c : aiResp.criteria()) {
                                    if (c.score() != null && c.score() >= 0.0) {
                                        criterionRecords.add(new CriterionScoreRecord(
                                                UUID.randomUUID(),
                                                artifactId,
                                                skill.name(),
                                                c.criterion(),
                                                c.score(),
                                                c.evidence() != null ? c.evidence().stream().map(e -> Map.<String, Object>of("snippet", e)).toList() : List.of(),
                                                Map.of("feedback", c.feedback() != null ? c.feedback() : ""),
                                                Instant.now()
                                        ));
                                    }
                                }
                            }
                        } else {
                            log.info("Speaking evaluation abstained or requires review: reviewRequired={}, overallBand={}, fallback={}, notes={}, abstention={}",
                                    aiResp.reviewRequired(), aiResp.overallBand(), aiFallbackMarker(aiResp), aiResp.reviewerNotes(), aiResp.abstention());
                            requiresReview = true;
                            // Critical Invariant: Missing or uncalibrated subjective score NEVER becomes 0.0 or 1.0.
                            // ScoreComponentRecord and CriterionScoreRecords are omitted so it remains PENDING/REVIEW.
                        }

                        String stageInputHash = aiResp.evidenceHash() != null ? aiResp.evidenceHash() : ("prod-input-" + UUID.randomUUID());
                        String stageOutputHash = aiResp.outputHash() != null ? aiResp.outputHash() : ("prod-output-" + UUID.randomUUID());

                        scoringRepository.insertJobStage(new JobStageRecord(
                                UUID.randomUUID(),
                                job.id(),
                                "PRODUCTIVE_" + skill.name(),
                                2,
                                stageInputHash,
                                stageOutputHash,
                                hasValidScore ? Map.of("score", aiResp.overallBand(), "status", "SUCCESS") : Map.of("status", "REVIEW_REQUIRED"),
                                null,
                                Map.of("provider", "FastAPI-Exams", "model", "judge-v4"),
                                1200,
                                hasValidScore ? JobStageStatus.SUCCESS : JobStageStatus.ABSTAINED,
                                Instant.now()
                        ));

                        if (aiResp.reviewRequired()) {
                            requiresReview = true;
                        }
                    } catch (Exception e) {
                        log.warn("Productive evaluation error for skill {}: {}", skill, e.getMessage());
                        requiresReview = true;
                    }
                    continue; // Skip the generic block below for speaking
                }

                try {
                    ExamAiClient.AiScoringRequest aiReq = new ExamAiClient.AiScoringRequest(
                            "STAGE_" + skill.name(),
                            attempt.family(),
                            skill,
                            skill.name(),
                            promptText,
                            learnerText,
                            null,
                            audioBase64,
                            rubric,
                            Map.of("calibration", "v1")
                    );

                    ExamAiClient.AiScoringResponse aiResp = aiClient.evaluateProductiveStage(aiReq);
                    boolean hasValidScore = isAuthoritativeAiScore(aiResp);
                    if (hasValidScore) {
                        double resolvedScore = aiResp.overallBand();
                        Map<String, Object> uncertaintyMap = new HashMap<>();

                        if (skill == SkillType.WRITING && aiResp.telemetry() != null) {
                            if (aiResp.telemetry().containsKey("canonicalWritingBand")) {
                                resolvedScore = ((Number) aiResp.telemetry().get("canonicalWritingBand")).doubleValue();
                            }
                            if (aiResp.telemetry().containsKey("task1Band")) {
                                uncertaintyMap.put("task1Band", aiResp.telemetry().get("task1Band"));
                            }
                            if (aiResp.telemetry().containsKey("task2Band")) {
                                uncertaintyMap.put("task2Band", aiResp.telemetry().get("task2Band"));
                            }
                            if (aiResp.telemetry().containsKey("canonicalWritingBand")) {
                                uncertaintyMap.put("canonicalWritingBand", resolvedScore);
                            }
                            if (aiResp.telemetry().containsKey("calculationVersion")) {
                                uncertaintyMap.put("calculationVersion", aiResp.telemetry().get("calculationVersion"));
                            }
                            for (String key : List.of("model", "rubricVersion", "assessmentType")) {
                                if (aiResp.telemetry().get(key) instanceof String v) uncertaintyMap.put(key, v);
                            }
                            uncertaintyMap.put("artifactId", artifactId.toString());
                        }

                        metricScores.put(metric, resolvedScore);

                        ScoreComponentRecord comp = new ScoreComponentRecord(
                                UUID.randomUUID(),
                                artifactId,
                                attempt.family(),
                                metric,
                                sec.sectionId(),
                                null,
                                null,
                                resolvedScore,
                                (attempt.family() == ExamFamily.IELTS) ? "IELTS_AI_PRACTICE_ESTIMATE" : "TOEIC_SCALE_0_200",
                                uncertaintyMap,
                                scheme != null ? scheme.calibrationId() : null,
                                Instant.now()
                        );
                        componentRecords.add(comp);
                    }

                    // Non-authoritative (review / fallback) results keep no criterion scores, as for Speaking.
                    if (hasValidScore && aiResp.criteria() != null) {
                        for (ExamAiClient.CriterionScoreDto c : aiResp.criteria()) {
                            if (c.score() != null && c.score() >= 0.0) {
                                criterionRecords.add(new CriterionScoreRecord(
                                        UUID.randomUUID(),
                                        artifactId,
                                        skill.name(),
                                        c.criterion(),
                                        c.score(),
                                        c.evidence() != null ? c.evidence().stream().map(e -> Map.<String, Object>of("snippet", e)).toList() : List.of(),
                                        Map.of("feedback", c.feedback() != null ? c.feedback() : ""),
                                        Instant.now()
                                ));
                            }
                        }
                    }

                    String stageInputHash = aiResp.evidenceHash() != null ? aiResp.evidenceHash() : ("prod-input-" + UUID.randomUUID());
                    String stageOutputHash = aiResp.outputHash() != null ? aiResp.outputHash() : ("prod-output-" + UUID.randomUUID());

                    if (job != null) {
                        scoringRepository.insertJobStage(new JobStageRecord(
                                UUID.randomUUID(),
                                job.id(),
                                "PRODUCTIVE_" + skill.name(),
                                2,
                                stageInputHash,
                                stageOutputHash,
                                hasValidScore ? Map.of("score", aiResp.overallBand(), "status", "SUCCESS") : Map.of("status", "REVIEW_REQUIRED"),
                                null,
                                Map.of("provider", "FastAPI-Exams", "model", "judge-v4"),
                                1200,
                                hasValidScore ? JobStageStatus.SUCCESS : JobStageStatus.ABSTAINED,
                                Instant.now()
                        ));
                    }

                    if (aiResp.reviewRequired() || !hasValidScore) {
                        requiresReview = true;
                    }
                } catch (Exception e) {
                    log.warn("Productive evaluation error for skill {}: {}", skill, e.getMessage());
                    requiresReview = true;
                }
            }
        }

        // 2. Aggregate final overall/composite score
        scoreAggregator.aggregateScores(attempt.family(), attempt.scope(), metricScores);

        // Add overall component if computed
        if (metricScores.containsKey(ScoreMetric.FULL_OVERALL)) {
            double overall = metricScores.get(ScoreMetric.FULL_OVERALL);
            Double l = metricScores.get(ScoreMetric.LISTENING);
            Double r = metricScores.get(ScoreMetric.READING);
            Double w = metricScores.get(ScoreMetric.WRITING);
            Double s = metricScores.get(ScoreMetric.SPEAKING);
            Map<String, Object> overallMeta = new HashMap<>();
            if (l != null && r != null && w != null && s != null) {
                overallMeta.put("lBand", l);
                overallMeta.put("rBand", r);
                overallMeta.put("wBand", w);
                overallMeta.put("sBand", s);
                overallMeta.put("rawMean", (l + r + w + s) / 4.0);
                overallMeta.put("roundingRule", "ielts_quarter_boundary_v1");
            }
            overallMeta.put("artifactId", artifactId.toString());

            componentRecords.add(new ScoreComponentRecord(
                    UUID.randomUUID(),
                    artifactId,
                    attempt.family(),
                    ScoreMetric.FULL_OVERALL,
                    null,
                    null,
                    null,
                    overall,
                    "IELTS_BAND",
                    overallMeta,
                    scheme != null ? scheme.calibrationId() : null,
                    Instant.now()
            ));
        } else if (metricScores.containsKey(ScoreMetric.LR_TOTAL)) {
            double lrTotal = metricScores.get(ScoreMetric.LR_TOTAL);
            componentRecords.add(new ScoreComponentRecord(
                    UUID.randomUUID(),
                    artifactId,
                    attempt.family(),
                    ScoreMetric.LR_TOTAL,
                    null,
                    null,
                    null,
                    lrTotal,
                    "TOEIC_SCALE_10_990",
                    Map.of(),
                    scheme != null ? scheme.calibrationId() : null,
                    Instant.now()
            ));
        }

        // 3. Persist ScoreArtifactRecord
        ResultStatus finalResultStatus = requiresReview ? ResultStatus.REVIEW_REQUIRED : ResultStatus.COMPLETED;

        int defaultOrdinal = (job != null) ? job.runOrdinal() : 1;
        int runOrdinal = existingArtifact.map(a -> Math.max(a.runOrdinal() + 1, defaultOrdinal)).orElse(defaultOrdinal);
        UUID predecessorId = existingArtifact.map(ScoreArtifactRecord::id).orElse(null);

        Map<String, Object> versionBundle = new LinkedHashMap<>();
        versionBundle.put("pipeline", "v1");
        versionBundle.put("scorer", "english-coach-exams");
        versionBundle.put("objectiveContentSource", snapshotContent.isPresent()
                ? "ATTEMPT_SNAPSHOT" : "LIVE_CONTENT_LEGACY_UNSNAPSHOTTED");
        if (!practiceRawScores.isEmpty()) versionBundle.put("practiceRawScores", practiceRawScores);
        ScoreArtifactRecord artifact = new ScoreArtifactRecord(
                artifactId,
                submission.id(),
                runOrdinal,
                predecessorId,
                versionBundle,
                "evidence-hash-" + artifactId,
                finalResultStatus,
                Map.of(),
                Instant.now()
        );
        Runnable persist = () -> persistResult(submission, attempt, objectiveOnly, form, artifact, componentRecords,
                criterionRecords, metricScores, finalResultStatus);
        if (transactions != null) transactions.executeWithoutResult(status -> persist.run());
        else persist.run(); // Standalone test fixtures use their own transaction boundary.
        return artifact;
    }

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.transaction.support.TransactionTemplate transactions;

    private void persistResult(SubmissionRecord submission, AttemptRecord attempt, boolean objectiveOnly, FormVersionRecord form,
                               ScoreArtifactRecord artifact, List<ScoreComponentRecord> componentRecords, List<CriterionScoreRecord> criterionRecords,
                               Map<ScoreMetric, Double> metricScores, ResultStatus finalResultStatus) {
        UUID artifactId = artifact.id();
        int runOrdinal = artifact.runOrdinal();
        scoringRepository.insertScoreArtifact(artifact);

        // Persist components & criteria
        for (ScoreComponentRecord comp : componentRecords) {
            scoringRepository.insertScoreComponent(comp);
        }
        scoringRepository.insertCriterionScores(criterionRecords);
        // Echo Sentinel (10 §BX): a simulation created after activation scores Activity Points and official evidence only
        // when its strict attempt ended COMPLETED_VERIFIED. Practice keeps its own (non-evidence) rules.
        boolean sentinelOk = sentinelIntegrity == null || attempt.attemptMode() != ExamAttemptMode.EXAM_SIMULATION
                || sentinelIntegrity.allowsAttempt(attempt.id());
        if (!sentinelOk) log.info("[EchoSentinel] attempt {} has no verified strict attempt: no evidence, no Activity Points", attempt.id());
        // Additive notification trigger for scored exam completion
        if (eventPublisher != null && finalResultStatus == ResultStatus.COMPLETED) {
            try {
                String scoreStr = "";
                if (metricScores.containsKey(ScoreMetric.FULL_OVERALL)) {
                    scoreStr = String.valueOf(metricScores.get(ScoreMetric.FULL_OVERALL));
                } else if (metricScores.containsKey(ScoreMetric.LR_TOTAL)) {
                    scoreStr = String.valueOf(Math.round(metricScores.get(ScoreMetric.LR_TOTAL)));
                } else if (!metricScores.isEmpty()) {
                    scoreStr = String.valueOf(metricScores.values().iterator().next());
                }
                String examName = form != null && form.title() != null ? form.title() : "Bài thi";
                eventPublisher.publishEvent(new com.englishcoach.notification.event.ExamCompletedNotificationEvent(
                        attempt.userId(), attempt.id(), examName, scoreStr
                ));
            } catch (Exception ex) {
                log.warn("Non-fatal: Failed to publish ExamCompletedNotificationEvent for attempt {}: {}", attempt.id(), ex.getMessage());
            }
        }

        // 4. Ingest into Profile Evidence only for a completed production form.
        // PILOT, CALIBRATED, and other pre-publication forms may be executable,
        // but their results are measurement evidence rather than trusted profile
        // evidence. The database trigger applies the same policy as a backstop.
        // Atomic Full Mock Invariant: For full IELTS mocks, all 5 metrics (L, R, W, S, FULL_OVERALL)
        // must exist on the canonical artifact with valid scores before any evidence is admitted to the profile.
        boolean isFullMock = attempt.family() == ExamFamily.IELTS &&
                ("FULL".equalsIgnoreCase(attempt.scope()) || "FULL_MOCK".equalsIgnoreCase(attempt.scope()) ||
                 (attempt.variant() != null && attempt.variant().toUpperCase().contains("FULL")));
        boolean hasAllFullMockComponents = true;
        if (isFullMock) {
            Set<ScoreMetric> presentMetrics = new HashSet<>();
            for (ScoreComponentRecord c : componentRecords) {
                if (c.scaledScore() >= 0.0) {
                    presentMetrics.add(c.metric());
                }
            }
            hasAllFullMockComponents = presentMetrics.contains(ScoreMetric.LISTENING)
                    && presentMetrics.contains(ScoreMetric.READING)
                    && presentMetrics.contains(ScoreMetric.WRITING)
                    && presentMetrics.contains(ScoreMetric.SPEAKING)
                    && presentMetrics.contains(ScoreMetric.FULL_OVERALL);
        }

        // Exams Phase 4.1D: the decision uses the evidence basis PINNED to the attempt (content validation and form
        // lifecycle at attempt creation), never the form as it is today. A retired / replaced / re-validated form
        // cannot rewrite the attempt's history: when the attempt was eligible but the CURRENT form can no longer take
        // new rows (V7 backstop reads the current lifecycle / calibration), existing evidence is PRESERVED.
        ExamAttemptEvidenceBasis.Resolution basis = evidenceBasis(attempt);
        EvidenceOutcome outcome = !sentinelOk ? EvidenceOutcome.REVOKE : profileEvidenceOutcome(attempt.attemptMode(), finalResultStatus,
                !isFullMock || hasAllFullMockComponents, basis, componentRecords,
                () -> contentRepository.isProductionEligibleForProfileEvidence(form.id()));
        if (outcome == EvidenceOutcome.INSERT) {
            // Supersede any active evidence from prior artifact runs of this attempt
            profileRepository.supersedeEvidenceForAttempt(attempt.id(), artifactId, "SUPERSEDED_BY_NEW_RUN", "v4.0");

            for (ScoreComponentRecord comp : componentRecords) {
                profileRepository.insertProfileEvidence(new ProfileEvidenceRecord(
                        UUID.randomUUID(),
                        attempt.userId(),
                        attempt.id(),
                        artifactId,
                        comp.id(),
                        attempt.family(),
                        comp.metric().name(),
                        attempt.scope(),
                        attempt.family().name() + "_" + attempt.variant(),
                        Instant.now(),
                        comp.scaledScore(),
                        "FIRST_EXPOSURE",
                        comp.metric() == ScoreMetric.WRITING || comp.metric() == ScoreMetric.SPEAKING || comp.metric() == ScoreMetric.FULL_OVERALL
                                || "IELTS_BAND_ESTIMATE".equals(comp.scaleName()) ? Map.of("basis", "SIMULATION_ESTIMATE") : Map.of("confidence", "HIGH"),
                        "ACTIVE",
                        Instant.now()
                ));
            }
        } else if (outcome == EvidenceOutcome.REVOKE) {
            // If artifact requires review, failed, or form is ineligible, revoke any stale active evidence for this attempt!
            profileRepository.revokeEvidenceForAttempt(attempt.id(), "ARTIFACT_REQUIRES_REVIEW_OR_INELIGIBLE", "v4.0");
        } else {
            log.info("[ExamsEvidence] attempt {}: existing profile evidence preserved, nothing new ({})", attempt.id(), basis.kind());
        }

        // Commit EXAM_AI_SCORING reservation if present
        if (!objectiveOnly && usageService != null && attempt.clientSessionMeta() != null && attempt.clientSessionMeta().containsKey("reservationId")) {
            Object resIdObj = attempt.clientSessionMeta().get("reservationId");
            if (resIdObj instanceof Number num) {
                if (finalResultStatus == ResultStatus.COMPLETED && (metricScores.containsKey(ScoreMetric.WRITING) || metricScores.containsKey(ScoreMetric.SPEAKING))) {
                    usageService.commitReservation(num.longValue());
                } else {
                    usageService.releaseReservation(num.longValue());
                }
            }
        }


        if (eventPublisher != null && sentinelOk) eventPublisher.publishEvent(new com.englishcoach.common.event.ExamScoredEvent(attempt.userId(), attempt.id(), submission.id(), artifactId, runOrdinal, form.id(), String.valueOf(attempt.family()), attempt.variant(), attempt.scope(), String.valueOf(attempt.attemptMode()), finalResultStatus.name(), new HashMap<>(metricScores), Instant.now()));

    }

    /**
     * Phase 0 containment (EXAM-AUD-014): an AI judge result is authoritative only when it succeeded, has a
     * non-negative band, does not ask for review AND was not produced by a deterministic fallback rubric
     * (ai-service marks those with telemetry.fallback, e.g. DETERMINISTIC_RUBRIC). Anything else keeps the
     * artifact REVIEW_REQUIRED, so it never becomes profile or Proficiency evidence.
     */
    private static Object learnerAnswer(ResponseRecord resp) {
        if (resp == null) return null;
        return resp.answerPayload() != null ? resp.answerPayload() : resp.textResponse();
    }

    public static boolean isAuthoritativeAiScore(ExamAiClient.AiScoringResponse aiResp) {
        return aiResp != null
                && aiResp.success()
                && aiResp.overallBand() != null
                && aiResp.overallBand() >= 0.0
                && !aiResp.reviewRequired()
                && aiFallbackMarker(aiResp) == null;
    }

    static String aiFallbackMarker(ExamAiClient.AiScoringResponse aiResp) {
        if (aiResp == null || aiResp.telemetry() == null) return null;
        Object marker = aiResp.telemetry().get("fallback");
        if (marker == null) return null;
        String text = marker.toString().trim();
        return text.isEmpty() || "false".equalsIgnoreCase(text) ? null : text;
    }

    /** Phase 4.1D: INSERT new profile evidence, REVOKE active evidence, or PRESERVE what exists (no new rows). */
    enum EvidenceOutcome { INSERT, REVOKE, PRESERVE }

    /** The attempt's pinned evidence basis (never current form content). */
    static ExamAttemptEvidenceBasis.Resolution evidenceBasis(AttemptRecord attempt) {
        return ExamAttemptEvidenceBasis.resolveFromSnapshot(attempt.snapshotState(), attempt.manifestSnapshot(),
                attempt.formId(), attempt.attemptMode() == null ? null : attempt.attemptMode().name());
    }

    /**
     * Exams Phase 2 + 4.1D (EXAM-AUD-003/006/024): every skill component must pass the shared
     * {@link com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy} against the attempt's PINNED basis —
     * simulation mode, COMPLETED, a real score and a skill that was official-evidence eligible when the attempt was
     * created. Components from AI fallback rubrics never exist (REVIEW_REQUIRED). Returns the first ineligible
     * decision, or null when every skill component is eligible.
     */
    private com.englishcoach.sentinel.SentinelExamIntegrity sentinelIntegrity;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setSentinelIntegrity(com.englishcoach.sentinel.SentinelExamIntegrity sentinelIntegrity) { this.sentinelIntegrity = sentinelIntegrity; }

    static com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy.Decision firstIneligible(
            ExamAttemptMode attemptMode, ResultStatus resultStatus, ExamAttemptEvidenceBasis.Resolution basis,
            List<ScoreComponentRecord> components) {
        boolean anySkill = false;
        for (ScoreComponentRecord c : components) {
            if (com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy.skillOf(c.metric().name()) == null) continue;
            anySkill = true;
            if ("IELTS_AI_PRACTICE_ESTIMATE".equals(c.scaleName()) || "IELTS_BAND_ESTIMATE".equals(c.scaleName())) {
                return new com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy.Decision(false,
                        com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy.Reason.UNCALIBRATED_ESTIMATE,
                        com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy.skillOf(c.metric().name()));
            }
            com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy.Decision decision =
                    com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy.decide(
                            attemptMode == null ? null : attemptMode.name(),
                            resultStatus == null ? null : resultStatus.name(),
                            c.metric().name(), c.scaledScore(), false, basis);
            if (!decision.eligible()) return decision;
        }
        return anySkill ? null : new com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy.Decision(false,
                com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy.Reason.NOT_A_SKILL_METRIC, null);
    }

    boolean hasValidContentForEvidence(ExamAttemptMode attemptMode, ResultStatus resultStatus,
                                       ExamAttemptEvidenceBasis.Resolution basis, List<ScoreComponentRecord> components) {
        com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy.Decision bad =
                firstIneligible(attemptMode, resultStatus, basis, components);
        if (bad != null) log.info("[ExamsValidation] profile evidence withheld: {} {}", bad.skill(), bad.reason());
        return bad == null;
    }

    /**
     * Outcome for exams.profile_evidence (Phase 4.1D):
     * <ul>
     *   <li>not a completed simulation / incomplete full mock / pinned basis ineligible: REVOKE (as before);</li>
     *   <li>legacy attempt without a pinned basis: PRESERVE (historical rows untouched, no new evidence);</li>
     *   <li>form not PUBLISHED at attempt time: REVOKE (it was measurement, never trusted evidence);</li>
     *   <li>eligible at attempt time but the CURRENT form fails the production backstop (retired / replaced, the V7
     *       trigger would refuse): PRESERVE;</li>
     *   <li>otherwise INSERT.</li>
     * </ul>
     */
    static EvidenceOutcome profileEvidenceOutcome(ExamAttemptMode attemptMode, ResultStatus resultStatus,
                                                  boolean fullMockComplete, ExamAttemptEvidenceBasis.Resolution basis,
                                                  List<ScoreComponentRecord> components,
                                                  java.util.function.BooleanSupplier currentProductionBackstop) {
        if (attemptMode != ExamAttemptMode.EXAM_SIMULATION || resultStatus != ResultStatus.COMPLETED || !fullMockComplete) {
            return EvidenceOutcome.REVOKE;
        }
        com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy.Decision bad =
                firstIneligible(attemptMode, resultStatus, basis, components);
        if (bad != null) {
            return bad.reason() == com.englishcoach.exams.validation.ExamEvidenceEligibilityPolicy.Reason.LEGACY_VALIDATION_UNAVAILABLE
                    ? EvidenceOutcome.PRESERVE : EvidenceOutcome.REVOKE;
        }
        if (!LifecycleState.PUBLISHED.name().equals(basis.basis().formLifecycleState())) return EvidenceOutcome.REVOKE;
        return currentProductionBackstop.getAsBoolean() ? EvidenceOutcome.INSERT : EvidenceOutcome.PRESERVE;
    }

    public static boolean isProductionEligibleForProfileEvidence(ExamAttemptMode attemptMode,
                                                          LifecycleState lifecycleState,
                                                          ResultStatus resultStatus,
                                                          boolean approvedProductionCalibration) {
        return attemptMode == ExamAttemptMode.EXAM_SIMULATION
                && lifecycleState == LifecycleState.PUBLISHED
                && resultStatus == ResultStatus.COMPLETED
                && approvedProductionCalibration;
    }
}
