package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoAction;
import com.englishcoach.ai.echo.EchoDestinations;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.ai.echo.camel.CaMeLPolicyEngine;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Validated navigation. The model names a destination from a fixed enumeration plus typed parameters; the route registry
 * builds the href after checking the target exists and is visible to this learner. CaMeL provenance ensures indirect
 * prompt injections inside reading passages can never auto-navigate or open unauthorized pages.
 */
@Component
public class OpenPageTool implements EchoTool {
    private final EchoDestinations destinations;
    private final ObjectMapper mapper;

    public OpenPageTool(EchoDestinations destinations, ObjectMapper mapper) { this.destinations = destinations; this.mapper = mapper; }

    public String name() { return "open_page"; }
    public String description() {
        return "Open a real English Coach page for the learner. destination is one of the listed screens; grammar_topic / "
                + "grammar_story / grammar_lab_item / grammar_detective_case need grammar_slug or activity_id (from search_grammar_topics), "
                + "reading_material / listening_lesson / dictation / speaking_shadowing_lesson need lesson_id, speaking_roleplay needs "
                + "scenario_id (or lesson_id), speaking_profile / speaking_pronunciation / speaking_history open Speaking analytics tabs, "
                + "flashcards_deck needs deck_id (or lesson_id), exams_family needs family, cosmos_word needs word. "
                + "Opens immediately only if the learner asked to open it.";
    }
    public Map<String, Object> parameters() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("destination", EchoToolRegistry.enumOf("Screen to open", EchoDestinations.names()));
        Map<String, Object> slug = EchoToolRegistry.str("Grammar topic slug or activity id", 80);
        slug.put("pattern", "[a-z0-9-]{1,80}");
        props.put("grammar_slug", slug);
        Map<String, Object> activityId = EchoToolRegistry.str("Grammar story, lab or detective id", 80);
        activityId.put("pattern", "[a-z0-9-]{1,80}");
        props.put("activity_id", activityId);
        props.put("lesson_id", EchoToolRegistry.integer("Reading text, Listening lesson, or Shadowing lesson id", 1, 2_000_000_000));
        props.put("scenario_id", EchoToolRegistry.integer("Speaking roleplay scenario id", 1, 2_000_000_000));
        props.put("deck_id", EchoToolRegistry.integer("Flashcard deck id", 1, 2_000_000_000));
        props.put("family", EchoToolRegistry.enumOf("Exam family", List.of("ielts", "toeic")));
        Map<String, Object> word = EchoToolRegistry.str("English word for the Knowledge Universe", 40);
        word.put("pattern", "[A-Za-z][A-Za-z' -]{0,39}");
        props.put("word", word);
        return EchoToolRegistry.schema(props, List.of("destination"));
    }
    public Kind kind() { return Kind.NAVIGATE; }
    public String status(boolean vi) { return vi ? "Echo đang chuẩn bị trang…" : "Echo is preparing the page…"; }

    public String run(EchoTurn turn, JsonNode args) throws Exception {
        var dest = EchoDestinations.parse(args.path("destination").asText()).orElse(null);
        if (dest == null) return "{\"error\":\"unknown_destination\"}";
        if (dest == EchoDestinations.Dest.EXAMS && args.hasNonNull("family") && !args.get("family").asText("").isBlank()) {
            dest = EchoDestinations.Dest.EXAMS_FAMILY;
        }
        Long id = null;
        if (args.has("lesson_id")) id = args.get("lesson_id").asLong();
        else if (args.has("scenario_id")) id = args.get("scenario_id").asLong();
        else if (args.has("deck_id")) id = args.get("deck_id").asLong();
        String slug = args.has("grammar_slug") ? args.get("grammar_slug").asText(null)
                : args.path("activity_id").asText(null);
        var resolved = destinations.resolve(turn.userId(), dest, slug, id,
                args.path("word").asText(null), args.path("family").asText(null), turn.vi());
        if (!resolved.ok()) return mapper.writeValueAsString(Map.of("opened", false, "reason", resolved.reason()));
        if (!CaMeLPolicyEngine.canOfferNavigation(turn, dest, resolved.href())) {
            return mapper.writeValueAsString(Map.of("opened", false, "offeredButton", false, "reason", "not_authorized_by_learner"));
        }
        boolean auto = CaMeLPolicyEngine.canAutoNavigate(turn, dest, resolved.href());
        if (auto && CaMeLPolicyEngine.isWorkRoute(turn.page(), resolved.href())) {
            turn.action(EchoAction.navigate(resolved.href(), resolved.label(), true));
            return mapper.writeValueAsString(Map.of(
                    "opened", false,
                    "awaitingConfirmation", true,
                    "reason", "active_work_route",
                    "label", resolved.label()));
        }
        turn.action(EchoAction.navigate(resolved.href(), resolved.label(), auto));
        return mapper.writeValueAsString(Map.of("opened", auto, "offeredButton", !auto, "label", resolved.label()));
    }
}
