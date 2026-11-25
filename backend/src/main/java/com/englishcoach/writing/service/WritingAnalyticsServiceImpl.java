package com.englishcoach.writing.service;

import com.englishcoach.writing.client.WritingAiClient;
import com.englishcoach.writing.config.WritingProperties;
import com.englishcoach.writing.dto.*;
import com.englishcoach.writing.entity.*;
import com.englishcoach.writing.enums.SubmissionKind;
import com.englishcoach.writing.enums.WritingSessionStage;
import com.englishcoach.writing.exception.WritingDisabledException;
import com.englishcoach.writing.repository.*;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.*;

@Slf4j
@Service
@RequiredArgsConstructor
public class WritingAnalyticsServiceImpl implements WritingAnalyticsService {

    private final WritingProperties writingProperties;
    private final WritingAiClient aiClient;
    private final WritingCatalogService catalogService;
    private final WritingSessionRepository sessionRepository;
    private final WritingSubmissionRepository submissionRepository;
    private final WritingAssessmentRepository assessmentRepository;
    private final WritingPracticeRepository practiceRepository;
    private final WritingErrorMemoryRepository errorMemoryRepository;
    private final WritingLearningEvidenceRepository evidenceRepository;
    private final WritingFeedbackIssueRepository issueRepository;
    private final WritingReferenceAnswerCacheService referenceAnswerCacheService;
    private final ObjectMapper objectMapper;

    private void checkEnabled() {
        if (!writingProperties.isEnabled()) {
            throw new WritingDisabledException("Writing module is currently disabled.");
        }
    }

