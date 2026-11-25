package com.englishcoach.learningpath;

import com.englishcoach.common.contract.LearnerDnaSnapshot;
import com.englishcoach.common.contract.LearnerDnaSnapshotProvider;
import com.englishcoach.common.contract.LearningPlanSummarySource;
import com.englishcoach.learningpath.LearningEvidenceReader.Context;
import com.englishcoach.learningpath.LearningEvidenceReader.ContentItem;
import com.englishcoach.learningpath.LearningEvidenceReader.Evidence;
import com.englishcoach.learningpath.LearningPathDtos.*;
import com.englishcoach.learningpath.LearningPathEngine.*;
import com.englishcoach.learningpath.LearningPathRepository.NewTask;
import com.englishcoach.learningpath.LearningPathRepository.Plan;
import com.englishcoach.learningpath.LearningPathRepository.Revision;
import com.englishcoach.learningpath.LearningPathRepository.Task;
import com.englishcoach.progress.config.LearningProgressProperties;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.*;
import java.util.*;
import java.util.stream.Collectors;

/**
 * Echo Learning Path. Daily planning is deterministic and AI-free: a day's tasks are created lazily on the learner's
 * first visit (idempotent per learner and day under an advisory lock), stay stable for the day, and are completed only
 * by server-persisted learning rows ({@link LearningEvidenceReader}). Learner DNA is read only inside the explicit
 * "Cập nhật bằng Learner DNA" request and changes the plan only after the learner confirms.
 */
@Service
public class LearningPathService implements LearningPlanSummarySource {

    static final Set<Integer> MINUTES = Set.of(15, 30, 45, 60);
    static final List<String> IELTS_TARGETS = List.of("5.0", "5.5", "6.0", "6.5", "7.0", "7.5");
    static final List<String> TOEIC_TARGETS = List.of("450", "550", "650", "750", "850", "900", "950", "990");
    static final int CARRY_DAYS = 7;
    static final int PLACEMENT_EVERY_DAYS = 7;
    static final int EXAM_EVERY_DAYS = 7;
    static final int WRITING_REPEAT_DAYS = 14;
    static final Duration PROPOSAL_TTL = Duration.ofMinutes(15);
    static final Duration PROPOSAL_REUSE = Duration.ofSeconds(30);
    static final int PROPOSALS_PER_DAY = 10;

    private final LearningPathRepository repo;
    private final LearningEvidenceReader evidence;
    private final LearningProgressProperties time;
    private final ObjectProvider<LearnerDnaSnapshotProvider> dna;
    private final ObjectProvider<LearningExamPractice> exams;
    private final ObjectMapper mapper;
    private Clock clock = Clock.systemUTC();

    public LearningPathService(LearningPathRepository repo, LearningEvidenceReader evidence, LearningProgressProperties time,
                               ObjectProvider<LearnerDnaSnapshotProvider> dna, ObjectProvider<LearningExamPractice> exams,
                               ObjectMapper mapper) {
        this.repo = repo;
        this.evidence = evidence;
        this.time = time;
        this.dna = dna;
        this.exams = exams;
        this.mapper = mapper;
    }

    void useClock(Clock clock) { this.clock = clock; }

    // ── commands ─────────────────────────────────────────────────────────────────────────────────

    /** Today's plan: creates the day once, links new evidence, returns the stored state. */
    @Transactional
    public TodayView today(long userId) {
        Optional<Plan> plan = repo.plan(userId);
        if (plan.isEmpty()) return TodayView.none();
        LocalDate day = today();
        List<Task> tasks = repo.tasksOn(userId, day);
        if (tasks.isEmpty()) {
            repo.lock(userId); // the first visit of the day creates it exactly once, also with two tabs
            plan = repo.plan(userId);
            if (plan.isEmpty()) return TodayView.none();
            if (repo.tasksOn(userId, day).isEmpty()) generateDay(userId, plan.get(), day);
            return view(userId, day);
        }
        if (retireUnavailable(userId, plan.get(), day, tasks)) return view(userId, day);
        return view(userId, day, tasks, plan.get());
    }

    @Transactional
    public TodayView setGoal(long userId, GoalRequest request) {
        String goal = request.goal();
        int minutes = request.dailyMinutes() == null ? 0 : request.dailyMinutes();
        if (!MINUTES.contains(minutes)) throw new LearningPathException(400, "INVALID_MINUTES");
        String target = normaliseTarget(goal, request.target());
        repo.lock(userId);
        Optional<Plan> existing = repo.plan(userId);
        if (existing.isPresent() && existing.get().goal().equals(goal) && existing.get().dailyMinutes() == minutes
                && Objects.equals(existing.get().target(), target)) {
            return today(userId);
        }
        Context ctx = evidence.context(userId);
        String[] level = level(ctx);
        repo.savePlan(userId, goal, minutes, target, level[0], level[1]);
        LocalDate day = today();
        Plan plan = repo.plan(userId).orElseThrow();
        // today's assigned tasks never change: the new goal plans the next days; a larger budget only adds tasks today
        if (repo.tasksOn(userId, day).isEmpty()) generateDay(userId, plan, day);
        else topUpDay(userId, plan, day);
        return view(userId, day);
    }

