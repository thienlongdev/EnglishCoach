package com.englishcoach.ai.service;

import com.englishcoach.common.contract.LearnerDnaSnapshot;
import com.englishcoach.common.contract.LearnerDnaSnapshotProvider;
import com.englishcoach.exams.model.ExamProfileRecords.IeltsProfileDto;
import com.englishcoach.exams.service.ExamProfileService;
import com.englishcoach.flashcard.repository.FlashcardRepository;
import com.englishcoach.listening.entity.ExerciseAttempt;
import com.englishcoach.listening.entity.enums.ErrorCategory;
import com.englishcoach.listening.repository.ExerciseAttemptRepository;
import com.englishcoach.speaking.entity.SpeakingShadowingAttempt;
import com.englishcoach.speaking.entity.SpeakingTurn;
import com.englishcoach.speaking.repository.SpeakingShadowingAttemptRepository;
import com.englishcoach.speaking.repository.SpeakingTurnRepository;
import com.englishcoach.writing.entity.WritingAssessmentEntity;
import com.englishcoach.writing.entity.WritingErrorMemoryEntity;
import com.englishcoach.writing.entity.WritingSubmissionEntity;
import com.englishcoach.writing.repository.WritingAssessmentRepository;
import com.englishcoach.writing.repository.WritingErrorMemoryRepository;
import com.englishcoach.writing.repository.WritingSubmissionRepository;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 7-Day Sliding Window "Learner DNA" Aggregation Service.
 * Compiles active learner weaknesses within the last 7 days (or last 10 sessions)
 * into a lightweight (< 1KB) snapshot cached in-memory with a 15-minute TTL.
 */
@Service
@Slf4j
public class LearnerDnaAggregatorService implements LearnerDnaSnapshotProvider {

    private final SpeakingShadowingAttemptRepository shadowingAttemptRepository;
    private final SpeakingTurnRepository speakingTurnRepository;
    private final WritingErrorMemoryRepository writingErrorMemoryRepository;
    private final WritingSubmissionRepository writingSubmissionRepository;
    private final WritingAssessmentRepository writingAssessmentRepository;
    private final ExerciseAttemptRepository exerciseAttemptRepository;
    private final FlashcardRepository flashcardRepository;
    private final ExamProfileService examProfileService;
    private final ObjectMapper objectMapper;

    // Owner-scoped in-memory cache, 15-minute TTL, bounded and really expiring (performance release 2026-11-16, PERF-05):
    // an expired snapshot is dropped and at most DNA_CACHE_MAX_ENTRIES accounts are kept.
    private static final int DNA_CACHE_MAX_ENTRIES = 2_000;
    private final com.englishcoach.common.cache.BoundedTtlCache<Long, CachedDna> cache =
            new com.englishcoach.common.cache.BoundedTtlCache<>(DNA_CACHE_MAX_ENTRIES, Duration.ofMinutes(15).toMillis());

    public LearnerDnaAggregatorService(
            SpeakingShadowingAttemptRepository shadowingAttemptRepository,
            SpeakingTurnRepository speakingTurnRepository,
            WritingErrorMemoryRepository writingErrorMemoryRepository,
            WritingSubmissionRepository writingSubmissionRepository,
            WritingAssessmentRepository writingAssessmentRepository,
            ExerciseAttemptRepository exerciseAttemptRepository,
            FlashcardRepository flashcardRepository,
            ExamProfileService examProfileService,
            ObjectMapper objectMapper) {
        this.shadowingAttemptRepository = shadowingAttemptRepository;
        this.speakingTurnRepository = speakingTurnRepository;
        this.writingErrorMemoryRepository = writingErrorMemoryRepository;
        this.writingSubmissionRepository = writingSubmissionRepository;
        this.writingAssessmentRepository = writingAssessmentRepository;
        this.exerciseAttemptRepository = exerciseAttemptRepository;
        this.flashcardRepository = flashcardRepository;
        this.examProfileService = examProfileService;
        this.objectMapper = objectMapper;
    }

    @org.springframework.transaction.event.TransactionalEventListener(fallbackExecution = true)
    public void examScored(com.englishcoach.common.event.ExamScoredEvent event) {
        cache.invalidate(event.userId());
    }

    private record CachedDna(String compactJson, LearnerDnaProfile profile, Instant cachedAt) {
        boolean isExpired() {
            return Duration.between(cachedAt, Instant.now()).toMinutes() >= 15;
        }
    }

    public String getLearnerDnaJson(Long userId) {
        return getLearnerDnaJson(userId, false);
    }

