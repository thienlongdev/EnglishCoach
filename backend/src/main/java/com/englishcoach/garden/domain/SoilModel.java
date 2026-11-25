package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.FarmingRules.Effect;
import com.englishcoach.garden.domain.FarmingRules.Soil;
import com.englishcoach.garden.domain.GrowthCalculator.Slowdown;
import com.englishcoach.garden.domain.WeatherCalendar.Weather;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Soil moisture of one growing crop (Phase 3D), compute-on-read like growth itself: a pure function of the planting
 * instant, the global weather timeline, the theme week, the crop's thirst and the care events recorded for the planting
 * (waterings and supplies with their instants). Nothing runs in the background and nothing is stored.
 *
 * <p>Moisture moves linearly inside a segment of constant conditions; segments end at weather windows, theme weeks, care
 * events, the end of a supply and at the exact instant moisture crosses the dry or the waterlogged line. A thirsty or
 * waterlogged segment slows growth through an ordinary {@link Slowdown}, for at most {@code maxStressHours} per planting
 * in total — so the loss of one crop is bounded whatever the weather does while the player is away.
 *
 * <p>Monotonic by construction: the past depends only on past weather and on events that already happened; a new event
 * is recorded at "now" and only changes the future. A crop that was ripe therefore never becomes unripe.
 */
public final class SoilModel {

    public enum Status { OK, DRY, WET }

    /**
     * A care event of a planting: a watering or a supply. {@code expiresAt}: when a timed effect ends ({@code null} for an
     * instant effect or one that lasts until harvest); {@code value}: the effect's number (moisture gained, factor…).
     */
    public record Event(Instant at, Effect effect, Instant expiresAt, double value) {

        boolean activeAt(Instant t) {
            return !t.isBefore(at) && (expiresAt == null || t.isBefore(expiresAt));
        }
    }

    /** One stretch of constant conditions: moisture from {@code m0} to {@code m1} and the soil status during it. */
    public record Segment(Instant start, Instant end, double m0, double m1, Status status) {

        double moistureAt(Instant t) {
            double span = seconds(start, end);
            if (span <= 0) return m1;
            double f = Math.max(0, Math.min(1, seconds(start, t) / span));
            return m0 + (m1 - m0) * f;
        }
    }

    /**
     * The soil of a planting at one instant. {@code stressSeconds} / {@code growSeconds}: time spent thirsty or
     * waterlogged out of the time since planting; {@code nextChangeAt} / {@code nextStatus}: the next expected change of
     * status ({@code null} when none is in sight).
     */
    public record Condition(double moisture, Status status, double stressSeconds, double growSeconds, Instant nextChangeAt,
                            Status nextStatus) {

        public double stressShare() {
            return growSeconds <= 0 ? 0 : Math.max(0, Math.min(1, stressSeconds / growSeconds));
        }
    }

    /** The whole timeline of a planting: its segments and the growth slowdowns they cause. */
    public record Timeline(Instant plantedAt, List<Segment> segments, List<Slowdown> slowdowns) {

        /** The soil at {@code at} (clamped into the timeline). */
        public Condition at(Instant at) {
            if (segments.isEmpty()) return new Condition(0, Status.OK, 0, 0, null, null);
            Instant t = at.isBefore(plantedAt) ? plantedAt : at;
            double stress = 0;
            Segment hit = null;
            int index = -1;
            for (int i = 0; i < segments.size(); i++) {
                Segment s = segments.get(i);
                if (!t.isBefore(s.end()) && i < segments.size() - 1) {
                    if (s.status() != Status.OK) stress += seconds(s.start(), s.end());
                    continue;
                }
                hit = s;
                index = i;
                break;
            }
            Instant inside = t.isAfter(hit.end()) ? hit.end() : t;
            if (hit.status() != Status.OK) stress += seconds(hit.start(), inside);
            Instant nextAt = null;
            Status next = null;
            for (int i = index + 1; i < segments.size(); i++) {
                if (segments.get(i).status() != hit.status()) {
                    nextAt = segments.get(i).start();
                    next = segments.get(i).status();
                    break;
                }
            }
            return new Condition(hit.moistureAt(inside), hit.status(), stress, seconds(plantedAt, inside), nextAt, next);
        }
    }

    private final GardenRules rules;
    private final Soil soil;
    private final GardenCalendar calendar;
    private final WeatherCalendar weather;

    public SoilModel(GardenRules rules, FarmingRules farming) {
        this.rules = rules;
        this.soil = farming.soil();
        this.calendar = new GardenCalendar(rules);
        this.weather = new WeatherCalendar(rules);
    }

