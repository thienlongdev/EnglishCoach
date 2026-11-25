package com.englishcoach.leaderboard.board;

import com.englishcoach.common.cache.BoundedTtlCache;
import com.englishcoach.leaderboard.activity.ActivityScoringProperties;
import com.englishcoach.leaderboard.activity.rollup.ActivityRankRepository;
import com.englishcoach.proficiency.api.ProficiencyQueryService;
import com.englishcoach.proficiency.board.ProficiencyBoardRepository;
import com.englishcoach.proficiency.board.ProficiencyBoardService;
import com.englishcoach.proficiency.board.ProficiencyBoardType;
import com.englishcoach.proficiency.model.OverallStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.TemporalAdjusters;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Board API read model (Phase 3). Rankings come only from mv_activity_rank / mv_proficiency_rank,
 * Activity breakdowns from leaderboard_activity_daily; never score_events or proficiency_evidence.
 * Period boundaries come from the refresh state (the "as of" clock of the views), so the reported
 * period always matches the data served.
 */
@Service
@RequiredArgsConstructor
public class LeaderboardBoardService {

    private static final int BOARD_CACHE_MAX_ENTRIES = 64;
    private static final long BOARD_CACHE_TTL_MS = Duration.ofSeconds(45).toMillis();

    private record ActivityBoardKey(long generation, BoardParams.Period period, BoardParams.Scope scope,
                                    BoardParams.Group group, int limit) {}

    private record ProficiencyBoardKey(long generation, ProficiencyBoardType board,
                                       BoardParams.Division division, int limit) {}

    private final ActivityScoringProperties activityProps;
    private final ActivityRankRepository activityRanks;
    private final ProficiencyBoardService proficiencyBoard;
    private final LeaderboardDisplayRepository displays;
    private final LeaderboardRefreshStateRepository stateRepository;
    private final LeaderboardProperties boardProps;
    private final LeaderboardOthersRepository others;

    private final AtomicLong cacheGeneration = new AtomicLong(0L);
    private final BoundedTtlCache<ActivityBoardKey, LeaderboardDtos.ActivityBoardResponse> activityBoardCache =
            new BoundedTtlCache<>(BOARD_CACHE_MAX_ENTRIES, BOARD_CACHE_TTL_MS);
    private final BoundedTtlCache<ProficiencyBoardKey, LeaderboardDtos.ProficiencyBoardResponse> proficiencyBoardCache =
            new BoundedTtlCache<>(BOARD_CACHE_MAX_ENTRIES, BOARD_CACHE_TTL_MS);

    /**
     * Increments the shared board cache generation and clears cached board views.
     * Called AFTER_COMMIT by {@link LeaderboardRefreshJob} and exposed for admin disable/visibility toggles.
     */
    public void invalidateBoardCache() {
        cacheGeneration.incrementAndGet();
        activityBoardCache.clear();
        proficiencyBoardCache.clear();
    }

    /** Inclusive day range of a period plus its API boundaries (endsAt exclusive, null for ALL_TIME). */
    record Window(LocalDate fromDay, LocalDate today, Instant startsAt, Instant endsAt) {}

    static Window window(BoardParams.Period period, Instant asOf, Instant startAt, ZoneId zone) {
        LocalDate today = asOf.atZone(zone).toLocalDate();
        LocalDate startDay = startAt == null ? null : startAt.atZone(zone).toLocalDate();
        return switch (period) {
            case WEEK -> {
                LocalDate s = today.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
                yield new Window(max(s, startDay), today, s.atStartOfDay(zone).toInstant(),
                        s.plusWeeks(1).atStartOfDay(zone).toInstant());
            }
            case MONTH -> {
                LocalDate s = today.withDayOfMonth(1);
                yield new Window(max(s, startDay), today, s.atStartOfDay(zone).toInstant(),
                        s.plusMonths(1).atStartOfDay(zone).toInstant());
            }
            case ALL_TIME -> new Window(startDay == null ? today : startDay, today, startAt, null);
        };
    }

    // ---- Thi đua ------------------------------------------------------------------------------

    @Transactional(readOnly = true)
    public LeaderboardDtos.ActivityBoardResponse activityBoard(BoardParams.Period period, BoardParams.Scope scope,
                                                               BoardParams.Group group, int limit) {
        ActivityBoardKey key = new ActivityBoardKey(cacheGeneration.get(), period, scope, group, limit);
        return activityBoardCache.get(key, k -> loadActivityBoard(k.period(), k.scope(), k.group(), k.limit()));
    }

