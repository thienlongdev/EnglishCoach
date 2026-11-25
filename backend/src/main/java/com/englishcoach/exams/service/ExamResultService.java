package com.englishcoach.exams.service;

import com.englishcoach.exams.exception.ExamExceptionHandler.ExamNotFoundException;
import com.englishcoach.exams.exception.ExamExceptionHandler.ExamForbiddenException;
import com.englishcoach.exams.model.ExamAttemptRecords.*;
import com.englishcoach.exams.model.ExamContentRecords.AnswerSpecRecord;
import com.englishcoach.exams.model.ExamContentRecords.ItemVersionRecord;
import com.englishcoach.exams.model.ExamContentRecords.SectionRecord;
import com.englishcoach.exams.model.ExamScoringRecords.*;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.ScoreMetric;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import com.englishcoach.exams.model.ExamTypes.ResultStatus;
import com.englishcoach.exams.model.ExamTypes.RecordingState;
import com.englishcoach.exams.model.ExamTypes.ExamSnapshotState;
import com.englishcoach.exams.model.ExamTypes.ExamSectionState;
import com.englishcoach.exams.model.ExamMediaRecords.RecordingRecord;
import com.englishcoach.exams.media.ExamMediaService;
import com.englishcoach.exams.model.ExamSpeakingReviewRecords;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.repository.ExamContentRepository;
import com.englishcoach.exams.repository.ExamMediaRepository;
import com.englishcoach.exams.repository.ExamScoringRepository;
import com.englishcoach.exams.scoring.ExamObjectiveScorer;
import com.englishcoach.exams.scoring.ExamObjectiveScorer.ItemScoreResult;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.*;

import org.springframework.beans.factory.annotation.Autowired;

@Slf4j
@Service
public class ExamResultService {

    private final ExamAttemptRepository attemptRepository;
    private final ExamScoringRepository scoringRepository;
    private final ExamContentRepository contentRepository;
    private final ExamMediaRepository mediaRepository;
    private final ExamMediaService mediaService;
    private final ExamObjectiveScorer objectiveScorer;

    @Autowired
    public ExamResultService(
            ExamAttemptRepository attemptRepository,
            ExamScoringRepository scoringRepository,
            ExamContentRepository contentRepository,
            ExamMediaRepository mediaRepository,
            @Autowired(required = false) ExamMediaService mediaService,
            ExamObjectiveScorer objectiveScorer
    ) {
        this.attemptRepository = attemptRepository;
        this.scoringRepository = scoringRepository;
        this.contentRepository = contentRepository;
        this.mediaRepository = mediaRepository;
        this.mediaService = mediaService;
        this.objectiveScorer = objectiveScorer;
    }

    public ExamResultService(
            ExamAttemptRepository attemptRepository,
            ExamScoringRepository scoringRepository,
            ExamContentRepository contentRepository,
            ExamMediaRepository mediaRepository,
            ExamObjectiveScorer objectiveScorer
    ) {
        this(attemptRepository, scoringRepository, contentRepository, mediaRepository, null, objectiveScorer);
    }

    public ExamResultService(
            ExamAttemptRepository attemptRepository,
            ExamScoringRepository scoringRepository,
            ExamContentRepository contentRepository,
            ExamObjectiveScorer objectiveScorer
    ) {
        this(attemptRepository, scoringRepository, contentRepository, null, null, objectiveScorer);
    }

