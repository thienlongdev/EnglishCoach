package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoAction;
import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.echo.EchoDestinations;
import com.englishcoach.ai.echo.EchoRouter;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.ai.service.EchoPolicy;
import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.repository.ExamProfileRepository;
import com.englishcoach.learningpath.LearningExamPractice;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.service.ExamResultService;
import com.englishcoach.exams.model.ExamTypes.ExamAttemptStatus;
import com.englishcoach.exams.model.ExamTypes.ResultStatus;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * The learner's own IELTS / TOEIC picture from the Exams module: stored simulation estimates (eligible active evidence,
 * the same rows as the Assessment profile), the latest simulation status, the recommended practice scopes with their
 * sample size, and how many practice-ready parts the catalog offers. Estimates are practice estimates, never official.
 */
@Component
public class ExamOverviewTool implements EchoTool {
    private final ObjectProvider<ExamProfileRepository> profiles;
    private final ObjectProvider<LearningExamPractice> practice;
    private final ObjectMapper mapper;
    private final ExamAttemptRepository attempts;
    private final ExamResultService results;

    public ExamOverviewTool(ObjectProvider<ExamProfileRepository> profiles, ObjectProvider<LearningExamPractice> practice, ObjectMapper mapper,
                           ExamAttemptRepository attempts, ExamResultService results) {
        this.attempts = attempts; this.results = results;
        this.profiles = profiles; this.practice = practice; this.mapper = mapper;
    }

    public String name() { return "get_exam_overview"; }
    public String description() {
        return "Read this learner's IELTS or TOEIC simulation estimates (per skill, practice estimates only), latest simulation status, "
                + "recommended practice parts with sample size, and how many practice-ready parts exist. Use for 'my latest IELTS result', "
                + "'which TOEIC part should I practise', exam readiness questions.";
    }
    public Map<String, Object> parameters() {
        return EchoToolRegistry.schema(Map.of("family", EchoToolRegistry.enumOf("Exam family", List.of("IELTS", "TOEIC"))), List.of("family"));
    }
    public Kind kind() { return Kind.READ; }
    public String status(boolean vi) { return vi ? "Echo đang xem kết quả thi thử của bạn…" : "Echo is reading your exam results…"; }

    public String run(EchoTurn turn, JsonNode args) {
        ExamFamily family = ExamFamily.valueOf(args.path("family").asText("IELTS"));
        ObjectNode out = mapper.createObjectNode().put("family", family.name()).put("nature", "stored English Coach simulation estimates, not official scores");
        ObjectNode scores = out.putObject("estimates");
        List<EchoCard.Item> items = new ArrayList<>();
        ExamProfileRepository repo = profiles.getIfAvailable();
        if (repo != null) {
            for (var row : repo.latestByMetric(turn.userId(), family)) {
                if (!Set.of("READING", "LISTENING", "WRITING", "SPEAKING", "FULL_OVERALL", "LR_TOTAL").contains(row.metric()) || !Double.isFinite(row.scoreValue())) continue;
                scores.put(row.metric(), row.scoreValue());
                if (row.measurementDate() != null) scores.put(row.metric() + "_date", row.measurementDate().toString().substring(0, 10));
                items.add(new EchoCard.Item(metricLabel(row.metric(), turn), fmt(row.scoreValue()), null, null, null));
            }
        }
        if (scores.isEmpty()) out.put("note", "no eligible simulation estimate recorded for this family");
        String question = EchoPolicy.normalize(turn.userText());
        boolean wantsPractice = question.matches(".*\\b(practise|practice|readiness|recommend|luyen|nen hoc|san sang|goi y)\\b.*");
        LearningExamPractice exams = wantsPractice ? practice.getIfAvailable() : null;
        if (exams != null) {
            var signals = exams.signals(turn.userId(), family.name());
            if (signals.latestSimulationStatus() != null) out.put("latestSimulationStatus", signals.latestSimulationStatus());
            ArrayNode focus = out.putArray("recommendedPractice");
            signals.focus().stream().limit(3).forEach(f -> focus.addObject().put("scope", f.code()).put("skill", f.skill())
                    .put("attempts", f.attempts()).put("questions", f.questions()).put("signal", f.signal()));
            if (question.matches(".*\\b(how many|bao nhieu|may phan|number of)\\b.*"))
                out.put("practiceReadyParts", exams.practiceScopes(family.name()).size());
        }
        var recent = out.putArray("recentReleasedAttempts");
        var seen = new HashSet<java.util.UUID>();
        for (var row : attempts.findHistoryByUserId(turn.userId(), family, null, null, 5, 0)) {
            if (row.status() != ExamAttemptStatus.SUBMITTED || row.completedAt() == null || !seen.add(row.attemptId())) continue;
            var result = results.getAttemptResult(row.attemptId(), turn.userId(), false);
            if (result.isEmpty() || result.get().resultStatus() != ResultStatus.COMPLETED) continue;
            var sample = recent.addObject().put("mode",row.mode().name()).put("submitted",row.completedAt().toString().substring(0,10));
            var skills = sample.putObject("releasedSkillScores");
            if (result.get().skillScores() != null) result.get().skillScores().forEach((skill, score) -> {
                if (Set.of("READING","LISTENING","WRITING","SPEAKING").contains(skill) && score != null && Double.isFinite(score)
                        && !(family == ExamFamily.TOEIC && skill.equals("SPEAKING"))) skills.put(skill,score);
            });
            if (recent.size() == 2) break;
        }
        if (!items.isEmpty()) turn.card(EchoCard.of("stats", turn.t("Ước tính thi thử ", "Simulation estimates ") + family.name(), items,
                turn.t("Ước tính luyện tập của English Coach, không phải điểm chính thức.", "English Coach practice estimates, not official scores.")));
        turn.action(EchoAction.navigate("/exams/" + family.name().toLowerCase(Locale.ROOT), (turn.vi() ? "Thi thử " : "Exams ") + family.name(),
                EchoRouter.explicitOpen(turn.userText())));
        return out.toString();
    }

    private static String metricLabel(String metric, EchoTurn turn) {
        return switch (metric) {
            case "READING" -> turn.t("Đọc", "Reading");
            case "LISTENING" -> turn.t("Nghe", "Listening");
            case "WRITING" -> turn.t("Viết", "Writing");
            case "SPEAKING" -> turn.t("Nói", "Speaking");
            case "FULL_OVERALL" -> turn.t("Tổng", "Overall");
            case "LR_TOTAL" -> turn.t("Tổng Nghe + Đọc", "Listening + Reading total");
            default -> metric;
        };
    }

    private static String fmt(double v) { return v == Math.rint(v) ? String.valueOf((long) v) : String.valueOf(Math.round(v * 10) / 10d); }
}