    /**
     * The soil timeline of a planting from {@code plantedAt} to {@code until}. Weather counts only before
     * {@code weatherUntil} (what the forecast reveals; sunshine is assumed beyond), {@code null} = always.
     */
    public Timeline timeline(Instant plantedAt, double thirst, List<Event> events, Instant until, Instant weatherUntil) {
        List<Event> sorted = events.stream().sorted(Comparator.comparing(Event::at)).toList();
        List<Segment> segments = new ArrayList<>();
        List<Slowdown> slowdowns = new ArrayList<>();
        double maxStress = soil.maxStressHours() * 3600;
        double slowed = 0;
        double m = soil.start();
        Instant t = plantedAt;
        int applied = 0;
        while (t.isBefore(until)) {
            // instant effects that happen exactly now
            while (applied < sorted.size() && !sorted.get(applied).at().isAfter(t)) {
                Event e = sorted.get(applied++);
                // watering never floods a bed: what the soil cannot hold runs off at the waterlogging line
                if (e.effect() == Effect.MOISTURE) m = m >= soil.wetAbove() ? m : Math.min(soil.wetAbove(), m + e.value());
                else if (e.effect() == Effect.DRAINAGE) m = Math.min(m, e.value());
            }
            boolean cover = false, shade = false, mulch = false, drain = false, tonic = false;
            double shadeFactor = 1, mulchFactor = 1;
            for (Event e : sorted) {
                if (!e.activeAt(t)) continue;
                switch (e.effect()) {
                    case RAIN_COVER -> cover = true;
                    case SHADE -> {
                        shade = true;
                        shadeFactor = Math.min(shadeFactor, e.value());
                    }
                    case MULCH -> {
                        mulch = true;
                        mulchFactor = Math.min(mulchFactor, e.value());
                    }
                    case DRAINAGE -> drain = true;
                    case TONIC -> tonic = true;
                    default -> { }
                }
            }
            Weather w = weatherUntil == null || t.isBefore(weatherUntil) ? weather.at(t) : Weather.SUNNY;
            double perHour;
            if (w == Weather.RAIN) {
                perHour = cover ? 0 : soil.rainPerHour() * (mulch ? mulchFactor : 1);
            } else {
                perHour = -soil.evapPerHour() * thirst * soil.seasonEvap().getOrDefault(calendar.theme(t), 1.0)
                        * (w == Weather.RAINBOW ? soil.rainbowEvap() : 1) * (shade ? shadeFactor : 1) * (mulch ? mulchFactor : 1);
            }
            double ceiling = drain ? soil.wetAbove() : 100;
            m = Math.min(m, ceiling);
            double rate = perHour / 3600;

            Instant end = min(min(weather.windowEnd(t), calendar.themeEndsAt(t)), until);
            for (Event e : sorted) {
                if (e.at().isAfter(t)) end = min(end, e.at());
                if (e.expiresAt() != null && e.expiresAt().isAfter(t)) end = min(end, e.expiresAt());
            }
            double span = seconds(t, end);
            if (rate != 0) {
                for (double line : new double[]{soil.dryBelow(), soil.wetAbove()}) {
                    double x = (line - m) / rate;
                    if (x > 1e-6 && x < span) {
                        end = t.plusNanos(Math.max(1_000_000_000L, (long) Math.ceil(x * 1e9)));
                        span = seconds(t, end);
                    }
                }
            }
            double m1 = clamp(m + rate * span, ceiling);
            double mid = clamp(m + rate * span / 2, ceiling);
            Status status = mid < soil.dryBelow() - 1e-9 ? Status.DRY : mid > soil.wetAbove() + 1e-9 ? Status.WET : Status.OK;
            segments.add(new Segment(t, end, m, m1, status));
            if (status != Status.OK && !tonic && slowed < maxStress) {
                double take = Math.min(span, maxStress - slowed);
                Instant slowEnd = take >= span ? end : t.plusNanos((long) (take * 1e9));
                if (slowEnd.isAfter(t)) {
                    slowdowns.add(new Slowdown(t, slowEnd, status == Status.DRY ? soil.dryFactor() : soil.wetFactor()));
                    slowed += take;
                }
            }
            // under a rain cover the rain does not reach the crop: its growth bonus is cancelled as well
            if (cover && w == Weather.RAIN && rules.weather().rainSpeed() > 0) {
                slowdowns.add(new Slowdown(t, end, 1.0 / rules.weather().rainSpeed()));
            }
            m = m1;
            t = end;
        }
        return new Timeline(plantedAt, List.copyOf(segments), List.copyOf(slowdowns));
    }

    /** Factor of the harvest care points for a share of the growing time spent stressed. */
    public double careFactor(double stressShare) {
        for (double[] row : soil.careShare()) {
            if (stressShare <= row[0] + 1e-9) return Math.max(0, Math.min(1, row[1]));
        }
        return 0;
    }

    /** The largest growth work (seconds at base speed) stressed soil can ever cost one crop. */
    public double maxGrowthLossSeconds() {
        return soil.maxStressHours() * 3600 * (1 - Math.min(soil.dryFactor(), soil.wetFactor()));
    }

    private static double clamp(double m, double ceiling) {
        return Math.max(0, Math.min(ceiling, m));
    }

    private static double seconds(Instant a, Instant b) {
        return Duration.between(a, b).toNanos() / 1e9;
    }

    private static Instant min(Instant a, Instant b) {
        return a.isBefore(b) ? a : b;
    }
}
