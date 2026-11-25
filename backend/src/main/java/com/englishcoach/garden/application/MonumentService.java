package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.api.GardenDtos.BranchView;
import com.englishcoach.garden.api.GardenDtos.MilestoneView;
import com.englishcoach.garden.api.GardenDtos.MilestonesPage;
import com.englishcoach.garden.api.GardenDtos.MilestonesSeen;
import com.englishcoach.garden.api.GardenDtos.MilestonesSeenRequest;
import com.englishcoach.garden.api.GardenDtos.MonumentView;
import com.englishcoach.garden.api.GardenDtos.NextStepView;
import com.englishcoach.garden.api.GardenDtos.RequirementView;
import com.englishcoach.garden.domain.LivingRules.Family;
import com.englishcoach.garden.domain.MonumentEngine;
import com.englishcoach.garden.domain.MonumentEngine.Counters;
import com.englishcoach.garden.domain.MonumentEngine.Requirement;
import com.englishcoach.garden.infra.GardenRepository.Profile;
import com.englishcoach.garden.infra.KnowledgeRepository;
import com.englishcoach.garden.infra.LearningSourceRepository;
import com.englishcoach.garden.infra.MonumentRepository;
import com.englishcoach.garden.infra.MonumentRepository.DayFlags;
import com.englishcoach.garden.infra.MonumentRepository.MilestoneRow;
import com.englishcoach.garden.infra.MonumentRepository.MonumentRow;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;

/**
 * The monumental Knowledge Tree (Phase 3B, blueprint §7.1): the learner's lifetime of VERIFIED learning, folded in on
 * {@code GET /state}.
 *
 * <ul>
 *   <li>{@link #collect} runs OUTSIDE the garden transaction (read only, fault-isolated per source): Vietnam days on
 *   which enough different cards were reviewed (the Flashcard module's own review log, from the last evaluated day) and
 *   the qualifying completions of the enabled skill / game sources (the modules' own records, from a cursor per source —
 *   NOT the reward ingest, which only looks back a few days). Only learning after the garden was created counts.</li>
 *   <li>{@link #reconcile} runs INSIDE the owner's advisory-lock transaction: verified days are stored once per
 *   (player, day) and only ever gain family flags; each graduated tree is examined exactly once and credited when enough
 *   of its words were never credited before; the counters are recounted, the era raised (never lowered) and every newly
 *   reached milestone stored once. Repeating a reconcile with the same facts changes nothing.</li>
 * </ul>
 * Nothing here grants coins, XP or items: the monument is a record, not a faucet.
 */
@Slf4j
@Service
public class MonumentService {

    private static final String CURSOR = "MONUMENT:";
    private static final int PAGE = 200;
    private static final int MAX_PAGES = 4;

    /** Facts gathered before the transaction: flags per verified day, the new cursor per source, the review watermark. */
    public record Collected(Map<LocalDate, boolean[]> days, Map<String, Instant> cursors, LocalDate reviewDaysThrough) {

        public static final Collected NONE = new Collected(Map.of(), Map.of(), null);
    }

    private final GardenContext ctx;
    private final GardenAccessService access;
    private final GardenSetup setup;
    private final MonumentRepository repo;
    private final KnowledgeRepository knowledge;
    private final LearningSourceRepository sources;

    public MonumentService(GardenContext ctx, GardenAccessService access, GardenSetup setup, MonumentRepository repo,
                           KnowledgeRepository knowledge, LearningSourceRepository sources) {
        this.ctx = ctx;
        this.access = access;
        this.setup = setup;
        this.repo = repo;
        this.knowledge = knowledge;
        this.sources = sources;
    }

    // flag indexes of a collected day
    private static final int VOCABULARY = 0, LISTENING = 1, SPEAKING = 2, WRITING = 3, EXAM = 4, PLAY = 5;

    private static int index(Family f) {
        return switch (f) {
            case VOCABULARY -> VOCABULARY;
            case LISTENING -> LISTENING;
            case SPEAKING -> SPEAKING;
            case WRITING -> WRITING;
            case EXAM -> EXAM;
        };
    }