    private LeaderboardDtos.ActivityBoardResponse loadActivityBoard(BoardParams.Period period, BoardParams.Scope scope,
                                                                    BoardParams.Group group, int limit) {
        Optional<LeaderboardRefreshStateRepository.State> state = stateRepository.find();
        Window w = windowFor(period, state);
        List<ActivityRankRepository.RankRow> rows = activityRanks.top(period.name(), scope.name(), group.name(), limit);
        Map<Long, LeaderboardDisplayRepository.Display> shown = displays.find(rows.stream().map(ActivityRankRepository.RankRow::userId).toList());
        List<LeaderboardDtos.ActivityItem> items = new ArrayList<>(rows.size());
        for (ActivityRankRepository.RankRow r : rows) {
            LeaderboardDisplayRepository.Display d = shown.get(r.userId());
            items.add(new LeaderboardDtos.ActivityItem(r.rank(), r.userId(), name(d), d == null ? null : d.avatarUrl(),
                    frame(d), r.points()));
        }
        int participants = activityRanks.participants(period.name(), scope.name(), group.name());
        return new LeaderboardDtos.ActivityBoardResponse(period.name(), scope.name(), group.name(), items,
                participants, w.startsAt(), w.endsAt(), updatedAt(state));
    }

    @Transactional(readOnly = true)
    public LeaderboardDtos.ActivityMeResponse activityMe(long userId, BoardParams.Period period, String scopeRaw,
                                                         BoardParams.Group group) {
        // "Bảng chung" (GLOBAL) is the default for everyone; the caller's division is reported separately.
        String defaultScope = BoardParams.Scope.GLOBAL.name();
        Optional<ActivityRankRepository.DivisionLevel> level = activityRanks.divisionLevelOf(userId);
        Optional<ActivityRankRepository.Promotion> promotion = activityRanks.latestPromotion(userId,
                Instant.now().minus(java.time.Duration.ofDays(boardProps.getDivision().getPromotionWindowDays())));
        BoardParams.Scope scope = BoardParams.parse(BoardParams.Scope.class, scopeRaw, BoardParams.Scope.GLOBAL, "scope");
        Optional<LeaderboardRefreshStateRepository.State> state = stateRepository.find();
        Window w = windowFor(period, state);

        List<LeaderboardDtos.SourceBreakdown> breakdown = new ArrayList<>();
        if (state.map(s -> s.asOf() != null && s.activityStartAt() != null).orElse(false)) {
            activityRanks.breakdown(userId, w.fromDay(), w.today(), group == BoardParams.Group.ALL ? null : group.name())
                    .forEach(b -> breakdown.add(new LeaderboardDtos.SourceBreakdown(b.sourceModule(), b.points())));
        }
        Optional<ActivityRankRepository.RankRow> row = activityRanks.find(period.name(), scope.name(), group.name(), userId);
        int points = row.map(ActivityRankRepository.RankRow::points)
                .orElse(breakdown.stream().mapToInt(LeaderboardDtos.SourceBreakdown::points).sum());
        Integer toNext = null;
        Integer nextRank = null;
        if (row.isPresent() && row.get().rank() > 1) {
            Optional<ActivityRankRepository.RankRow> above =
                    activityRanks.rowAbove(period.name(), scope.name(), group.name(), row.get().rank());
            if (above.isPresent()) {
                toNext = above.get().points() - points + 1;
                nextRank = above.get().rank();
            }
        }
        LeaderboardDisplayRepository.Display self = displays.find(List.of(userId)).get(userId);
        boolean excluded = self == null || self.excluded();
        boolean placed = activityRanks.hasValidPlacement(userId);
        String division = level.map(ActivityRankRepository.DivisionLevel::division).orElse(null);
        String eligibility = eligibility(row.isPresent(), excluded, placed, points, scope, division);
        return new LeaderboardDtos.ActivityMeResponse(userId, period.name(), scope.name(), group.name(),
                row.map(ActivityRankRepository.RankRow::rank).orElse(null), points, toNext, nextRank, defaultScope,
                division,
                level.map(ActivityRankRepository.DivisionLevel::cefr).orElse(null),
                level.map(ActivityRankRepository.DivisionLevel::source).orElse(null),
                promotion.map(ActivityRankRepository.Promotion::toCefr).orElse(null),
                promotion.map(ActivityRankRepository.Promotion::at).orElse(null),
                breakdown, w.startsAt(), w.endsAt(), updatedAt(state), eligibility, placed,
                "EXCLUDED".equals(eligibility)
                        ? (self == null ? LeaderboardDisplayRepository.INACTIVE : self.excludedReason()) : null);
    }