    /**
     * Retrieve the final or in-progress score result for an attempt.
     */
    public Optional<ExamResultDto> getAttemptResult(UUID attemptId, Long userId, boolean isAdmin) {
        AttemptRecord attempt = attemptRepository.findAttemptById(attemptId)
                .orElseThrow(() -> new ExamNotFoundException("Attempt not found: " + attemptId));

        if (!isAdmin && !attempt.userId().equals(userId)) {
            throw new ExamForbiddenException("User cannot access foreign attempt results");
        }

        Optional<SubmissionRecord> subOpt = attemptRepository.findSubmissionByAttemptId(attemptId);
        if (subOpt.isEmpty()) {
            return Optional.empty();
        }
        SubmissionRecord submission = subOpt.get();

        Optional<ScoreArtifactRecord> artOpt = scoringRepository.findLatestArtifactBySubmissionId(submission.id());
        if (artOpt.isEmpty()) {
            return Optional.empty();
        }
        ScoreArtifactRecord artifact = artOpt.get();

        List<ScoreComponentRecord> components = scoringRepository.findComponentsByArtifactId(artifact.id());
        List<CriterionScoreRecord> criteria = scoringRepository.findCriteriaByArtifactId(artifact.id());

        Double overallScore = null;
        Map<String, Double> skillScores = new LinkedHashMap<>();
        List<ComponentScoreDto> componentDtos = new ArrayList<>();

        boolean isCompleted = artifact.resultStatus() == ResultStatus.COMPLETED;
        boolean isFullIeltsMock = attempt.family() == ExamFamily.IELTS && (
                "FULL".equalsIgnoreCase(attempt.scope()) ||
                "ALL".equalsIgnoreCase(attempt.scope()) ||
                "FULL_MOCK".equalsIgnoreCase(attempt.scope())
        );

        boolean hasListening = components.stream().anyMatch(c -> c.metric() == ScoreMetric.LISTENING && c.scaledScore() > 0.0);
        boolean hasReading = components.stream().anyMatch(c -> c.metric() == ScoreMetric.READING && c.scaledScore() > 0.0);
        boolean hasWriting = components.stream().anyMatch(c -> c.metric() == ScoreMetric.WRITING && c.scaledScore() > 0.0);
        boolean hasSpeaking = components.stream().anyMatch(c -> c.metric() == ScoreMetric.SPEAKING && c.scaledScore() > 0.0);
        boolean hasOverall = components.stream().anyMatch(c -> c.metric() == ScoreMetric.FULL_OVERALL && c.scaledScore() >= 0.0);

        boolean allFourSkillsReady = hasListening && hasReading && hasWriting && hasSpeaking && hasOverall;
        boolean isResultReady = isFullIeltsMock ? (allFourSkillsReady && isCompleted) : isCompleted;

        Set<ScoreMetric> scoredMetrics = new HashSet<>();
        for (ScoreComponentRecord c : components) {
            scoredMetrics.add(c.metric());

            if (isFullIeltsMock && !isResultReady) {
                // ATOMIC POLICY: Never expose numeric 0.0 placeholder before RESULT_READY for Full IELTS Mock
                boolean isEvaluated = c.scaledScore() > 0.0;
                componentDtos.add(new ComponentScoreDto(
                        c.metric(),
                        null,
                        null,
                        c.scaleName(),
                        c.uncertaintyRange(),
                        isEvaluated ? "EVALUATED" : "PENDING_AI_EVALUATION",
                        true
                ));
            } else {
                boolean isSubjectiveMetric = (c.metric() == ScoreMetric.SPEAKING || c.metric() == ScoreMetric.WRITING);
                boolean isPendingMetric = isSubjectiveMetric && (!isCompleted || c.scaledScore() < 0.0);

                componentDtos.add(new ComponentScoreDto(
                        c.metric(),
                        c.rawScore(),
                        isPendingMetric ? null : c.scaledScore(),
                        c.scaleName(),
                        c.uncertaintyRange(),
                        isPendingMetric ? "PENDING_AI_EVALUATION" : "EVALUATED",
                        isPendingMetric
                ));

                if (c.metric() == ScoreMetric.FULL_OVERALL) {
                    if (isCompleted && c.scaledScore() >= 0.0) {
                        overallScore = c.scaledScore();
                    } else {
                        overallScore = null;
                    }
                } else if (c.metric() == ScoreMetric.LR_TOTAL) {
                    if (!isPendingMetric) {
                        skillScores.put(c.metric().name(), c.scaledScore());
                    }
                    if (attempt.family() == ExamFamily.TOEIC) {
                        overallScore = null;
                    } else {
                        overallScore = (isCompleted && c.scaledScore() >= 0.0) ? c.scaledScore() : null;
                    }
                } else {
                    if (!isPendingMetric) {
                        skillScores.put(c.metric().name(), c.scaledScore());
                    }
                }
            }
        }

        // Include any attempt sections that were never attempted/scored to prevent fake 0.0 or omission
        List<SectionRecord> formSections = contentRepository.findSectionsByFormId(attempt.formId());
        Map<UUID, SkillType> sectionSkillMap = new HashMap<>();
        for (SectionRecord fs : formSections) {
            sectionSkillMap.put(fs.id(), fs.skill());
        }
        List<AttemptSectionRecord> attemptSections = attemptRepository.findSectionsByAttemptId(attemptId);
        for (AttemptSectionRecord sec : attemptSections) {
            SkillType skill = sectionSkillMap.get(sec.sectionId());
            if (skill == null) continue;
            ScoreMetric expectedMetric = switch (skill) {
                case LISTENING -> ScoreMetric.LISTENING;
                case READING -> ScoreMetric.READING;
                case WRITING -> ScoreMetric.WRITING;
                case SPEAKING -> ScoreMetric.SPEAKING;
            };
            if (!scoredMetrics.contains(expectedMetric)) {
                Object rawScores = artifact.versionBundle() == null ? null : artifact.versionBundle().get("practiceRawScores");
                if ((!isFullIeltsMock || isResultReady) && rawScores instanceof Map<?, ?> scores
                        && scores.get(expectedMetric.name()) instanceof Map<?, ?> raw && raw.get("correct") instanceof Number correct
                        && raw.get("maxRaw") instanceof Number total) {
                    componentDtos.add(new ComponentScoreDto(expectedMetric, correct.doubleValue(), null, "RAW_ONLY",
                            Map.of("maxRaw", total.doubleValue()), "RAW_ONLY", false));
                    scoredMetrics.add(expectedMetric);
                    continue;
                }
                String status = (sec.state() == ExamSectionState.PENDING || sec.state() == ExamSectionState.SKIPPED)
                        ? "UNATTEMPTED" : "OMITTED";
                componentDtos.add(new ComponentScoreDto(
                        expectedMetric,
                        null,
                        null,
                        attempt.family() == ExamFamily.IELTS ? "IELTS Band" : "TOEIC Scale",
                        null,
                        status,
                        false
                ));
                scoredMetrics.add(expectedMetric);
            }
        }

        List<CriterionScoreDto> criterionDtos = criteria.stream().map(cr -> new CriterionScoreDto(
                cr.target(),
                cr.rubricCriterion(),
                cr.score(),
                cr.evidenceReferences(),
                cr.confidenceMeta()
        )).toList();

        ResultStatus finalStatus = isResultReady ? ResultStatus.COMPLETED : (isFullIeltsMock ? ResultStatus.PARTIAL : artifact.resultStatus());

        return Optional.of(new ExamResultDto(
                artifact.id(),
                attempt.id(),
                attempt.family(),
                attempt.variant(),
                attempt.scope(),
                attempt.attemptMode(),
                finalStatus,
                overallScore,
                skillScores,
                componentDtos,
                criterionDtos,
                artifact.versionBundle(),
                artifact.createdAt()
        ));
    }