    @Override
    @Transactional(readOnly = true)
    public WeeklyWritingReportDto getWeeklyReport(Long userId) {
        checkEnabled();
        Instant now = Instant.now();
        Instant weekAgo = now.minus(7, ChronoUnit.DAYS);

        // Every read below is bounded by the week in SQL and batched (performance release 2026-11-16, PERF-03): the report
        // used to load the whole history and query drafts / assessments / issues once per historical session.

        // 1. Completed sessions in past 7 days
        List<WritingSessionEntity> weeklyCompletedSessions = sessionRepository
                .findByUserIdAndStageAndCompletedAtAfter(userId, WritingSessionStage.COMPLETED, weekAgo);

        int completedSessionsCount = weeklyCompletedSessions.size();

        // 2. Submissions in past 7 days
        List<WritingSubmissionEntity> weeklySubmissions = submissionRepository
                .findByUserIdAndKindAndCreatedAtAfterOrderByCreatedAtDesc(userId, SubmissionKind.COACH_DRAFT, weekAgo);

        int draftsComposed = weeklySubmissions.size();

        // 3. Words written in past 7 days
        int totalWordsWritten = 0;
        for (WritingSubmissionEntity sub : weeklySubmissions) {
            if (sub.getContent() != null && !sub.getContent().isBlank()) {
                totalWordsWritten += sub.getContent().trim().split("\\s+").length;
            }
        }
        if (totalWordsWritten == 0) {
            for (WritingSessionEntity s : weeklyCompletedSessions) {
                if (s.getWorkingText() != null && !s.getWorkingText().isBlank()) {
                    totalWordsWritten += s.getWorkingText().trim().split("\\s+").length;
                }
            }
        }

        // 4. Practices completed in past 7 days
        long practicesCompleted = practiceRepository.countByUserIdAndIsCompletedTrueAndUpdatedAtAfter(userId, weekAgo);

        // 5. Error resolution velocity / correction rate:
        // Conceptually: resolved previously detected issues / issues that had an opportunity to be corrected
        int resolvedCount = 0;
        int opportunityCount = 0;

        // Only sessions with a draft written this week can contribute; their whole draft list is read (the predecessor of a
        // draft may be older than the week), then the predecessors' assessments and issues, each in one statement.
        List<String> weeklyDraftSessions = submissionRepository.findSessionIdsWithSubmissionsAfter(userId, weekAgo);
        Map<String, List<WritingSubmissionEntity>> draftsBySession = draftsBySession(weeklyDraftSessions);
        List<String> predecessorIds = new ArrayList<>();
        for (List<WritingSubmissionEntity> drafts : draftsBySession.values()) {
            for (int i = 1; i < drafts.size(); i++) {
                WritingSubmissionEntity dCurr = drafts.get(i);
                if (dCurr.getCreatedAt() != null && dCurr.getCreatedAt().isAfter(weekAgo)) {
                    predecessorIds.add(drafts.get(i - 1).getId());
                }
            }
        }
        Map<String, WritingAssessmentEntity> assessmentBySubmission = assessmentsBySubmission(predecessorIds);
        Map<String, List<WritingFeedbackIssueEntity>> issuesByAssessment = issuesByAssessment(
                assessmentBySubmission.values().stream().map(WritingAssessmentEntity::getId).toList());

        for (List<WritingSubmissionEntity> drafts : draftsBySession.values()) {
            if (drafts.size() >= 2) {
                for (int i = 1; i < drafts.size(); i++) {
                    WritingSubmissionEntity dCurr = drafts.get(i);
                    if (dCurr.getCreatedAt() != null && dCurr.getCreatedAt().isAfter(weekAgo)) {
                        WritingSubmissionEntity dPrev = drafts.get(i - 1);
                        Optional<WritingAssessmentEntity> prevAssess = Optional.ofNullable(assessmentBySubmission.get(dPrev.getId()));
                        if (prevAssess.isPresent()) {
                            List<WritingFeedbackIssueEntity> prevIssues = issuesByAssessment.getOrDefault(prevAssess.get().getId(), List.of());
                            for (WritingFeedbackIssueEntity issue : prevIssues) {
                                if (issue.getSourceQuote() != null && !issue.getSourceQuote().isBlank()) {
                                    opportunityCount++;
                                    if (!dCurr.getContent().contains(issue.getSourceQuote().trim())) {
                                        resolvedCount++;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        List<WritingLearningEvidenceEntity> weeklyEvidences = evidenceRepository.findByUserIdAndRecordedAtAfter(userId, weekAgo);
        for (WritingLearningEvidenceEntity ev : weeklyEvidences) {
            opportunityCount++;
            if (Boolean.TRUE.equals(ev.getIsPositive())) {
                resolvedCount++;
            }
        }

        Double velocity = null;
        if (opportunityCount > 0) {
            velocity = Math.round((resolvedCount * 100.0 / opportunityCount) * 10.0) / 10.0;
        }

        // 6. Top Mastered Patterns
        List<WritingErrorMemoryEntity> patterns = errorMemoryRepository.findByUserIdAndIsMutedFalseOrderByOccurrenceCountDesc(userId);
        List<MasteredPatternDto> masteredDtos = new ArrayList<>();
        for (int i = 0; i < Math.min(5, patterns.size()); i++) {
            WritingErrorMemoryEntity p = patterns.get(i);
            int mastery = p.getEstimatedMastery() != null ? p.getEstimatedMastery() : 0;
            String status = mastery >= 80 ? "RESOLVED" : (mastery >= 50 ? "IN_PROGRESS" : "NEEDS_ATTENTION");
            masteredDtos.add(MasteredPatternDto.builder()
                    .patternCode(p.getPatternCode())
                    .title(p.getTitle())
                    .category(p.getCategory())
                    .occurrenceCount(p.getOccurrenceCount())
                    .contextCount(p.getContextCount())
                    .masteryPercentage(mastery)
                    .status(status)
                    .build());
        }

        // 7. Skill dimension scores
        List<SkillDimensionScoreDto> dimensionScores = getSkillDimensionScores(userId);

        // 8. Constructive summary
        String summary;
        if (completedSessionsCount > 0 || practicesCompleted > 0 || totalWordsWritten > 0) {
            String velocityStr = velocity != null ? String.format("%.1f%%", velocity) : "Chưa đủ dữ liệu";
            summary = String.format(
                    "You produced %d words across %d completed session(s) and %d practice item(s) this week. Error correction rate: %s.",
                    totalWordsWritten, completedSessionsCount, practicesCompleted, velocityStr
            );
        } else {
            summary = "No writing activity recorded for this period. Choose an adaptive task to build your weekly streak!";
        }

        return WeeklyWritingReportDto.builder()
                .periodStart(weekAgo)
                .periodEnd(now)
                .totalWordsWritten(totalWordsWritten)
                .completedSessions(completedSessionsCount)
                .draftsComposed(draftsComposed)
                .practicesCompleted((int) practicesCompleted)
                .errorResolutionVelocity(velocity)
                .topMasteredPatterns(masteredDtos)
                .skillDimensionScores(dimensionScores)
                .constructiveSummary(summary)
                .build();
    }

    @Override
    @Transactional(readOnly = true)
    public LongitudinalProgressDto getLongitudinalProgress(Long userId) {
        checkEnabled();

        List<WritingSessionEntity> allSessions = sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId);
        List<WritingSessionEntity> completedSessions = allSessions.stream()
                .filter(s -> s.getStage() == WritingSessionStage.COMPLETED)
                .sorted(Comparator.comparing(s -> s.getCompletedAt() != null ? s.getCompletedAt() : s.getUpdatedAt()))
                .toList();

        List<WritingTimelinePointDto> timeline = new ArrayList<>();
        long totalWordsCumulative = 0;
        int scoreSum = 0;
        int scoreCount = 0;

        Map<String, int[]> dailyStats = new TreeMap<>(); // date -> [totalWords, totalErrors]
        DateTimeFormatter dtf = DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneOffset.UTC);

        // Drafts, assessments and issues of every completed session in three statements (PERF-03), not per session.
        Map<String, List<WritingSubmissionEntity>> draftsOf = draftsBySession(completedSessions.stream().map(WritingSessionEntity::getId).toList());
        List<String> allDraftIds = new ArrayList<>();
        draftsOf.values().forEach(list -> list.forEach(d -> allDraftIds.add(d.getId())));
        Map<String, WritingAssessmentEntity> assessmentOfDraft = assessmentsBySubmission(allDraftIds);
        Map<String, WritingAssessmentEntity> activeAssessment = assessmentsById(completedSessions.stream()
                .map(WritingSessionEntity::getActiveAssessmentId).filter(Objects::nonNull).toList());
        Map<String, List<WritingFeedbackIssueEntity>> issuesOfActive = issuesByAssessment(new ArrayList<>(activeAssessment.keySet()));

        for (WritingSessionEntity s : completedSessions) {
            Map<String, Object> task = parseTaskSnapshot(s.getTaskSnapshot());
            String title = (String) task.getOrDefault("title", "Writing Assignment");

            int wordCount = 0;
            if (s.getWorkingText() != null && !s.getWorkingText().isBlank()) {
                wordCount = s.getWorkingText().trim().split("\\s+").length;
            }
            totalWordsCumulative += wordCount;

            // Draft 1 and Draft 2 scores
            List<WritingSubmissionEntity> drafts = draftsOf.getOrDefault(s.getId(), List.of());
            Integer d1Score = null;
            Integer finalScore = null;

            if (!drafts.isEmpty()) {
                WritingSubmissionEntity d1 = drafts.get(0);
                Optional<WritingAssessmentEntity> d1Assess = Optional.ofNullable(assessmentOfDraft.get(d1.getId()));
                if (d1Assess.isPresent()) {
                    d1Score = d1Assess.get().getOverallScore();
                }
            }

            if (s.getActiveAssessmentId() != null) {
                Optional<WritingAssessmentEntity> finalAssess = Optional.ofNullable(activeAssessment.get(s.getActiveAssessmentId()));
                if (finalAssess.isPresent()) {
                    finalScore = finalAssess.get().getOverallScore();
                }
            }
            if (finalScore == null && !drafts.isEmpty()) {
                for (int d = drafts.size() - 1; d >= 0; d--) {
                    Optional<WritingAssessmentEntity> aOpt = Optional.ofNullable(assessmentOfDraft.get(drafts.get(d).getId()));
                    if (aOpt.isPresent() && aOpt.get().getOverallScore() != null) {
                        finalScore = aOpt.get().getOverallScore();
                        break;
                    }
                }
            }

            Integer revisionGain = (finalScore != null && d1Score != null) ? (finalScore - d1Score) : null;

            if (finalScore != null) {
                scoreSum += finalScore;
                scoreCount++;
            }

            Instant dateInstant = s.getCompletedAt() != null ? s.getCompletedAt() : s.getUpdatedAt();
            timeline.add(WritingTimelinePointDto.builder()
                    .sessionId(s.getId())
                    .taskTitle(title)
                    .completedAt(dateInstant)
                    .wordCount(wordCount)
                    .draft1Score(d1Score)
                    .finalScore(finalScore)
                    .revisionGain(revisionGain)
                    .build());

            // Track daily error density
            String dateStr = dtf.format(dateInstant);
            int errorsInSession = 0;
            if (s.getActiveAssessmentId() != null) {
                List<WritingFeedbackIssueEntity> issues = issuesOfActive.getOrDefault(s.getActiveAssessmentId(), List.of());
                if (issues != null && !issues.isEmpty()) {
                    errorsInSession = (int) issues.stream()
                            .filter(i -> i.getKind() == com.englishcoach.writing.enums.IssueKind.ERROR)
                            .count();
                }
            }
            int[] current = dailyStats.computeIfAbsent(dateStr, k -> new int[2]);
            current[0] += wordCount;
            current[1] += errorsInSession;
        }

        List<ErrorDensityPointDto> errorDensityHistory = new ArrayList<>();
        for (Map.Entry<String, int[]> entry : dailyStats.entrySet()) {
            int words = entry.getValue()[0];
            int errors = entry.getValue()[1];
            double density = words > 0 ? Math.round((errors * 100.0 / words) * 10.0) / 10.0 : 0.0;
            errorDensityHistory.add(ErrorDensityPointDto.builder()
                    .date(entry.getKey())
                    .errorsPerHundredWords(density)
                    .totalWords(words)
                    .totalErrors(errors)
                    .build());
        }

        long completedPractices = practiceRepository.countByUserIdAndIsCompletedTrue(userId);

        Double avgScore = scoreCount > 0 ? Math.round((scoreSum * 1.0 / scoreCount) * 10.0) / 10.0 : null;

        return LongitudinalProgressDto.builder()
                .totalWordsCumulative(totalWordsCumulative)
                .completedSessionsCount(completedSessions.size())
                .totalPracticesCompleted((int) completedPractices)
                .averageScore(avgScore)
                .timeline(timeline)
                .errorDensityHistory(errorDensityHistory)
                .build();
    }

    @Override
    @Transactional(readOnly = true)
    public List<SkillDimensionScoreDto> getSkillDimensionScores(Long userId) {
        checkEnabled();

        // 4 Canonical Dimensions
        String[] dimensions = {"TASK_FULFILLMENT", "COHERENCE_COHESION", "LEXICAL_RESOURCE", "GRAMMATICAL_RANGE_ACCURACY"};
        String[] names = {
                "Task Fulfillment",
                "Coherence & Cohesion",
                "Lexical Resource",
                "Grammatical Range & Accuracy"
        };
        String[] guidances = {
                "Address all parts of the task with clear ideas, relevant support, and appropriate development.",
                "Organize information logically with clear paragraph progression and cohesive devices.",
                "Use a wide range of vocabulary accurately with appropriate collocations and precision.",
                "Use a variety of complex grammatical structures with accurate syntax and punctuation."
        };

        // Gather latest valid evaluated assessment per session, ordered chronologically
        List<WritingSessionEntity> sessions = sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId);
        List<WritingSessionEntity> chronologicalSessions = new ArrayList<>(sessions);
        chronologicalSessions.sort(Comparator.comparing(s -> s.getCreatedAt() != null ? s.getCreatedAt() : Instant.EPOCH));

        Map<String, List<Integer>> dimHistory = new LinkedHashMap<>();
        for (String dim : dimensions) {
            dimHistory.put(dim, new ArrayList<>());
        }

        // Active assessments in one statement; drafts and their assessments only for sessions that need the fallback (PERF-03).
        Map<String, WritingAssessmentEntity> activeById = assessmentsById(chronologicalSessions.stream()
                .map(WritingSessionEntity::getActiveAssessmentId).filter(Objects::nonNull).toList());
        List<String> needFallback = new ArrayList<>();
        for (WritingSessionEntity session : chronologicalSessions) {
            WritingAssessmentEntity a = session.getActiveAssessmentId() != null ? activeById.get(session.getActiveAssessmentId()) : null;
            if (!hasDimensionVerdicts(a)) needFallback.add(session.getId());
        }
        Map<String, List<WritingSubmissionEntity>> fallbackDrafts = draftsBySession(needFallback);
        List<String> fallbackDraftIds = new ArrayList<>();
        fallbackDrafts.values().forEach(list -> list.forEach(d -> fallbackDraftIds.add(d.getId())));
        Map<String, WritingAssessmentEntity> fallbackAssessments = assessmentsBySubmission(fallbackDraftIds);

        for (WritingSessionEntity session : chronologicalSessions) {
            WritingAssessmentEntity targetAssessment = null;
            if (session.getActiveAssessmentId() != null) {
                targetAssessment = activeById.get(session.getActiveAssessmentId());
            }
            if (targetAssessment == null || targetAssessment.getDimensionVerdicts() == null || targetAssessment.getDimensionVerdicts().isBlank() || targetAssessment.getDimensionVerdicts().equals("[]")) {
                List<WritingSubmissionEntity> drafts = fallbackDrafts.getOrDefault(session.getId(), List.of());
                for (int d = drafts.size() - 1; d >= 0; d--) {
                    Optional<WritingAssessmentEntity> aOpt = Optional.ofNullable(fallbackAssessments.get(drafts.get(d).getId()));
                    if (aOpt.isPresent() && aOpt.get().getDimensionVerdicts() != null && !aOpt.get().getDimensionVerdicts().isBlank() && !aOpt.get().getDimensionVerdicts().equals("[]")) {
                        targetAssessment = aOpt.get();
                        break;
                    }
                }
            }

            if (targetAssessment != null && targetAssessment.getDimensionVerdicts() != null && !targetAssessment.getDimensionVerdicts().isBlank()) {
                try {
                    List<DimensionVerdictDto> verdicts = objectMapper.readValue(
                            targetAssessment.getDimensionVerdicts(),
                            new TypeReference<List<DimensionVerdictDto>>() {}
                    );
                    for (DimensionVerdictDto verdict : verdicts) {
                        String canonDim = normalizeDimension(verdict.getDimension());
                        if (canonDim != null && verdict.getScore() != null && dimHistory.containsKey(canonDim)) {
                            dimHistory.get(canonDim).add(verdict.getScore());
                        }
                    }
                } catch (Exception e) {
                    log.warn("Failed to parse dimension verdicts for assessment {}: {}", targetAssessment.getId(), e.getMessage());
                }
            }
        }

        List<SkillDimensionScoreDto> result = new ArrayList<>();
        for (int i = 0; i < dimensions.length; i++) {
            String dim = dimensions[i];
            String name = names[i];
            String guidance = guidances[i];
            List<Integer> history = dimHistory.get(dim);

            if (history == null || history.isEmpty()) {
                result.add(SkillDimensionScoreDto.builder()
                        .dimension(dim)
                        .name(name)
                        .score(null)
                        .evidenceCount(0)
                        .trend("INSUFFICIENT_DATA")
                        .guidance(guidance)
                        .build());
            } else {
                int sum = 0;
                for (int s : history) {
                    sum += s;
                }
                int meanScore = (int) Math.round((double) sum / history.size());
                String trend = "STEADY";
                if (history.size() >= 2) {
                    int latest = history.get(history.size() - 1);
                    int prev = history.get(history.size() - 2);
                    trend = latest > prev + 3 ? "IMPROVING" : (latest < prev - 3 ? "NEEDS_WORK" : "STEADY");
                }

                result.add(SkillDimensionScoreDto.builder()
                        .dimension(dim)
                        .name(name)
                        .score(meanScore)
                        .evidenceCount(history.size())
                        .trend(trend)
                        .guidance(guidance)
                        .build());
            }
        }
        return result;
    }

    private static boolean hasDimensionVerdicts(WritingAssessmentEntity a) {
        return a != null && a.getDimensionVerdicts() != null && !a.getDimensionVerdicts().isBlank() && !a.getDimensionVerdicts().equals("[]");
    }

    /** Bound of one IN (...) list; larger sets are read in several statements. */
    private static final int BATCH = 500;

    private static <T> List<List<T>> batches(List<T> ids) {
        List<List<T>> out = new ArrayList<>();
        for (int i = 0; i < ids.size(); i += BATCH) out.add(ids.subList(i, Math.min(ids.size(), i + BATCH)));
        return out;
    }

    /** Session id -> its submissions ordered by ordinal (the order findBySessionIdOrderByOrdinalAsc gave). */
    private Map<String, List<WritingSubmissionEntity>> draftsBySession(List<String> sessionIds) {
        Map<String, List<WritingSubmissionEntity>> out = new LinkedHashMap<>();
        List<String> ids = sessionIds.stream().filter(Objects::nonNull).distinct().toList();
        for (List<String> batch : batches(ids)) {
            for (WritingSubmissionEntity sub : submissionRepository.findBySessionIdInOrderBySessionIdAscOrdinalAsc(batch)) {
                out.computeIfAbsent(sub.getSessionId(), k -> new ArrayList<>()).add(sub);
            }
        }
        return out;
    }

    /** Submission id -> its assessment (one per submission, as findBySubmissionId assumed). */
    private Map<String, WritingAssessmentEntity> assessmentsBySubmission(List<String> submissionIds) {
        Map<String, WritingAssessmentEntity> out = new HashMap<>();
        List<String> ids = submissionIds.stream().filter(Objects::nonNull).distinct().toList();
        for (List<String> batch : batches(ids)) {
            for (WritingAssessmentEntity a : assessmentRepository.findBySubmissionIdIn(batch)) {
                out.putIfAbsent(a.getSubmissionId(), a);
            }
        }
        return out;
    }

    private Map<String, WritingAssessmentEntity> assessmentsById(List<String> assessmentIds) {
        Map<String, WritingAssessmentEntity> out = new HashMap<>();
        List<String> ids = assessmentIds.stream().filter(Objects::nonNull).distinct().toList();
        for (List<String> batch : batches(ids)) {
            for (WritingAssessmentEntity a : assessmentRepository.findAllById(batch)) out.put(a.getId(), a);
        }
        return out;
    }

    /** Assessment id -> its issues by priority rank (the order findByAssessmentIdOrderByPriorityRankAsc gave). */
    private Map<String, List<WritingFeedbackIssueEntity>> issuesByAssessment(List<String> assessmentIds) {
        Map<String, List<WritingFeedbackIssueEntity>> out = new HashMap<>();
        List<String> ids = assessmentIds.stream().filter(Objects::nonNull).distinct().toList();
        for (List<String> batch : batches(ids)) {
            for (WritingFeedbackIssueEntity i : issueRepository.findByAssessmentIdInOrderByPriorityRankAsc(batch)) {
                out.computeIfAbsent(i.getAssessmentId(), k -> new ArrayList<>()).add(i);
            }
        }
        return out;
    }

    private String normalizeDimension(String dim) {
        if (dim == null) return null;
        String upper = dim.toUpperCase().trim();
        if (upper.contains("TASK") || upper.contains("ACHIEVEMENT") || upper.contains("RESPONSE") || upper.contains("FULFILLMENT")) {
            return "TASK_FULFILLMENT";
        }
        if (upper.contains("COHERENCE") || upper.contains("COHESION")) {
            return "COHERENCE_COHESION";
        }
        if (upper.contains("LEXICAL") || upper.contains("VOCABULARY") || upper.contains("RESOURCE")) {
            return "LEXICAL_RESOURCE";
        }
        if (upper.contains("GRAMMAR") || upper.contains("GRAMMATICAL") || upper.contains("ACCURACY") || upper.contains("RANGE")) {
            return "GRAMMATICAL_RANGE_ACCURACY";
        }
        return null;
    }

    @Override
    public AdaptiveTaskAiResponse generateAdaptiveTask(Long userId, AdaptiveTaskRequestDto request) {
        checkEnabled();

        String cefr = request != null && request.getCefrLevel() != null ? request.getCefrLevel() : "B1";
        String category = request != null && request.getCategory() != null ? request.getCategory() : "Work";
        String register = request != null && request.getRegister() != null ? request.getRegister() : "formal";
        List<String> focusPatterns = request != null && request.getFocusPatternCodes() != null ? request.getFocusPatternCodes() : Collections.emptyList();

        if (focusPatterns.isEmpty()) {
            List<WritingErrorMemoryEntity> topDue = errorMemoryRepository.findByUserIdAndDueForPracticeTrueOrderByNextPracticeDueAtAsc(userId);
            if (!topDue.isEmpty()) {
                focusPatterns = List.of(topDue.get(0).getPatternCode());
            } else {
                List<WritingErrorMemoryEntity> top = errorMemoryRepository.findByUserIdAndIsMutedFalseOrderByOccurrenceCountDesc(userId);
                if (!top.isEmpty()) {
                    focusPatterns = List.of(top.get(0).getPatternCode());
                }
            }
        }

        AdaptiveTaskAiResponse response = aiClient.generateAdaptiveTask(cefr, focusPatterns, category, register);

        // Register generated dynamic task in Catalog so it can be instantiated into a session immediately
        String taskId = "adaptive-" + UUID.randomUUID().toString().substring(0, 8);
        Map<String, Object> dynamicTask = new HashMap<>();
        dynamicTask.put("id", taskId);
        dynamicTask.put("title", response.getTitle());
        dynamicTask.put("prompt", response.getPrompt());
        dynamicTask.put("guidance", response.getGuidance());
        dynamicTask.put("category", category);
        dynamicTask.put("level", cefr);
        dynamicTask.put("audience", response.getAudience());
        dynamicTask.put("targetRegister", response.getTargetRegister());
        dynamicTask.put("targetWordCountMin", response.getTargetWordCountMin());
        dynamicTask.put("targetWordCountMax", response.getTargetWordCountMax());
        dynamicTask.put("requirements", response.getRequirements());
        catalogService.registerDynamicTask(userId, dynamicTask);

        return response;
    }

    @Override
    public SocraticPlanAiResponse getSocraticGuidance(Long userId, SocraticPlanRequestDto request) {
        checkEnabled();
        String prompt = request != null && request.getTaskPrompt() != null ? request.getTaskPrompt() : "";
        String plan = request != null && request.getCurrentPlan() != null ? request.getCurrentPlan() : "";
        String question = request != null && request.getLearnerQuestion() != null ? request.getLearnerQuestion() : "";
        return aiClient.getSocraticGuidance(prompt, plan, question);
    }

    @Override
    public ModelAnswerComparisonAiResponse compareModelAnswer(Long userId, ModelAnswerComparisonRequestDto request) {
        checkEnabled();
        String prompt = request != null && request.getTaskPrompt() != null ? request.getTaskPrompt().trim() : "";
        String draft = request != null && request.getLearnerDraft() != null ? request.getLearnerDraft().trim() : "";
        String register = request != null && request.getTargetRegister() != null ? request.getTargetRegister().trim() : "formal";
        String level = request != null && request.getLearnerLevel() != null && !request.getLearnerLevel().isBlank() ? request.getLearnerLevel().trim() : null;

        String taskId = request != null && request.getTaskId() != null && !request.getTaskId().isBlank()
                ? request.getTaskId().trim()
                : null;
        String sessionId = request != null && request.getSessionId() != null && !request.getSessionId().isBlank()
                ? request.getSessionId().trim()
                : null;

        Map<String, Object> taskData = null;
        if (taskId != null && !taskId.isBlank()) {
            taskData = catalogService.getTaskById(userId, taskId).orElse(null);
        }
        if (sessionId != null && !sessionId.isBlank()) {
            Optional<WritingSessionEntity> sOpt = sessionRepository.findByIdAndUserId(sessionId, userId);
            if (sOpt.isPresent()) {
                WritingSessionEntity s = sOpt.get();
                if ((taskId == null || taskId.isBlank()) && s.getTaskId() != null && !s.getTaskId().isBlank()) {
                    taskId = s.getTaskId();
                    taskData = catalogService.getTaskById(userId, taskId).orElse(null);
                }
                if (taskData == null && s.getTaskSnapshot() != null && !s.getTaskSnapshot().isBlank()) {
                    try {
                        taskData = objectMapper.readValue(s.getTaskSnapshot(), new TypeReference<Map<String, Object>>() {});
                    } catch (Exception e) {
                        log.warn("Failed to parse task snapshot for session {}: {}", sessionId, e.getMessage());
                    }
                }
            }
        }

        // EC-SEC-2026-029: Only verified static catalog tasks may read or write the cross-user shared reference cache,
        // and their authoritative catalog definition is always used so caller prompts can never poison shared entries.
        boolean isStaticCatalogTask = taskId != null && catalogService.isStaticTask(taskId);
        if (isStaticCatalogTask) {
            taskData = catalogService.getStaticTaskById(taskId).orElse(taskData);
        }

        String fullPrompt = buildComprehensiveTaskPrompt(isStaticCatalogTask ? "" : prompt, taskData);
        if (fullPrompt.isBlank()) {
            fullPrompt = prompt;
        }
        String visualDataFingerprint = "";
        if (taskData != null && taskData.get("visualData") != null) {
            try {
                visualDataFingerprint = objectMapper.writeValueAsString(taskData.get("visualData"));
            } catch (Exception ignored) {
                visualDataFingerprint = String.valueOf(taskData.get("visualData"));
            }
        }

        final String finalFullPrompt = fullPrompt;
        WritingReferenceAnswerCacheService.SharedReferenceAnswer sharedAnswer;
        if (isStaticCatalogTask) {
            String taskContentVersion = WritingReferenceAnswerCacheService.computeContentVersion(
                    finalFullPrompt, visualDataFingerprint, register, level
            );
            // 1. Get or Generate Shared Reference Answer (Global cache ONLY for verified static catalog tasks)
            sharedAnswer = referenceAnswerCacheService.getOrGenerate(
                    taskId,
                    taskContentVersion,
                    () -> {
                        // Call AI service WITHOUT learner draft so shared exemplar is pure task-level
                        ModelAnswerComparisonAiResponse aiResp = aiClient.compareModelAnswer(finalFullPrompt, "", register, level);
                        return WritingReferenceAnswerCacheService.SharedReferenceAnswer.builder()
                                .exemplarModelAnswer(aiResp.getExemplarModelAnswer())
                                .calibratedLevel(aiResp.getCalibratedLevel())
                                .structuralObservations(aiResp.getStructuralObservations())
                                .lexicalAlternatives(aiResp.getLexicalAlternatives())
                                .build();
                    }
            );
        } else {
            // Dynamic, source-adapted, or ad-hoc prompt: never read or write the global shared reference cache
            ModelAnswerComparisonAiResponse aiResp = aiClient.compareModelAnswer(finalFullPrompt, "", register, level);
            sharedAnswer = WritingReferenceAnswerCacheService.SharedReferenceAnswer.builder()
                    .exemplarModelAnswer(aiResp.getExemplarModelAnswer())
                    .calibratedLevel(aiResp.getCalibratedLevel())
                    .structuralObservations(aiResp.getStructuralObservations())
                    .lexicalAlternatives(aiResp.getLexicalAlternatives())
                    .build();
        }

        // 2. Synthesize User-Specific Coaching (Tailored to this learner's draft and evaluation, NEVER put in shared cache)
        String personalizedCoaching = synthesizeUserCoaching(userId, sessionId, draft, sharedAnswer);

        return ModelAnswerComparisonAiResponse.builder()
                .exemplarModelAnswer(sharedAnswer.getExemplarModelAnswer())
                .calibratedLevel(sharedAnswer.getCalibratedLevel())
                .structuralObservations(sharedAnswer.getStructuralObservations())
                .lexicalAlternatives(sharedAnswer.getLexicalAlternatives())
                .coachingSummary(personalizedCoaching)
                .build();
    }

    private String synthesizeUserCoaching(Long userId, String sessionId, String draft, WritingReferenceAnswerCacheService.SharedReferenceAnswer shared) {
        int learnerWordCount = draft.isEmpty() ? 0 : draft.split("\\s+").length;
        int modelWordCount = (shared.getExemplarModelAnswer() == null || shared.getExemplarModelAnswer().isBlank())
                ? 0 : shared.getExemplarModelAnswer().split("\\s+").length;

        if (sessionId != null) {
            Optional<WritingSessionEntity> sOpt = sessionRepository.findByIdAndUserId(sessionId, userId);
            if (sOpt.isPresent() && sOpt.get().getActiveAssessmentId() != null) {
                Optional<WritingAssessmentEntity> aOpt = assessmentRepository.findById(sOpt.get().getActiveAssessmentId());
                if (aOpt.isPresent()) {
                    List<WritingFeedbackIssueEntity> issues = issueRepository.findByAssessmentIdOrderByPriorityRankAsc(aOpt.get().getId());
                    Optional<WritingFeedbackIssueEntity> topIssue = issues.stream()
                            .filter(i -> i.getKind() == com.englishcoach.writing.enums.IssueKind.ERROR ||
                                    i.getSeverity() == com.englishcoach.writing.enums.IssueSeverity.CRITICAL ||
                                    i.getSeverity() == com.englishcoach.writing.enums.IssueSeverity.MAJOR)
                            .findFirst();

                    if (topIssue.isPresent()) {
                        WritingFeedbackIssueEntity iss = topIssue.get();
                        String advice = iss.getTitle() != null ? iss.getTitle() : "cấu trúc ngữ pháp";
                        return String.format(
                                "Bản nháp của bạn dài %d từ (bài mẫu khoảng %d từ). Để tiệm cận bài viết mẫu, hãy tập trung khắc phục: \"%s\"%s. Hãy đối chiếu các liên từ trong bài mẫu để nâng cao tính liên kết.",
                                learnerWordCount, modelWordCount, advice,
                                (iss.getReplacement() != null && !iss.getReplacement().isBlank()) ? (" (gợi ý: " + iss.getReplacement() + ")") : ""
                        );
                    }
                }
            }
        }

        if (learnerWordCount > 0) {
            return String.format(
                    "Bản nháp của bạn dài %d từ (bài mẫu tham khảo khoảng %d từ). Hãy quan sát cách bài mẫu mở rộng luận điểm chính và cách sử dụng các cụm từ vựng chủ đề để hoàn thiện bài viết của bạn.",
                    learnerWordCount, modelWordCount
            );
        } else {
            return String.format(
                    "Bài viết mẫu tham khảo gồm khoảng %d từ với cấu trúc rõ ràng. Bạn có thể dựa vào các gợi ý từ vựng và khung lập luận phía trên để bắt đầu xây dựng bài viết của mình.",
                    modelWordCount
            );
        }
    }

    private String buildComprehensiveTaskPrompt(String basePrompt, Map<String, Object> taskData) {
        if (taskData == null) {
            return basePrompt;
        }
        StringBuilder sb = new StringBuilder();
        String title = (String) taskData.get("title");
        if (title != null && !title.isBlank()) {
            sb.append("Task Title: ").append(title).append("\n\n");
        }
        String prompt = (String) taskData.get("prompt");
        if (prompt != null && !prompt.isBlank()) {
            sb.append("Prompt: ").append(prompt).append("\n\n");
        } else if (basePrompt != null && !basePrompt.isBlank()) {
            sb.append("Prompt: ").append(basePrompt).append("\n\n");
        }

        Object visualDataObj = taskData.get("visualData");
        if (visualDataObj != null) {
            sb.append("Visual Data / Source Details:\n");
            Map<String, Object> vd = null;
            if (visualDataObj instanceof Map) {
                vd = (Map<String, Object>) visualDataObj;
            } else if (visualDataObj instanceof String) {
                try {
                    vd = objectMapper.readValue((String) visualDataObj, new TypeReference<Map<String, Object>>() {});
                } catch (Exception ignored) {}
            }
            if (vd != null) {
                if (vd.get("title") != null) {
                    sb.append("- Chart Title: ").append(vd.get("title")).append("\n");
                }
                if (vd.get("chartType") != null) {
                    sb.append("- Chart Type: ").append(vd.get("chartType")).append("\n");
                }
                if (vd.get("unit") != null) {
                    sb.append("- Unit: ").append(vd.get("unit")).append("\n");
                }
                Object xAxisObj = vd.get("xAxis");
                List<String> categories = new ArrayList<>();
                if (xAxisObj instanceof Map) {
                    Map<String, Object> xAxis = (Map<String, Object>) xAxisObj;
                    if (xAxis.get("categories") instanceof List) {
                        List<?> cats = (List<?>) xAxis.get("categories");
                        for (Object c : cats) categories.add(String.valueOf(c));
                        sb.append("- Time Periods / Categories: ").append(String.join(", ", categories)).append("\n");
                    }
                }
                Object seriesObj = vd.get("series");
                if (seriesObj instanceof List) {
                    sb.append("- Data Series:\n");
                    List<?> seriesList = (List<?>) seriesObj;
                    for (Object sItem : seriesList) {
                        if (sItem instanceof Map) {
                            Map<String, Object> sMap = (Map<String, Object>) sItem;
                            String sName = (String) sMap.get("name");
                            Object sDataObj = sMap.get("data");
                            if (sDataObj instanceof List) {
                                List<?> sData = (List<?>) sDataObj;
                                StringBuilder seriesLine = new StringBuilder("  * " + sName + ": ");
                                for (int i = 0; i < sData.size(); i++) {
                                    String catLabel = (i < categories.size()) ? categories.get(i) : ("Period " + (i + 1));
                                    seriesLine.append(catLabel).append(": ").append(sData.get(i));
                                    if (vd.get("unit") != null) {
                                        seriesLine.append(vd.get("unit"));
                                    }
                                    if (i < sData.size() - 1) {
                                        seriesLine.append(", ");
                                    }
                                }
                                sb.append(seriesLine).append("\n");
                            }
                        }
                    }
                }
            }
            sb.append("\n");
        }

        Object reqObj = taskData.get("requirements");
        if (reqObj instanceof List) {
            List<?> reqs = (List<?>) reqObj;
            if (!reqs.isEmpty()) {
                sb.append("Requirements:\n");
                for (Object r : reqs) {
                    sb.append("- ").append(r).append("\n");
                }
                sb.append("\n");
            }
        }
        return sb.toString().trim();
    }

    private Map<String, Object> parseTaskSnapshot(String json) {
        if (json == null || json.isBlank()) return Collections.emptyMap();
        try {
            return objectMapper.readValue(json, new TypeReference<Map<String, Object>>() {});
        } catch (Exception e) {
            log.warn("Failed to parse task snapshot JSON: {}", e.getMessage());
            return Collections.emptyMap();
        }
    }
}
