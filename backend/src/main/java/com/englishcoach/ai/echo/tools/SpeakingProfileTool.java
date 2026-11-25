package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.speaking.dto.SpeakingPronunciationMetricsDto;
import com.englishcoach.speaking.dto.SpeakingRecurringIssueDto;
import com.englishcoach.speaking.profile.SpeakingProfileAnalyticsService;
import com.englishcoach.speaking.profile.SpeakingProfileDtos.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Grounded read-only Speaking Profile & Pronunciation Analytics tool ({@code get_speaking_profile}).
 * Reads longitudinal V2.2 pronunciation, lexical stress, fluency, score trends, recurring issues, and strong phoneme
 * patterns strictly for {@code turn.userId()} via {@link SpeakingProfileAnalyticsService}.
 * Never fabricates scores or trends when {@code INSUFFICIENT_DATA}.
 */
@Component
public class SpeakingProfileTool implements EchoTool {

    private final ObjectProvider<SpeakingProfileAnalyticsService> analytics;
    private final ObjectMapper mapper;

    public SpeakingProfileTool(ObjectProvider<SpeakingProfileAnalyticsService> analytics, ObjectMapper mapper) {
        this.analytics = analytics;
        this.mapper = mapper;
    }

    @Override
    public String name() {
        return "get_speaking_profile";
    }

    @Override
    public String description() {
        return "Read this learner's verified 30-day Speaking Profile and Pronunciation Analytics (V2.2 pronunciation score, "
                + "phoneme accuracy, lexical stress ratio, fluency, chronological score trend, recurring issues, and strong "
                + "phoneme patterns). Honest sufficiency statuses: READY, LIMITED_EVIDENCE, INSUFFICIENT_DATA.";
    }

