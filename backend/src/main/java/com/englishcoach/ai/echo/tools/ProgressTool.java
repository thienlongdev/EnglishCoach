package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.leaderboard.board.BoardParams;
import com.englishcoach.leaderboard.board.LeaderboardBoardService;
import com.englishcoach.learningpath.LearningPathService;
import com.englishcoach.progress.service.UnifiedProgressService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Study consistency and standing: streak, active days in the last 7 / 30 days (heatmap), Learning Path tasks completed,
 * and this week's Activity leaderboard rank / points (the board's own eligibility rules; never other learners' data).
 */
@Component
public class ProgressTool implements EchoTool {
    private final ObjectProvider<UnifiedProgressService> progress;
    private final ObjectProvider<LearningPathService> learningPath;
    private final ObjectProvider<LeaderboardBoardService> leaderboard;
    private final ObjectMapper mapper;

    public ProgressTool(ObjectProvider<UnifiedProgressService> progress, ObjectProvider<LearningPathService> learningPath,
                        ObjectProvider<LeaderboardBoardService> leaderboard, ObjectMapper mapper) {
        this.progress = progress; this.learningPath = learningPath; this.leaderboard = leaderboard; this.mapper = mapper;
    }

    public String name() { return "get_progress_overview"; }
    public String description() {
        return "Read this learner's study consistency and standing: current / longest streak, active days in the last 7 and 30 days, "
                + "Learning Path tasks completed (7 / 30 days), and this week's Activity leaderboard rank and points (if ranked).";
    }
    public Map<String, Object> parameters() { return EchoToolRegistry.schema(Map.of(), List.of()); }
    public Kind kind() { return Kind.READ; }
    public String status(boolean vi) { return vi ? "Echo đang xem tiến trình của bạn…" : "Echo is checking your progress…"; }

    public String run(EchoTurn turn, JsonNode args) {
        ObjectNode out = mapper.createObjectNode();
        List<EchoCard.Item> items = new ArrayList<>();
        UnifiedProgressService p = progress.getIfAvailable();
        if (p != null) {
            var streak = p.getStreak(turn.userId());
            out.put("currentStreakDays", streak.currentStreakDays()).put("longestStreakDays", streak.longestStreakDays()).put("studiedToday", streak.activeToday());
            items.add(new EchoCard.Item(turn.t("Chuỗi ngày học", "Study streak"), streak.currentStreakDays() + turn.t(" ngày", " days"),
                    turn.t("dài nhất " + streak.longestStreakDays(), "longest " + streak.longestStreakDays()), null, null));
            try {
                var heat = p.getHeatmap(turn.userId(), 30);
                int active7 = 0, active30 = 0, events30 = 0;
                java.time.LocalDate today = java.time.LocalDate.now(java.time.ZoneId.of("Asia/Ho_Chi_Minh"));
                for (var d : heat.days() == null ? List.<com.englishcoach.progress.dto.HeatmapDayDto>of() : heat.days()) {
                    if (d.date() == null || d.activityCount() <= 0) continue;
                    if (!d.date().isBefore(today.minusDays(29))) { active30++; events30 += d.activityCount(); }
                    if (!d.date().isBefore(today.minusDays(6))) active7++;
                }
                out.put("activeDaysLast7", active7).put("activeDaysLast30", active30).put("learningEventsLast30", events30);
                items.add(new EchoCard.Item(turn.t("Ngày học 7 / 30 ngày qua", "Active days, last 7 / 30"), active7 + " / " + active30, null, null, null));
            } catch (RuntimeException ignored) { out.put("heatmap", "unknown"); }
        }
        LearningPathService lp = learningPath.getIfAvailable();
        if (lp != null) {
            try {
                var s = lp.summary(turn.userId());
                out.put("pathTasksDone7d", s.tasksDone7d()).put("pathTasksDone30d", s.tasksDone30d()).put("pathTasksDoneTotal", s.tasksDone());
                items.add(new EchoCard.Item(turn.t("Nhiệm vụ lộ trình (7 ngày)", "Path tasks (7 days)"), String.valueOf(s.tasksDone7d()), null, null, null));
            } catch (RuntimeException ignored) { out.put("learningPath", "unknown"); }
        }
        LeaderboardBoardService board = leaderboard.getIfAvailable();
        if (board != null) {
            try {
                var me = board.activityMe(turn.userId(), BoardParams.Period.WEEK, null, BoardParams.Group.ALL);
                out.put("weeklyPoints", me.points()).put("eligibility", me.eligibility() == null ? "UNKNOWN" : me.eligibility());
                if (me.rank() != null) out.put("weeklyRank", me.rank());
                items.add(new EchoCard.Item(turn.t("Thi đua tuần này", "This week's activity"), me.points() + turn.t(" điểm", " pts"),
                        me.rank() == null ? turn.t("chưa xếp hạng", "unranked") : "#" + me.rank(), "/leaderboard", null));
            } catch (RuntimeException ignored) { out.put("leaderboard", "unknown"); }
        }
        if (!items.isEmpty()) turn.card(EchoCard.of("stats", turn.t("Tiến trình của bạn", "Your progress"), items, null));
        return out.toString();
    }
}