    // ------------------------------------------------------------------ collect (outside the transaction)

    public Collected collect(long userId, Instant now) {
        Profile profile = ctx.repo.profile(userId);
        if (profile == null) return Collected.NONE;
        var e = ctx.engine();
        var rules = ctx.living().rules().monument();
        MonumentRow row = repo.row(userId);
        Map<LocalDate, boolean[]> days = new TreeMap<>();
        Map<String, Instant> cursors = new HashMap<>();
        LocalDate today = e.calendar().dayKey(now);

        // 1. vocabulary: days with enough different cards reviewed, re-read from the last evaluated day
        LocalDate created = e.calendar().dayKey(profile.createdAt());
        LocalDate from = row == null || row.reviewDaysThrough() == null || row.reviewDaysThrough().isBefore(created)
                ? created : row.reviewDaysThrough();
        Instant since = e.calendar().startOfDay(from);
        if (since.isBefore(profile.createdAt())) since = profile.createdAt();
        LocalDate through = from;
        // Phase 5: the review days and the first page of every source are independent — one exchange for all of them
        Instant reviewsSince = since;
        List<Runnable> first = new ArrayList<>();
        first.add(() -> repo.reviewDays(userId, reviewsSince, e.rules().zone(), rules.minCardReviews(), rules.scanDays()));
        java.util.stream.Stream.concat(rules.familySources().values().stream().filter(s -> !"FLASHCARD".equals(s)),
                rules.playSources().stream()).distinct().forEach(code -> first.add(() -> {
            var rule = e.rules().learning().sources().get(code);
            if (rule == null || !rule.enabled()) return;
            Instant cursor = ctx.repo.cursorTime(userId, CURSOR + rule.code());
            if (cursor == null || cursor.isBefore(profile.createdAt())) cursor = profile.createdAt();
            sources.find(rule.code(), userId, cursor, rule.minCount(), PAGE);
        }));
        GardenScope.prefetch(first.toArray(Runnable[]::new));
        try {
            List<LocalDate> found = repo.reviewDays(userId, since, e.rules().zone(), rules.minCardReviews(), rules.scanDays());
            for (LocalDate d : found) days.computeIfAbsent(d, k -> new boolean[6])[VOCABULARY] = true;
            // a full page may hide later days: resume from its last day next time; otherwise everything up to today is read
            through = found.size() >= rules.scanDays() ? found.getLast() : today;
        } catch (RuntimeException ex) {
            log.warn("Echo Garden monument: review days skipped: {}", ex.getClass().getSimpleName());
        }

        // 2. skill families and play sources: the modules' own completion records, from a cursor per source
        Map<String, Integer> flagOf = new HashMap<>();
        rules.familySources().forEach((family, source) -> {
            if (!"FLASHCARD".equals(source)) flagOf.put(source, index(family));
        });
        rules.playSources().forEach(s -> flagOf.putIfAbsent(s, PLAY));
        Instant overlap = now.minus(Duration.ofHours(rules.overlapHours()));
        for (var entry : flagOf.entrySet()) {
            var rule = e.rules().learning().sources().get(entry.getKey());
            if (rule == null || !rule.enabled()) continue;
            Instant cursor = ctx.repo.cursorTime(userId, CURSOR + rule.code());
            if (cursor == null || cursor.isBefore(profile.createdAt())) cursor = profile.createdAt();
            try {
                boolean drained = false;
                for (int page = 0; page < MAX_PAGES && !drained; page++) {
                    var found = sources.find(rule.code(), userId, cursor, rule.minCount(), PAGE);
                    for (var a : found) {
                        if (a.occurredAt() == null || a.occurredAt().isBefore(profile.createdAt()) || a.occurredAt().isAfter(now)) continue;
                        days.computeIfAbsent(e.calendar().dayKey(a.occurredAt()), k -> new boolean[6])[entry.getValue()] = true;
                    }
                    Instant last = found.isEmpty() ? null : found.getLast().occurredAt();
                    if (found.size() < PAGE || last == null) {
                        drained = true;
                    } else {
                        // a page of records sharing one instant must still advance
                        cursor = last.isAfter(cursor) ? last : cursor.plusMillis(1);
                    }
                }
                // caught up: keep re-reading a short overlap so a record written late is never missed
                if (drained && overlap.isAfter(cursor)) cursor = overlap;
                cursors.put(rule.code(), cursor);
            } catch (RuntimeException ex) {
                log.warn("Echo Garden monument: source {} skipped: {}", rule.code(), ex.getClass().getSimpleName());
            }
        }
        return new Collected(days, cursors, through);
    }

