package com.englishcoach.garden.application;

import com.englishcoach.garden.infra.GardenScope;
import com.englishcoach.garden.domain.RewardEngine.DayStats;
import com.englishcoach.garden.infra.GardenRepository.Daily;
import com.englishcoach.garden.infra.GardenRepository.Profile;
import com.englishcoach.garden.infra.GardenRepository.Review;
import com.englishcoach.garden.infra.LearningSourceRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Pull-style ingest of real learning (GDD 03 §7.1), Phase 1 source: {@code FLASHCARD_REVIEWED} rows of
 * {@code learning_activity_events} (read-only; the Flashcard module is never modified). Only events that occurred
 * after the garden was created count. A cursor {@code (occurred_at, id)} bounds every read; the unique
 * {@code (source, source_ref)} insert guarantees a review is rewarded at most once even if the cursor were reset.
 * Garden actions themselves never create learning events.
 *
 * <p>Phase 2 adds skill lessons and vocabulary games from the modules' own completion records
 * ({@link LearningSourceRepository}). They are COLLECTED outside the garden transaction (read only, one bounded query
 * per enabled source, each fault-isolated so a missing / failing module never breaks the garden) and CREDITED inside
 * it: the unique {@code (source, source_ref)} insert makes every activity count once, daily caps per category come from
 * {@code garden_daily_stats}, rewards go through the ledger. After all sources, the mixed daily goal is evaluated.
 */
@Slf4j
@Service
public class LearningIngestService {

    public static final String SOURCE = "FLASHCARD_REVIEW";
    private static final int BATCH = 500;
    private static final int MAX_BATCHES = 4;

    public record Result(int ingested, int water, long xp) {}

    /** A verified activity of a learning module, collected before the garden transaction. */
    public record Activity(String source, String category, String ref, Instant occurredAt) {}

    private final GardenContext ctx;
    private final LedgerService ledger;
    private final LearningSourceRepository sources;

    public LearningIngestService(GardenContext ctx, LedgerService ledger, LearningSourceRepository sources) {
        this.ctx = ctx;
        this.ledger = ledger;
        this.sources = sources;
    }

    /**
     * Reads the enabled sources for activities after the garden was created (and inside the look-back window). Runs
     * OUTSIDE any garden transaction; a source that fails (module unavailable, schema drift) is skipped and logged.
     */
    public List<Activity> collect(long userId, Instant now) {
        Profile profile = ctx.repo.profile(userId);
        if (profile == null) return List.of();
        var learning = ctx.engine().rules().learning();
        Instant lookback = now.minus(Duration.ofDays(learning.lookbackDays()));
        Instant since = profile.createdAt().isAfter(lookback) ? profile.createdAt() : lookback;
        List<Activity> out = new ArrayList<>();
        // Phase 5: the sources are independent of each other — one exchange for all of them
        GardenScope.prefetch(learning.sources().values().stream().filter(s -> s.enabled())
                .map(s -> (Runnable) () -> sources.find(s.code(), userId, since, s.minCount(), learning.batchLimit()))
                .toArray(Runnable[]::new));
        for (var s : learning.sources().values()) {
            if (!s.enabled()) continue;
            try {
                for (var a : sources.find(s.code(), userId, since, s.minCount(), learning.batchLimit())) {
                    if (a.occurredAt() != null) out.add(new Activity(s.code(), s.category(), a.ref(), a.occurredAt()));
                }
            } catch (RuntimeException ex) {
                log.warn("Echo Garden learning source {} skipped: {}", s.code(), ex.getClass().getSimpleName());
            }
        }
        out.sort(Comparator.comparing(Activity::occurredAt).thenComparing(Activity::ref));
        return out;
    }

    public Result ingest(long userId, Profile profile, Instant now) {
        return ingest(userId, profile, now, List.of());
    }

    public Result ingest(long userId, Profile profile, Instant now, List<Activity> activities) {
        Result flash = ingestFlashcards(userId, profile, now);
        Set<LocalDate> touched = creditActivities(userId, profile, activities, now);
        int goals = evaluateMixedGoal(userId, now, touched);
        return new Result(flash.ingested() + touched.size(), flash.water(), flash.xp() + goals);
    }