    /** Explicit Learner DNA analysis → a proposal the learner must confirm. Never changes the plan by itself. */
    @Transactional
    public ProposalView propose(long userId) {
        repo.lock(userId);
        Plan plan = repo.plan(userId).orElseThrow(() -> new LearningPathException(404, "NO_PLAN"));
        Instant now = clock.instant();
        Optional<Revision> open = repo.latestOpenRevision(userId);
        if (open.isPresent() && open.get().baseVersion() == plan.version() && open.get().createdAt() != null
                && open.get().createdAt().isAfter(now.minus(PROPOSAL_REUSE)) && open.get().expiresAt().isAfter(now)) {
            return proposalView(open.get()); // a double click returns the same analysis
        }
        if (repo.revisionsSince(userId, now.minus(Duration.ofDays(1))) >= PROPOSALS_PER_DAY)
            throw new LearningPathException(429, "RATE_LIMITED");
        LearnerDnaSnapshotProvider aggregator = dna.getIfAvailable();
        if (aggregator == null) throw new LearningPathException(503, "DNA_UNAVAILABLE");
        LearnerDnaSnapshot profile = aggregator.getSnapshot(userId, true); // fresh 7-day aggregation, no AI
        DnaSignals signals = signals(profile);
        Map<String, Double> proposed = LearningPathEngine.focusFromDna(signals);
        List<FocusChange> changes = LearningPathEngine.diff(plan.focus(), proposed, signals);
        DnaFacts facts = facts(profile);
        Instant generatedAt = parseInstant(profile.generatedAt(), now);
        Map<String, Object> stored = new LinkedHashMap<>();
        stored.put("changes", changes.stream().map(c -> new ChangeView(c.skill(), c.to() > c.from() ? "UP" : "DOWN", c.reason())).toList());
        stored.put("facts", facts);
        long id = repo.insertRevision(userId, plan.version(), generatedAt, proposed, json(stored), now.plus(PROPOSAL_TTL));
        return proposalView(repo.revision(userId, id).orElseThrow());
    }

    @Transactional
    public TodayView apply(long userId, long revisionId) {
        repo.lock(userId);
        Plan plan = repo.plan(userId).orElseThrow(() -> new LearningPathException(404, "NO_PLAN"));
        Revision r = repo.revision(userId, revisionId).orElseThrow(() -> new LearningPathException(404, "NOT_FOUND"));
        if (!"PROPOSED".equals(r.status())) throw new LearningPathException(409, "ALREADY_DECIDED");
        if (!r.expiresAt().isAfter(clock.instant())) {
            repo.decide(userId, revisionId, "EXPIRED");
            throw new LearningPathException(410, "EXPIRED");
        }
        if (r.baseVersion() != plan.version() || !repo.applyFocus(userId, plan.version(), r.focus())) {
            repo.decide(userId, revisionId, "SUPERSEDED");
            throw new LearningPathException(409, "STALE");
        }
        repo.decide(userId, revisionId, "APPLIED");
        // the new focus plans the next days; today's assigned tasks (and their content) stay exactly as they are
        LocalDate day = today();
        if (repo.tasksOn(userId, day).isEmpty()) generateDay(userId, repo.plan(userId).orElseThrow(), day);
        return view(userId, day);
    }

    @Transactional
    public void cancel(long userId, long revisionId) {
        repo.revision(userId, revisionId).orElseThrow(() -> new LearningPathException(404, "NOT_FOUND"));
        repo.decide(userId, revisionId, "CANCELLED");
    }