    // ------------------------------------------------------------------ reconcile (inside the transaction)

    public void reconcile(long userId, Instant now, Collected c) {
        var engine = ctx.living().monument();
        var rules = ctx.living().rules().monument();
        repo.ensure(userId, now);
        boolean changed = false;
        for (var d : c.days().entrySet()) {
            boolean[] f = d.getValue();
            changed |= repo.recordDay(userId, d.getKey(), new DayFlags(f[VOCABULARY], f[LISTENING], f[SPEAKING], f[WRITING],
                    f[EXAM], f[PLAY]), now);
        }
        c.cursors().forEach((source, at) -> ctx.repo.saveCursor(userId, CURSOR + source, at, 0));

        for (var tree : repo.unexaminedGraduations(userId, rules.creditBatch())) {
            Set<Long> cards = new LinkedHashSet<>();
            knowledge.cards(userId, List.of(tree.id())).forEach(card -> cards.add(card.flashcardId()));
            Set<Long> fresh = new LinkedHashSet<>(cards);
            repo.creditedWords(userId, cards).forEach(fresh::remove);
            boolean credited = engine.credits(fresh.size());
            if (!repo.recordCredit(userId, tree.id(), tree.graduatedAt(), fresh.size(), credited, now)) continue;
            if (credited) fresh.forEach(card -> repo.recordWord(userId, card, tree.id(), now));
            ctx.repo.log(userId, "MONUMENT_GRADUATION", ctx.write(Map.of("treeId", tree.id(), "newWords", fresh.size(),
                    "credited", credited)), now);
            changed = true;
        }

        MonumentRow row = repo.row(userId);
        boolean watermark = c.reviewDaysThrough() != null
                && (row.reviewDaysThrough() == null || c.reviewDaysThrough().isAfter(row.reviewDaysThrough()));
        if (!changed && !watermark) return;
        var counts = repo.counts(userId);
        int graduations = repo.creditedGraduations(userId);
        Counters counters = MonumentEngine.counters(counts.days(), counts.vocabulary(), counts.listening(), counts.speaking(),
                counts.writing(), counts.exam(), graduations);
        int era = Math.max(row.era(), engine.era(counters));
        repo.save(userId, counts, graduations, era, c.reviewDaysThrough(), now);
        if (!changed) return;
        for (var m : engine.milestones(era, counters)) {
            if (repo.recordMilestone(userId, m.kind(), m.code(), m.tier(), now, false)) {
                ctx.repo.log(userId, "MONUMENT_MILESTONE", ctx.write(Map.of("kind", m.kind(), "code", m.code(), "tier", m.tier())), now);
            }
        }
    }

    // ------------------------------------------------------------------ view

    /** The garden's monument row; the state read names it among its first reads (Phase 5). */
    public MonumentRow row(long userId) {
        return repo.row(userId);
    }

    public static Counters counters(MonumentRow row) {
        return row == null ? MonumentEngine.counters(0, 0, 0, 0, 0, 0, 0)
                : MonumentEngine.counters(row.learningDays(), row.vocabularyDays(), row.listeningDays(), row.speakingDays(),
                row.writingDays(), row.examDays(), row.graduations());
    }