    public String getLearnerDnaJson(Long userId, boolean forceRefresh) {
        if (userId == null) {
            return getGuestDnaJson();
        }

        return snapshot(userId, forceRefresh).compactJson();
    }

    private CachedDna snapshot(Long userId, boolean forceRefresh) {
        if (forceRefresh) {
            cache.invalidate(userId);
        }
        return cache.get(userId, this::computeSnapshot);
    }

    private CachedDna computeSnapshot(Long userId) {
        long start = System.currentTimeMillis();
        LearnerDnaProfile profile = aggregateProfile(userId);
        String compactJson = serializeCompact(profile);
        CachedDna fresh = new CachedDna(compactJson, profile, Instant.now());
        long elapsed = System.currentTimeMillis() - start;
        log.info("Aggregated Learner DNA for userId={} in {}ms (payloadSize={} bytes)", userId, elapsed, compactJson.length());
        return fresh;
    }

    public LearnerDnaProfile getLearnerDna(Long userId) {
        return getLearnerDna(userId, false);
    }

    public LearnerDnaProfile getLearnerDna(Long userId, boolean forceRefresh) {
        if (userId == null) {
            return getGuestProfile();
        }
        return snapshot(userId, forceRefresh).profile();
    }

    @Override
    public LearnerDnaSnapshot getSnapshot(Long userId, boolean forceRefresh) {
        LearnerDnaProfile p = getLearnerDna(userId, forceRefresh);
        return new LearnerDnaSnapshot(
                p.generatedAt(),
                p.speaking() != null ? p.speaking().missingPhonemes() : null,
                p.speaking() != null ? p.speaking().pausingIssues() : null,
                p.writing() != null ? p.writing().topGrammarErrors() : null,
                p.listening() != null ? p.listening().section3DistractorTraps() : null,
                p.listening() != null ? p.listening().formCompletionPluralSpellingErrors() : null,
                p.vocabulary() != null ? p.vocabulary().criticalForgettingCount() : null
        );
    }

    private LearnerDnaProfile aggregateProfile(Long userId) {
        LocalDateTime sevenDaysAgo = LocalDateTime.now().minusDays(7);

        // 1. Speaking DNA
        SpeakingDna speakingDna = aggregateSpeaking(userId, sevenDaysAgo);

        // 2. Writing DNA
        WritingDna writingDna = aggregateWriting(userId);

        // 3. Listening DNA
        ListeningDna listeningDna = aggregateListening(userId);

        // 4. Reading DNA (Strict: detailed_dna_available = false)
        ReadingDna readingDna = aggregateReading(userId);

        // 5. Vocabulary / Flashcards DNA
        VocabularyDna vocabularyDna = aggregateVocabulary(userId);

        return new LearnerDnaProfile(
                userId,
                7,
                Instant.now().atOffset(ZoneOffset.UTC).toString(),
                speakingDna,
                writingDna,
                listeningDna,
                readingDna,
                vocabularyDna
        );
    }

    private SpeakingDna aggregateSpeaking(Long userId, LocalDateTime since) {
        Map<String, Integer> phonemeCounts = new LinkedHashMap<>();
        List<Double> wpmList = new ArrayList<>();
        int pauseIssuesCount = 0;
        int totalAnalyzed = 0;

        try {
            // Shadowing attempts
            List<SpeakingShadowingAttempt> attempts = shadowingAttemptRepository.findRecentAttemptsByUserId(
                    userId, since, PageRequest.of(0, 10));

            for (SpeakingShadowingAttempt att : attempts) {
                totalAnalyzed++;
                if (att.getProductSafeResultJson() != null && !att.getProductSafeResultJson().isBlank()) {
                    extractPhonemesAndProsody(att.getProductSafeResultJson(), phonemeCounts, wpmList);
                } else if (att.getPrimaryIssueType() != null) {
                    recordPhonemeIssue(att.getPrimaryIssueType(), att.getTargetWord(), phonemeCounts);
                }
                if (att.getFluencyScore() != null && att.getFluencyScore() < 65.0) {
                    pauseIssuesCount++;
                }
            }

            // Speaking turns (Roleplay / Quick Check)
            List<SpeakingTurn> turns = speakingTurnRepository.findRecentLearnerTurnsByUserId(
                    userId, since, PageRequest.of(0, 10));

            for (SpeakingTurn turn : turns) {
                totalAnalyzed++;
                if (turn.getPronunciationResultJson() != null && !turn.getPronunciationResultJson().isBlank()) {
                    extractPhonemesAndProsody(turn.getPronunciationResultJson(), phonemeCounts, wpmList);
                }
                if (turn.getFluencyScore() != null && turn.getFluencyScore() < 65) {
                    pauseIssuesCount++;
                }
            }
        } catch (Exception e) {
            log.warn("Error gathering speaking DNA for userId {}: {}", userId, e.getMessage());
        }

        // Sort phonemes by frequency descending, take top 3
        List<String> topPhonemes = phonemeCounts.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .limit(3)
                .map(Map.Entry::getKey)
                .toList();

        Double avgWpm = wpmList.isEmpty() ? null : Math.round(wpmList.stream().mapToDouble(Double::doubleValue).average().orElse(110.0) * 10.0) / 10.0;
        boolean hasPausingIssues = (totalAnalyzed > 0 && ((double) pauseIssuesCount / totalAnalyzed) >= 0.3)
                || (avgWpm != null && avgWpm < 95.0);

        return new SpeakingDna(topPhonemes, avgWpm, hasPausingIssues);
    }