    // ── reads (no writes, no generation) ─────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public ProgressSummary summary(long userId) {
        Map<Skill, SkillEstimate> estimates = estimates(userId);
        Optional<Plan> plan = repo.plan(userId);
        // Reading has a scored outcome only through exam reading parts (IELTS / TOEIC paths), Writing only through the
        // optional AI feedback: without a scored observation either is "Chưa đo được" (never a low band)
        Set<Skill> measurable = plan.map(p -> LearningPathEngine.measurable(Goal.valueOf(p.goal()))).orElse(LearningPathEngine.MEASURABLE);
        List<SkillView> skills = Arrays.stream(Skill.values()).map(s -> {
            SkillEstimate e = estimates.get(s);
            boolean unmeasured = LearningPathEngine.PRACTICE_MILESTONE_SKILLS.contains(s)
                    && (!measurable.contains(s) || e.observations() == 0);
            return new SkillView(s.name(), unmeasured ? "NOT_MEASURED" : e.band(), e.observations(), e.daysSinceLast());
        }).toList();
        LocalDate day = today();
        LearningPathRepository.DoneStats done = repo.doneStats(userId, day);
        if (plan.isEmpty()) return new ProgressSummary(null, null, skills, done.total(), done.last7d(), done.last30d());
        Context ctx = evidence.context(userId);
        StageStatus stage = LearningPathEngine.stage(plan.get().stage(), stageInput(plan.get(), ctx, done, estimates));
        return new ProgressSummary(planView(plan.get()), stageView(stage), skills, done.total(), done.last7d(), done.last30d());
    }

    @Override
    @Transactional(readOnly = true)
    public Map<String, Object> planSummary(long userId) {
        return planSummary(userId, true);
    }

    @Transactional(readOnly = true)
    public Map<String, Object> planSummary(long userId, boolean includeExamSignals) {
        Optional<Plan> plan = repo.plan(userId);
        if (plan.isEmpty()) return Map.of();
        List<Task> tasks = repo.tasksOn(userId, today()).stream().filter(t -> isShown(t.status())).toList();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("goal", plan.get().goal());
        out.put("stage", plan.get().stage());
        if (plan.get().target() != null) out.put("target", plan.get().target());
        LearningExamPractice practice = exams.getIfAvailable();
        if (includeExamSignals && practice != null) {
            var signals = practice.signals(userId, plan.get().goal());
            out.put("practiceFocus", signals.focus());
            out.put("latestSimulationStatus", signals.latestSimulationStatus());
            out.put("estimates", signals.estimates());
        }
        out.put("dailyMinutes", plan.get().dailyMinutes());
        out.put("todayTasks", tasks.size());
        out.put("todayDone", (int) tasks.stream().filter(t -> "DONE".equals(t.status())).count());
        out.put("todayRemainingSkills", tasks.stream().filter(t -> "OPEN".equals(t.status())).map(Task::skill).distinct().toList());
        return out;
    }

    // ── day generation ───────────────────────────────────────────────────────────────────────────

    private void generateDay(long userId, Plan plan, LocalDate day) {
        // 1. settle earlier open tasks: link evidence first, then carry the latest day's unfinished work
        List<Task> earlier = repo.openBefore(userId, day);
        Set<Long> completed = new HashSet<>();
        settle(userId, earlier, completed);
        List<Task> remaining = earlier.stream().filter(t -> !completed.contains(t.id())).toList();
        LocalDate lastDay = remaining.stream().map(Task::day).max(Comparator.naturalOrder()).orElse(null);
        Set<String> existing = evidence.existingTargets(remaining);
        List<Task> carry = new ArrayList<>(), drop = new ArrayList<>();
        for (Task t : remaining) {
            boolean recent = t.day().equals(lastDay) && !t.day().isBefore(day.minusDays(CARRY_DAYS));
            boolean real = deliverable(t, existing);
            (recent && real && !"PLACEMENT".equals(t.kind()) ? carry : drop).add(t);
        }
        // 2. level and evidence-based priorities
        Context ctx = evidence.context(userId);
        Goal goal = Goal.valueOf(plan.goal());
        String[] level = level(ctx);
        repo.updateLevel(userId, level[0], level[1]);
        Map<Skill, SkillEstimate> estimates = estimates(userId);
        // 3. carried work first, within the day's budget
        List<NewTask> rows = new ArrayList<>();
        Set<String> takenSkills = new HashSet<>();
        int used = 0, position = repo.nextPosition(userId, day);
        int limit = (int) Math.floor(plan.dailyMinutes() * LearningPathEngine.BUDGET_TOLERANCE);
        carry.sort(Comparator.comparingInt(Task::position));
        List<Long> carried = new ArrayList<>();
        for (Task t : carry) {
            boolean fits = rows.isEmpty() || used + t.minutes() <= limit;
            if (!fits || takenSkills.contains(t.skill()) || rows.size() >= LearningPathEngine.MAX_TASKS) { drop.add(t); continue; }
            rows.add(new NewTask(day, position++, plan.version(), t.kind(), t.skill(), t.targetId(), t.targetKey(), t.title(),
                    t.minutes(), t.goalCount(), "CARRIED_OVER", t.id(), t.assignedAt(), t.targetRef()));
            takenSkills.add(t.skill());
            used += t.minutes();
            carried.add(t.id());
        }
        repo.close(userId, carried, "CARRIED");
        repo.close(userId, drop.stream().map(Task::id).toList(), "DROPPED");
        // 4. fill the rest of the budget
        rows.addAll(fill(userId, plan, goal, level, ctx, estimates, day, takenSkills, used, rows.size(), position));
        repo.insert(userId, rows);
    }

    /**
     * Goal change: today's assigned tasks keep their identity and content (open, done or carried); only the part of a
     * larger daily budget that is still free is filled with new tasks.
     */
    private void topUpDay(long userId, Plan plan, LocalDate day) {
        List<Task> tasks = repo.tasksOn(userId, day);
        settle(userId, tasks.stream().filter(t -> "OPEN".equals(t.status())).toList());
        Set<String> takenSkills = new HashSet<>();
        int used = 0, kept = 0;
        for (Task t : repo.tasksOn(userId, day)) {
            if (isShown(t.status())) { takenSkills.add(t.skill()); used += t.minutes(); kept++; }
        }
        Context ctx = evidence.context(userId);
        repo.insert(userId, fill(userId, plan, Goal.valueOf(plan.goal()), new String[]{plan.level(), plan.levelBasis()}, ctx,
                estimates(userId), day, takenSkills, used, kept, repo.nextPosition(userId, day)));
    }

    /**
     * Explicit replacement policy, the only one: an OPEN task whose SYSTEM material no longer exists, or whose kind is no
     * longer assignable (no trustworthy completion contract), is first checked for evidence, then closed as REPLACED (its
     * row stays, never completed) and the freed budget is filled again. Nothing else ever replaces an assigned task.
     * Returns true when a row changed.
     */
    private boolean retireUnavailable(long userId, Plan plan, LocalDate day, List<Task> tasks) {
        List<Task> open = tasks.stream().filter(t -> "OPEN".equals(t.status())).toList();
        List<Task> targeted = open.stream().filter(t -> t.targetId() != null || t.targetRef() != null).toList();
        Set<String> existing = targeted.isEmpty() ? Set.of() : evidence.existingTargets(targeted);
        List<Task> gone = open.stream().filter(t -> !deliverable(t, existing)).toList();
        if (gone.isEmpty()) return false;
        repo.lock(userId);
        // re-read under the lock: a concurrent request may already have replaced them (then nothing is added twice)
        Set<Long> goneIds = gone.stream().map(Task::id).collect(Collectors.toSet());
        gone = repo.tasksOn(userId, day).stream().filter(t -> "OPEN".equals(t.status()) && goneIds.contains(t.id())).toList();
        if (gone.isEmpty()) return true;
        Set<Long> done = new HashSet<>();
        settle(userId, gone, done);
        repo.close(userId, gone.stream().map(Task::id).filter(id -> !done.contains(id)).toList(), "REPLACED");
        topUpDay(userId, plan, day);
        return true;
    }

    private List<NewTask> fill(long userId, Plan plan, Goal goal, String[] level, Context ctx, Map<Skill, SkillEstimate> estimates,
                               LocalDate day, Set<String> takenSkills, int usedMinutes, int usedSlots, int position) {
        int budget = plan.dailyMinutes();
        Map<String, Priority> priorities = new HashMap<>();
        LearningPathRepository.Coverage coverage = repo.coverage(userId, day, LearningPathEngine.COVERAGE_DAYS);
        boolean balance = coverage.planDays() >= LearningPathEngine.COVERAGE_MIN_DAYS;
        for (Skill s : Skill.values())
            priorities.put(s.name(), LearningPathEngine.priority(goal, estimates.get(s), ctx.dueCards(),
                    plan.focus().getOrDefault(s.name(), 0.0), balance && !coverage.skills().contains(s.name())));
        List<Candidate> candidates = candidates(userId, plan, goal, level, ctx, estimates, day);
        Set<String> yesterday = repo.skillsOfPreviousDay(userId, day);
        List<Selected> chosen = LearningPathEngine.select(candidates, priorities, yesterday, takenSkills, usedMinutes, usedSlots, budget);
        Instant now = clock.instant();
        List<NewTask> rows = new ArrayList<>();
        for (Selected s : chosen) {
            Candidate c = s.candidate();
            rows.add(new NewTask(day, position++, plan.version(), c.kind().name(), c.skill(), c.targetId(), c.targetKey(),
                    c.title(), c.minutes(), c.goalCount(), s.reason(), null, now, c.targetRef()));
        }
        return rows;
    }

    /** Only real, reachable activities. Too little suitable content ⇒ fewer candidates, never an invented one. */
    private List<Candidate> candidates(long userId, Plan plan, Goal goal, String[] level, Context ctx,
                                       Map<Skill, SkillEstimate> estimates, LocalDate day) {
        int budget = plan.dailyMinutes();
        List<Candidate> c = new ArrayList<>();
        Map<String, LocalDate> last = repo.lastTaskDays(userId, List.of("PLACEMENT", "EXAM_PRACTICE"));
        boolean levelKnown = ctx.placementValid() || (ctx.currentCefr() != null && !"UNDETERMINED".equals(ctx.overallStatus()));
        if (!levelKnown && due(last.get("PLACEMENT"), day, PLACEMENT_EVERY_DAYS))
            c.add(new Candidate(Kind.PLACEMENT, "ASSESSMENT", null, null, "", 4, 1));
        if (ctx.dueCards() > 0) {
            int cards = LearningPathEngine.vocabGoal(ctx.dueCards(), budget);
            c.add(new Candidate(Kind.VOCAB_REVIEW, Skill.VOCABULARY.name(), null, null, "", LearningPathEngine.vocabMinutes(cards), cards));
        }
        int maxWords = (int) Math.floor(budget * 0.7 * 110);
        long seed = userId * 31 + day.toEpochDay();
        boolean dictation = false, reading = false;
        String[] lis = skillLevel(ctx, Skill.LISTENING, level), rea = skillLevel(ctx, Skill.READING, level);
        Band listeningBand = LearningPathEngine.band(LearningPathEngine.stepOf(lis[0]), !"PROVISIONAL".equals(lis[1]),
                estimates.get(Skill.LISTENING));
        Band readingBand = LearningPathEngine.band(LearningPathEngine.stepOf(rea[0]), !"PROVISIONAL".equals(rea[1]),
                estimates.get(Skill.READING));
        for (ContentItem item : evidence.content(userId, listeningBand, readingBand, seed, maxWords)) {
            if ("DICTATION".equals(item.kind()) && !dictation) {
                int segments = LearningPathEngine.dictationGoal(item.size(), budget);
                c.add(new Candidate(Kind.DICTATION, Skill.LISTENING.name(), item.id(), cefrKey(item.cefr()), item.title(),
                        LearningPathEngine.dictationMinutes(segments), segments));
                dictation = true;
            } else if ("READING".equals(item.kind()) && !reading) {
                c.add(new Candidate(Kind.READING, Skill.READING.name(), item.id(), cefrKey(item.cefr()), item.title(),
                        LearningPathEngine.readingMinutes(item.size()), 1));
                reading = true;
            }
        }
        String style = LearningPathEngine.speakingStyle(goal, skillLevel(ctx, Skill.SPEAKING, level)[0]);
        int rounds = LearningPathEngine.speakingRounds(budget);
        c.add(new Candidate(Kind.TOPIC_SPEAKING, Skill.SPEAKING.name(), null, style, "",
                LearningPathEngine.speakingMinutes(rounds, style), rounds));
        writingCandidate(userId, goal, skillLevel(ctx, Skill.WRITING, level)[0], budget, day, seed).ifPresent(c::add);
        // weekly exam practice for exam goals once the starting level is known: one exact, practice-ready part
        if ((goal == Goal.IELTS || goal == Goal.TOEIC) && budget >= 30 && levelKnown
                && due(last.get("EXAM_PRACTICE"), day, EXAM_EVERY_DAYS))
            examCandidate(userId, goal, LearningPathEngine.stepOf(level[0]), seed).ifPresent(c::add);
        // only kinds with a verified, AI-free completion contract every learner can reach are offered
        c.removeIf(x -> !LearningPathEngine.ASSIGNABLE.contains(x.kind().name()));
        return c;
    }

    /** A Writing Coach prompt suited to the writing level and budget, not given in the last two weeks (else none). */
    private Optional<Candidate> writingCandidate(long userId, Goal goal, String writingLevel, int budget, LocalDate day, long seed) {
        List<LearningPathEngine.WritingTask> options = LearningPathEngine.writingOptions(goal, LearningPathEngine.stepOf(writingLevel), budget);
        if (options.isEmpty()) return Optional.empty();
        Set<String> recent = repo.recentWritingKeys(userId, day, WRITING_REPEAT_DAYS);
        List<LearningPathEngine.WritingTask> fresh = options.stream().filter(t -> !recent.contains(t.key())).toList();
        List<LearningPathEngine.WritingTask> pool = fresh.isEmpty() ? options : fresh;
        LearningPathEngine.WritingTask task = pool.get((int) Math.floorMod(seed, (long) pool.size()));
        return Optional.of(new Candidate(Kind.WRITING, Skill.WRITING.name(), null, task.key(), "",
                LearningPathEngine.writingMinutes(task.minWords()), 1));
    }

    /**
     * One exact practice part from the Exams catalog (only parts that module declares practice-ready), in the level's
     * order of preference, a form + part the learner has not practised in 180 days, varied by the day's seed.
     */
    private Optional<Candidate> examCandidate(long userId, Goal goal, int step, long seed) {
        LearningExamPractice source = exams.getIfAvailable();
        if (source == null) return Optional.empty();
        List<String> preference = LearningPathEngine.examPreference(goal, step);
        if (preference.isEmpty()) return Optional.empty();
        List<LearningExamPractice.Scope> ready = source.practiceScopes(goal.name());
        if (ready.isEmpty()) return Optional.empty();
        Set<String> done = evidence.practisedExamParts(userId);
        Set<String> ranked = new LinkedHashSet<>();
        source.recommendedFocus(userId, goal.name()).forEach(f -> ranked.add(f.code()));
        ranked.addAll(preference);
        for (String code : ranked) {
            if (LearningPathEngine.examPart(code) == null) continue;
            List<LearningExamPractice.Scope> forms = ready.stream()
                    .filter(s -> code.equals(s.scopeCode()) && !done.contains(s.formId() + "/" + code))
                    .sorted(Comparator.comparing(s -> s.formId().toString())).toList();
            if (forms.isEmpty()) continue;
            LearningExamPractice.Scope pick = forms.get((int) Math.floorMod(seed, (long) forms.size()));
            LearningPathEngine.ExamPart part = LearningPathEngine.examPart(code);
            return Optional.of(new Candidate(Kind.EXAM_PRACTICE, part.skill().name(), null, goal.name(),
                    Objects.toString(pick.title(), ""), part.minutes(), 1, pick.formId() + "/" + code));
        }
        return Optional.empty();
    }

    /**
     * Whether a stored task can still lead to its activity: an assignable kind, a known Writing prompt, an exact exam
     * part, and a target that still exists. A task that cannot is never completed by time; an OPEN one is replaced.
     */
    private static boolean deliverable(Task t, Set<String> existing) {
        if (!LearningPathEngine.ASSIGNABLE.contains(t.kind())) return false;
        return switch (t.kind()) {
            case "WRITING" -> t.targetKey() != null && LearningPathEngine.WRITING_TASKS.containsKey(t.targetKey());
            case "EXAM_PRACTICE" -> LearningEvidenceReader.examForm(t.targetRef()) != null
                    && LearningPathEngine.examPart(LearningEvidenceReader.examScope(t.targetRef())) != null
                    && existing.contains("EXAM_PRACTICE:" + LearningEvidenceReader.examForm(t.targetRef()));
            default -> t.targetId() == null || existing.contains(t.kind() + ":" + t.targetId());
        };
    }

    // ── evidence linking ─────────────────────────────────────────────────────────────────────────

    private int settle(long userId, List<Task> open) {
        return settle(userId, open, new HashSet<>());
    }

    /** Links new evidence to open tasks; collects the ids that became DONE and returns the number of rows changed. */
    private int settle(long userId, List<Task> open, Set<Long> done) {
        List<Task> candidates = open.stream().filter(t -> "OPEN".equals(t.status())).toList();
        if (candidates.isEmpty()) return 0;
        Map<Long, Instant> since = new HashMap<>();
        for (Task t : candidates) since.put(t.id(), dayStart(t.assignedAt()));
        Map<Long, Task> byId = candidates.stream().collect(Collectors.toMap(Task::id, t -> t));
        int changed = 0;
        for (Evidence e : evidence.evaluate(userId, candidates, since)) {
            Task t = byId.get(e.taskId());
            if (t == null) continue;
            if ("EXAM_PRACTICE".equals(t.kind()) && e.count() >= t.goalCount() && e.ref() != null) e = examOutcome(userId, e);
            if (e == null) continue;
            if (e.count() >= t.goalCount() && e.ref() != null) {
                if (repo.complete(userId, t.id(), e.ref(), e.count(), e.resultPct())) { done.add(t.id()); changed++; }
            } else if (e.count() != t.progressCount()) {
                repo.progress(userId, t.id(), e.count());
                changed++;
            }
        }
        return changed;
    }

    /**
     * The submitted attempts of the assigned part (newest first, at most {@link LearningEvidenceReader#EXAM_CANDIDATES})
     * are scored by the Exams module from their own snapshots, owner-scoped; {@link LearningPathEngine#examEvidence}
     * picks the evidence (≥ half of the scored items answered; a later low-information submit never displaces an earlier
     * complete one). The task keeps that attempt's raw accuracy as its result and its answered count as progress.
     * Null = not complete yet.
     */
    private Evidence examOutcome(long userId, Evidence e) {
        LearningExamPractice source = exams.getIfAvailable();
        if (source == null) return null;
        List<ExamAttemptOutcome> scored = new ArrayList<>();
        for (String ref : e.ref().split(",")) {
            UUID attempt;
            try {
                attempt = UUID.fromString(ref.strip().substring(3));
            } catch (RuntimeException ex) {
                continue;
            }
            source.outcome(userId, attempt).ifPresent(o ->
                    scored.add(new ExamAttemptOutcome(ref.strip(), o.answered(), o.total(), o.accuracyPct())));
        }
        return LearningPathEngine.examEvidence(scored)
                .map(o -> new Evidence(e.taskId(), Math.max(1, o.answered()), o.ref(), o.accuracyPct()))
                .orElse(null);
    }

    private StageInput stageInput(Plan plan, Context ctx, LearningPathRepository.DoneStats done, Map<Skill, SkillEstimate> estimates) {
        Goal goal = Goal.valueOf(plan.goal());
        boolean levelEvidence = ctx.placementValid() || (ctx.currentCefr() != null && !"UNDETERMINED".equals(ctx.overallStatus()));
        boolean goalAssessment = goal == Goal.IELTS || goal == Goal.TOEIC ? ctx.examSubmitted30d() : ctx.proficiencyVerified();
        Map<Skill, Integer> bySkill = new EnumMap<>(Skill.class);
        done.bySkill().forEach((k, v) -> bySkill.put(Skill.valueOf(k), v));
        return new StageInput(done.total(), done.distinctSkills30d(), levelEvidence, estimates, goal, goalAssessment, bySkill);
    }

    // ── view ─────────────────────────────────────────────────────────────────────────────────────

    private TodayView view(long userId, LocalDate day) {
        return view(userId, day, repo.tasksOn(userId, day), repo.plan(userId).orElseThrow());
    }

    /** Links new evidence to today's open tasks, then builds the response (re-reading only when a row changed). */
    private TodayView view(long userId, LocalDate day, List<Task> tasks, Plan plan) {
        if (settle(userId, tasks.stream().filter(t -> "OPEN".equals(t.status())).toList()) > 0) tasks = repo.tasksOn(userId, day);
        Context ctx = evidence.context(userId);
        Map<Skill, SkillEstimate> estimates = estimates(userId);
        LearningPathRepository.DoneStats done = repo.doneStats(userId, day);
        StageStatus stage = LearningPathEngine.stage(plan.stage(), stageInput(plan, ctx, done, estimates));
        if (stage.stage() > plan.stage()) {
            repo.raiseStage(userId, stage.stage());
            plan = repo.plan(userId).orElseThrow();
        }
        List<TaskView> shown = tasks.stream().filter(t -> isShown(t.status()))
                .map(t -> new TaskView(t.id(), t.kind(), t.skill(), t.targetId(), t.targetKey(), t.title(), t.minutes(),
                        t.goalCount(), "DONE".equals(t.status()) ? Math.max(t.progressCount(), t.goalCount()) : t.progressCount(),
                        t.status(), t.reasonCode(), t.carriedFrom() != null, t.resultPct(), t.targetRef()))
                .toList();
        int doneCount = (int) shown.stream().filter(t -> "DONE".equals(t.status())).count();
        int minutes = shown.stream().mapToInt(TaskView::minutes).sum();
        return new TodayView(planView(plan), day, shown, doneCount, shown.size(), minutes, stageView(stage));
    }

    private Map<Skill, SkillEstimate> estimates(long userId) {
        Map<Skill, SkillEstimate> out = new EnumMap<>(Skill.class);
        evidence.skillSums(userId).forEach((k, v) -> out.put(k, LearningPathEngine.estimate(v)));
        return out;
    }

    private static PlanView planView(Plan p) {
        return new PlanView(p.goal(), p.dailyMinutes(), p.target(), p.level(), p.levelBasis(), p.stage(), p.version(),
                p.focus(), p.focusUpdatedAt());
    }

    private static StageView stageView(StageStatus s) {
        return new StageView(s.stage(), s.next(), s.assessmentNeeded());
    }

    private ProposalView proposalView(Revision r) {
        List<ChangeView> changes = new ArrayList<>();
        DnaFacts facts = new DnaFacts(0, List.of(), List.of(), 0, false);
        try {
            JsonNode root = mapper.readTree(r.changesJson());
            for (JsonNode c : root.path("changes"))
                changes.add(new ChangeView(c.path("skill").asText(), c.path("direction").asText(), c.path("reason").asText()));
            facts = mapper.treeToValue(root.path("facts"), DnaFacts.class);
        } catch (Exception ignored) {
            // a malformed stored proposal shows no change and cannot be mistaken for one
        }
        return new ProposalView(r.id(), r.baseVersion(), r.dnaGeneratedAt(), r.expiresAt(), changes, facts);
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────

    /**
     * Plan content level and its basis, by evidence strength: the Proficiency Engine's overall level (exam / SYSTEM
     * dictation / roleplay evidence), else the latest valid placement quiz, else PROVISIONAL A2 for every goal — an
     * ambitious target never raises the starting content, and a provisional level is never shown as the learner's level.
     */
    static String[] level(Context ctx) {
        if (ctx.currentCefr() != null && !"UNDETERMINED".equals(ctx.overallStatus()))
            return new String[]{ctx.currentCefr(), "PROFICIENCY"};
        if (ctx.placementCefr() != null) return new String[]{ctx.placementCefr(), "PLACEMENT"};
        return new String[]{LearningPathEngine.PROVISIONAL_LEVEL, "PROVISIONAL"};
    }

    /**
     * Content level of one skill: the skill's own Proficiency rating when it is determined (VERIFIED, PROVISIONAL or
     * STALE — a past achievement is kept — with confidence ≥ 0.35), so a learner can read at B2 and listen at A2; else
     * the plan level.
     */
    static String[] skillLevel(Context ctx, Skill skill, String[] planLevel) {
        LearningEvidenceReader.SkillLevel s = ctx.skillLevels() == null ? null : ctx.skillLevels().get(skill.name());
        if (s != null && Set.of("VERIFIED", "PROVISIONAL", "STALE").contains(s.status())
                && s.confidence() >= LearningPathEngine.SKILL_LEVEL_CONFIDENCE)
            return new String[]{LearningPathEngine.cefrOfRating(s.rating()), "PROFICIENCY_SKILL"};
        return planLevel;
    }

    /** Echo's plan-change preview validates with the same rules {@link #setGoal} applies at commit (no second rule set). */
    public static boolean acceptsGoal(String goal, Integer dailyMinutes, String target) {
        if (goal == null || !Set.of("GENERAL", "COMMUNICATION", "IELTS", "TOEIC").contains(goal)) return false;
        if (dailyMinutes == null || !MINUTES.contains(dailyMinutes)) return false;
        try { normaliseTarget(goal, target); return true; } catch (LearningPathException e) { return false; }
    }

    static String normaliseTarget(String goal, String target) {
        String t = target == null ? null : target.strip();
        switch (goal) {
            case "GENERAL" -> {
                if(t!=null&&!Set.of("A1","A2","B1","B2","C1").contains(t))throw new LearningPathException(400,"INVALID_TARGET");
                return t; // a destination only; never used to set starting ability or skip evidence
            }
            case "IELTS" -> {
                if (t == null || !IELTS_TARGETS.contains(t)) throw new LearningPathException(400, "INVALID_TARGET");
                return t;
            }
            case "TOEIC" -> {
                if (t == null || !TOEIC_TARGETS.contains(t)) throw new LearningPathException(400, "INVALID_TARGET");
                return t;
            }
            default -> { return null; }
        }
    }

    private static boolean due(LocalDate last, LocalDate day, int everyDays) {
        return last == null || !last.isAfter(day.minusDays(everyDays));
    }

    static DnaSignals signals(LearnerDnaSnapshot p) {
        int phonemes = p.missingPhonemes() == null ? 0 : p.missingPhonemes().size();
        boolean pauses = Boolean.TRUE.equals(p.pausingIssues());
        int grammar = p.topGrammarErrors() == null ? 0 : p.topGrammarErrors().size();
        int traps = p.section3DistractorTraps() == null ? 0 : p.section3DistractorTraps();
        int spelling = p.formCompletionPluralSpellingErrors() == null ? 0 : p.formCompletionPluralSpellingErrors();
        long cards = p.criticalForgettingCount() == null ? 0 : p.criticalForgettingCount();
        return new DnaSignals(phonemes, pauses, grammar, traps, spelling, cards);
    }

    private static final java.util.regex.Pattern SOUND = java.util.regex.Pattern.compile("[/\\p{L}ːˈˌθðʃʒŋæəɪʊɑɔɛɜʌɒɹ-]{1,16}");
    private static final List<String> GRAMMAR = List.of("tense", "run-on", "article", "preposition", "subject-verb", "fragment", "parallel");

    /** Enumerated / validated facts only; no free text from the DNA reaches the client. */
    static DnaFacts facts(LearnerDnaSnapshot p) {
        List<String> sounds = new ArrayList<>();
        if (p.missingPhonemes() != null)
            for (String s : p.missingPhonemes()) if (s != null && SOUND.matcher(s).matches() && sounds.size() < 3) sounds.add(s);
        Set<String> grammar = new LinkedHashSet<>();
        if (p.topGrammarErrors() != null)
            for (String g : p.topGrammarErrors())
                for (String key : GRAMMAR) if (g != null && g.toLowerCase(Locale.ROOT).contains(key)) grammar.add(key.toUpperCase(Locale.ROOT).replace('-', '_'));
        DnaSignals d = signals(p);
        return new DnaFacts(d.vocabularyCritical(), sounds, List.copyOf(grammar),
                d.listeningDistractorMistakes() + d.listeningSpellingMistakes(), d.pausingIssues());
    }

    private static String cefrKey(String cefr) {
        String c = cefr == null ? null : cefr.toUpperCase(Locale.ROOT);
        return c != null && LearningPathEngine.CEFR.contains(c) ? c : null;
    }

    private static boolean isShown(String status) {
        return "OPEN".equals(status) || "DONE".equals(status);
    }

    private LocalDate today() {
        return LocalDate.now(clock.withZone(time.getZoneId()));
    }

    private Instant dayStart(Instant at) {
        ZoneId zone = time.getZoneId();
        return at.atZone(zone).toLocalDate().atStartOfDay(zone).toInstant();
    }

    private static Instant parseInstant(String s, Instant fallback) {
        try {
            return s == null ? fallback : OffsetDateTime.parse(s).toInstant();
        } catch (Exception e) {
            return fallback;
        }
    }

    private String json(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (Exception e) {
            return "{}";
        }
    }
}