    public MonumentView view(long userId, Instant now, int forestCount) {
        var e = ctx.engine();
        var engine = ctx.living().monument();
        var rules = ctx.living().rules().monument();
        LocalDate today = e.calendar().dayKey(now);
        Instant startOfToday = e.calendar().startOfDay(today);
        // Phase 5: what this view reads, in one exchange
        GardenScope.prefetch(() -> repo.row(userId), () -> repo.day(userId, today),
                () -> repo.milestones(userId, null, rules.historyLimit()), () -> repo.unseenMilestones(userId, rules.historyLimit()),
                () -> {
                    Profile p = ctx.repo.profile(userId);
                    repo.cardsReviewedSince(userId, p.createdAt().isAfter(startOfToday) ? p.createdAt() : startOfToday);
                });
        MonumentRow row = repo.row(userId);
        Counters c = counters(row);
        int era = row == null ? 0 : row.era();
        DayFlags flags = repo.day(userId, today);

        List<BranchView> branches = new ArrayList<>();
        for (Family f : Family.values()) {
            String source = rules.familySources().get(f);
            var rule = source == null ? null : e.rules().learning().sources().get(source);
            boolean enabled = "FLASHCARD".equals(source) || (rule != null && rule.enabled());
            int days = c.days(f);
            branches.add(new BranchView(f.name(), enabled, days, engine.branchTier(days), rules.branchTiers().size(),
                    engine.nextBranchAt(days).orElse(null), today(flags, f)));
        }
        NextStepView next = engine.next(era, c).map(n -> new NextStepView(n.era(), requirements(n.requirements()))).orElse(null);
        Profile profile = ctx.repo.profile(userId);
        Instant cardsSince = profile.createdAt().isAfter(startOfToday) ? profile.createdAt() : startOfToday;
        return new MonumentView(era, rules.maxEra(), c.learningDays(), flags.any(), branches, engine.branchTierSum(c),
                c.graduations(), forestCount, engine.memoryTier(c.graduations()), rules.memoryTiers().size(),
                engine.nextMemoryAt(c.graduations()).orElse(null), next, engine.rings(era, c),
                engine.daysToNextRing(era, c).orElse(null), rules.minCardReviews(), repo.cardsReviewedSince(userId, cardsSince),
                rules.minNewWords(), profile.createdAt(), milestoneViews(repo.milestones(userId, null, rules.historyLimit())),
                milestoneViews(repo.unseenMilestones(userId, rules.historyLimit())));
    }

    private static boolean today(DayFlags f, Family family) {
        return switch (family) {
            case VOCABULARY -> f.vocabulary();
            case LISTENING -> f.listening();
            case SPEAKING -> f.speaking();
            case WRITING -> f.writing();
            case EXAM -> f.exam();
        };
    }

    public static List<RequirementView> requirements(List<Requirement> reqs) {
        return reqs.stream().map(r -> new RequirementView(r.code(), r.have(), r.need(), r.met())).toList();
    }

    static List<MilestoneView> milestoneViews(List<MilestoneRow> rows) {
        return rows.stream().map(m -> new MilestoneView(m.id(), m.kind(), m.code(), m.tier(), m.reachedAt(), m.seenAt() != null)).toList();
    }

    // ------------------------------------------------------------------ queries / commands

    public MilestonesPage milestones(long userId, Long before) {
        access.require(userId);
        int limit = 20;
        return ctx.read(userId, now -> {
            setup.ensure(userId, now);
            var rows = repo.milestones(userId, before, limit + 1);
            boolean more = rows.size() > limit;
            var page = more ? rows.subList(0, limit) : rows;
            return new MilestonesPage(milestoneViews(page), more ? page.getLast().id() : null);
        });
    }

    /** "Đã xem": a celebration is shown once; marking only touches the caller's own unseen milestones. */
    public MilestonesSeen seen(long userId, UUID key, MilestonesSeenRequest request) {
        access.require(userId);
        List<Long> ids = request.ids().stream().distinct().sorted().toList();
        return ctx.command(userId, key, "MILESTONES_SEEN", ids, MilestonesSeen.class, setup.ensurer(userId), (now, op) ->
                new MilestonesSeen(repo.markSeen(userId, ids, now)));
    }
}
