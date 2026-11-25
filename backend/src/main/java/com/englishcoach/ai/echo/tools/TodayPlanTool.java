package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoAction;
import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.echo.EchoDestinations;
import com.englishcoach.ai.echo.EchoRouter;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.learningpath.LearningPathDtos;
import com.englishcoach.learningpath.LearningPathService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Today's Learning Path tasks, through {@link LearningPathService#today} exactly as opening the Learning Path does (the day is
 * created once and completion is linked from server evidence). Destinations follow the frontend task rules for the
 * simple kinds and otherwise point to the Learning Path itself, where the real task button lives.
 */
@Component
public class TodayPlanTool implements EchoTool {
    private final ObjectProvider<LearningPathService> learningPath;
    private final ObjectMapper mapper;

    public TodayPlanTool(ObjectProvider<LearningPathService> learningPath, ObjectMapper mapper) {
        this.learningPath = learningPath; this.mapper = mapper;
    }

    public String name() { return "get_today_plan"; }
    public String description() {
        return "Read today's Learning Path tasks for this learner (kind, skill, title, minutes, OPEN/DONE) and the plan goal. "
                + "Use for 'what should I study today', 'my tasks', or before suggesting a study order. Never invent tasks.";
    }
    public Map<String, Object> parameters() { return EchoToolRegistry.schema(Map.of(), List.of()); }
    public Kind kind() { return Kind.READ; }
    /** The service owns its transaction (it may create today's tasks, as the Learning Path page does). */
    public boolean readOnlyTransaction() { return false; }
    public String status(boolean vi) { return vi ? "Echo đang mở lộ trình hôm nay…" : "Echo is opening today's path…"; }

    public String run(EchoTurn turn, JsonNode args) {
        LearningPathService svc = learningPath.getIfAvailable();
        ObjectNode out = mapper.createObjectNode();
        if (svc == null) return out.put("error", "unavailable").toString();
        LearningPathDtos.TodayView today = svc.today(turn.userId());
        if (today.plan() == null) {
            out.put("hasLearningPath", false);
            turn.action(EchoAction.navigate(EchoDestinations.Dest.TODAY.pattern(), turn.t("Tạo lộ trình học", "Create a learning path"), false));
            return out.toString();
        }
        out.put("hasLearningPath", true).put("goal", today.plan().goal()).put("stage", today.plan().stage())
                .put("done", today.done()).put("total", today.total()).put("minutes", today.minutes());
        if (today.plan().target() != null) out.put("target", today.plan().target());
        ArrayNode tasks = out.putArray("tasks");
        List<EchoCard.Item> items = new ArrayList<>();
        for (var t : today.tasks()) {
            if (!"OPEN".equals(t.status()) && !"DONE".equals(t.status())) continue;
            String label = label(t, turn);
            tasks.addObject().put("kind", t.kind()).put("skill", t.skill()).put("title", clip(t.title()))
                    .put("minutes", t.minutes()).put("status", t.status()).put("label", label);
            items.add(new EchoCard.Item(label, t.title() == null || t.title().isBlank() ? null : clip(t.title()),
                    t.minutes() + (turn.vi() ? " phút" : " min"), href(t), t.status()));
        }
        turn.card(EchoCard.of("tasks", turn.t("Lộ trình hôm nay", "Today's path") + " · " + today.done() + "/" + today.total(), items, null));
        turn.action(EchoAction.navigate(EchoDestinations.Dest.TODAY.pattern(), EchoDestinations.Dest.TODAY.label(turn.vi()), EchoRouter.explicitOpen(turn.userText())));
        return out.toString();
    }

    /** Mirrors {@code taskHref} in frontend/src/lib/learning-path/model.ts for the kinds that need no parsed target. */
    static String href(LearningPathDtos.TaskView t) {
        boolean id = t.targetId() != null && t.targetId() > 0;
        return switch (t.kind()) {
            case "VOCAB_REVIEW" -> "/flashcards?review=due";
            case "DICTATION" -> id ? "/listening/" + t.targetId() + "/practice" : EchoDestinations.Dest.TODAY.pattern();
            case "READING" -> id ? "/reading?materialId=" + t.targetId() : EchoDestinations.Dest.TODAY.pattern();
            case "TOPIC_SPEAKING" -> "/speaking?mode=topic";
            default -> EchoDestinations.Dest.TODAY.pattern();
        };
    }

    private static String label(LearningPathDtos.TaskView t, EchoTurn turn) {
        int n = Math.max(1, t.goalCount());
        return switch (t.kind()) {
            case "PLACEMENT" -> turn.t("Bài xếp lớp nhanh", "Quick placement quiz");
            case "VOCAB_REVIEW" -> turn.t("Ôn " + n + " thẻ từ vựng", "Review " + n + " flashcards");
            case "DICTATION" -> turn.t("Nghe chép chính tả " + n + " câu", "Dictation: " + n + " sentences");
            case "READING" -> turn.t("Đọc hết một bài", "Read one text to the end");
            case "TOPIC_SPEAKING" -> turn.t("Nói theo chủ đề · " + n + " lượt", "Topic speaking · " + n + " rounds");
            case "WRITING" -> turn.t("Bài viết luyện tập", "Writing practice");
            case "EXAM_PRACTICE" -> turn.t("Luyện một phần thi", "Exam part practice");
            default -> t.kind();
        };
    }

    private static String clip(String s) { return s == null ? "" : s.length() <= 90 ? s : s.substring(0, 89) + "…"; }
}