    private Result ingestFlashcards(long userId, Profile profile, Instant now) {
        var repo = ctx.repo;
        var e = ctx.engine();
        Instant cursorTime = repo.cursorTime(userId, SOURCE);
        long cursorId = repo.cursorId(userId, SOURCE);
        if (cursorTime == null) {
            cursorTime = profile.createdAt();
            cursorId = 0;
        }
        Instant startTime = cursorTime;
        long startId = cursorId;
        Map<LocalDate, Daily> days = new LinkedHashMap<>();
        Map<LocalDate, int[]> grants = new LinkedHashMap<>(); // day -> {water, xp, goalXp}
        int ingested = 0;

        for (int b = 0; b < MAX_BATCHES; b++) {
            Review[] rows = repo.reviewsAfter(userId, cursorTime, cursorId, profile.createdAt(), BATCH);
            for (Review r : rows) {
                cursorTime = r.occurredAt();
                cursorId = r.id();
                String card = cardRef(r.sourceRef());
                LocalDate day = e.calendar().dayKey(r.occurredAt());
                boolean first = card == null || !repo.subjectSeenOnDay(userId, SOURCE, day, card);
                double units = e.rewards().unitsForReview(first);
                Long id = repo.insertLearningEvent(userId, SOURCE, "lae:" + r.id(), card, r.occurredAt(), day, units,
                        ctx.write(Map.of("sourceRef", r.sourceRef(), "firstOfDay", first)), now);
                if (id == null) continue;
                ingested++;
                Daily d = days.computeIfAbsent(day, k -> repo.daily(userId, k));
                var delta = e.rewards().applyReview(new DayStats(d.rawUnits(), d.effectiveUnits(), d.waterCarry(), d.reviews()), first);
                var a = delta.after();
                Instant goalAt = d.goalDoneAt();
                int[] g = grants.computeIfAbsent(day, k -> new int[3]);
                g[0] += delta.water();
                g[1] += delta.xp();
                if (goalAt == null && a.effectiveUnits() + 1e-9 >= e.rules().rewards().goalUnits()) {
                    goalAt = r.occurredAt(); // the blessing starts when the learning actually reached the goal
                    g[2] += e.rules().rewards().goalXp();
                }
                days.put(day, new Daily(day, a.rawUnits(), a.effectiveUnits(), a.waterCarry(), a.reviews(), goalAt));
            }
            if (rows.length < BATCH) break;
        }

        // GDD default goal, second variant: the due queue emptied after the minimum number of reviews (evaluated now)
        LocalDate today = e.calendar().dayKey(now);
        Daily t = days.containsKey(today) ? days.get(today) : repo.daily(userId, today);
        if (t.goalDoneAt() == null && t.reviews() >= e.rules().rewards().goalDueMinReviews() && repo.dueCount(userId) == 0) {
            days.put(today, new Daily(today, t.rawUnits(), t.effectiveUnits(), t.waterCarry(), t.reviews(), now));
            grants.computeIfAbsent(today, k -> new int[3])[2] += e.rules().rewards().goalXp();
        }

        if (cursorId != startId || !cursorTime.equals(startTime)) repo.saveCursor(userId, SOURCE, cursorTime, cursorId);
        int water = 0;
        long xp = 0;
        for (var entry : days.entrySet()) repo.saveDaily(userId, entry.getValue());
        for (var entry : grants.entrySet()) {
            String ref = entry.getKey().toString();
            int[] g = entry.getValue();
            ledger.addItem(userId, "WATER", "NA", g[0], "LEARNING", "LEARNING_DAY", ref, null, now);
            ledger.addXp(userId, g[1], "LEARNING", "LEARNING_DAY", ref, null, now);
            if (g[2] > 0) {
                ledger.addXp(userId, g[2], "GOAL", "LEARNING_DAY", ref, null, now);
                repo.log(userId, "BLESSING", ctx.write(Map.of("day", ref)), now);
            }
            water += g[0];
            xp += g[1] + g[2];
        }
        return new Result(ingested, water, xp);
    }