    private void extractPhonemesAndProsody(String json, Map<String, Integer> phonemeCounts, List<Double> wpmList) {
        try {
            JsonNode root = objectMapper.readTree(json);

            // Extract priorities / phones with issues
            JsonNode priorities = root.path("priorities");
            if (priorities.isArray()) {
                for (JsonNode p : priorities) {
                    String phone = p.path("phone").asText(null);
                    if (phone != null && !phone.isBlank()) {
                        String normalized = normalizePhoneme(phone);
                        phonemeCounts.merge(normalized, 1, Integer::sum);
                    }
                }
            }

            JsonNode phones = root.path("phones");
            if (phones.isArray()) {
                for (JsonNode ph : phones) {
                    String quality = ph.path("qualityClass").asText("");
                    String diag = ph.path("diagnosisType").asText("");
                    if ("ERROR".equalsIgnoreCase(quality) || "MISSING".equalsIgnoreCase(diag)) {
                        String exp = ph.path("expectedPhone").asText(null);
                        if (exp != null && !exp.isBlank()) {
                            phonemeCounts.merge(normalizePhoneme(exp), 1, Integer::sum);
                        }
                    }
                }
            }

            // Prosody / Speech Rate
            JsonNode prosody = root.path("prosody");
            if (prosody.isObject()) {
                double rate = prosody.path("speechRate").asDouble(0.0);
                if (rate > 20.0 && rate < 300.0) {
                    wpmList.add(rate);
                }
            }
        } catch (Exception ignored) {
        }
    }

    private void recordPhonemeIssue(String issueType, String targetWord, Map<String, Integer> counts) {
        if (targetWord != null) {
            String lower = targetWord.toLowerCase();
            if (lower.endsWith("s") || lower.endsWith("es")) {
                counts.merge("/s/", 1, Integer::sum);
            } else if (lower.endsWith("ed")) {
                counts.merge("/ed/", 1, Integer::sum);
            } else if (lower.endsWith("t")) {
                counts.merge("/t/", 1, Integer::sum);
            }
        }
    }

    private String normalizePhoneme(String phone) {
        String cleaned = phone.replace("/", "").trim().toLowerCase();
        return "/" + cleaned + "/";
    }

    private WritingDna aggregateWriting(Long userId) {
        List<String> topErrors = new ArrayList<>();
        Map<String, Double> subscores = new LinkedHashMap<>();

        try {
            // Top grammar errors from writing_error_memories
            List<WritingErrorMemoryEntity> memories = writingErrorMemoryRepository
                    .findByUserIdAndIsMutedFalseOrderByOccurrenceCountDesc(userId);

            for (WritingErrorMemoryEntity mem : memories) {
                if (topErrors.size() >= 3) break;
                String name = mapPatternToGrammarType(mem.getPatternCode(), mem.getTitle());
                if (!topErrors.contains(name)) {
                    topErrors.add(name);
                }
            }

            // Recent sub-scores from writing assessments (single batched IN query instead of N+1)
            List<WritingSubmissionEntity> submissions = writingSubmissionRepository
                    .findTop10ByUserIdOrderByCreatedAtDesc(userId);
            if (submissions != null && !submissions.isEmpty()) {
                List<String> submissionIds = submissions.stream()
                        .map(WritingSubmissionEntity::getId)
                        .filter(Objects::nonNull)
                        .toList();
                if (!submissionIds.isEmpty()) {
                    List<WritingAssessmentEntity> assessments = writingAssessmentRepository
                            .findBySubmissionIdIn(submissionIds);
                    Map<String, WritingAssessmentEntity> bySubmissionId = new HashMap<>();
                    if (assessments != null) {
                        for (WritingAssessmentEntity assess : assessments) {
                            if (assess != null && assess.getSubmissionId() != null) {
                                bySubmissionId.putIfAbsent(assess.getSubmissionId(), assess);
                            }
                        }
                    }
                    for (WritingSubmissionEntity sub : submissions) {
                        WritingAssessmentEntity assess = bySubmissionId.get(sub.getId());
                        if (assess != null && assess.getDimensionVerdicts() != null && !assess.getDimensionVerdicts().isBlank()) {
                            extractSubscores(assess.getDimensionVerdicts(), subscores);
                            if (!subscores.isEmpty()) break;
                        }
                    }
                }
            }
        } catch (Exception e) {
            log.warn("Error gathering writing DNA for userId {}: {}", userId, e.getMessage());
        }

        return new WritingDna(topErrors, subscores.isEmpty() ? null : subscores);
    }

