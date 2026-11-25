package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.echo.EchoLearnerBrain;
import com.englishcoach.ai.echo.EchoRouter;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/** The learner's full, evidence-labelled profile (verified level, 7-day signals, goals, estimates, grammar, vocabulary). */
@Component
public class LearnerProfileTool implements EchoTool {
    private static final Map<String, List<String>> SECTIONS = Map.of(
            "level", List.of("verifiedProficiency"),
            "recent", List.of("rolling7Days", "consistency"),
            "goals", List.of("goalSetByLearner", "learnerStated"),
            "grammar", List.of("grammar"),
            "vocabulary", List.of("vocabulary"),
            "exams", List.of("practiceEstimates"));

    private final EchoLearnerBrain brain;
    private final ObjectMapper mapper;

    public LearnerProfileTool(EchoLearnerBrain brain, ObjectMapper mapper) { this.brain = brain; this.mapper = mapper; }

    public String name() { return "get_learner_profile"; }
    public String description() {
        return "Read this learner's own evidence-labelled profile: verified CEFR level per skill (Proficiency Engine), rolling "
                + "7-day practice signals, the goal and target they set (a target, not a level), stored exam-simulation estimates, "
                + "grammar mastery and recurring mistake tags, due vocabulary and study streak. Use before diagnosing weaknesses, "
                + "comparing recent work with long-term ability, or planning.";
    }
    public Map<String, Object> parameters() {
        return EchoToolRegistry.schema(Map.of("section", EchoToolRegistry.enumOf("Part to read; all when omitted",
                List.of("all", "level", "recent", "goals", "grammar", "vocabulary", "exams"))), List.of());
    }
    public Kind kind() { return Kind.READ; }
    @Override public boolean readOnlyTransaction() { return false; } // each profile section owns a read-only transaction
    public String status(boolean vi) { return vi ? "Echo đang xem hồ sơ học tập của bạn…" : "Echo is reading your learning profile…"; }

    public String run(EchoTurn turn, JsonNode args) throws Exception {
        String section = args.path("section").asText("all");
        boolean full = !section.equals("level") && !section.equals("goals");
        JsonNode all = mapper.readTree(brain.snapshot(turn.userId(), full,
                section.equals("exams") || EchoRouter.examPracticeFocus(turn.userText())).json());
        if (!SECTIONS.containsKey(section)) return all.toString();
        ObjectNode out = mapper.createObjectNode();
        for (String key : SECTIONS.get(section)) if (all.has(key)) out.set(key, all.get(key));
        if (all.has("unknown")) out.set("unknown", all.get("unknown"));
        return out.toString();
    }
}