    /** Status behind "Hạng của bạn" — a zero-state is shown only for NO_POINTS. */
    String eligibility(boolean ranked, boolean excluded, boolean placed, int points, BoardParams.Scope scope,
                       String division) {
        if (excluded) return "EXCLUDED";
        if (boardProps.isRequirePlacement() && !placed) return "PLACEMENT_REQUIRED";
        if (ranked) return "RANKED";
        if (scope != BoardParams.Scope.GLOBAL && !scope.name().equals(division)) return "OTHER_DIVISION";
        return points > 0 ? "PENDING" : "NO_POINTS";
    }

    /** "Chưa ghi điểm kỳ này": one page (cursor = last user id) of learners not ranked in the partition. */
    @Transactional(readOnly = true)
    public LeaderboardDtos.UnrankedResponse activityUnranked(BoardParams.Period period, BoardParams.Scope scope,
                                                             BoardParams.Group group, Long cursor, int limit) {
        List<Long> ids = activityRanks.unranked(period.name(), scope.name(), group.name(),
                cursor == null ? 0L : cursor, limit + 1, boardProps.excludedUserIdsArrayLiteral(),
                boardProps.isRequirePlacement());
        boolean more = ids.size() > limit;
        List<Long> page = more ? ids.subList(0, limit) : ids;
        Map<Long, LeaderboardDisplayRepository.Display> shown = displays.find(page);
        List<LeaderboardDtos.UnrankedItem> items = new ArrayList<>(page.size());
        for (Long id : page) {
            LeaderboardDisplayRepository.Display d = shown.get(id);
            items.add(new LeaderboardDtos.UnrankedItem(id, name(d), d == null ? null : d.avatarUrl(), frame(d)));
        }
        return new LeaderboardDtos.UnrankedResponse(period.name(), scope.name(), group.name(), items,
                more ? page.get(page.size() - 1) : null);
    }

    // ---- Năng lực -----------------------------------------------------------------------------

    @Transactional(readOnly = true)
    public LeaderboardDtos.ProficiencyBoardResponse proficiencyBoard(long callerId, ProficiencyBoardType board,
                                                                     String divisionRaw, int limit) {
        // Resolve the concrete non-null Division BEFORE keying the shared cache (NEVER key by raw null).
        BoardParams.Division division = BoardParams.parse(BoardParams.Division.class, divisionRaw,
                defaultDivision(callerId, board), "division");
        ProficiencyBoardKey key = new ProficiencyBoardKey(cacheGeneration.get(), board, division, limit);
        return proficiencyBoardCache.get(key, k -> loadProficiencyBoard(k.board(), k.division(), k.limit()));
    }

    private LeaderboardDtos.ProficiencyBoardResponse loadProficiencyBoard(ProficiencyBoardType board,
                                                                          BoardParams.Division division, int limit) {
        List<ProficiencyBoardRepository.BoardRow> rows = proficiencyBoard.top(board, division.name(), limit);
        Map<Long, LeaderboardDisplayRepository.Display> shown = displays.find(rows.stream().map(ProficiencyBoardRepository.BoardRow::userId).toList());
        List<LeaderboardDtos.ProficiencyItem> items = new ArrayList<>(rows.size());
        for (ProficiencyBoardRepository.BoardRow r : rows) {
            LeaderboardDisplayRepository.Display d = shown.get(r.userId());
            Map<String, LeaderboardDtos.SkillCellDto> skills = new LinkedHashMap<>();
            skills.put("L", cell(r.listening()));
            skills.put("R", cell(r.reading()));
            skills.put("W", cell(r.writing()));
            skills.put("S", cell(r.speaking()));
            items.add(new LeaderboardDtos.ProficiencyItem(r.rank(), r.userId(), name(d), d == null ? null : d.avatarUrl(),
                    frame(d), r.cefr(), r.rating(),
                    ProficiencyQueryService.confidenceLabel(OverallStatus.VERIFIED, r.confidence()), skills));
        }
        return new LeaderboardDtos.ProficiencyBoardResponse(board.name(), division.name(), items,
                updatedAt(stateRepository.find()));
    }