    @Override
    public Map<String, Object> parameters() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("section", EchoToolRegistry.enumOf(
                "Speaking profile section to inspect (default 'both')",
                List.of("overview", "pronunciation", "both")));
        return EchoToolRegistry.schema(props, List.of());
    }

    @Override
    public Kind kind() {
        return Kind.READ;
    }

    @Override
    public boolean readOnlyTransaction() {
        // SpeakingProfileAnalyticsService manages its own @Transactional(readOnly = true)
        return false;
    }

    @Override
    public boolean parallelizableRead() {
        return true;
    }

    @Override
    public String status(boolean vi) {
        return vi ? "Echo đang kiểm tra hồ sơ luyện nói của bạn…" : "Echo is checking your speaking profile…";
    }

    @Override
    public String run(EchoTurn turn, JsonNode args) throws Exception {
        SpeakingProfileAnalyticsService svc = analytics.getIfAvailable();
        if (svc == null) return "{\"error\":\"unavailable\"}";

        String section = args.path("section").asText("both");
        boolean wantOverview = "overview".equals(section) || "both".equals(section);
        boolean wantPronunciation = "pronunciation".equals(section) || "both".equals(section);

        SpeakingProfileOverviewDto overview = wantOverview ? svc.getOverview(turn.userId()) : null;
        SpeakingProfilePronunciationDto pron = wantPronunciation ? svc.getPronunciation(turn.userId()) : null;

        ObjectNode out = mapper.createObjectNode();
        out.put("section", section);

        String sufficiencyStatus = "INSUFFICIENT_DATA";
        if (pron != null && pron.sufficiencyStatus() != null) {
            sufficiencyStatus = pron.sufficiencyStatus();
        } else if (overview != null && overview.dataSufficiency() != null) {
            if ("READY".equals(overview.dataSufficiency().strengthsStatus()) || "READY".equals(overview.dataSufficiency().trendStatus())) {
                sufficiencyStatus = "READY";
            } else if (overview.dataSufficiency().hasAnyPractice()) {
                sufficiencyStatus = "LIMITED_EVIDENCE";
            }
        }
        out.put("sufficiencyStatus", sufficiencyStatus);

        if (overview != null && overview.dataSufficiency() != null) {
            SpeakingDataSufficiencyDto ds = overview.dataSufficiency();
            ObjectNode dsNode = out.putObject("dataSufficiency");
            dsNode.put("hasAnyPractice", ds.hasAnyPractice());
            dsNode.put("strengthsStatus", ds.strengthsStatus() == null ? "INSUFFICIENT_DATA" : ds.strengthsStatus());
            dsNode.put("focusStatus", ds.focusStatus() == null ? "INSUFFICIENT_DATA" : ds.focusStatus());
            dsNode.put("trendStatus", ds.trendStatus() == null ? "INSUFFICIENT_DATA" : ds.trendStatus());
        }

        if (overview != null && overview.recentWindow() != null) {
            SpeakingWindowActivityDto w = overview.recentWindow();
            out.put("practiceDays7d", w.practiceDays7d());
            out.put("practiceDays30d", w.practiceDays30d());
            out.put("currentStreakDays", w.currentStreakDays());
            out.put("sessionsCompleted30d", w.sessionsCompleted30d());
            putNullableDouble(out, "averagePronunciationScore30d", w.averagePronunciationScore30d());
            putNullableDouble(out, "averageContentMatchScore30d", w.averageContentMatchScore30d());
        }

        if (pron != null && pron.metrics() != null) {
            SpeakingPronunciationMetricsDto m = pron.metrics();
            if (!out.has("averagePronunciationScore30d")) {
                putNullableDouble(out, "averagePronunciationScore30d", m.getAveragePronunciationScore());
            }
            putNullableDouble(out, "averagePhonemeScore", m.getAveragePhonemeScore());
            putNullableDouble(out, "averageStressScore", m.getAverageStressScore());
            putNullableDouble(out, "averageFluencyScore", m.getAverageFluencyScore());
            if (m.getLexicalStressMatchedWords() != null) out.put("lexicalStressMatchedWords", m.getLexicalStressMatchedWords());
            if (m.getLexicalStressAssessedWords() != null) out.put("lexicalStressAssessedWords", m.getLexicalStressAssessedWords());
            if (m.getScoredAttemptsCount() != null) out.put("scoredAttemptsCount", m.getScoredAttemptsCount());
        }

        // Chronological score trend (NEVER fabricate trends when INSUFFICIENT_DATA!)
        ObjectNode trendNode = out.putObject("scoreTrend");
        List<SpeakingScoreTrendPointDto> pts = overview != null && overview.scoreTrend() != null ? overview.scoreTrend() : List.of();
        String trendStatus = overview != null && overview.dataSufficiency() != null && overview.dataSufficiency().trendStatus() != null
                ? overview.dataSufficiency().trendStatus()
                : (pts.size() >= 2 ? "READY" : "INSUFFICIENT_DATA");
        trendNode.put("status", trendStatus);
        if ("READY".equals(trendStatus) && pts.size() >= 2) {
            SpeakingScoreTrendPointDto first = pts.get(0);
            SpeakingScoreTrendPointDto latest = pts.get(pts.size() - 1);
            Double firstScore = first.pronunciationScore() != null ? first.pronunciationScore() : first.contentMatchScore();
            Double latestScore = latest.pronunciationScore() != null ? latest.pronunciationScore() : latest.contentMatchScore();
            trendNode.put("scoredSessionsCount", pts.size());
            if (firstScore != null && latestScore != null) {
                double delta = round1(latestScore - firstScore);
                String dir = delta >= 2.0 ? "IMPROVING" : (delta <= -2.0 ? "DECLINING" : "STABLE");
                trendNode.put("firstScore", round1(firstScore));
                trendNode.put("latestScore", round1(latestScore));
                trendNode.put("delta", delta);
                trendNode.put("direction", dir);
            }
        } else {
            trendNode.put("scoredSessionsCount", pts.size());
            trendNode.put("note", "Insufficient scored sessions in the last 30 days to establish a trend; state plainly that more practice is needed.");
        }

        List<SpeakingRecurringIssueDto> issuesSrc = pron != null && pron.recurringIssues() != null ? pron.recurringIssues()
                : (overview != null && overview.focusAreas() != null ? overview.focusAreas() : List.of());
        ArrayNode issuesArr = out.putArray("recurringIssues");
        for (SpeakingRecurringIssueDto issue : issuesSrc.stream().limit(4).toList()) {
            ObjectNode item = issuesArr.addObject();
            item.put("title", clip(issue.getTitle(), 80));
            if (issue.getCategory() != null) item.put("category", issue.getCategory());
            if (issue.getTargetPhone() != null) item.put("targetPhone", issue.getTargetPhone());
            if (issue.getTargetWord() != null) item.put("targetWord", issue.getTargetWord());
            if (issue.getStatus() != null) item.put("status", issue.getStatus());
            if (issue.getDistinctSessionsObserved() != null) item.put("distinctSessionsObserved", issue.getDistinctSessionsObserved());
        }

        ArrayNode strongArr = out.putArray("strongPatterns");
        if (pron != null && pron.strongPatterns() != null) {
            for (SpeakingStrongPhonemePatternDto sp : pron.strongPatterns().stream().limit(3).toList()) {
                ObjectNode sNode = strongArr.addObject();
                sNode.put("phone", sp.ipaDisplay() != null ? sp.ipaDisplay() : sp.phone());
                sNode.put("acceptableRate", round2(sp.acceptableRate()));
                sNode.put("averageQualityScore", round1(sp.averageQualityScore()));
                sNode.put("observationsCount", sp.observationsCount());
            }
        }

        turn.authorizeResourceHref("/speaking?view=profile");
        turn.authorizeResourceHref("/speaking?view=profile&sub=pronunciation");
        turn.authorizeResourceHref("/speaking?view=profile&sub=history");

        List<EchoCard.Item> cardRows = buildStatsCardRows(turn, sufficiencyStatus, out, trendNode);
        String cardHrefNote = turn.t("Số liệu thực tế trong 30 ngày gần nhất từ Hồ sơ Luyện nói.",
                "Verified 30-day metrics from your Speaking Profile.");
        turn.card(EchoCard.of("stats", turn.t("Hồ sơ Luyện nói (30 ngày)", "Speaking Profile (30d)"), cardRows, cardHrefNote));

        return out.toString();
    }

    private static List<EchoCard.Item> buildStatsCardRows(EchoTurn turn, String sufficiency, ObjectNode out, ObjectNode trend) {
        List<EchoCard.Item> rows = new ArrayList<>();
        if ("INSUFFICIENT_DATA".equals(sufficiency) && !out.hasNonNull("averagePronunciationScore30d")) {
            rows.add(new EchoCard.Item(
                    turn.t("Độ đủ dữ liệu", "Evidence status"),
                    turn.t("Chưa đủ dữ liệu chấm điểm", "Insufficient scored data"),
                    turn.t("Hãy hoàn thành thêm bài Shadowing hoặc Kiểm tra nói nhanh", "Complete a Shadowing or Quick Check session"),
                    "/speaking?view=profile",
                    "INSUFFICIENT_DATA"));
        } else {
            if (out.hasNonNull("averagePronunciationScore30d")) {
                rows.add(new EchoCard.Item(
                        turn.t("Điểm phát âm TB (30 ngày)", "Avg Pronunciation (30d)"),
                        out.get("averagePronunciationScore30d").asDouble() + "/100",
                        sufficiency,
                        "/speaking?view=profile&sub=pronunciation",
                        null));
            }
            if (out.hasNonNull("lexicalStressAssessedWords") && out.get("lexicalStressAssessedWords").asLong() > 0) {
                long matched = out.path("lexicalStressMatchedWords").asLong(0);
                long assessed = out.get("lexicalStressAssessedWords").asLong();
                rows.add(new EchoCard.Item(
                        turn.t("Trọng âm từ vựng đúng", "Lexical stress accuracy"),
                        matched + "/" + assessed + turn.t(" từ", " words"),
                        out.hasNonNull("averageStressScore") ? out.get("averageStressScore").asDouble() + "/100" : null,
                        "/speaking?view=profile&sub=pronunciation",
                        null));
            }
            if ("READY".equals(trend.path("status").asText()) && trend.hasNonNull("direction")) {
                double delta = trend.path("delta").asDouble(0.0);
                String sign = delta > 0 ? "+" : "";
                rows.add(new EchoCard.Item(
                        turn.t("Xu hướng điểm", "Score trend"),
                        trend.get("firstScore").asDouble() + " → " + trend.get("latestScore").asDouble() + " (" + sign + delta + ")",
                        trend.get("direction").asText(),
                        "/speaking?view=profile",
                        null));
            }
        }
        if (out.has("practiceDays30d")) {
            rows.add(new EchoCard.Item(
                    turn.t("Ngày luyện tập (7 / 30 ngày)", "Practice days (7d / 30d)"),
                    out.path("practiceDays7d").asInt(0) + " / " + out.path("practiceDays30d").asInt(0) + turn.t(" ngày", " days"),
                    null,
                    "/speaking?view=profile",
                    null));
        }
        return rows;
    }

    private static void putNullableDouble(ObjectNode node, String key, Double value) {
        if (value != null && Double.isFinite(value)) {
            node.put(key, round1(value));
        } else {
            node.putNull(key);
        }
    }

    private static double round1(double v) {
        return Math.round(v * 10.0) / 10.0;
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    private static String clip(String s, int max) {
        return s == null ? "" : s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }
}
