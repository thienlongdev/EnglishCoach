package com.englishcoach.leaderboard.board;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.proficiency.board.ProficiencyBoardType;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Leaderboard read API (Phase 3). Authenticated by the default filter chain (no security change).
 * Read-only: rankings from materialized views; display name + avatar only, never email.
 */
@RestController
@RequestMapping("/api/v1/leaderboard")
@RequiredArgsConstructor
public class LeaderboardController {

    private final LeaderboardBoardService service;

    @GetMapping("/activity")
    public LeaderboardDtos.ActivityBoardResponse activity(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(required = false) String period,
            @RequestParam(required = false) String scope,
            @RequestParam(required = false) String group,
            @RequestParam(required = false) Integer limit) {
        requireUser(principal);
        return service.activityBoard(
                BoardParams.parse(BoardParams.Period.class, period, BoardParams.Period.WEEK, "period"),
                BoardParams.parse(BoardParams.Scope.class, scope, BoardParams.Scope.GLOBAL, "scope"),
                BoardParams.parse(BoardParams.Group.class, group, BoardParams.Group.ALL, "group"),
                BoardParams.activityLimit(limit));
    }

    @GetMapping("/activity/me")
    public LeaderboardDtos.ActivityMeResponse activityMe(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(required = false) String period,
            @RequestParam(required = false) String scope,
            @RequestParam(required = false) String group) {
        long userId = requireUser(principal);
        return service.activityMe(userId,
                BoardParams.parse(BoardParams.Period.class, period, BoardParams.Period.WEEK, "period"),
                scope,
                BoardParams.parse(BoardParams.Group.class, group, BoardParams.Group.ALL, "group"));
    }

    /** "Chưa ghi điểm kỳ này": cursor-paginated unranked learners (default 30 per page, max 50). */
    @GetMapping("/activity/unranked")
    public LeaderboardDtos.UnrankedResponse activityUnranked(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(required = false) String period,
            @RequestParam(required = false) String scope,
            @RequestParam(required = false) String group,
            @RequestParam(required = false) Long cursor,
            @RequestParam(required = false) Integer limit) {
        requireUser(principal);
        if (cursor != null && cursor < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "cursor must be >= 0");
        }
        return service.activityUnranked(
                BoardParams.parse(BoardParams.Period.class, period, BoardParams.Period.WEEK, "period"),
                BoardParams.parse(BoardParams.Scope.class, scope, BoardParams.Scope.GLOBAL, "scope"),
                BoardParams.parse(BoardParams.Group.class, group, BoardParams.Group.ALL, "group"),
                cursor, limit == null ? 30 : BoardParams.limit(limit));
    }

    @GetMapping("/proficiency")
    public LeaderboardDtos.ProficiencyBoardResponse proficiency(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(required = false) String board,
            @RequestParam(required = false) String division,
            @RequestParam(required = false) Integer limit) {
        long userId = requireUser(principal);
        return service.proficiencyBoard(userId,
                BoardParams.parse(ProficiencyBoardType.class, board, ProficiencyBoardType.OVERALL, "board"),
                division, BoardParams.limit(limit));
    }

    /** Năng lực board, below the ranked rows: "Đang xác thực", "Theo bài xếp lớp", undetermined count. */
    @GetMapping("/proficiency/others")
    public LeaderboardDtos.ProficiencyOthersResponse proficiencyOthers(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(required = false) String board,
            @RequestParam(required = false) String division) {
        long userId = requireUser(principal);
        return service.proficiencyOthers(userId,
                BoardParams.parse(ProficiencyBoardType.class, board, ProficiencyBoardType.OVERALL, "board"), division);
    }

    @GetMapping("/proficiency/me")
    public LeaderboardDtos.ProficiencyMeResponse proficiencyMe(
            @AuthenticationPrincipal UserDetailsImpl principal,
            @RequestParam(required = false) String board) {
        long userId = requireUser(principal);
        return service.proficiencyMe(userId,
                BoardParams.parse(ProficiencyBoardType.class, board, ProficiencyBoardType.OVERALL, "board"));
    }

    private static long requireUser(UserDetailsImpl principal) {
        if (principal == null) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED);
        }
        return principal.getId();
    }
}