    /**
     * Retrieve full review (with answer keys & explanations) only after permitted embargo status.
     * Guaranteed: Subjective items (Speaking & Writing) never leak objective answer keys.
     */
    public AttemptReviewDto getAttemptReview(UUID attemptId, Long userId, boolean isAdmin) {
        AttemptRecord attempt = attemptRepository.findAttemptById(attemptId)
                .orElseThrow(() -> new ExamNotFoundException("Attempt not found: " + attemptId));

        if (!isAdmin && !attempt.userId().equals(userId)) {
            throw new ExamForbiddenException("User cannot access foreign attempt review");
        }

        // Review Embargo Rule: Attempt must be submitted
        if (attempt.submittedAt() == null) {
            throw new ExamForbiddenException("Review is embargoed until the attempt is officially submitted");
        }

        List<ResponseRecord> responses = attemptRepository.findResponsesByAttemptId(attemptId);
        Map<UUID, ResponseRecord> responseByItem = new HashMap<>();
        for (ResponseRecord r : responses) {
            if (r.itemId() != null) {
                responseByItem.put(r.itemId(), r);
            }
        }

        List<ItemVersionRecord> formItems;
        Map<UUID, AnswerSpecRecord> answerSpecs;
        Map<UUID, SkillType> itemSkills;

        if (attempt.snapshotState() == ExamSnapshotState.SNAPSHOTTED && attempt.manifestSnapshot() != null) {
            formItems = new ArrayList<>();
            answerSpecs = new HashMap<>();
            itemSkills = new HashMap<>();
            extractFromSnapshot(attempt.manifestSnapshot(), formItems, answerSpecs, itemSkills);
        } else {
            formItems = contentRepository.findItemsByFormId(attempt.formId());
            answerSpecs = contentRepository.findAnswerSpecsByFormId(attempt.formId());
            itemSkills = contentRepository.findItemSkillsByFormId(attempt.formId());
        }
        List<RecordingRecord> recordings = mediaRepository != null ? mediaRepository.findRecordingsByAttemptId(attemptId) : List.of();
        Map<UUID, RecordingRecord> recordingById = new HashMap<>();
        for (RecordingRecord rec : recordings) {
            recordingById.put(rec.id(), rec);
        }

        List<AttemptSectionRecord> attemptSections = attemptRepository.findSectionsByAttemptId(attemptId);
        List<com.englishcoach.exams.model.ExamContentRecords.SectionRecord> formSections = contentRepository.findSectionsByFormId(attempt.formId());

        Optional<AttemptSectionRecord> speakingSectionOpt = attemptSections.stream()
                .filter(asr -> formSections.stream().anyMatch(fs -> fs.id().equals(asr.sectionId()) && fs.skill() == SkillType.SPEAKING)
                        || asr.turnCursor() > 0
                        || (asr.currentTurnKey() != null && !asr.currentTurnKey().isBlank()))
                .findFirst();
        List<ResponseRecord> speakingChildTurns = speakingSectionOpt.isPresent()
                ? attemptRepository.findSpeakingResponsesByAttemptAndSection(attemptId, speakingSectionOpt.get().sectionId())
                : List.of();

        List<ResponseRecord> sortedChildTurns = speakingChildTurns.stream()
                .filter(r -> "SPEAKING_TURN".equalsIgnoreCase(r.responseKind()) || (r.turnKey() != null && !r.turnKey().isBlank()))
                .sorted(Comparator.comparingInt(r -> r.turnSequence() != null ? r.turnSequence() : 0))
                .toList();

        // Exams Phase 4C: review uses the same set-aware, word-limit-enforcing scorer as the job worker (per skill, so a
        // choose-TWO set is judged once and a duplicate selection is shown as not credited, exactly as scored).
        Map<UUID, ItemScoreResult> objectiveReview = new HashMap<>();
        Map<SkillType, List<ExamObjectiveScorer.ObjectiveItemInput>> inputsBySkill = new EnumMap<>(SkillType.class);
        for (ItemVersionRecord item : formItems) {
            SkillType sk = itemSkills.get(item.id());
            AnswerSpecRecord spec = answerSpecs.get(item.id());
            if (spec == null || sk == SkillType.WRITING || sk == SkillType.SPEAKING) continue;
            ResponseRecord r = responseByItem.get(item.id());
            Object ans = r != null ? (r.answerPayload() != null ? r.answerPayload() : r.textResponse()) : null;
            Map<String, Object> defs = item.optionDefinitions();
            Integer qn = defs != null && defs.get("questionNumber") instanceof Number n ? n.intValue() : item.ordinal();
            inputsBySkill.computeIfAbsent(sk != null ? sk : SkillType.READING, k -> new ArrayList<>())
                    .add(new ExamObjectiveScorer.ObjectiveItemInput(item.id(), qn, ans, spec,
                            com.englishcoach.exams.scoring.ExamAttemptSnapshotContent.wordLimitAllowsNumber(defs)));
        }
        for (List<ExamObjectiveScorer.ObjectiveItemInput> inputs : inputsBySkill.values()) {
            for (ItemScoreResult r : objectiveScorer.scoreItems(inputs)) objectiveReview.put(r.itemId(), r);
        }

        List<ItemReviewDto> itemReviews = new ArrayList<>();
        boolean speakingChildTurnsExpanded = false;

        int qIndex = 1;
        for (ItemVersionRecord item : formItems) {
            UUID itemId = item.id();
            SkillType skill = itemSkills.get(itemId);
            ResponseRecord resp = responseByItem.get(itemId);
            String placementId = resp != null ? resp.placementId() : itemId.toString();

            String displayPrompt = (item.prompt() != null && !item.prompt().isBlank())
                    ? item.prompt()
                    : "Question " + qIndex;

            if (skill == SkillType.SPEAKING) {
                if (!sortedChildTurns.isEmpty()) {
                    if (!speakingChildTurnsExpanded) {
                        speakingChildTurnsExpanded = true;
                        // Child-turn aware Speaking review: expand each individual child turn
                        for (ResponseRecord childResp : sortedChildTurns) {
                            UUID recId = childResp.recordingId();
                            RecordingRecord rec = recId != null ? recordingById.get(recId) : null;
                            String playbackUrl = null;
                            if (rec != null) {
                                if (mediaService != null) {
                                    String playToken = mediaService.createRecordingPlaybackToken(attempt.userId(), attemptId, rec.id());
                                    playbackUrl = "/api/v1/exams/media/recordings/" + rec.id() + "/playback?token=" + playToken;
                                } else {
                                    playbackUrl = "/api/v1/exams/media/recordings/" + rec.id() + "/playback";
                                }
                            }

                            Integer durationSeconds = null;
                            if (rec != null) {
                                if (rec.durationMs() != null && rec.durationMs() > 0) {
                                    durationSeconds = (int) Math.max(1, rec.durationMs() / 1000);
                                } else if (rec.totalBytes() > 0) {
                                    durationSeconds = (int) Math.max(1, rec.totalBytes() / 16000);
                                }
                            }

                            String transcriptText = childResp.textResponse();
                            if (transcriptText == null && rec != null && rec.transcriptText() != null) {
                                transcriptText = rec.transcriptText();
                            }

                            String childPrompt = null;
                            if (childResp.sourceSnapshot() != null) {
                                Object p = childResp.sourceSnapshot().get("questionText");
                                if (p == null) p = childResp.sourceSnapshot().get("prompt");
                                if (p == null) p = childResp.sourceSnapshot().get("promptText");
                                if (p instanceof String s && !s.isBlank()) childPrompt = s;
                            }
                            if (childPrompt == null && childResp.answerPayload() instanceof Map<?, ?> pMap) {
                                Object p = pMap.get("prompt");
                                if (p instanceof String s && !s.isBlank()) childPrompt = s;
                            }
                            String partLabel = "Part 1";
                            if (childResp.turnKey() != null) {
                                if (childResp.turnKey().contains("p2") || childResp.turnKey().contains("part2")) {
                                    partLabel = "Part 2 - Cue Card";
                                } else if (childResp.turnKey().contains("p3") || childResp.turnKey().contains("part3")) {
                                    partLabel = "Part 3";
                                }
                            }
                            if (childPrompt == null || childPrompt.isBlank()) {
                                childPrompt = "IELTS " + partLabel + " • Question " + (childResp.turnSequence() != null ? childResp.turnSequence() : qIndex);
                            }

                            Map<String, Object> ans = new LinkedHashMap<>();
                            ans.put("turnKey", childResp.turnKey());
                            ans.put("turnSequence", childResp.turnSequence());
                            ans.put("partKey", partLabel);
                            if (rec != null) {
                                ans.put("recordingId", rec.id());
                                ans.put("state", rec.state().name());
                                ans.put("playbackUrl", playbackUrl);
                                if (durationSeconds != null) ans.put("durationSeconds", durationSeconds);
                            } else {
                                ans.put("status", "NO_RECORDING");
                            }
                            if (transcriptText != null) {
                                ans.put("transcript", transcriptText);
                            }

                            itemReviews.add(new ItemReviewDto(
                                    childResp.turnKey(),
                                    childResp.itemId() != null ? childResp.itemId() : itemId,
                                    childPrompt,
                                    "SPEAKING_TURN",
                                    ans,
                                    null,
                                    null,
                                    false,
                                    0.0,
                                    0.0,
                                    SkillType.SPEAKING,
                                    true
                            ));
                        }
                    }
                } else {
                    Map<String, Object> speakingUserAnswer = new LinkedHashMap<>();
                    speakingUserAnswer.put("status", "NO_RECORDING");
                    itemReviews.add(new ItemReviewDto(
                            placementId,
                            itemId,
                            displayPrompt,
                            "SPEAKING_PROMPT",
                            speakingUserAnswer,
                            null,
                            null,
                            false,
                            0.0,
                            0.0,
                            SkillType.SPEAKING,
                            true
                    ));
                }
            } else if (skill == SkillType.WRITING) {
                Object userAns = resp != null ? resp.textResponse() : null;
                // Writing review MUST NEVER have an objective answer key
                itemReviews.add(new ItemReviewDto(
                        placementId,
                        itemId,
                        displayPrompt,
                        "WRITING_PROMPT",
                        userAns,
                        null,
                        null,
                        false,
                        0.0,
                        0.0,
                        SkillType.WRITING,
                        true
                    ));
            } else {
                // Objective item (LISTENING, READING, etc.)
                AnswerSpecRecord spec = answerSpecs.get(itemId);
                if (spec == null) {
                    qIndex++;
                    continue;
                }
                Object userAns = resp != null ? (resp.answerPayload() != null ? resp.answerPayload() : resp.textResponse()) : null;
                ItemScoreResult isr = objectiveReview.get(itemId);
                if (isr == null) isr = objectiveScorer.scoreItem(itemId, userAns, spec);

                itemReviews.add(new ItemReviewDto(
                        placementId,
                        itemId,
                        displayPrompt,
                        item.interactionType() != null ? item.interactionType() : "OBJECTIVE",
                        userAns,
                        learnerCorrectAnswers(spec),
                        spec.explanation(),
                        isr.isCorrect(),
                        isr.creditAwarded(),
                        isr.maxCredit(),
                        skill != null ? skill : SkillType.READING,
                        false
                ));
            }
            qIndex++;
        }

        // Assemble speaking review if speaking items exist
        ExamSpeakingReviewRecords.SpeakingAttemptReviewDto speakingReview = null;
        boolean hasSpeaking = itemSkills.values().stream().anyMatch(s -> s == SkillType.SPEAKING);
        if (hasSpeaking) {
            List<ExamSpeakingReviewRecords.SpeakingCriterionReviewDto> criteriaReviews = new ArrayList<>();
            Double speakingBand = null;
            ResultStatus speakingStatus = ResultStatus.PARTIAL;
            ScoreComponentRecord speakingComp = null;

            Optional<SubmissionRecord> subOpt = attemptRepository.findSubmissionByAttemptId(attemptId);
            if (subOpt.isPresent()) {
                Optional<ScoreArtifactRecord> artOpt = scoringRepository.findLatestArtifactBySubmissionId(subOpt.get().id());
                if (artOpt.isPresent()) {
                    ScoreArtifactRecord artifact = artOpt.get();
                    List<ScoreComponentRecord> components = scoringRepository.findComponentsByArtifactId(artifact.id());
                    for (ScoreComponentRecord c : components) {
                        if (c.metric() == ScoreMetric.SPEAKING && c.scaledScore() >= 0.0) {
                            speakingBand = c.scaledScore();
                            speakingStatus = artifact.resultStatus();
                            speakingComp = c;
                        }
                    }

                    List<CriterionScoreRecord> critRecords = scoringRepository.findCriteriaByArtifactId(artifact.id());
                    for (CriterionScoreRecord cr : critRecords) {
                        if ("SPEAKING".equalsIgnoreCase(cr.target())) {
                            String bandFeedback = cr.confidenceMeta() != null ? (String) cr.confidenceMeta().get("feedback") : null;
                            List<String> evidenceHighlights = new ArrayList<>();
                            if (cr.evidenceReferences() != null) {
                                for (Map<String, Object> ev : cr.evidenceReferences()) {
                                    if (ev.get("snippet") instanceof String snip && !snip.isBlank()) {
                                        evidenceHighlights.add(snip);
                                    }
                                }
                            }
                            criteriaReviews.add(new ExamSpeakingReviewRecords.SpeakingCriterionReviewDto(
                                    cr.rubricCriterion(),
                                    cr.score(),
                                    bandFeedback,
                                    evidenceHighlights,
                                    cr.confidenceMeta(),
                                    "EVALUATED"
                            ));
                        }
                    }
                }
            }

            if (criteriaReviews.isEmpty()) {
                List<String> stdCriteria = List.of(
                        "FLUENCY_AND_COHERENCE",
                        "LEXICAL_RESOURCE",
                        "GRAMMATICAL_RANGE_AND_ACCURACY",
                        "PRONUNCIATION"
                );
                for (String crit : stdCriteria) {
                    criteriaReviews.add(new ExamSpeakingReviewRecords.SpeakingCriterionReviewDto(
                            crit,
                            null,
                            null,
                            List.of(),
                            Map.of(),
                            "PENDING_AI_EVALUATION"
                    ));
                }
            }

            String overallFeedback = speakingBand != null ? "Examiner evaluation recorded." : "Speaking evaluation in progress.";
            Map<String, Object> sessionSummary = null;
            Map<String, Object> turnFeedbackMap = null;
            Map<String, Object> turnDiagnosticsMap = null;

            if (speakingComp != null && speakingComp.uncertaintyRange() != null) {
                Map<String, Object> meta = speakingComp.uncertaintyRange();
                if (meta.get("overallFeedback") instanceof String ofb && !ofb.isBlank()) {
                    overallFeedback = ofb;
                }
                sessionSummary = new LinkedHashMap<>();
                if (meta.get("overallFeedback") != null) sessionSummary.put("overallFeedback", meta.get("overallFeedback"));
                if (meta.get("strongestArea") != null) sessionSummary.put("strongestArea", meta.get("strongestArea"));
                if (meta.get("mainWeakness") != null) sessionSummary.put("mainWeakness", meta.get("mainWeakness"));
                if (meta.get("nextRecommendedFocus") != null) sessionSummary.put("nextRecommendedFocus", meta.get("nextRecommendedFocus"));
                if (meta.get("strengths") != null) sessionSummary.put("strengths", meta.get("strengths"));
                if (meta.get("weaknesses") != null) sessionSummary.put("weaknesses", meta.get("weaknesses"));
                if (meta.get("nextSteps") != null) sessionSummary.put("nextSteps", meta.get("nextSteps"));

                if (meta.get("turnFeedback") instanceof Map<?, ?> tfMap) {
                    turnFeedbackMap = (Map<String, Object>) tfMap;
                }
                if (meta.get("turnDiagnostics") instanceof Map<?, ?> tdMap) {
                    turnDiagnosticsMap = (Map<String, Object>) tdMap;
                }
            }

            List<ExamSpeakingReviewRecords.SpeakingTurnReviewDto> turns = new ArrayList<>();

            if (!sortedChildTurns.isEmpty()) {
                int turnOrder = 1;
                for (ResponseRecord resp : sortedChildTurns) {
                    UUID recId = resp.recordingId();
                    RecordingRecord rec = recId != null ? recordingById.get(recId) : null;

                    String playbackUrl = null;
                    if (rec != null) {
                        if (mediaService != null) {
                            String playToken = mediaService.createRecordingPlaybackToken(attempt.userId(), attemptId, rec.id());
                            playbackUrl = "/api/v1/exams/media/recordings/" + rec.id() + "/playback?token=" + playToken;
                        } else {
                            playbackUrl = "/api/v1/exams/media/recordings/" + rec.id() + "/playback";
                        }
                    }

                    Integer durationSeconds = null;
                    if (rec != null) {
                        if (rec.durationMs() != null && rec.durationMs() > 0) {
                            durationSeconds = (int) Math.max(1, rec.durationMs() / 1000);
                        } else if (rec.totalBytes() > 0) {
                            durationSeconds = (int) Math.max(1, rec.totalBytes() / 16000);
                        }
                    }

                    String transcriptText = resp.textResponse();
                    if ((transcriptText == null || transcriptText.isBlank()) && rec != null && rec.transcriptText() != null) {
                        transcriptText = rec.transcriptText();
                    }
                    if ((transcriptText == null || transcriptText.isBlank()) && turnDiagnosticsMap != null && resp.turnKey() != null) {
                        Object diagObj = turnDiagnosticsMap.get(resp.turnKey());
                        if (diagObj instanceof Map<?, ?> diag && diag.get("transcriptText") instanceof String s) {
                            transcriptText = s;
                        }
                    }

                    String transcriptStatus;
                    if (rec == null) {
                        transcriptStatus = "NO_RECORDING";
                    } else if (transcriptText != null && !transcriptText.isBlank()) {
                        transcriptStatus = "COMPLETED";
                    } else if (rec.transcriptStatus() != null && !rec.transcriptStatus().isBlank() && !"NOT_REQUESTED".equals(rec.transcriptStatus())) {
                        transcriptStatus = rec.transcriptStatus();
                    } else if (speakingStatus == ResultStatus.COMPLETED) {
                        transcriptStatus = "UNAVAILABLE";
                    } else if (rec.state() == com.englishcoach.exams.model.ExamTypes.RecordingState.SEALED) {
                        transcriptStatus = "PENDING_AI_EVALUATION";
                    } else {
                        transcriptStatus = rec.state().name();
                    }

                    String missingReason = rec == null ? "RECORDING_MISSING" : null;
                    if (missingReason == null && (transcriptText == null || transcriptText.isBlank()) && speakingStatus == ResultStatus.COMPLETED) {
                        missingReason = "NO_SPEECH_RECOGNIZED";
                    }

                    Map<String, Object> acousticEvidence = new LinkedHashMap<>();
                    if (rec != null) {
                        if (rec.qualityMeta() != null) {
                            acousticEvidence.putAll(rec.qualityMeta());
                        }
                        if (rec.codec() != null) {
                            acousticEvidence.put("codec", rec.codec());
                        }
                        acousticEvidence.put("chunkCount", rec.chunkCount());
                        acousticEvidence.put("totalBytes", rec.totalBytes());
                    }

                    String promptText = null;
                    if (resp.sourceSnapshot() != null) {
                        Object p = resp.sourceSnapshot().get("questionText");
                        if (p == null) p = resp.sourceSnapshot().get("prompt");
                        if (p == null) p = resp.sourceSnapshot().get("promptText");
                        if (p instanceof String s && !s.isBlank()) {
                            promptText = s;
                        }
                    }
                    if (promptText == null && resp.answerPayload() instanceof Map<?, ?> payloadMap) {
                        Object p = payloadMap.get("prompt");
                        if (p instanceof String s && !s.isBlank()) {
                            promptText = s;
                        }
                    }
                    if (promptText == null) {
                        promptText = "Turn " + turnOrder;
                    }

                    String partLabel = "Part 1";
                    if (resp.turnKey() != null) {
                        if (resp.turnKey().contains("p2") || resp.turnKey().contains("part2")) {
                            partLabel = "Part 2 - Cue Card";
                        } else if (resp.turnKey().contains("p3") || resp.turnKey().contains("part3")) {
                            partLabel = "Part 3";
                        }
                    }

                    Map<String, Object> turnFb = null;
                    if (turnFeedbackMap != null && resp.turnKey() != null && turnFeedbackMap.get(resp.turnKey()) instanceof Map<?, ?> tf) {
                        turnFb = (Map<String, Object>) tf;
                    } else if (turnDiagnosticsMap != null && resp.turnKey() != null && turnDiagnosticsMap.get(resp.turnKey()) instanceof Map<?, ?> td) {
                        if (td.get("turnFeedback") instanceof Map<?, ?> tf) {
                            turnFb = (Map<String, Object>) tf;
                        }
                    }

                    String turnKeyVal = resp.turnKey() != null ? resp.turnKey() : "turn-" + turnOrder;
                    turns.add(new ExamSpeakingReviewRecords.SpeakingTurnReviewDto(
                            resp.turnSequence() != null ? resp.turnSequence() : turnOrder,
                            turnKeyVal,
                            partLabel,
                            turnKeyVal,
                            promptText,
                            rec != null ? rec.id() : null,
                            playbackUrl,
                            durationSeconds,
                            transcriptText,
                            transcriptStatus,
                            acousticEvidence,
                            missingReason,
                            turnFb
                    ));
                    turnOrder++;
                }
            } else {
                int turnOrder = 1;
                for (ItemVersionRecord item : formItems) {
                    if (itemSkills.get(item.id()) == SkillType.SPEAKING) {
                        ResponseRecord resp = responseByItem.get(item.id());
                        String placementId = resp != null ? resp.placementId() : item.id().toString();
                        RecordingRecord rec = resp != null && resp.recordingId() != null ? recordingById.get(resp.recordingId()) : null;

                        String playbackUrl = null;
                        if (rec != null) {
                            if (mediaService != null) {
                                String playToken = mediaService.createRecordingPlaybackToken(attempt.userId(), attemptId, rec.id());
                                playbackUrl = "/api/v1/exams/media/recordings/" + rec.id() + "/playback?token=" + playToken;
                            } else {
                                playbackUrl = "/api/v1/exams/media/recordings/" + rec.id() + "/playback";
                            }
                        }

                        Integer durationSeconds = null;
                        if (rec != null) {
                            if (rec.durationMs() != null && rec.durationMs() > 0) {
                                durationSeconds = (int) Math.max(1, rec.durationMs() / 1000);
                            } else if (rec.totalBytes() > 0) {
                                durationSeconds = (int) Math.max(1, rec.totalBytes() / 16000);
                            }
                        }

                        String transcriptText = resp != null ? resp.textResponse() : null;
                        if ((transcriptText == null || transcriptText.isBlank()) && rec != null && rec.transcriptText() != null) {
                            transcriptText = rec.transcriptText();
                        }
                        String turnKey = resp != null ? resp.turnKey() : null;
                        if ((transcriptText == null || transcriptText.isBlank()) && turnDiagnosticsMap != null && turnKey != null) {
                            Object diagObj = turnDiagnosticsMap.get(turnKey);
                            if (diagObj instanceof Map<?, ?> diag && diag.get("transcriptText") instanceof String s) {
                                transcriptText = s;
                            }
                        }

                        String transcriptStatus;
                        if (rec == null) {
                            transcriptStatus = "NO_RECORDING";
                        } else if (transcriptText != null && !transcriptText.isBlank()) {
                            transcriptStatus = "COMPLETED";
                        } else if (rec.transcriptStatus() != null && !rec.transcriptStatus().isBlank() && !"NOT_REQUESTED".equals(rec.transcriptStatus())) {
                            transcriptStatus = rec.transcriptStatus();
                        } else if (speakingStatus == ResultStatus.COMPLETED) {
                            transcriptStatus = "UNAVAILABLE";
                        } else if (rec.state() == com.englishcoach.exams.model.ExamTypes.RecordingState.SEALED) {
                            transcriptStatus = "PENDING_AI_EVALUATION";
                        } else {
                            transcriptStatus = rec.state().name();
                        }

                        String missingReason = rec == null ? "RECORDING_MISSING" : null;
                        if (missingReason == null && (transcriptText == null || transcriptText.isBlank()) && speakingStatus == ResultStatus.COMPLETED) {
                            missingReason = "NO_SPEECH_RECOGNIZED";
                        }

                        Map<String, Object> acousticEvidence = new LinkedHashMap<>();
                        if (rec != null) {
                            if (rec.qualityMeta() != null) {
                                acousticEvidence.putAll(rec.qualityMeta());
                            }
                            if (rec.codec() != null) {
                                acousticEvidence.put("codec", rec.codec());
                            }
                            acousticEvidence.put("chunkCount", rec.chunkCount());
                            acousticEvidence.put("totalBytes", rec.totalBytes());
                        }

                        Map<String, Object> turnFb = null;
                        if (turnFeedbackMap != null && turnKey != null && turnFeedbackMap.get(turnKey) instanceof Map<?, ?> tf) {
                            turnFb = (Map<String, Object>) tf;
                        } else if (turnDiagnosticsMap != null && turnKey != null && turnDiagnosticsMap.get(turnKey) instanceof Map<?, ?> td) {
                            if (td.get("turnFeedback") instanceof Map<?, ?> tf) {
                                turnFb = (Map<String, Object>) tf;
                            }
                        }

                        String fallbackKey = turnKey != null ? turnKey : "turn-" + turnOrder;
                        turns.add(new ExamSpeakingReviewRecords.SpeakingTurnReviewDto(
                                turnOrder,
                                fallbackKey,
                                "Part " + ((turnOrder <= 1) ? "1" : (turnOrder <= 2 ? "2" : "3")),
                                item.logicalItemKey() != null ? item.logicalItemKey() : item.id().toString(),
                                item.prompt(),
                                rec != null ? rec.id() : null,
                                playbackUrl,
                                durationSeconds,
                                transcriptText,
                                transcriptStatus,
                                acousticEvidence,
                                missingReason,
                                turnFb
                        ));
                        turnOrder++;
                    }
                }
            }

            speakingReview = new ExamSpeakingReviewRecords.SpeakingAttemptReviewDto(
                    attemptId,
                    attempt.family(),
                    speakingStatus,
                    speakingBand,
                    turns,
                    criteriaReviews,
                    overallFeedback,
                    null,
                    sessionSummary
            );
        }

        return new AttemptReviewDto(
                attemptId,
                attempt.family(),
                itemReviews,
                true,
                speakingReview
        );
    }

