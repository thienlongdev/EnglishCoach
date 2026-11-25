package com.englishcoach.exams.analytics;

import com.englishcoach.exams.analytics.ExamAnalyticsRecords.*;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;

import java.time.*;
import java.time.temporal.ChronoUnit;
import java.time.temporal.TemporalAdjusters;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Exams Phase 8 — the PURE, deterministic learner analytics model (8A analytics, 8B mistake intelligence, 8C recommended
 * practice). No I/O, no randomness, no AI, no clock other than the {@code now} argument: the same facts always produce the
 * same output (same ranking, same reasons).
 *
 * <p>Inputs are facts derived from the learner's own SUBMITTED attempts, each re-scored from the content snapshot that
 * attempt pinned (never from current form content) — see {@link ExamLearnerAnalyticsService}. Nothing here writes or
 * feeds official evidence: practice analytics guide practice suggestions only.
 *
 * <h2>Sample sufficiency ({@value #SIGNAL_POLICY_VERSION})</h2>
 * Computed on the RECENT block of a scope = its latest {@value #RECENT_ATTEMPTS} submitted attempts that are not older
 * than {@value #RECENT_DAYS} days (recency); older attempts stay in the history / totals only.
 * <pre>
 * INSUFFICIENT_DATA   recent scored questions &lt; {@value #EMERGING_MIN_QUESTIONS}
 * EMERGING_SIGNAL     recent scored questions ≥ {@value #EMERGING_MIN_QUESTIONS}
 * ESTABLISHED_SIGNAL  recent scored questions ≥ {@value #ESTABLISHED_MIN_QUESTIONS} AND ≥ {@value #ESTABLISHED_MIN_ATTEMPTS} recent attempts
 * NOT_APPLICABLE      writing (no score exists, so no strength / weakness claim)
 * </pre>
 * "Scored questions" = correct + incorrect + unanswered objective items (blank answers count: they are real misses).
 * Raw accuracy = correct ÷ scored questions (Phase 6 definition), one decimal.
 *
 * <h2>Mistakes ({@value #MISTAKE_POLICY_VERSION})</h2>
 * Item identity = logical item key + version of the snapshot item (the content actually seen). Occurrences are ordered by
 * submission time. REPEATED = missed ≥ 2 times and missed in the latest occurrence; SINGLE = missed exactly once, in the
 * latest occurrence; IMPROVED = missed before, correct in the latest occurrence (history stays visible, but it no longer
 * counts as a current mistake). Never a linguistic topic: only the canonical interaction type of the item.
 *
 * <h2>Recommendations ({@value #RECOMMENDATION_POLICY_VERSION})</h2>
 * Candidates are ONLY scopes currently AVAILABLE on a form (server practice readiness at request time). FOCUS needs a
 * scope signal ≥ EMERGING and (recent miss rate ≥ {@value #FOCUS_MIN_MISS_RATE}% or ≥ {@value #FOCUS_MIN_REPEATED}
 * repeated mistakes). Pressure = recent miss rate (pp) + 2 × min(repeated, 10) + max(0, accuracy of the learner's OTHER
 * signalled scopes − this scope's recent accuracy); × 0.5 when the scope improved by ≥ {@value #IMPROVEMENT_PP} pp versus
 * its earlier attempts; × 0.8 while only EMERGING. Ranked by pressure desc, then scope code. Up to
 * {@value #MAX_RECOMMENDATIONS} items; remaining slots: COVERAGE (an available scope never practised in the window). No
 * signalled scope at all ⇒ status INSUFFICIENT_DATA with neutral START suggestions (no weakness claimed).
 */
public final class ExamLearnerAnalytics {

    private ExamLearnerAnalytics() {}

    public static final String SIGNAL_POLICY_VERSION = "exam-practice-signal-v1";
    public static final String MISTAKE_POLICY_VERSION = "exam-practice-mistake-v1";
    public static final String RECOMMENDATION_POLICY_VERSION = "exam-practice-recommendation-v1";

    public static final int WINDOW_DAYS = 180;
    public static final int RECENT_DAYS = 60;
    public static final int RECENT_ATTEMPTS = 3;
    public static final int EMERGING_MIN_QUESTIONS = 10;
    public static final int ESTABLISHED_MIN_QUESTIONS = 30;
    public static final int ESTABLISHED_MIN_ATTEMPTS = 2;
    public static final double FOCUS_MIN_MISS_RATE = 30.0;
    public static final int FOCUS_MIN_REPEATED = 2;
    public static final double IMPROVEMENT_PP = 15.0;
    public static final double LOWER_THAN_OTHERS_PP = 10.0;
    public static final int MAX_RECOMMENDATIONS = 3;
    public static final int MAX_MISTAKES = 20;
    public static final int ACTIVITY_WEEKS = 8;
    public static final ZoneId ZONE = ZoneId.of("Asia/Ho_Chi_Minh");

    public enum Signal { INSUFFICIENT_DATA, EMERGING_SIGNAL, ESTABLISHED_SIGNAL, NOT_APPLICABLE }

    public enum Outcome { CORRECT, INCORRECT, UNANSWERED, NOT_SCORED }

    // ─── input facts ──────────────────────────────────────────────────────────────────────────

    /** One objective item of a submitted practice attempt, scored from that attempt's snapshot. */
    public record ItemOutcome(UUID itemId, String logicalItemKey, int version, Integer questionNumber, String interactionType,
                              Outcome outcome) {}

    /** One SUBMITTED, scope-pinned PRACTICE attempt. */
    public record PracticeAttemptFacts(UUID attemptId, ExamFamily family, String scopeCode, String scopeType, SkillType skill,
                                       int scopeNumber, UUID sourceFormId, String formTitle, boolean objective,
                                       Instant startedAt, Instant submittedAt, List<ItemOutcome> items, Integer wordCount,
                                       Integer minimumWords) {
        public PracticeAttemptFacts {
            items = items == null ? List.of() : List.copyOf(items);
        }

        Long timeSpentSeconds() {
            return startedAt != null && submittedAt != null
                    ? Math.max(0, Duration.between(startedAt, submittedAt).getSeconds()) : null;
        }
    }

    /** A canonical scope that is AVAILABLE for practice right now on one form (server readiness). */
    public record AvailableScope(String scopeCode, String scopeType, SkillType skill, int scopeNumber, UUID formId,
                                 String formTitle, boolean objective) {}

    // ─── entry point ──────────────────────────────────────────────────────────────────────────

    public static FamilyAnalyticsDto compute(ExamFamily family, List<PracticeAttemptFacts> practiceIn,
                                             List<SimulationAttemptDto> simulations, List<AvailableScope> available,
                                             Instant now) {
        Instant windowStart = now.minus(WINDOW_DAYS, ChronoUnit.DAYS);
        List<PracticeAttemptFacts> practice = (practiceIn == null ? List.<PracticeAttemptFacts>of() : practiceIn).stream()
                // no upper bound: the database clock may run slightly ahead of the application clock
                .filter(a -> a.family() == family && a.submittedAt() != null && !a.submittedAt().isBefore(windowStart))
                .sorted(CHRONO).toList();
        List<SimulationAttemptDto> sims = simulations == null ? List.of() : simulations;

        List<MistakeTrack> tracks = mistakeTracks(practice);
        Map<String, Integer> repeatedByScope = new HashMap<>();
        for (MistakeTrack t : tracks) if (t.state().equals("REPEATED")) repeatedByScope.merge(t.scopeCode(), 1, Integer::sum);

        Map<String, List<PracticeAttemptFacts>> byScope = new TreeMap<>();
        for (PracticeAttemptFacts a : practice) byScope.computeIfAbsent(a.scopeCode(), k -> new ArrayList<>()).add(a);
        List<ScopeStatsDto> scopes = new ArrayList<>();
        for (List<PracticeAttemptFacts> attempts : byScope.values()) {
            scopes.add(scopeStats(attempts, repeatedByScope.getOrDefault(attempts.get(0).scopeCode(), 0), now));
        }
        scopes.sort(SCOPE_ORDER_DTO);

        return new FamilyAnalyticsDto(family, overview(practice, scopes, now), scopes, interactionStats(practice, now),
                mistakeSummary(tracks), recommend(scopes, practice, available, now), simulationOverview(sims),
                activity(practice, sims, now));
    }

    // ─── 8A: scope statistics ───────────────────────────────────────────────────────────────

    static final Comparator<PracticeAttemptFacts> CHRONO = Comparator
            .comparing(PracticeAttemptFacts::submittedAt).thenComparing(a -> a.attemptId().toString());

    private record Tally(int correct, int incorrect, int unanswered) {
        int questions() {
            return correct + incorrect + unanswered;
        }

        int missed() {
            return incorrect + unanswered;
        }

        Tally plus(Tally o) {
            return new Tally(correct + o.correct, incorrect + o.incorrect, unanswered + o.unanswered);
        }

        static final Tally ZERO = new Tally(0, 0, 0);
    }

    private static Tally tally(PracticeAttemptFacts a) {
        int c = 0, i = 0, u = 0;
        for (ItemOutcome o : a.items()) {
            switch (o.outcome()) {
                case CORRECT -> c++;
                case INCORRECT -> i++;
                case UNANSWERED -> u++;
                default -> { }
            }
        }
        return new Tally(c, i, u);
    }

    private static Tally tally(List<PracticeAttemptFacts> attempts) {
        Tally t = Tally.ZERO;
        for (PracticeAttemptFacts a : attempts) t = t.plus(tally(a));
        return t;
    }

    static Double accuracy(int correct, int questions) {
        return questions > 0 ? Math.round(correct * 1000.0 / questions) / 10.0 : null;
    }

    /** The recency block of one scope: its latest {@link #RECENT_ATTEMPTS} attempts not older than {@link #RECENT_DAYS}. */
    static List<PracticeAttemptFacts> recentBlock(List<PracticeAttemptFacts> chronological, Instant now) {
        Instant recentStart = now.minus(RECENT_DAYS, ChronoUnit.DAYS);
        List<PracticeAttemptFacts> recent = chronological.stream().filter(a -> !a.submittedAt().isBefore(recentStart)).toList();
        return recent.subList(Math.max(0, recent.size() - RECENT_ATTEMPTS), recent.size());
    }

    static Signal signal(int recentQuestions, int recentAttempts) {
        if (recentQuestions >= ESTABLISHED_MIN_QUESTIONS && recentAttempts >= ESTABLISHED_MIN_ATTEMPTS) return Signal.ESTABLISHED_SIGNAL;
        if (recentQuestions >= EMERGING_MIN_QUESTIONS) return Signal.EMERGING_SIGNAL;
        return Signal.INSUFFICIENT_DATA;
    }

    static ScopeStatsDto scopeStats(List<PracticeAttemptFacts> attempts, int repeated, Instant now) {
        PracticeAttemptFacts first = attempts.get(0);
        PracticeAttemptFacts last = attempts.get(attempts.size() - 1);
        Long spent = null;
        boolean allTimed = true;
        for (PracticeAttemptFacts a : attempts) {
            Long s = a.timeSpentSeconds();
            if (s == null) allTimed = false;
            else spent = (spent == null ? 0L : spent) + s;
        }
        if (!first.objective()) {
            List<Integer> counts = attempts.stream().map(PracticeAttemptFacts::wordCount).filter(Objects::nonNull).toList();
            Integer min = last.minimumWords();
            int met = (int) attempts.stream().filter(a -> a.minimumWords() != null && a.wordCount() != null
                    && a.wordCount() >= a.minimumWords()).count();
            WritingStatsDto w = new WritingStatsDto(attempts.size(), last.wordCount(),
                    counts.isEmpty() ? null : (int) Math.round(counts.stream().mapToInt(Integer::intValue).average().orElse(0)),
                    min, met, "NOT_SCORED");
            return new ScopeStatsDto(first.scopeCode(), first.scopeType(), first.skill(), first.scopeNumber(), false,
                    attempts.size(), 0, 0, 0, 0, 0, null, null, null, null, null, null, null, Signal.NOT_APPLICABLE.name(),
                    recentBlock(attempts, now).size(), spent, null, last.submittedAt(), null, null, w);
        }
        Tally all = tally(attempts);
        List<PracticeAttemptFacts> recent = recentBlock(attempts, now);
        Tally r = tally(recent);
        Set<UUID> recentIds = recent.stream().map(PracticeAttemptFacts::attemptId).collect(Collectors.toSet());
        List<PracticeAttemptFacts> earlier = attempts.stream().filter(a -> !recentIds.contains(a.attemptId())).toList();
        Tally e = tally(earlier);
        Double avg = allTimed && spent != null && all.questions() > 0 ? Math.round(spent * 10.0 / all.questions()) / 10.0 : null;
        List<TrendPointDto> trend = null;
        if (attempts.size() >= 2) {
            trend = new ArrayList<>();
            for (PracticeAttemptFacts a : attempts) {
                Tally t = tally(a);
                if (t.questions() > 0) trend.add(new TrendPointDto(a.attemptId(), a.submittedAt(), t.questions(), t.correct(),
                        accuracy(t.correct(), t.questions())));
            }
            if (trend.size() < 2) trend = null;
        }
        return new ScopeStatsDto(first.scopeCode(), first.scopeType(), first.skill(), first.scopeNumber(), true,
                attempts.size(), all.questions(), all.correct() + all.incorrect(), all.correct(), all.incorrect(),
                all.unanswered(), accuracy(all.correct(), all.questions()), r.questions(), r.correct(), r.incorrect(),
                r.unanswered(), accuracy(r.correct(), r.questions()), e.questions() > 0 ? accuracy(e.correct(), e.questions()) : null,
                signal(r.questions(), recent.size()).name(), recent.size(), spent, avg, last.submittedAt(), repeated, trend, null);
    }

    static PracticeOverviewDto overview(List<PracticeAttemptFacts> practice, List<ScopeStatsDto> scopes, Instant now) {
        Tally t = tally(practice.stream().filter(PracticeAttemptFacts::objective).toList());
        Long spent = null;
        for (PracticeAttemptFacts a : practice) {
            Long s = a.timeSpentSeconds();
            if (s != null) spent = (spent == null ? 0L : spent) + s;
        }
        Set<LocalDate> days = practice.stream().map(a -> a.submittedAt().atZone(ZONE).toLocalDate()).collect(Collectors.toSet());
        int recentQuestions = 0, recentAttempts = 0;
        for (ScopeStatsDto s : scopes) {
            if (!s.objective()) continue;
            recentQuestions += s.recentQuestions() == null ? 0 : s.recentQuestions();
            recentAttempts += s.recentAttempts();
        }
        int objective = (int) practice.stream().filter(PracticeAttemptFacts::objective).count();
        return new PracticeOverviewDto(practice.size(), objective, practice.size() - objective, t.questions(), t.correct(),
                t.incorrect(), t.unanswered(), accuracy(t.correct(), t.questions()), spent, scopes.size(), days.size(),
                practice.isEmpty() ? null : practice.get(practice.size() - 1).submittedAt(),
                objective == 0 ? Signal.INSUFFICIENT_DATA.name() : signal(recentQuestions, recentAttempts).name());
    }

    static List<InteractionStatsDto> interactionStats(List<PracticeAttemptFacts> practice, Instant now) {
        Map<String, int[]> counts = new TreeMap<>();       // type → correct, incorrect, unanswered
        Map<String, Set<UUID>> attemptsByType = new HashMap<>();
        Instant recentStart = now.minus(RECENT_DAYS, ChronoUnit.DAYS);
        for (PracticeAttemptFacts a : practice) {
            if (!a.objective() || a.submittedAt().isBefore(recentStart)) continue;
            for (ItemOutcome o : a.items()) {
                if (o.interactionType() == null || o.interactionType().isBlank() || o.outcome() == Outcome.NOT_SCORED) continue;
                int[] c = counts.computeIfAbsent(o.interactionType(), k -> new int[3]);
                if (o.outcome() == Outcome.CORRECT) c[0]++;
                else if (o.outcome() == Outcome.INCORRECT) c[1]++;
                else c[2]++;
                attemptsByType.computeIfAbsent(o.interactionType(), k -> new HashSet<>()).add(a.attemptId());
            }
        }
        List<InteractionStatsDto> out = new ArrayList<>();
        counts.forEach((type, c) -> {
            int q = c[0] + c[1] + c[2];
            out.add(new InteractionStatsDto(type, q, c[0], c[1], c[2], accuracy(c[0], q),
                    signal(q, attemptsByType.get(type).size()).name()));
        });
        return out;
    }

    // ─── 8B: mistakes ───────────────────────────────────────────────────────────────────────

    /** Occurrence history of one item (identity = logical key + version) across the learner's practice attempts. */
    record MistakeTrack(String key, String logicalItemKey, int version, Integer questionNumber, String interactionType,
                        String scopeCode, String formTitle, List<Outcome> outcomes, Instant lastSeenAt, int missCount,
                        int correctCount, String state, UUID reviewAttemptId) {}

    static List<MistakeTrack> mistakeTracks(List<PracticeAttemptFacts> chronological) {
        record Occ(PracticeAttemptFacts attempt, ItemOutcome item) {}
        Map<String, List<Occ>> byItem = new LinkedHashMap<>();
        for (PracticeAttemptFacts a : chronological) {
            if (!a.objective()) continue;
            for (ItemOutcome o : a.items()) {
                if (o.outcome() == Outcome.NOT_SCORED) continue;
                String identity = o.logicalItemKey() != null && !o.logicalItemKey().isBlank() ? o.logicalItemKey() : String.valueOf(o.itemId());
                byItem.computeIfAbsent(identity + "#v" + o.version(), k -> new ArrayList<>()).add(new Occ(a, o));
            }
        }
        List<MistakeTrack> out = new ArrayList<>();
        for (Map.Entry<String, List<Occ>> e : byItem.entrySet()) {
            List<Occ> occ = e.getValue();
            int miss = 0, correct = 0;
            UUID lastMissAttempt = null;
            List<Outcome> outcomes = new ArrayList<>();
            for (Occ o : occ) {
                outcomes.add(o.item().outcome());
                if (o.item().outcome() == Outcome.CORRECT) correct++;
                else {
                    miss++;
                    lastMissAttempt = o.attempt().attemptId();
                }
            }
            if (miss == 0) continue;
            Occ last = occ.get(occ.size() - 1);
            boolean lastCorrect = last.item().outcome() == Outcome.CORRECT;
            String state = lastCorrect ? "IMPROVED" : miss >= 2 ? "REPEATED" : "SINGLE";
            out.add(new MistakeTrack(e.getKey(), last.item().logicalItemKey(), last.item().version(), last.item().questionNumber(),
                    last.item().interactionType(), last.attempt().scopeCode(), last.attempt().formTitle(), outcomes,
                    last.attempt().submittedAt(), miss, correct, state, lastMissAttempt));
        }
        return out;
    }

    private static final Map<String, Integer> STATE_ORDER = Map.of("REPEATED", 0, "SINGLE", 1, "IMPROVED", 2);

    static MistakeSummaryDto mistakeSummary(List<MistakeTrack> tracks) {
        List<MistakeTrack> sorted = new ArrayList<>(tracks);
        sorted.sort(Comparator.<MistakeTrack>comparingInt(t -> STATE_ORDER.get(t.state()))
                .thenComparing(Comparator.comparingInt(MistakeTrack::missCount).reversed())
                .thenComparing(MistakeTrack::lastSeenAt, Comparator.reverseOrder())
                .thenComparing(MistakeTrack::key));
        List<MistakeItemDto> items = sorted.stream().limit(MAX_MISTAKES).map(t -> new MistakeItemDto(t.logicalItemKey(),
                t.version(), t.questionNumber(), t.interactionType(), t.scopeCode(), t.formTitle(), t.outcomes().size(),
                t.missCount(), t.correctCount(), t.outcomes().get(t.outcomes().size() - 1).name(), t.lastSeenAt(), t.state(),
                t.reviewAttemptId(), t.outcomes().stream().map(Enum::name).toList())).toList();
        int repeated = (int) tracks.stream().filter(t -> t.state().equals("REPEATED")).count();
        int single = (int) tracks.stream().filter(t -> t.state().equals("SINGLE")).count();
        int improved = (int) tracks.stream().filter(t -> t.state().equals("IMPROVED")).count();
        return new MistakeSummaryDto(repeated, single, improved, items, tracks.size());
    }

    // ─── 8C: recommendations ────────────────────────────────────────────────────────────────

    /** Canonical scope order: skill (Listening, Reading, Writing, Speaking), then the printed number. */
    static int skillOrder(SkillType skill) {
        return skill == null ? 9 : skill.ordinal();
    }

    static final Comparator<ScopeStatsDto> SCOPE_ORDER_DTO = Comparator
            .comparingInt((ScopeStatsDto s) -> skillOrder(s.skill())).thenComparingInt(ScopeStatsDto::scopeNumber)
            .thenComparing(ScopeStatsDto::scopeCode);

    static final Comparator<AvailableScope> SCOPE_ORDER_AVAILABLE = Comparator
            .comparingInt((AvailableScope s) -> skillOrder(s.skill())).thenComparingInt(AvailableScope::scopeNumber)
            .thenComparing(AvailableScope::scopeCode);

    private record Candidate(ScopeStatsDto stats, double pressure, List<ReasonDto> reasons) {}

    static RecommendationBlockDto recommend(List<ScopeStatsDto> scopes, List<PracticeAttemptFacts> practice,
                                            List<AvailableScope> availableIn, Instant now) {
        Map<String, List<AvailableScope>> available = new TreeMap<>();
        for (AvailableScope s : availableIn == null ? List.<AvailableScope>of() : availableIn) {
            available.computeIfAbsent(s.scopeCode(), k -> new ArrayList<>()).add(s);
        }
        if (available.isEmpty()) return new RecommendationBlockDto("NO_AVAILABLE_SCOPE", List.of());

        List<ScopeStatsDto> signalled = scopes.stream().filter(s -> s.objective()
                && (Signal.EMERGING_SIGNAL.name().equals(s.signal()) || Signal.ESTABLISHED_SIGNAL.name().equals(s.signal()))).toList();
        Set<String> practised = scopes.stream().map(ScopeStatsDto::scopeCode).collect(Collectors.toSet());
        List<RecommendationDto> out = new ArrayList<>();

        if (signalled.isEmpty()) {
            // Not enough history: never claim a weak area. Neutral starters only (never-practised first, canonical order).
            List<AvailableScope> starters = representatives(available).stream()
                    .sorted(Comparator.comparing((AvailableScope s) -> practised.contains(s.scopeCode()))
                            .thenComparing(SCOPE_ORDER_AVAILABLE)).limit(MAX_RECOMMENDATIONS).toList();
            for (AvailableScope s : starters) {
                AvailableScope target = target(available.get(s.scopeCode()), practice);
                out.add(new RecommendationDto(out.size() + 1, "START", s.scopeCode(), s.scopeType(), s.skill(), s.scopeNumber(),
                        target.formId(), target.formTitle(), List.of(new ReasonDto("AVAILABLE_TO_START", Map.of())),
                        null, null, null));
            }
            return new RecommendationBlockDto("INSUFFICIENT_DATA", out);
        }

        List<Candidate> candidates = new ArrayList<>();
        for (ScopeStatsDto s : signalled) {
            if (!available.containsKey(s.scopeCode())) continue;   // never recommend a scope that cannot be practised now
            int rq = s.recentQuestions(), rc = s.recentCorrect(), ri = s.recentIncorrect(), ru = s.recentUnanswered();
            double missRate = rq > 0 ? (ri + ru) * 100.0 / rq : 0.0;
            int repeated = s.currentRepeatedMistakes() == null ? 0 : s.currentRepeatedMistakes();
            if (missRate < FOCUS_MIN_MISS_RATE && repeated < FOCUS_MIN_REPEATED) continue;
            int otherQ = 0, otherC = 0;
            for (ScopeStatsDto o : signalled) {
                if (o.scopeCode().equals(s.scopeCode())) continue;
                otherQ += o.recentQuestions();
                otherC += o.recentCorrect();
            }
            Double others = accuracy(otherC, otherQ);
            double recentAcc = s.recentAccuracyPercent();
            double gap = others == null ? 0.0 : others - recentAcc;
            boolean improving = s.earlierAccuracyPercent() != null && recentAcc - s.earlierAccuracyPercent() >= IMPROVEMENT_PP;
            double pressure = missRate + 2.0 * Math.min(repeated, 10) + Math.max(0.0, gap);
            if (improving) pressure *= 0.5;
            if (Signal.EMERGING_SIGNAL.name().equals(s.signal())) pressure *= 0.8;

            List<ReasonDto> reasons = new ArrayList<>();
            if (repeated >= FOCUS_MIN_REPEATED) {
                reasons.add(new ReasonDto("REPEATED_MISTAKES", ordered("scopeCode", s.scopeCode(), "count", repeated)));
            } else if (ru >= 3 && ru * 2 >= ri + ru) {
                reasons.add(new ReasonDto("MANY_BLANKS", ordered("scopeCode", s.scopeCode(), "unanswered", ru, "total", rq)));
            } else {
                reasons.add(new ReasonDto("RECENT_MISSES", ordered("scopeCode", s.scopeCode(), "incorrect", ri,
                        "unanswered", ru, "total", rq)));
            }
            if (others != null && gap >= LOWER_THAN_OTHERS_PP) {
                reasons.add(new ReasonDto("LOWER_THAN_OTHER_SCOPES", ordered("scopeCode", s.scopeCode(),
                        "recentAccuracy", recentAcc, "otherAccuracy", others)));
            }
            if (improving) {
                reasons.add(new ReasonDto("IMPROVING", ordered("scopeCode", s.scopeCode(),
                        "earlierAccuracy", s.earlierAccuracyPercent(), "recentAccuracy", recentAcc)));
            }
            candidates.add(new Candidate(s, Math.round(pressure * 1000.0) / 1000.0, reasons));
        }
        candidates.sort(Comparator.comparingDouble(Candidate::pressure).reversed()
                .thenComparing(c -> c.stats().scopeCode()));
        for (Candidate c : candidates) {
            if (out.size() >= MAX_RECOMMENDATIONS) break;
            ScopeStatsDto s = c.stats();
            AvailableScope target = target(available.get(s.scopeCode()), practice);
            out.add(new RecommendationDto(out.size() + 1, "FOCUS", s.scopeCode(), s.scopeType(), s.skill(), s.scopeNumber(),
                    target.formId(), target.formTitle(), c.reasons(), s.signal(), s.recentQuestions(), s.recentAttempts()));
        }
        if (out.size() < MAX_RECOMMENDATIONS) {
            for (AvailableScope s : representatives(available).stream().sorted(SCOPE_ORDER_AVAILABLE).toList()) {
                if (out.size() >= MAX_RECOMMENDATIONS) break;
                if (practised.contains(s.scopeCode())) continue;
                AvailableScope target = target(available.get(s.scopeCode()), practice);
                out.add(new RecommendationDto(out.size() + 1, "COVERAGE", s.scopeCode(), s.scopeType(), s.skill(),
                        s.scopeNumber(), target.formId(), target.formTitle(),
                        List.of(new ReasonDto("NOT_PRACTICED_YET", ordered("scopeCode", s.scopeCode(), "attempts", 0))),
                        null, null, null));
            }
        }
        return new RecommendationBlockDto("PERSONALIZED", out);
    }

    /** One entry per scope code (the canonical scope facts are identical across forms). */
    private static List<AvailableScope> representatives(Map<String, List<AvailableScope>> available) {
        List<AvailableScope> out = new ArrayList<>();
        for (List<AvailableScope> l : available.values()) out.add(l.get(0));
        return out;
    }

    /**
     * Form to practise a recommended scope on: one where the learner has not practised this scope yet, else the one
     * practised least recently; ties by title then id (deterministic).
     */
    static AvailableScope target(List<AvailableScope> forms, List<PracticeAttemptFacts> practice) {
        Map<UUID, Instant> lastOnForm = new HashMap<>();
        Map<UUID, Integer> countOnForm = new HashMap<>();
        String scopeCode = forms.get(0).scopeCode();
        for (PracticeAttemptFacts a : practice) {
            if (!scopeCode.equals(a.scopeCode())) continue;
            countOnForm.merge(a.sourceFormId(), 1, Integer::sum);
            lastOnForm.merge(a.sourceFormId(), a.submittedAt(), (x, y) -> x.isAfter(y) ? x : y);
        }
        return forms.stream().sorted(Comparator
                .comparingInt((AvailableScope f) -> countOnForm.getOrDefault(f.formId(), 0) > 0 ? 1 : 0)
                .thenComparing(f -> lastOnForm.getOrDefault(f.formId(), Instant.EPOCH))
                .thenComparing(f -> f.formTitle() == null ? "" : f.formTitle())
                .thenComparing(f -> f.formId().toString())).findFirst().orElseThrow();
    }

    private static Map<String, Object> ordered(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put(String.valueOf(kv[i]), kv[i + 1]);
        return m;
    }

    // ─── simulation + activity ──────────────────────────────────────────────────────────────

    static SimulationOverviewDto simulationOverview(List<SimulationAttemptDto> sims) {
        List<SimulationAttemptDto> sorted = new ArrayList<>(sims);
        sorted.sort(Comparator.comparing(SimulationAttemptDto::submittedAt, Comparator.nullsLast(Comparator.reverseOrder()))
                .thenComparing(s -> s.attemptId().toString()));
        int scored = (int) sorted.stream().filter(s -> s.components() != null && !s.components().isEmpty()).count();
        return new SimulationOverviewDto(sorted.size(), scored, sorted);
    }

    static List<ActivityWeekDto> activity(List<PracticeAttemptFacts> practice, List<SimulationAttemptDto> sims, Instant now) {
        LocalDate thisWeek = now.atZone(ZONE).toLocalDate().with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
        Map<LocalDate, int[]> weeks = new LinkedHashMap<>();
        for (int i = ACTIVITY_WEEKS - 1; i >= 0; i--) weeks.put(thisWeek.minusWeeks(i), new int[3]);
        for (PracticeAttemptFacts a : practice) {
            int[] w = weeks.get(a.submittedAt().atZone(ZONE).toLocalDate().with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)));
            if (w == null) continue;
            w[0]++;
            w[2] += tally(a).questions();
        }
        for (SimulationAttemptDto s : sims) {
            if (s.submittedAt() == null) continue;
            int[] w = weeks.get(s.submittedAt().atZone(ZONE).toLocalDate().with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)));
            if (w != null) w[1]++;
        }
        List<ActivityWeekDto> out = new ArrayList<>();
        weeks.forEach((d, w) -> out.add(new ActivityWeekDto(d, w[0], w[1], w[2])));
        return out;
    }
}
