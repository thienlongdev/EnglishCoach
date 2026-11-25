package com.englishcoach.ai.echo;

import com.englishcoach.ai.service.EchoPolicy;
import com.englishcoach.ai.service.LearnerDnaAggregatorService;
import com.englishcoach.common.cache.BoundedTtlCache;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.repository.ExamProfileRepository;
import com.englishcoach.flashcard.service.FlashcardService;
import com.englishcoach.grammar.GrammarService;
import com.englishcoach.learningpath.LearningPathService;
import com.englishcoach.progress.service.UnifiedProgressService;
import com.englishcoach.proficiency.api.ProficiencyQueryService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * Memory layer 1: the unified, authoritative learner picture Echo reasons from. Every value is projected from the owning
 * module's own read service for the authenticated learner and labelled by its evidence class:
 * - {@code verifiedProficiency}: the Proficiency Engine (VERIFIED / PROVISIONAL / UNDETERMINED + confidence). The only
 *   source of a current level. Long-term: recent inactivity marks it STALE in that engine, it never resets it here.
 * - {@code goalSetByLearner}: the Learning Path goal / target the learner chose: a target, never a measurement.
 * - {@code rolling7Days}: Learner DNA of the last 7 days (practice signals, not a level).
 * - {@code practiceEstimates}: stored exam-simulation estimates and Learning Path practice bands (estimates, labelled).
 * - {@code grammar}, {@code vocabulary}, {@code consistency}: verified study state (mastery counts, due reviews, recurring
 *   mistake tags, due cards, streak).
 * - {@code learnerStated}: what the learner asked Echo to remember (preferences, a stated goal): untrusted text.
 * - {@code unknown}: what could not be read; the model must say "unknown" rather than infer.
 * Numbers and enumerations only (plus the learner's own stated notes); no ids, e-mail, timestamps of events, answers or
 * other learners. Sub-queries execute in parallel across a bounded 4-thread pool (each inside an isolated read-only tx,
 * holding zero pooled connections during LLM inference) and merge deterministically. Cached 45 s per learner.
 */
@Service
@Slf4j
public class EchoLearnerBrain {
    private static final Set<String> SKILL_STATUS = Set.of("UNSUPPORTED", "STALE", "UNDETERMINED", "VERIFIED", "PROVISIONAL");
    private static final Set<String> CEFR = Set.of("A1", "A2", "B1", "B2", "C1", "C2", "PRE_A1", "preA1");
    private static final String THREAD_MARKER = "echo-brain-";
    private static final String WARM_THREAD_MARKER = "echo-warm-";

    public record Snapshot(String json, String levelCefr, String levelStatus) {}

    private final ObjectMapper mapper;
    private final ObjectProvider<PlatformTransactionManager> transactions;
    private final ObjectProvider<ProficiencyQueryService> proficiency;
    private final ObjectProvider<LearningPathService> learningPath;
    private final ObjectProvider<LearnerDnaAggregatorService> dna;
    private final ObjectProvider<ExamProfileRepository> examProfiles;
    private final ObjectProvider<GrammarService> grammar;
    private final ObjectProvider<FlashcardService> flashcards;
    private final ObjectProvider<UnifiedProgressService> progress;
    private final ObjectProvider<EchoMemoryService> memory;
    private final BoundedTtlCache<String, Snapshot> cache = new BoundedTtlCache<>(4_000, 45_000);
    private final BoundedTtlCache<Long, String> prefCache = new BoundedTtlCache<>(4_000, 45_000);
    private final BoundedTtlCache<Long, Long> warmCooldown = new BoundedTtlCache<>(4_000, 5_000);
    private final ThreadPoolExecutor brainPool;
    private final ThreadPoolExecutor warmPool;

    public EchoLearnerBrain(ObjectMapper mapper, ObjectProvider<PlatformTransactionManager> transactions,
                            ObjectProvider<ProficiencyQueryService> proficiency, ObjectProvider<LearningPathService> learningPath,
                            ObjectProvider<LearnerDnaAggregatorService> dna, ObjectProvider<ExamProfileRepository> examProfiles,
                            ObjectProvider<GrammarService> grammar, ObjectProvider<FlashcardService> flashcards,
                            ObjectProvider<UnifiedProgressService> progress, ObjectProvider<EchoMemoryService> memory) {
        this.mapper = mapper; this.transactions = transactions; this.proficiency = proficiency; this.learningPath = learningPath;
        this.dna = dna; this.examProfiles = examProfiles; this.grammar = grammar; this.flashcards = flashcards;
        this.progress = progress; this.memory = memory;
        AtomicInteger seq = new AtomicInteger();
        this.brainPool = new ThreadPoolExecutor(
                4, 4, 60L, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(256),
                r -> { Thread t = new Thread(r, THREAD_MARKER + seq.incrementAndGet()); t.setDaemon(true); return t; },
                new ThreadPoolExecutor.CallerRunsPolicy());
        this.brainPool.allowCoreThreadTimeOut(true);

        AtomicInteger warmSeq = new AtomicInteger();
        this.warmPool = new ThreadPoolExecutor(
                2, 2, 60L, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(64),
                r -> { Thread t = new Thread(r, WARM_THREAD_MARKER + warmSeq.incrementAndGet()); t.setDaemon(true); return t; },
                new ThreadPoolExecutor.DiscardPolicy());
        this.warmPool.allowCoreThreadTimeOut(true);
    }

    @PreDestroy
    public void shutdown() {
        warmPool.shutdownNow();
        brainPool.shutdownNow();
    }

    /** {@code full}: everything (planning / progress / weakness); otherwise only level, goal and stated preferences. */
    public Snapshot snapshot(long userId, boolean full) {
        return snapshot(userId, full, full);
    }

    public Snapshot snapshot(long userId, boolean full, boolean examFocus) {
        String section = !full ? ":M" : examFocus ? ":F" : ":P";
        return cache.get(userId + section, key -> build(userId, full, full && examFocus));
    }

    /**
     * Zero-LLM, zero-quota background pre-warmer triggered on VAD speech onset or panel wake.
     * Dispatches from dedicated {@code warmPool} (NOT {@code brainPool}) so {@link #build} fans out
     * its sub-queries 4-way in parallel on {@code brainPool}, throttled by a 5 s per-user cooldown.
     */
    public void warm(long userId) {
        if (warmCooldown.getIfPresent(userId) != null) return;
        warmCooldown.put(userId, System.currentTimeMillis());
        if (cache.getIfPresent(userId + ":M") == null) {
            CompletableFuture.runAsync(() -> {
                try { snapshot(userId, false, false); } catch (RuntimeException ignored) { }
            }, warmPool);
        }
        if (cache.getIfPresent(userId + ":P") == null) {
            CompletableFuture.runAsync(() -> {
                try { snapshot(userId, true, false); } catch (RuntimeException ignored) { }
            }, warmPool);
        }
        if (prefCache.getIfPresent(userId) == null) {
            CompletableFuture.runAsync(() -> {
                try { teachingPreferences(userId); } catch (RuntimeException ignored) { }
            }, warmPool);
        }
    }

    public void forget(long userId) {
        cache.invalidate(userId + ":F");
        cache.invalidate(userId + ":M");
        cache.invalidate(userId + ":P");
        prefCache.invalidate(userId);
        warmCooldown.invalidate(userId);
    }

    private <T> T inTransaction(java.util.function.Supplier<T> work) {
        PlatformTransactionManager tm = transactions.getIfAvailable();
        if (tm == null) return work.get();
        TransactionTemplate template = new TransactionTemplate(tm);
        template.setReadOnly(true);
        template.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        template.setTimeout(15);
        return template.execute(status -> work.get());
    }

    Snapshot build(long userId, boolean full) {
        return build(userId, full, full);
    }

    private record SectionOutcome(String name, Consumer<ObjectNode> apply, boolean failed) {}

    private interface SectionWork { Consumer<ObjectNode> compute() throws Exception; }

    private CompletableFuture<SectionOutcome> submitSection(String name, SectionWork work) {
        // Avoid nested pool starvation if build() is already called from inside a brainPool worker (e.g. warm()).
        if (Thread.currentThread().getName().startsWith(THREAD_MARKER)) {
            return CompletableFuture.completedFuture(runSection(name, work));
        }
        return CompletableFuture.supplyAsync(() -> runSection(name, work), brainPool);
    }

    private SectionOutcome runSection(String name, SectionWork work) {
        try {
            Consumer<ObjectNode> mutator = inTransaction(() -> {
                try { return work.compute(); }
                catch (RuntimeException e) { throw e; }
                catch (Exception e) { throw new IllegalStateException(e); }
            });
            return new SectionOutcome(name, mutator == null ? r -> {} : mutator, false);
        } catch (Exception e) {
            if (!(e instanceof IllegalStateException)) {
                log.debug("Echo brain section {} unavailable ({})", name, e.getClass().getSimpleName());
            }
            return new SectionOutcome(name, r -> {}, true);
        }
    }

    private Snapshot build(long userId, boolean full, boolean examFocus) {
        String[] level = {null, "UNDETERMINED"};
        List<CompletableFuture<SectionOutcome>> futures = new ArrayList<>();

        // 1. verified proficiency (the only current level)
        futures.add(submitSection("proficiency", () -> {
            var svc = proficiency.getIfAvailable();
            if (svc == null) throw new IllegalStateException();
            var me = svc.me(userId);
            ObjectNode p = mapper.createObjectNode();
            String foundCefr = null;
            String foundStatus = "UNDETERMINED";
            if (me.overall() != null) {
                ObjectNode o = p.putObject("overall");
                String status = enumValue(me.overall().status(), Set.of("UNDETERMINED", "PROVISIONAL", "VERIFIED"));
                o.put("status", status);
                if (cefr(me.overall().currentCefr()) != null && !"UNDETERMINED".equals(status)) {
                    foundCefr = cefr(me.overall().currentCefr());
                    o.put("currentCefr", foundCefr);
                }
                if (cefr(me.overall().peakCefr()) != null) o.put("peakCefr", cefr(me.overall().peakCefr()));
                o.put("confidence", round2(me.overall().confidence()));
                foundStatus = status;
            }
            ArrayNode skills = p.putArray("skills");
            for (var s : me.skills() == null ? List.<com.englishcoach.proficiency.api.ProficiencyDtos.SkillDto>of() : me.skills()) {
                String status = enumValue(s.status(), SKILL_STATUS);
                ObjectNode n = skills.addObject();
                n.put("skill", enumValue(s.skill(), Set.of("READING", "LISTENING", "SPEAKING", "WRITING", "VOCABULARY", "GRAMMAR")));
                n.put("status", status);
                if (cefr(s.cefr()) != null && ("VERIFIED".equals(status) || "PROVISIONAL".equals(status) || "STALE".equals(status))) n.put("cefr", cefr(s.cefr()));
                n.put("confidence", round2(s.confidence()));
            }
            if (me.placementCta() != null) p.put("placementQuizSuggested", true);
            final String fCefr = foundCefr, fStatus = foundStatus;
            return root -> {
                root.set("verifiedProficiency", p);
                level[0] = fCefr;
                level[1] = fStatus;
            };
        }));

        // 2. goal the learner set (a target, never a measurement)
        futures.add(submitSection("learningPath", () -> {
            var svc = learningPath.getIfAvailable();
            if (svc == null) throw new IllegalStateException();
            Map<String, Object> plan = examFocus ? svc.planSummary(userId) : svc.planSummary(userId, false);
            if (plan.isEmpty()) {
                return root -> root.putObject("goalSetByLearner").put("hasLearningPath", false);
            }
            ObjectNode g = mapper.createObjectNode();
            g.put("hasLearningPath", true);
            if (plan.get("goal") instanceof String goal && Set.of("GENERAL", "COMMUNICATION", "IELTS", "TOEIC").contains(goal)) g.put("goal", goal);
            if (plan.get("target") instanceof String target && target.matches("(?:[0-9.]{1,4}|A1|A2|B1|B2|C1)")) g.put("target", target);
            for (String k : List.of("stage", "dailyMinutes", "todayTasks", "todayDone"))
                if (plan.get(k) instanceof Number n && n.intValue() >= 0 && n.intValue() <= 120) g.put(k, n.intValue());
            JsonNode withPlan = full ? mapper.readTree(EchoPolicy.withPlan("{}", plan, mapper)).path("learningPath") : null;
            if (withPlan != null && withPlan.has("todayRemainingSkills")) {
                g.set("todayRemainingSkills", withPlan.get("todayRemainingSkills"));
            }
            return root -> {
                root.set("goalSetByLearner", g);
                if (withPlan != null) {
                    ObjectNode est = obj(root, "practiceEstimates");
                    if (withPlan.has("eligibleSimulationEstimates")) est.set("learningPathSimulationEstimates", withPlan.get("eligibleSimulationEstimates"));
                    if (withPlan.has("rawPracticeFocus")) est.set("examPracticeFocus", withPlan.get("rawPracticeFocus"));
                    if (withPlan.has("latestSimulationStatus")) est.put("latestSimulationStatus", withPlan.get("latestSimulationStatus").asText());
                }
            };
        }));

        if (full) {
            // 3. rolling 7-day Learner DNA (practice signals only)
            futures.add(submitSection("rolling7Days", () -> {
                var svc = dna.getIfAvailable();
                if (svc == null) throw new IllegalStateException();
                JsonNode ctx = mapper.readTree(EchoPolicy.context(svc.getLearnerDnaJson(userId), EchoPolicy.Intent.PROGRESS_REVIEW, mapper));
                ObjectNode r = mapper.createObjectNode();
                ctx.fields().forEachRemaining(e -> r.set(e.getKey(), e.getValue()));
                return root -> root.set("rolling7Days", r);
            }));

            // 4. stored exam-simulation estimates per family
            futures.add(submitSection("examEstimates", () -> {
                var repo = examProfiles.getIfAvailable();
                if (repo == null) throw new IllegalStateException();
                ObjectNode sim = mapper.createObjectNode();
                for (ExamFamily family : ExamFamily.values()) {
                    ObjectNode f = mapper.createObjectNode();
                    for (var row : repo.latestByMetric(userId, family))
                        if (Set.of("READING", "LISTENING", "WRITING", "SPEAKING", "FULL_OVERALL", "LR_TOTAL").contains(row.metric()) && Double.isFinite(row.scoreValue()))
                            f.put(row.metric(), row.scoreValue());
                    if (!f.isEmpty()) sim.set(family.name(), f);
                }
                return root -> obj(root, "practiceEstimates").set("examSimulation", sim);
            }));

            futures.add(submitSection("learningPathBands", () -> {
                var svc = learningPath.getIfAvailable();
                if (svc == null) throw new IllegalStateException();
                ArrayNode bands = mapper.createArrayNode();
                for (var s : svc.summary(userId).skills()) {
                    ObjectNode b = bands.addObject();
                    b.put("skill", s.skill());
                    b.put("band", s.band() == null ? "UNKNOWN" : s.band());
                    b.put("observations", s.observations());
                }
                return root -> obj(root, "practiceEstimates").set("learningPathPracticeBands", bands);
            }));

            // 5. grammar mastery and recurring mistake tags (server-scored practice)
            futures.add(submitSection("grammar", () -> {
                var svc = grammar.getIfAvailable();
                if (svc == null) throw new IllegalStateException();
                var me = svc.me(userId);
                ObjectNode g = mapper.createObjectNode();
                g.put("topicsStudied", me.counts().studied());
                g.put("topicsPractising", me.counts().practising());
                g.put("topicsMastered", me.counts().mastered());
                g.put("reviewsDue", me.counts().due());
                g.put("attemptsLast30Days", me.counts().attempts30d());
                ArrayNode tags = g.putArray("recurringMistakes");
                svc.mistakes(userId).groups().stream().filter(m -> m.recent30d() > 0)
                        .sorted(Comparator.comparingInt(com.englishcoach.grammar.GrammarDtos.MistakeGroup::recent30d).reversed()).limit(4)
                        .forEach(m -> {
                            ObjectNode t = tags.addObject();
                            t.put("tag", token(m.tag()));
                            if (m.topic() != null) t.put("topicSlug", token(m.topic()));
                            t.put("wrongLast30Days", m.recent30d());
                        });
                return root -> root.set("grammar", g);
            }));

            futures.add(submitSection("vocabulary", () -> {
                var svc = flashcards.getIfAvailable();
                if (svc == null) throw new IllegalStateException();
                ObjectNode v = mapper.createObjectNode();
                v.put("reviewDueNow", svc.countReviewDue(userId));
                v.put("dueIncludingNew", svc.countActualDue(userId));
                return root -> root.set("vocabulary", v);
            }));

            futures.add(submitSection("consistency", () -> {
                var svc = progress.getIfAvailable();
                if (svc == null) throw new IllegalStateException();
                var streak = svc.getStreak(userId);
                ObjectNode c = mapper.createObjectNode();
                c.put("currentStreakDays", streak.currentStreakDays());
                c.put("longestStreakDays", streak.longestStreakDays());
                c.put("studiedToday", streak.activeToday());
                return root -> root.set("consistency", c);
            }));
        }

        // 6. learner-stated notes (untrusted; preferences adapt style, a stated goal is not a level)
        futures.add(submitSection("learnerStated", () -> {
            var svc = memory.getIfAvailable();
            if (svc == null) throw new IllegalStateException();
            var items = svc.list(userId);
            if (items.isEmpty()) return root -> {};
            ArrayNode notes = mapper.createArrayNode();
            for (var item : items) notes.addObject().put("kind", item.kind()).put("text", item.value());
            return root -> root.set("learnerStated", notes);
        }));

        ObjectNode root = mapper.createObjectNode();
        List<String> unknown = new ArrayList<>();
        for (CompletableFuture<SectionOutcome> f : futures) {
            try {
                SectionOutcome out = f.get(16, TimeUnit.SECONDS);
                if (out.failed()) unknown.add(out.name());
                else out.apply().accept(root);
            } catch (Exception e) {
                f.cancel(true);
                unknown.add("timeout");
            }
        }

        if (!unknown.isEmpty()) {
            ArrayNode u = root.putArray("unknown");
            unknown.forEach(u::add);
        }
        return new Snapshot(root.toString(), level[0], level[1]);
    }

    /** Requested example levels already specify the teaching level. Retain the learner's stated preferences (cached 45 s). */
    public String teachingPreferences(long userId) {
        return prefCache.get(userId, uid -> {
            ObjectNode root = mapper.createObjectNode();
            SectionOutcome out = runSection("learnerStated", () -> {
                var svc = memory.getIfAvailable();
                if (svc == null) throw new IllegalStateException();
                var items = svc.list(uid);
                if (items.isEmpty()) return r -> {};
                ArrayNode notes = mapper.createArrayNode();
                for (var item : items) notes.addObject().put("kind", item.kind()).put("text", item.value());
                return r -> r.set("learnerStated", notes);
            });
            if (out.failed()) root.putArray("unknown").add("learnerStated");
            else out.apply().accept(root);
            return root.toString();
        });
    }

    private static String cefr(String value) {
        if (value == null) return null;
        String v = value.trim();
        return CEFR.contains(v) ? v : null;
    }

    private static String enumValue(String value, Set<String> allowed) {
        return value != null && allowed.contains(value) ? value : "UNKNOWN";
    }

    /** Only identifier-like tokens (tags, slugs) cross into the context: no learner answers or free text. */
    private static String token(String value) {
        if (value == null) return "unknown";
        String v = value.trim();
        return v.matches("[A-Za-z0-9_.:-]{1,64}") ? v : "unknown";
    }

    private static ObjectNode obj(ObjectNode parent, String name) {
        JsonNode existing = parent.get(name);
        return existing instanceof ObjectNode o ? o : parent.putObject(name);
    }

    private static double round2(double v) { return Double.isFinite(v) ? Math.round(v * 100) / 100d : 0; }
}