    /**
     * Exams Phase 9B: the answer truth a learner may see after submission = the canonical correct values only (the same
     * rule as the Phase 6 practice review) — never {@code keySource}, scoring policies, evidence notes, distractor logic or
     * rejected answers that the stored answer spec keeps for scoring / QA.
     */
    public static Map<String, Object> learnerCorrectAnswers(AnswerSpecRecord spec) {
        return Map.of("values", com.englishcoach.exams.practice.ExamPracticeService.correctAnswers(spec));
    }

    /**
     * Operator rescores or resolves an anomaly.
     * Invariant: IMMUTABLE HISTORICAL ARTIFACT. A new artifact is created pointing to predecessorId.
     */
    @Transactional
    public UUID rescoreArtifact(
            UUID oldArtifactId,
            Long operatorId,
            String reason,
            List<ScoreComponentRecord> adjustedComponents
    ) {
        ScoreArtifactRecord predecessor = scoringRepository.findArtifactById(oldArtifactId)
                .orElseThrow(() -> new ExamNotFoundException("Artifact not found: " + oldArtifactId));

        UUID newArtifactId = UUID.randomUUID();
        ScoreArtifactRecord newArtifact = new ScoreArtifactRecord(
                newArtifactId,
                predecessor.submissionId(),
                predecessor.runOrdinal() + 1,
                oldArtifactId,
                predecessor.versionBundle(),
                "rescore-evidence-" + newArtifactId,
                com.englishcoach.exams.model.ExamTypes.ResultStatus.COMPLETED,
                Map.of("operatorId", operatorId, "reason", reason, "rescoreTimestamp", Instant.now().toString()),
                Instant.now()
        );

        scoringRepository.insertScoreArtifact(newArtifact);

        for (ScoreComponentRecord c : adjustedComponents) {
            ScoreComponentRecord newComp = new ScoreComponentRecord(
                    UUID.randomUUID(),
                    newArtifactId,
                    c.family(),
                    c.metric(),
                    c.sectionId(),
                    c.responseId(),
                    c.rawScore(),
                    c.scaledScore(),
                    c.scaleName(),
                    c.uncertaintyRange(),
                    c.calibrationId(),
                    Instant.now()
            );
            scoringRepository.insertScoreComponent(newComp);
        }

        return newArtifactId;
    }