    @Transactional(readOnly = true)
    public LeaderboardDtos.ProficiencyMeResponse proficiencyMe(long userId, ProficiencyBoardType board) {
        ProficiencyBoardService.Standing s = proficiencyBoard.standing(board, userId);
        LeaderboardDisplayRepository.Display me = displays.find(List.of(userId)).get(userId);
        boolean excluded = me == null || me.excluded();
        boolean verified = "VERIFIED".equals(s.status());
        boolean eligible = !excluded && verified;
        String reason = excluded ? "EXCLUDED" : (verified ? null : s.status());
        return new LeaderboardDtos.ProficiencyMeResponse(userId, board.name(), excluded ? null : s.rank(), s.rating(), s.cefr(),
                s.status(), s.division(), s.hidden(), eligible, reason, updatedAt(stateRepository.find()));
    }

    /** Năng lực board, below the ranked rows (Stage 3.4). */
    @Transactional(readOnly = true)
    public LeaderboardDtos.ProficiencyOthersResponse proficiencyOthers(long callerId, ProficiencyBoardType board,
                                                                       String divisionRaw) {
        BoardParams.Division division = BoardParams.parse(BoardParams.Division.class, divisionRaw,
                defaultDivision(callerId, board), "division");
        String excluded = boardProps.excludedUserIdsArrayLiteral();
        List<LeaderboardOthersRepository.OtherRow> verifying = others.verifying(board.name(), division.name(), 50, excluded);
        List<LeaderboardOthersRepository.OtherRow> placed = board == ProficiencyBoardType.OVERALL
                ? others.placement(division.name(), 50, excluded) : List.of();
        List<Long> ids = new ArrayList<>();
        verifying.forEach(r -> ids.add(r.userId()));
        placed.forEach(r -> ids.add(r.userId()));
        Map<Long, LeaderboardDisplayRepository.Display> shown = displays.find(ids);
        return new LeaderboardDtos.ProficiencyOthersResponse(board.name(), division.name(),
                toOthers(verifying, shown), toOthers(placed, shown), others.undeterminedCount(board.name(), excluded));
    }

    private static List<LeaderboardDtos.OtherLevelItem> toOthers(List<LeaderboardOthersRepository.OtherRow> rows,
                                                                 Map<Long, LeaderboardDisplayRepository.Display> shown) {
        List<LeaderboardDtos.OtherLevelItem> out = new ArrayList<>(rows.size());
        for (LeaderboardOthersRepository.OtherRow r : rows) {
            LeaderboardDisplayRepository.Display d = shown.get(r.userId());
            out.add(new LeaderboardDtos.OtherLevelItem(r.userId(), name(d), d == null ? null : d.avatarUrl(), frame(d),
                    r.cefr(), r.source()));
        }
        return out;
    }

    /** The caller's own division on that board, else TRUNG_CAP. */
    private BoardParams.Division defaultDivision(long callerId, ProficiencyBoardType board) {
        String own = proficiencyBoard.standing(board, callerId).division();
        return own == null ? BoardParams.Division.TRUNG_CAP : BoardParams.Division.valueOf(own);
    }

    // ---- helpers ------------------------------------------------------------------------------

    private Window windowFor(BoardParams.Period period, Optional<LeaderboardRefreshStateRepository.State> state) {
        Instant asOf = state.map(LeaderboardRefreshStateRepository.State::asOf).orElse(null);
        Instant startAt = state.map(LeaderboardRefreshStateRepository.State::activityStartAt).orElse(null);
        String tz = state.map(LeaderboardRefreshStateRepository.State::timeZone).orElse(activityProps.getTimeZone());
        if (asOf == null) {
            asOf = Instant.now();
            startAt = activityProps.startAtInstant();
            tz = activityProps.getTimeZone();
        }
        return window(period, asOf, startAt, ZoneId.of(tz));
    }

    private static Instant updatedAt(Optional<LeaderboardRefreshStateRepository.State> state) {
        return state.map(LeaderboardRefreshStateRepository.State::lastSuccessAt).orElse(null);
    }

    private static String name(LeaderboardDisplayRepository.Display d) {
        return d == null ? LeaderboardDisplayRepository.FALLBACK_NAME : d.displayName();
    }

    private static LeaderboardDtos.AvatarFrameDto frame(LeaderboardDisplayRepository.Display d) {
        if (d == null || d.frame() == null) return null;
        LeaderboardDisplayRepository.Frame f = d.frame();
        return new LeaderboardDtos.AvatarFrameDto(f.slug(), f.tier(), f.renderType(), f.posterAsset());
    }

    private static LeaderboardDtos.SkillCellDto cell(ProficiencyBoardRepository.SkillCell c) {
        return new LeaderboardDtos.SkillCellDto(c.cefr(), c.status() == null ? "UNDETERMINED" : c.status());
    }

    private static LocalDate max(LocalDate a, LocalDate b) {
        return b != null && b.isAfter(a) ? b : a;
    }
}
