package com.englishcoach.garden.domain;

import com.englishcoach.garden.domain.GardenRules.Season;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZonedDateTime;
import java.time.temporal.ChronoUnit;
import java.time.temporal.TemporalAdjusters;

/**
 * Day keys and theme weeks in {@code Asia/Ho_Chi_Minh} (GDD 03 §3: DayClock + SeasonCalendar). A theme week starts at
 * Monday 00:00 local time; {@code weekIndex = floorDiv(days(epochMonday, day), 7)}, theme = {@code order[weekIndex mod 4]}.
 */
public final class GardenCalendar {

    private final GardenRules rules;

    public GardenCalendar(GardenRules rules) {
        this.rules = rules;
    }

    public LocalDate dayKey(Instant at) {
        return at.atZone(rules.zone()).toLocalDate();
    }

    public Instant startOfDay(LocalDate day) {
        return day.atStartOfDay(rules.zone()).toInstant();
    }

    public Season theme(Instant at) {
        long days = ChronoUnit.DAYS.between(rules.seasons().epochMonday(), dayKey(at));
        int week = (int) Math.floorMod(Math.floorDiv(days, 7), rules.seasons().order().size());
        return rules.seasons().order().get(week);
    }

    /** The next Monday 00:00 (local) strictly after {@code at}: the end of the current theme week. */
    public Instant themeEndsAt(Instant at) {
        ZonedDateTime local = at.atZone(rules.zone());
        LocalDate nextMonday = local.toLocalDate().with(TemporalAdjusters.next(DayOfWeek.MONDAY));
        return nextMonday.atStartOfDay(rules.zone()).toInstant();
    }

    /** Harvest between 19:00 and 04:59 local time records the "Ánh trăng" codex form. */
    public boolean moonlit(Instant at) {
        int hour = at.atZone(rules.zone()).getHour();
        int from = rules.quality().moonlitFromHour();
        int to = rules.quality().moonlitToHour();
        return from > to ? (hour >= from || hour < to) : (hour >= from && hour < to);
    }
}