    @Transactional(readOnly = true)
    public List<ReviewCaseRecord> findOpenReviewCases(int limit, int offset) {
        return scoringRepository.findOpenReviewCases(limit, offset);
    }

    @Transactional
    public void resolveReviewCase(UUID caseId, Long operatorId, Map<String, Object> decisionPayload) {
        scoringRepository.updateReviewCaseDecision(caseId, operatorId, "RESOLVED", decisionPayload);
    }

    @SuppressWarnings("unchecked")
    private void extractFromSnapshot(
            Map<String, Object> snapshot,
            List<ItemVersionRecord> formItems,
            Map<UUID, AnswerSpecRecord> answerSpecs,
            Map<UUID, SkillType> itemSkills
    ) {
        List<Map<String, Object>> sections = (List<Map<String, Object>>) snapshot.get("sections");
        if (sections == null) return;

        for (Map<String, Object> secMap : sections) {
            SkillType skill = SkillType.valueOf((String) secMap.get("skill"));
            List<Map<String, Object>> parts = (List<Map<String, Object>>) secMap.get("parts");
            if (parts == null) continue;

            for (Map<String, Object> partMap : parts) {
                List<Map<String, Object>> groups = (List<Map<String, Object>>) partMap.get("groups");
                if (groups == null) continue;

                for (Map<String, Object> grpMap : groups) {
                    UUID grpId = UUID.fromString((String) grpMap.get("id"));
                    List<Map<String, Object>> items = (List<Map<String, Object>>) grpMap.get("items");
                    if (items == null) continue;

                    for (Map<String, Object> itemMap : items) {
                        UUID itemId = UUID.fromString((String) itemMap.get("id"));
                        itemSkills.put(itemId, skill);

                        String logicalItemKey = (String) itemMap.get("logicalItemKey");
                        int version = itemMap.get("version") != null ? ((Number) itemMap.get("version")).intValue() : 1;
                        String prompt = (String) itemMap.get("prompt");
                        String interactionType = (String) itemMap.get("interactionType");
                        Map<String, Object> optionDefs = (Map<String, Object>) itemMap.get("optionDefinitions");
                        String construct = (String) itemMap.get("construct");
                        Integer ordinal = itemMap.get("ordinal") != null ? ((Number) itemMap.get("ordinal")).intValue() : null;

                        ItemVersionRecord item = new ItemVersionRecord(
                                itemId, grpId, logicalItemKey, version, prompt, interactionType,
                                optionDefs, construct, null, null, null, ordinal
                        );
                        formItems.add(item);

                        Map<String, Object> ansMap = (Map<String, Object>) itemMap.get("answerSpec");
                        if (ansMap != null) {
                            UUID specId = ansMap.get("id") != null ? UUID.fromString((String) ansMap.get("id")) : UUID.randomUUID();
                            UUID rubricId = ansMap.get("rubricId") != null ? UUID.fromString((String) ansMap.get("rubricId")) : null;
                            AnswerSpecRecord spec = new AnswerSpecRecord(
                                    specId,
                                    itemId,
                                    (Map<String, Object>) ansMap.get("acceptedAnswers"),
                                    (Map<String, Object>) ansMap.get("normalizationPolicy"),
                                    ansMap.get("cardinality") != null ? ((Number) ansMap.get("cardinality")).intValue() : 1,
                                    ansMap.get("wordLimit") != null ? ((Number) ansMap.get("wordLimit")).intValue() : null,
                                    ansMap.get("creditUnits") != null ? ((Number) ansMap.get("creditUnits")).doubleValue() : 1.0,
                                    (String) ansMap.get("explanation"),
                                    rubricId,
                                    null
                            );
                            answerSpecs.put(itemId, spec);
                        }
                    }
                }
            }
        }
    }
}