    private String mapPatternToGrammarType(String patternCode, String title) {
        if (patternCode != null) {
            String p = patternCode.toLowerCase();
            if (p.contains("run_on") || p.contains("comma_splice")) return "run-on sentences";
            if (p.contains("tense") || p.contains("aspect")) return "tense inconsistency";
            if (p.contains("agreement") || p.contains("sva")) return "subject-verb agreement";
            if (p.contains("article")) return "article omission/misuse";
            if (p.contains("preposition")) return "preposition errors";
            if (p.contains("fragment")) return "sentence fragments";
            if (p.contains("parallel")) return "faulty parallelism";
        }
        if (title != null && !title.isBlank()) {
            return title.trim().toLowerCase();
        }
        return "grammar accuracy";
    }

    private void extractSubscores(String verdictsJson, Map<String, Double> subscores) {
        try {
            JsonNode verdicts = objectMapper.readTree(verdictsJson);
            if (verdicts.isArray()) {
                for (JsonNode v : verdicts) {
                    String dim = v.path("dimension").asText("").toLowerCase();
                    double score = v.path("score").asDouble(0.0);
                    if (score > 0) {
                        if (dim.contains("cohesion") || dim.contains("coherence")) {
                            subscores.put("cohesion", score);
                        } else if (dim.contains("task") || dim.contains("achievement") || dim.contains("response")) {
                            subscores.put("task_achievement", score);
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }
    }

    private ListeningDna aggregateListening(Long userId) {
        int distractorTraps = 0;
        int pluralSpellingErrors = 0;

        try {
            List<ExerciseAttempt> recentAttempts = exerciseAttemptRepository
                    .findRecentAttemptsWithExerciseByUserId(userId, PageRequest.of(0, 30));

            for (ExerciseAttempt att : recentAttempts) {
                if (Boolean.FALSE.equals(att.getIsCorrect())) {
                    String raw = att.getRawUserAnswer() != null ? att.getRawUserAnswer().trim().toLowerCase() : "";
                    String exp = att.getListeningExercise() != null && att.getListeningExercise().getExpectedAnswer() != null
                            ? att.getListeningExercise().getExpectedAnswer().trim().toLowerCase() : "";
                    String qText = att.getListeningExercise() != null && att.getListeningExercise().getQuestionText() != null
                            ? att.getListeningExercise().getQuestionText().toLowerCase() : "";
                    String diag = att.getDiagnosticFeedback() != null ? att.getDiagnosticFeedback().toLowerCase() : "";

                    // Plural (-s/-es) or minor spelling errors
                    if (att.getPrimaryErrorCategory() == ErrorCategory.MINOR_SPELLING ||
                            (raw.endsWith("s") != exp.endsWith("s") && !raw.isEmpty() && !exp.isEmpty()) ||
                            (raw.endsWith("es") != exp.endsWith("es") && !raw.isEmpty() && !exp.isEmpty())) {
                        pluralSpellingErrors++;
                    }

                    // Distractor traps in Section 3 / multiple choice
                    if (qText.contains("section 3") || qText.contains("part 3") ||
                            diag.contains("distractor") || diag.contains("bẫy") ||
                            (att.getListeningExercise() != null && (att.getListeningExercise().getExerciseType() == com.englishcoach.listening.entity.enums.ExerciseType.MCQ || "MCQ".equalsIgnoreCase(String.valueOf(att.getListeningExercise().getExerciseType()))))) {
                        distractorTraps++;
                    }
                }
            }
        } catch (Exception e) {
            log.warn("Error gathering listening DNA for userId {}: {}", userId, e.getMessage());
        }

        return new ListeningDna(distractorTraps, pluralSpellingErrors);
    }

    private ReadingDna aggregateReading(Long userId) {
        Double bandScore = null;
        try {
            IeltsProfileDto profile = examProfileService.getIeltsProfile(userId);
            if (profile != null && profile.reading() != null && profile.reading().latest() != null) {
                bandScore = profile.reading().latest();
            }
        } catch (Exception e) {
            log.debug("No active exam profile for reading band score: {}", e.getMessage());
        }

        // STRICT INVARIANT: Reading error tracking is not yet implemented.
        // detailed_dna_available MUST ALWAYS BE FALSE. Never hallucinate Reading error types.
        return new ReadingDna(false, bandScore);
    }

    private VocabularyDna aggregateVocabulary(Long userId) {
        long criticalCount = 0;
        try {
            criticalCount = flashcardRepository.countCriticalForgettingByUserId(userId);
        } catch (Exception e) {
            log.warn("Error counting flashcards in critical forgetting curve for userId {}: {}", userId, e.getMessage());
        }
        return new VocabularyDna(criticalCount);
    }

    private String serializeCompact(LearnerDnaProfile profile) {
        try {
            String json = objectMapper.writeValueAsString(profile);
            // Verify < 1KB requirement (1024 bytes)
            if (json.getBytes(java.nio.charset.StandardCharsets.UTF_8).length >= 1024) {
                // Trim if needed
                LearnerDnaProfile trimmed = new LearnerDnaProfile(
                        profile.userId(),
                        profile.windowDays(),
                        profile.generatedAt(),
                        new SpeakingDna(
                                profile.speaking().missingPhonemes().stream().limit(2).toList(),
                                profile.speaking().avgWpm(),
                                profile.speaking().pausingIssues()
                        ),
                        new WritingDna(
                                profile.writing().topGrammarErrors().stream().limit(2).toList(),
                                profile.writing().recentSubscores()
                        ),
                        profile.listening(),
                        profile.reading(),
                        profile.vocabulary()
                );
                return objectMapper.writeValueAsString(trimmed);
            }
            return json;
        } catch (Exception e) {
            log.error("Failed to serialize Learner DNA profile: {}", e.getMessage());
            return "{\"user_id\":" + profile.userId() + ",\"window_days\":7,\"reading\":{\"detailed_dna_available\":false}}";
        }
    }

    private String getGuestDnaJson() {
        LearnerDnaProfile guest = getGuestProfile();
        return serializeCompact(guest);
    }

    private LearnerDnaProfile getGuestProfile() {
        return new LearnerDnaProfile(
                null,
                7,
                Instant.now().atOffset(ZoneOffset.UTC).toString(),
                new SpeakingDna(Collections.emptyList(), null, false),
                new WritingDna(Collections.emptyList(), null),
                new ListeningDna(0, 0),
                new ReadingDna(false, null),
                new VocabularyDna(0L)
        );
    }

    // ─── DTO Records ─────────────────────────────────────────────────────────

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record LearnerDnaProfile(
            @JsonProperty("user_id") Long userId,
            @JsonProperty("window_days") Integer windowDays,
            @JsonProperty("generated_at") String generatedAt,
            @JsonProperty("speaking") SpeakingDna speaking,
            @JsonProperty("writing") WritingDna writing,
            @JsonProperty("listening") ListeningDna listening,
            @JsonProperty("reading") ReadingDna reading,
            @JsonProperty("vocabulary") VocabularyDna vocabulary
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record SpeakingDna(
            @JsonProperty("missing_phonemes") List<String> missingPhonemes,
            @JsonProperty("avg_wpm") Double avgWpm,
            @JsonProperty("pausing_issues") Boolean pausingIssues
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record WritingDna(
            @JsonProperty("top_grammar_errors") List<String> topGrammarErrors,
            @JsonProperty("recent_subscores") Map<String, Double> recentSubscores
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ListeningDna(
            @JsonProperty("section3_distractor_traps") Integer section3DistractorTraps,
            @JsonProperty("form_completion_plural_spelling_errors") Integer formCompletionPluralSpellingErrors
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ReadingDna(
            @JsonProperty("detailed_dna_available") Boolean detailedDnaAvailable,
            @JsonProperty("estimated_band_score") Double estimatedBandScore
    ) {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record VocabularyDna(
            @JsonProperty("critical_forgetting_count") Long criticalForgettingCount
    ) {}
}
