package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.GardenRules.Season;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * The global weather timeline (Phase 2). Time from {@code weather.startAt} is cut into fixed windows of
 * {@code windowHours}; window {@code i} is decided once and forever by a hash of {@code i} and the chances of the
 * season (theme week) the window starts in, so every player sees the same weather at the same moment and a window
 * never changes after the fact. No job advances it.
 * <ul>
 *   <li>RAIN: {@code unit("weather:rain:i") < chance.rain} (winter renders it as snow; the rule is the same).</li>
 *   <li>RAINBOW: no rain in {@code i}, rain in {@code i − 1} and {@code unit("weather:rainbow:i") < chance.rainbow}.</li>
 *   <li>SUNNY otherwise, and before {@code startAt}.</li>
 * </ul>
 * The forecast reveals the current window and {@code forecastWindows} more; a rainbow is never revealed before it
 * begins (forecasts show it as "after rain").
 */
public final class WeatherCalendar {

    public enum Weather { SUNNY, RAIN, RAINBOW }

    public record Window(long index, Instant start, Instant end, Weather weather, Season season) {}

    private final GardenRules rules;
    private final GardenCalendar calendar;
    private final long windowSeconds;

    public WeatherCalendar(GardenRules rules) {
        this.rules = rules;
        this.calendar = new GardenCalendar(rules);
        this.windowSeconds = rules.weather().windowHours() * 3600L;
    }

    public long index(Instant at) {
        return Math.floorDiv(Duration.between(rules.weather().startAt(), at).getSeconds(), windowSeconds);
    }

    public Instant windowStart(long index) {
        return rules.weather().startAt().plusSeconds(index * windowSeconds);
    }

    public Instant windowEnd(Instant at) {
        return windowStart(index(at) + 1);
    }

    private boolean rains(long i) {
        if (i < 0) return false;
        double[] chance = rules.weather().chances().get(calendar.theme(windowStart(i)));
        return chance != null && DeterministicRandom.unit("weather:rain:" + i) < chance[0];
    }

    public Weather weather(long i) {
        if (i < 0) return Weather.SUNNY;
        if (rains(i)) return Weather.RAIN;
        double[] chance = rules.weather().chances().get(calendar.theme(windowStart(i)));
        if (chance != null && rains(i - 1) && DeterministicRandom.unit("weather:rainbow:" + i) < chance[1]) {
            return Weather.RAINBOW;
        }
        return Weather.SUNNY;
    }

    public Weather at(Instant t) {
        return weather(index(t));
    }

    public Window window(long i) {
        Instant start = windowStart(i);
        return new Window(i, start, windowStart(i + 1), weather(i), calendar.theme(start));
    }

    /** Growth multiplier of the weather at {@code t} (rain speeds every crop; sun and rainbow are neutral). */
    public double growthFactor(Instant t) {
        return at(t) == Weather.RAIN ? rules.weather().rainSpeed() : 1.0;
    }

    /** End of what the forecast reveals at {@code now}: the end of window {@code index(now) + forecastWindows}. */
    public Instant revealedUntil(Instant now) {
        return windowStart(index(now) + 1 + rules.weather().forecastWindows());
    }

    /** Current window + the revealed windows; a future RAINBOW is reported as SUNNY (it is never forecast). */
    public List<Window> forecast(Instant now) {
        return forecast(now, 0);
    }

    /**
     * Phase 3C: the cottage's almanac reveals {@code extraWindows} more windows (information only; growth estimates
     * keep using {@link #revealedUntil}, so an estimate still never contradicts what any player was told).
     */
    public List<Window> forecast(Instant now, int extraWindows) {
        long i0 = index(now);
        List<Window> out = new ArrayList<>();
        for (long i = i0; i <= i0 + rules.weather().forecastWindows() + Math.max(0, extraWindows); i++) {
            Window w = window(i);
            if (i > i0 && w.weather() == Weather.RAINBOW) {
                w = new Window(w.index(), w.start(), w.end(), Weather.SUNNY, w.season());
            }
            out.add(w);
        }
        return out;
    }
}