    /**
     * Credits newly found activities once each: inside the daily cap of its category the activity grants XP (+ a
     * fertilizer for the first lessons of the day); beyond the cap it is still recorded (so it is never re-evaluated)
     * with 0 units.
     */
    private Set<LocalDate> creditActivities(long userId, Profile profile, List<Activity> activities, Instant now) {
        Set<LocalDate> touched = new LinkedHashSet<>();
        if (activities.isEmpty()) return touched;
        var e = ctx.engine();
        var repo = ctx.repo;
        for (Activity a : activities) {
            if (a.occurredAt().isBefore(profile.createdAt())) continue;
            LocalDate day = e.calendar().dayKey(a.occurredAt());
            Daily d = repo.daily(userId, day);
            boolean skill = "SKILL".equals(a.category());
            int before = skill ? d.skillCount() : d.gameCount();
            var credit = e.rewards().creditActivity(a.category(), before);
            Long id = repo.insertLearningEvent(userId, a.source(), a.ref(), null, a.occurredAt(), day,
                    credit.credited() ? 1 : 0, ctx.write(Map.of("category", a.category(), "credited", credit.credited())), now);
            if (id == null || !credit.credited()) continue;
            touched.add(day);
            repo.addDailyCounters(userId, day, skill ? 1 : 0, skill ? 0 : 1, 0, 0);
            String reason = skill ? "SKILL" : "GAME";
            ledger.addXp(userId, credit.xp(), reason, a.source(), a.ref(), null, now);
            ledger.addItem(userId, "FERTILIZER", "NA", credit.fertilizer(), reason, a.source(), a.ref(), null, now);
            repo.log(userId, "LESSON", ctx.write(Map.of("source", a.source(), "xp", credit.xp(), "fertilizer", credit.fertilizer())), now);
        }
        return touched;
    }

    /** Mixed goal (Phase 2): enough card units plus a credited skill lesson the same day; evaluated after ingest. */
    private int evaluateMixedGoal(long userId, Instant now, Set<LocalDate> touched) {
        var e = ctx.engine();
        LocalDate today = e.calendar().dayKey(now);
        Set<LocalDate> days = new LinkedHashSet<>(touched);
        days.add(today);
        int xp = 0;
        for (LocalDate day : days) {
            Daily d = ctx.repo.daily(userId, day);
            if (d.goalDoneAt() != null || !e.rewards().mixedGoal(d.effectiveUnits(), d.skillCount())) continue;
            // the blessing starts now for today; a past day is closed at the end of that day
            Instant at = day.equals(today) ? now : e.calendar().startOfDay(day.plusDays(1)).minusSeconds(1);
            if (!ctx.repo.markGoal(userId, day, at)) continue;
            int goalXp = e.rules().rewards().goalXp();
            ledger.addXp(userId, goalXp, "GOAL", "LEARNING_DAY", day.toString(), null, now);
            ctx.repo.log(userId, "BLESSING", ctx.write(Map.of("day", day.toString(), "variant", "MIXED")), now);
            xp += goalXp;
        }
        return xp;
    }

    /** Blessing (Phúc Lành Echo): today's goal was reached at or before {@code now}. */
    public boolean blessing(long userId, Instant now) {
        LocalDate today = ctx.engine().calendar().dayKey(now);
        Instant done = ctx.repo.daily(userId, today).goalDoneAt();
        return done != null && !done.isAfter(now);
    }

    /** {@code "<cardId>:<reviewCount>"} (FlashcardService#reviewFlashcard) → card id; null when unparseable. */
    static String cardRef(String sourceRef) {
        if (sourceRef == null) return null;
        int i = sourceRef.indexOf(':');
        String id = i > 0 ? sourceRef.substring(0, i) : sourceRef;
        return id.matches("\\d{1,19}") ? id : null;
    }
}
