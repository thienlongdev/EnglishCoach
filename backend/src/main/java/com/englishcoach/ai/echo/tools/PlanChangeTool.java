package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.echo.EchoConfirmations;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.learningpath.LearningPathService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * PREPARE only: builds a preview of a Learning Path goal / target / daily-time change and a single-use confirmation. It never
 * applies anything: the learner presses "Xác nhận" in the card, and {@link EchoConfirmations#decide} commits through the
 * Learning Path service with its own validation. Today's assigned tasks never change (the service's own rule).
 */
@Component
public class PlanChangeTool implements EchoTool {
    private final ObjectProvider<LearningPathService> learningPath;
    private final EchoConfirmations confirmations;
    private final ObjectMapper mapper;

    public PlanChangeTool(ObjectProvider<LearningPathService> learningPath, EchoConfirmations confirmations, ObjectMapper mapper) {
        this.learningPath = learningPath; this.confirmations = confirmations; this.mapper = mapper;
    }

    public String name() { return "prepare_plan_change"; }
    public String description() {
        return "Prepare (not apply) a change to the learner's Learning Path goal, target or daily minutes. Shows the learner a preview "
                + "card with Confirm / Cancel; nothing changes until they confirm. Targets: IELTS 5.0-7.5 (half bands), TOEIC 450/550/650/750/850/900/950/990, "
                + "GENERAL A1-C1 or none. Daily minutes: 15, 30, 45 or 60. Say it is prepared, never that it is done.";
    }
    public Map<String, Object> parameters() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("goal", EchoToolRegistry.enumOf("Learning goal", List.of("GENERAL", "COMMUNICATION", "IELTS", "TOEIC")));
        Map<String, Object> target = EchoToolRegistry.str("Target band / score / CEFR for the goal", 4);
        target.put("pattern", "(?:[0-9.]{1,4}|A1|A2|B1|B2|C1)");
        props.put("target", target);
        props.put("daily_minutes", EchoToolRegistry.integer("Daily study minutes: 15, 30, 45 or 60", 15, 60));
        return EchoToolRegistry.schema(props, List.of());
    }
    public Kind kind() { return Kind.PREPARE; }
    public String status(boolean vi) { return vi ? "Echo đang chuẩn bị thay đổi lộ trình để bạn xác nhận…" : "Echo is preparing a plan change for you to confirm…"; }

    public String run(EchoTurn turn, JsonNode args) throws Exception {
        if (!com.englishcoach.ai.echo.camel.CaMeLPolicyEngine.canPreparePlanChange(turn)) {
            return mapper.writeValueAsString(Map.of("prepared", false, "reason", "not_authorized_by_learner"));
        }
        LearningPathService svc = learningPath.getIfAvailable();
        if (svc == null) return "{\"error\":\"unavailable\"}";
        Map<String, Object> current = svc.planSummary(turn.userId());
        String curGoal = current.get("goal") instanceof String g ? g : null;
        Integer curMinutes = current.get("dailyMinutes") instanceof Number n ? n.intValue() : null;
        String curTarget = current.get("target") instanceof String t ? t : null;
        String goal = args.path("goal").asText(curGoal == null ? "GENERAL" : curGoal);
        Integer minutes = args.has("daily_minutes") ? args.get("daily_minutes").asInt() : (curMinutes == null ? 30 : curMinutes);
        String target = args.has("target") ? args.get("target").asText()
                : (Objects.equals(goal, curGoal) ? curTarget : null);
        if (target != null && target.matches("\\d")) target = target + ".0";
        if ("COMMUNICATION".equals(goal)) target = null; // the service stores no target for this goal
        if (!LearningPathService.acceptsGoal(goal, minutes, target))
            return mapper.writeValueAsString(Map.of("prepared", false, "reason", "invalid_values",
                    "rules", "IELTS targets 5.0-7.5 half bands; TOEIC 450,550,650,750,850,900,950,990; GENERAL A1-C1 or none; minutes 15/30/45/60"));
        if (Objects.equals(goal, curGoal) && Objects.equals(minutes, curMinutes) && Objects.equals(target, curTarget))
            return mapper.writeValueAsString(Map.of("prepared", false, "reason", "no_change"));
        String token = confirmations.issue(turn.userId(), new EchoConfirmations.PlanChange(goal, minutes, target));
        List<EchoCard.Item> rows = new ArrayList<>();
        rows.add(new EchoCard.Item(turn.t("Mục tiêu", "Goal"), goal, curGoal == null ? turn.t("chưa có", "none") : curGoal, null, null));
        rows.add(new EchoCard.Item(turn.t("Đích đến", "Target"), target == null ? "—" : target, curTarget == null ? "—" : curTarget, null, null));
        rows.add(new EchoCard.Item(turn.t("Thời gian mỗi ngày", "Daily time"), minutes + turn.t(" phút", " min"),
                curMinutes == null ? "—" : curMinutes + turn.t(" phút", " min"), null, null));
        turn.card(new EchoCard("confirm", turn.t("Thay đổi lộ trình học", "Learning Path change"), rows, token,
                turn.t("Nhiệm vụ hôm nay giữ nguyên; thay đổi áp dụng cho các ngày tiếp theo.", "Today's tasks stay; the change plans the next days.")));
        return mapper.writeValueAsString(Map.of("prepared", true, "requiresLearnerConfirmation", true));
    }
}
