package com.englishcoach.listening.service;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.listening.dto.ErrorDNADto;
import com.englishcoach.listening.dto.SegmentHeatmapDto;
import com.englishcoach.listening.entity.ErrorDNA;
import com.englishcoach.listening.entity.ExerciseAttempt;
import com.englishcoach.listening.entity.ListeningProfile;
import com.englishcoach.listening.entity.enums.ErrorCategory;
import com.englishcoach.listening.repository.ExerciseAttemptRepository;
import com.englishcoach.listening.repository.ListeningProfileRepository;
import com.englishcoach.common.cache.BoundedTtlCache;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class ListeningAnalyticsService {

    private final ListeningProfileRepository profileRepository;
    private final UserRepository userRepository;
    private final ExerciseAttemptRepository attemptRepository;
    private final DictationScoringService scoringService;
    private final com.englishcoach.listening.repository.ListeningSessionRepository sessionRepository;
    private final com.englishcoach.listening.repository.ListeningExerciseRepository exerciseRepository;
    private final PlatformTransactionManager transactionManager;

    /** Bound of one IN (...) list of the reconciliation; larger sets go in several statements. */
    private static final int RECONCILE_CHUNK = 500;

    /**
     * Ends the sessions whose every exercise was already attempted (a session completed before completion was recorded)
     * and recomputes each affected owner's profile ONCE. Runs after start-up (the server already answers), in a constant
     * number of statements per {@value #RECONCILE_CHUNK} sessions instead of two to three per session (performance
     * release 2026-11-16, PERF-15). Each owner's recalculation has its own transaction: called from inside this bean the
     * {@code @Transactional} of {@link #recalculateUserProfileFromCompletedSessions} does not apply, and without one the
     * profile's lazy error list could not be touched (the old loop stopped silently at the first such owner).
     */
    @EventListener(ApplicationReadyEvent.class)
    public void reconcileHistoricalCompletedSessions() {
        try {
            List<Object[]> keys = sessionRepository.findUnendedSessionKeys();
            if (keys.isEmpty()) return;
            Map<Long, Long> sessionMaterial = new LinkedHashMap<>();
            Map<Long, Long> sessionOwner = new HashMap<>();
            for (Object[] k : keys) {
                Long sessionId = ((Number) k[0]).longValue();
                sessionMaterial.put(sessionId, ((Number) k[1]).longValue());
                if (k[2] != null) sessionOwner.put(sessionId, ((Number) k[2]).longValue());
            }
            List<Long> materials = new ArrayList<>(new LinkedHashSet<>(sessionMaterial.values()));
            Map<Long, Long> dictationTotals = new HashMap<>();
            Map<Long, Long> allTotals = new HashMap<>();
            Map<Long, Long> distinctBySession = new HashMap<>();
            for (List<Long> chunk : chunks(materials)) {
                for (Object[] r : exerciseRepository.countDictationExercisesByMaterialIds(chunk)) {
                    dictationTotals.put(((Number) r[0]).longValue(), ((Number) r[1]).longValue());
                }
                for (Object[] r : exerciseRepository.countExercisesByMaterialIds(chunk)) {
                    allTotals.put(((Number) r[0]).longValue(), ((Number) r[1]).longValue());
                }
            }
            for (List<Long> chunk : chunks(new ArrayList<>(sessionMaterial.keySet()))) {
                for (Object[] r : attemptRepository.countDistinctExercisesAttemptedBySessionIds(chunk)) {
                    distinctBySession.put(((Number) r[0]).longValue(), ((Number) r[1]).longValue());
                }
            }
            List<Long> completed = new ArrayList<>();
            Set<Long> owners = new LinkedHashSet<>();
            for (Map.Entry<Long, Long> en : sessionMaterial.entrySet()) {
                long total = dictationTotals.getOrDefault(en.getValue(), 0L);
                if (total == 0) total = allTotals.getOrDefault(en.getValue(), 0L);
                long distinct = distinctBySession.getOrDefault(en.getKey(), 0L);
                if (distinct >= total && total > 0) {
                    completed.add(en.getKey());
                    Long owner = sessionOwner.get(en.getKey());
                    if (owner != null) owners.add(owner);
                }
            }
            if (completed.isEmpty()) return;
            TransactionTemplate tx = new TransactionTemplate(transactionManager);
            java.time.LocalDateTime now = java.time.LocalDateTime.now();
            for (List<Long> chunk : chunks(completed)) {
                tx.executeWithoutResult(st -> sessionRepository.markEnded(chunk, now));
            }
            int failed = 0;
            for (Long owner : owners) {
                try {
                    tx.executeWithoutResult(st -> recalculateProfileInternal(owner));
                } catch (RuntimeException ex) {
                    failed++;
                    log.warn("Listening reconciliation: one owner profile not recalculated: {}", ex.getClass().getSimpleName());
                }
            }
            log.info("Listening reconciliation: {} unended session(s) checked, {} ended, {} owner profile(s) recalculated, {} failed",
                    sessionMaterial.size(), completed.size(), owners.size() - failed, failed);
        } catch (RuntimeException ex) {
            log.warn("Listening reconciliation skipped: {}", ex.getClass().getSimpleName());
        }
    }

    private static List<List<Long>> chunks(List<Long> ids) {
        List<List<Long>> out = new ArrayList<>();
        for (int i = 0; i < ids.size(); i += RECONCILE_CHUNK) {
            out.add(new ArrayList<>(ids.subList(i, Math.min(ids.size(), i + RECONCILE_CHUNK))));
        }
        return out;
    }

    /**
     * Dictation scoring is a pure function of (answer, expected sentence): a learner's history is re-read on every Error
     * DNA request, but each pair is aligned once and reused while it stays in this bounded memo (performance release
     * 2026-11-16, PERF-04). Nothing stored is changed; a new scoring rule ships with a new process, which starts with an
     * empty memo. Callers only read the result.
     */
    private record ScoreKey(String expected, String answer) {}
    private final BoundedTtlCache<ScoreKey, DictationScoringService.ScoringResult> scoreMemo =
            new BoundedTtlCache<>(4_096, java.time.Duration.ofHours(6).toMillis());

    private DictationScoringService.ScoringResult score(String rawUser, String expected) {
        return scoreMemo.get(new ScoreKey(expected, rawUser), k -> scoringService.scoreDictation(k.answer(), k.expected()));
    }

    @Transactional
    public void recalculateUserProfileFromCompletedSessions(Long userId) {
        recalculateProfileInternal(userId);
    }

    private void recalculateProfileInternal(Long userId) {
        ListeningProfile profile = profileRepository.findByUserId(userId)
                .orElseGet(() -> {
                    User user = userRepository.findById(userId)
                            .orElseThrow(() -> new RuntimeException("User not found"));
                    return ListeningProfile.builder()
                            .user(user)
                            .totalListeningTimeSeconds(0L)
                            .overallAccuracy(null)
                            .build();
                });

        List<ExerciseAttempt> completedAttempts = attemptRepository.findAttemptsInCompletedSessionsWithExerciseByUserId(userId);
        if (completedAttempts.isEmpty()) {
            profile.setOverallAccuracy(null);
            if (profile.getErrorDnaList() != null) {
                profile.getErrorDnaList().clear();
            }
            profileRepository.save(profile);
            return;
        }

        double avgAcc = completedAttempts.stream()
                .filter(a -> a.getAccuracyPercentage() != null)
                .mapToDouble(ExerciseAttempt::getAccuracyPercentage)
                .average()
                .orElse(0.0);
        profile.setOverallAccuracy(Math.round(avgAcc * 10.0) / 10.0);

        // Compute error DNA from completed sessions
        Map<ErrorCategory, Integer> categoryCounts = new HashMap<>();
        for (ExerciseAttempt a : completedAttempts) {
            if (a.getPrimaryErrorCategory() != null && a.getPrimaryErrorCategory() != ErrorCategory.EXACT_MATCH) {
                categoryCounts.merge(a.getPrimaryErrorCategory(), 1, Integer::sum);
            }
        }

        if (profile.getErrorDnaList() == null) {
            profile.setErrorDnaList(new ArrayList<>());
        } else {
            profile.getErrorDnaList().clear();
        }

        for (Map.Entry<ErrorCategory, Integer> entry : categoryCounts.entrySet()) {
            profile.getErrorDnaList().add(ErrorDNA.builder()
                    .errorCategory(entry.getKey())
                    .occurrenceCount(entry.getValue())
                    .historicalWeight(1.0)
                    .build());
        }

        profileRepository.save(profile);
    }

    @Transactional(readOnly = true)
    public ErrorDNADto getUserErrorDNA(Long userId) {
        List<ExerciseAttempt> completedAttempts = attemptRepository.findAttemptsInCompletedSessionsWithExerciseByUserId(userId);

        if (completedAttempts.isEmpty()) {
            return ErrorDNADto.builder()
                    .overallAccuracy(null)
                    .totalAttempts(0)
                    .errorBreakdownPercentage(new HashMap<>())
                    .topMissingWords(Collections.emptyList())
                    .topExtraWords(Collections.emptyList())
                    .topSubstitutions(Collections.emptyList())
                    .topSpellingErrors(Collections.emptyList())
                    .representativeErrors(Collections.emptyList())
                    .practicePriorities(Collections.emptyList())
                    .build();
        }

        // Real mathematically derived accuracy from completed work
        double avgAccuracy = completedAttempts.stream()
                .filter(a -> a.getAccuracyPercentage() != null)
                .mapToDouble(ExerciseAttempt::getAccuracyPercentage)
                .average()
                .orElse(0.0);
        avgAccuracy = Math.round(avgAccuracy * 10.0) / 10.0;

        Map<ErrorCategory, Integer> categoryCounts = new HashMap<>();
        Map<String, Integer> missingWordsMap = new HashMap<>();
        Map<String, Integer> extraWordsMap = new HashMap<>();
        Map<String, Integer> substitutionsMap = new HashMap<>();
        Map<String, Integer> spellingMap = new HashMap<>();
        List<ErrorDNADto.RepresentativeErrorDto> representativeErrors = new ArrayList<>();

        for (ExerciseAttempt attempt : completedAttempts) {
            if (attempt.getListeningExercise() == null || attempt.getListeningExercise().getExpectedAnswer() == null) {
                continue;
            }
            if (attempt.getRawUserAnswer() == null) {
                continue;
            }

            String expected = attempt.getListeningExercise().getExpectedAnswer();
            String rawUser = attempt.getRawUserAnswer();
            DictationScoringService.ScoringResult scoringResult = score(rawUser, expected);

            if (scoringResult.isCorrect || scoringResult.primaryErrorCategory == ErrorCategory.EXACT_MATCH || scoringResult.alignedWords.isEmpty()) {
                continue;
            }

            // Word-level error aggregation and category tally from WER alignment
            for (DictationScoringService.AlignedWord aw : scoringResult.alignedWords) {
                if (aw.op == DictationScoringService.AlignmentOp.MATCH) {
                    continue;
                }

                if (aw.op == DictationScoringService.AlignmentOp.DELETION && aw.referenceWord != null) {
                    categoryCounts.merge(ErrorCategory.MISSING_WORD, 1, Integer::sum);
                    missingWordsMap.merge(cleanToken(aw.referenceWord), 1, Integer::sum);
                } else if (aw.op == DictationScoringService.AlignmentOp.INSERTION && aw.userWord != null) {
                    categoryCounts.merge(ErrorCategory.EXTRA_WORD, 1, Integer::sum);
                    extraWordsMap.merge(cleanToken(aw.userWord), 1, Integer::sum);
                } else if (aw.errorCategory == ErrorCategory.MINOR_SPELLING && aw.referenceWord != null && aw.userWord != null) {
                    categoryCounts.merge(ErrorCategory.MINOR_SPELLING, 1, Integer::sum);
                    String pair = cleanToken(aw.referenceWord) + " -> " + cleanToken(aw.userWord);
                    spellingMap.merge(pair, 1, Integer::sum);
                } else if (aw.referenceWord != null && aw.userWord != null) {
                    categoryCounts.merge(ErrorCategory.WRONG_WORD, 1, Integer::sum);
                    String pair = cleanToken(aw.referenceWord) + " -> " + cleanToken(aw.userWord);
                    substitutionsMap.merge(pair, 1, Integer::sum);
                }
            }

            // Collect up to 4 distinct representative errors for display
            if (representativeErrors.size() < 4) {
                List<ErrorDNADto.AlignedDiffDto> diffs = new ArrayList<>();
                for (DictationScoringService.AlignedWord aw : scoringResult.alignedWords) {
                    if (aw.op == DictationScoringService.AlignmentOp.MATCH) {
                        diffs.add(ErrorDNADto.AlignedDiffDto.builder()
                                .expectedWord(aw.referenceWord)
                                .userWord(aw.userWord)
                                .type("MATCH")
                                .label("ĐÚNG")
                                .build());
                    } else if (aw.op == DictationScoringService.AlignmentOp.DELETION) {
                        diffs.add(ErrorDNADto.AlignedDiffDto.builder()
                                .expectedWord(aw.referenceWord)
                                .userWord(null)
                                .type("MISSING")
                                .label("BỎ SÓT")
                                .build());
                    } else if (aw.op == DictationScoringService.AlignmentOp.INSERTION) {
                        diffs.add(ErrorDNADto.AlignedDiffDto.builder()
                                .expectedWord(null)
                                .userWord(aw.userWord)
                                .type("EXTRA")
                                .label("VIẾT THỪA")
                                .build());
                    } else if (aw.errorCategory == ErrorCategory.MINOR_SPELLING) {
                        diffs.add(ErrorDNADto.AlignedDiffDto.builder()
                                .expectedWord(aw.referenceWord)
                                .userWord(aw.userWord)
                                .type("SPELLING")
                                .label("LỖI CHÍNH TẢ")
                                .build());
                    } else {
                        diffs.add(ErrorDNADto.AlignedDiffDto.builder()
                                .expectedWord(aw.referenceWord)
                                .userWord(aw.userWord)
                                .type("SUBSTITUTION")
                                .label("NGHE NHẦM")
                                .build());
                    }
                }
                representativeErrors.add(ErrorDNADto.RepresentativeErrorDto.builder()
                        .exerciseId(attempt.getListeningExercise().getId())
                        .expectedSentence(expected)
                        .rawUserAnswer(rawUser)
                        .alignedDiffs(diffs)
                        .build());
            }
        }

        // Error breakdown percentages strictly derived from real WER error counts
        int totalErrors = categoryCounts.values().stream().mapToInt(Integer::intValue).sum();
        Map<String, Double> breakdown = new HashMap<>();
        if (totalErrors > 0) {
            for (Map.Entry<ErrorCategory, Integer> entry : categoryCounts.entrySet()) {
                double pct = ((double) entry.getValue() / (double) totalErrors) * 100.0;
                breakdown.put(entry.getKey().name(), Math.round(pct * 10.0) / 10.0);
            }
        }

        // Format sorted word error lists
        List<ErrorDNADto.WordErrorItemDto> topMissingWords = missingWordsMap.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .limit(6)
                .map(e -> ErrorDNADto.WordErrorItemDto.builder().word(e.getKey()).count(e.getValue()).build())
                .collect(Collectors.toList());

        List<ErrorDNADto.WordErrorItemDto> topExtraWords = extraWordsMap.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .limit(6)
                .map(e -> ErrorDNADto.WordErrorItemDto.builder().word(e.getKey()).count(e.getValue()).build())
                .collect(Collectors.toList());

        List<ErrorDNADto.WordSubstitutionItemDto> topSubstitutions = substitutionsMap.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .limit(6)
                .map(e -> {
                    String[] parts = e.getKey().split(" -> ");
                    return ErrorDNADto.WordSubstitutionItemDto.builder()
                            .expectedWord(parts[0])
                            .userWord(parts.length > 1 ? parts[1] : "")
                            .count(e.getValue())
                            .build();
                })
                .collect(Collectors.toList());

        List<ErrorDNADto.WordSubstitutionItemDto> topSpellingErrors = spellingMap.entrySet().stream()
                .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
                .limit(6)
                .map(e -> {
                    String[] parts = e.getKey().split(" -> ");
                    return ErrorDNADto.WordSubstitutionItemDto.builder()
                            .expectedWord(parts[0])
                            .userWord(parts.length > 1 ? parts[1] : "")
                            .count(e.getValue())
                            .build();
                })
                .collect(Collectors.toList());

        return ErrorDNADto.builder()
                .overallAccuracy(avgAccuracy)
                .totalAttempts(completedAttempts.size())
                .errorBreakdownPercentage(breakdown)
                .topMissingWords(topMissingWords)
                .topExtraWords(topExtraWords)
                .topSubstitutions(topSubstitutions)
                .topSpellingErrors(topSpellingErrors)
                .representativeErrors(representativeErrors)
                .practicePriorities(Collections.emptyList())
                .build();
    }

    private String cleanToken(String token) {
        if (token == null) return "";
        return token.trim().toLowerCase().replaceAll("^[\\p{Punct}]+|[\\p{Punct}]+$", "");
    }

    @Transactional(readOnly = true)
    public List<SegmentHeatmapDto> getMaterialHeatmap(Long materialId, Long userId) {
        return attemptRepository.getSegmentAccuracyHeatmap(userId, materialId);
    }
}
