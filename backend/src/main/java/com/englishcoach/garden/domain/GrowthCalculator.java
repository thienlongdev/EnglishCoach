package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.GardenRules.Season;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * Compute-on-read crop growth (GDD 03 §4). Nothing runs in the background: growth is the integral of the speed over
 * authoritative server time, cut into constant-speed segments. Segments end at theme-week boundaries (season factor),
 * at weather-window boundaries (rain, Phase 2) and at the start / end of a Forgotten Pest's effect on this planting
 * (Phase 2). Care items reduce the REQUIRED work retroactively (02 §3), so watering early or late is worth the same and
 * stacking cannot exceed {@code maxBoost}.
 *
 * <p>The past uses the real weather. The readiness ESTIMATE uses the weather only as far as the forecast reveals it
 * and assumes sunshine beyond, so the client's "ready at" never contradicts the forecast (a rain shower can only make
 * a crop ripen earlier than announced). Pest windows only ever start at the moment the pest appears and can only end
 * earlier (a review), so progress is monotonic: a crop that was ready never becomes unready.
 */
public final class GrowthCalculator {

    /** A pest's effect on this planting: speed × {@code factor} from {@code start} (inclusive) to {@code end}. */
    public record Slowdown(Instant start, Instant end, double factor) {}

    public record PlantingFacts(Instant plantedAt, int baseSeconds, double boostFraction, Season cropSeason,
                                List<Slowdown> slowdowns) {
        public PlantingFacts(Instant plantedAt, int baseSeconds, double boostFraction, Season cropSeason) {
            this(plantedAt, baseSeconds, boostFraction, cropSeason, List.of());
        }
    }

    /**
     * {@code readyAt}: when the crop became ready (past) or the estimate assuming today's known timeline (future;
     * null beyond the horizon). {@code speedNow} lets the client project its countdown between refreshes.
     */
    public record Snapshot(double progressSeconds, double requiredSeconds, Instant readyAt, boolean ready, int stage,
                           double fraction, double speedNow) {}

    private final GardenRules rules;
    private final GardenCalendar calendar;
    private final WeatherCalendar weather;

    public GrowthCalculator(GardenRules rules) {
        this.rules = rules;
        this.calendar = new GardenCalendar(rules);
        this.weather = new WeatherCalendar(rules);
    }

    public double requiredSeconds(PlantingFacts p) {
        double boost = Math.min(rules.growth().maxBoost(), Math.max(0, p.boostFraction()));
        return p.baseSeconds() * (1 - boost);
    }

    public double seasonFactor(Season cropSeason, Instant at) {
        if (cropSeason == Season.ALL) return rules.growth().allSeason();
        return calendar.theme(at) == cropSeason ? rules.growth().inSeason() : rules.growth().offSeason();
    }

    /**
     * Growth speed at an instant: max(floor, season × weather × pest). {@code weatherUntil}: weather counts only before
     * this instant (estimates), {@code null} = always (the real past).
     */
    public double speedAt(PlantingFacts p, Instant at, Instant weatherUntil) {
        double w = weatherUntil == null || at.isBefore(weatherUntil) ? weather.growthFactor(at) : 1.0;
        double pest = 1.0;
        for (Slowdown s : p.slowdowns()) {
            if (!at.isBefore(s.start()) && (s.end() == null || at.isBefore(s.end()))) pest *= s.factor();
        }
        return Math.max(rules.growth().speedFloor(), seasonFactor(p.cropSeason(), at) * w * pest);
    }

    public double speedAt(PlantingFacts p, Instant at) {
        return speedAt(p, at, null);
    }

    /** Next instant after {@code t} where the speed may change (week, weather window, pest boundary), capped. */
    private Instant nextBoundary(PlantingFacts p, Instant t, Instant cap) {
        Instant b = min(calendar.themeEndsAt(t), weather.windowEnd(t));
        for (Slowdown s : p.slowdowns()) {
            if (s.start().isAfter(t)) b = min(b, s.start());
            if (s.end() != null && s.end().isAfter(t)) b = min(b, s.end());
        }
        return min(b, cap);
    }

    public Snapshot evaluate(PlantingFacts p, Instant now) {
        double required = requiredSeconds(p);
        // a server clock never runs backwards relative to planted_at; clamp defensively
        Instant end = now.isBefore(p.plantedAt()) ? p.plantedAt() : now;
        double progress = 0;
        Instant readyAt = null;
        Instant t = p.plantedAt();
        while (t.isBefore(end)) {
            Instant segEnd = nextBoundary(p, t, end);
            double speed = speedAt(p, t, null);
            double gain = speed * seconds(t, segEnd);
            if (readyAt == null && progress + gain >= required) readyAt = plusSeconds(t, (required - progress) / speed);
            progress += gain;
            t = segEnd;
        }
        boolean ready = readyAt != null;
        Instant revealed = weather.revealedUntil(end);
        if (!ready) readyAt = estimateReadyAt(p, end, progress, required, revealed);
        double fraction = Math.min(1.0, progress / required);
        return new Snapshot(Math.min(progress, required), required, readyAt, ready, stageOf(fraction, ready), fraction,
                speedAt(p, end, null));
    }

    /** Continue the known timeline from {@code from} until the work is done (bounded horizon, GDD 03 §4). */
    private Instant estimateReadyAt(PlantingFacts p, Instant from, double progress, double required, Instant revealed) {
        Instant horizon = from.plus(Duration.ofDays(rules.growth().estimateHorizonDays()));
        Instant t = from;
        while (t.isBefore(horizon)) {
            Instant segEnd = nextBoundary(p, t, horizon);
            double speed = speedAt(p, t, revealed);
            double gain = speed * seconds(t, segEnd);
            if (progress + gain >= required) return plusSeconds(t, (required - progress) / speed);
            progress += gain;
            t = segEnd;
        }
        return null;
    }

    public int stageOf(double fraction, boolean ready) {
        if (ready) return 4;
        double[] th = rules.growth().stageThresholds();
        if (fraction < th[0]) return 1;
        if (fraction < th[1]) return 2;
        return 3;
    }

    private static double seconds(Instant a, Instant b) {
        return Duration.between(a, b).toNanos() / 1e9;
    }

    private static Instant plusSeconds(Instant t, double s) {
        return t.plusNanos((long) Math.ceil(s * 1e9));
    }

    private static Instant min(Instant a, Instant b) {
        return a.isBefore(b) ? a : b;
    }
}
