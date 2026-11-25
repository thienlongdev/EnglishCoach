package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoAction;
import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.echo.EchoDestinations;
import com.englishcoach.ai.echo.EchoRouter;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.ai.echo.camel.CaMeLPolicyEngine;
import com.englishcoach.ai.service.EchoPolicy;
import com.englishcoach.speaking.dto.SpeakingScenarioSummaryDto;
import com.englishcoach.speaking.entity.enums.CefrLevel;
import com.englishcoach.speaking.entity.enums.ScenarioCategory;
import com.englishcoach.speaking.service.SpeakingScenarioService;
import com.englishcoach.speaking.topic.TopicDtos;
import com.englishcoach.speaking.topic.TopicException;
import com.englishcoach.speaking.topic.TopicService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Principal-scoped Speaking tools:
 * - {@code search_speaking_scenarios}: searches SYSTEM and the learner's own Roleplay scenarios.
 * - {@code draw_speaking_topic}: draws a curated English speaking prompt from {@link TopicService} (0 AI quota).
 */
@Component
public class SpeakingScenarioTool implements EchoTool {
    private final ObjectProvider<SpeakingScenarioService> scenarios;
    private final ObjectMapper mapper;

    public SpeakingScenarioTool(ObjectProvider<SpeakingScenarioService> scenarios, ObjectMapper mapper) {
        this.scenarios = scenarios;
        this.mapper = mapper;
    }

    @Override public String name() { return "search_speaking_scenarios"; }
    @Override public String description() {
        return "Search real Speaking Roleplay scenarios visible to this learner (system scenarios plus their own custom scenarios) "
                + "by CEFR level, category or topic keywords. Returns up to 5 scenarios with id, title, level, category and roles. "
                + "Use before opening speaking_roleplay via open_page.";
    }
    @Override public Map<String, Object> parameters() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("query", EchoToolRegistry.str("Optional topic or situation words", 80));
        props.put("level", EchoToolRegistry.enumOf("Optional CEFR level", List.of("A1", "A2", "B1", "B2", "C1", "C2")));
        props.put("category", EchoToolRegistry.enumOf("Optional scenario category",
                List.of("TRAVEL", "DAILY_LIFE", "BUSINESS", "WORK", "ACADEMIC", "CASUAL")));
        return EchoToolRegistry.schema(props, List.of());
    }
    @Override public Kind kind() { return Kind.READ; }
    @Override public String status(boolean vi) { return vi ? "Echo đang tìm tình huống luyện nói…" : "Echo is finding speaking scenarios…"; }

    @Override
    public String run(EchoTurn turn, JsonNode args) {
        SpeakingScenarioService svc = scenarios.getIfAvailable();
        if (svc == null) return "{\"error\":\"unavailable\"}";
        CefrLevel cefr = args.has("level") ? CefrLevel.fromString(args.get("level").asText()) : null;
        ScenarioCategory cat = args.has("category") ? ScenarioCategory.valueOf(args.get("category").asText()) : null;
        String query = args.path("query").asText(null);
        List<String> words = queryWords(query);

        List<SpeakingScenarioSummaryDto> all = svc.getScenarios(turn.userId(), cefr, cat);
        List<SpeakingScenarioSummaryDto> matched = all.stream()
                .filter(s -> words.isEmpty() || words.stream().anyMatch(w -> matchesScenario(s, w)))
                .limit(5)
                .toList();

        ObjectNode out = mapper.createObjectNode();
        ArrayNode list = out.putArray("scenarios");
        List<EchoCard.Item> items = new ArrayList<>();
        for (SpeakingScenarioSummaryDto s : matched) {
            String lvl = s.cefrLevel() == null ? "" : s.cefrLevel();
            String category = s.category() == null ? "" : s.category();
            list.addObject()
                    .put("id", s.id())
                    .put("title", clip(s.title(), 80))
                    .put("level", lvl)
                    .put("category", category)
                    .put("aiRole", clip(s.aiRole(), 60))
                    .put("learnerRole", clip(s.learnerRole(), 60));
            String href = "/speaking/roleplay/" + s.id();
            turn.authorizeResourceHref(href);
            String subtitle = s.aiRole() == null ? "" : turn.t("Vai đối thoại: ", "Partner: ") + clip(s.aiRole(), 50);
            String meta = (lvl.isEmpty() ? "" : lvl + " · ") + category;
            items.add(new EchoCard.Item(clip(s.title(), 80), subtitle, meta, href, null));
        }
        if (matched.isEmpty()) {
            out.put("note", "no speaking scenario matched; widen the level or category, or open speaking_roleplay_hub");
        } else {
            turn.card(EchoCard.of("resources", turn.t("Tình huống nhập vai gợi ý", "Suggested roleplay scenarios"), items, null));
            SpeakingScenarioSummaryDto best = matched.get(0);
            String href = "/speaking/roleplay/" + best.id();
            if (CaMeLPolicyEngine.canSearchToolAutoOpenItem(turn, EchoDestinations.Dest.SPEAKING_ROLEPLAY, href)) {
                turn.action(EchoAction.navigate(href, clip(best.title(), 80), true));
                if (CaMeLPolicyEngine.isWorkRoute(turn.page(), href)) {
                    out.put("opened", false);
                    out.put("awaitingConfirmation", true);
                    out.put("reason", "active_work_route");
                } else {
                    out.put("opened", true);
                    out.put("autoOpened", true);
                    out.put("openedScenarioId", best.id());
                    out.put("openedHref", href);
                }
            }
        }
        return out.toString();
    }

    private static boolean matchesScenario(SpeakingScenarioSummaryDto s, String word) {
        String hay = EchoPolicy.normalize(
                Objects.toString(s.title(), "") + " " + Objects.toString(s.description(), "") + " "
                + Objects.toString(s.learnerRole(), "") + " " + Objects.toString(s.aiRole(), "") + " "
                + Objects.toString(s.category(), ""));
        return hay.contains(word);
    }

    private static List<String> queryWords(String query) {
        if (query == null || query.isBlank()) return List.of();
        return Arrays.stream(EchoPolicy.normalize(query).split(" "))
                .filter(w -> w.length() >= 3 && w.matches("[a-z0-9]+"))
                .limit(5)
                .toList();
    }

    static String clip(String s, int max) {
        return s == null ? "" : s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }

    /** Deterministic zero-AI speaking topic draw for the authenticated learner. */
    @Component
    public static class DrawSpeakingTopicTool implements EchoTool {
        private final ObjectProvider<TopicService> topics;
        private final ObjectMapper mapper;

        public DrawSpeakingTopicTool(ObjectProvider<TopicService> topics, ObjectMapper mapper) {
            this.topics = topics;
            this.mapper = mapper;
        }

        @Override public String name() { return "draw_speaking_topic"; }
        @Override public String description() {
            return "Draw a curated English speaking topic prompt for this learner (styles: QUICK, DEEP, IELTS1, IELTS2, IELTS3; "
                    + "bands: BASIC, INTERMEDIATE, ADVANCED for QUICK/DEEP). Uses zero AI quota and returns the drawn questions.";
        }
        @Override public Map<String, Object> parameters() {
            Map<String, Object> props = new LinkedHashMap<>();
            props.put("style", EchoToolRegistry.enumOf("Topic style", List.of("QUICK", "DEEP", "IELTS1", "IELTS2", "IELTS3")));
            Map<String, Object> category = EchoToolRegistry.str("Optional topic category slug (e.g. work, travel, technology)", 40);
            category.put("pattern", "[a-z0-9-]{2,40}");
            props.put("category", category);
            props.put("band", EchoToolRegistry.enumOf("Optional difficulty band for QUICK or DEEP", List.of("BASIC", "INTERMEDIATE", "ADVANCED")));
            return EchoToolRegistry.schema(props, List.of());
        }
        @Override public Kind kind() { return Kind.READ; }
        @Override public boolean readOnlyTransaction() { return false; } // TopicService.draw records the draw in its own @Transactional
        @Override public String status(boolean vi) { return vi ? "Echo đang rút chủ đề luyện nói…" : "Echo is drawing a speaking topic…"; }

        @Override
        public String run(EchoTurn turn, JsonNode args) {
            TopicService svc = topics.getIfAvailable();
            if (svc == null) return "{\"error\":\"unavailable\"}";
            String style = args.path("style").asText("QUICK");
            String category = args.has("category") ? args.get("category").asText() : null;
            String band = args.has("band") ? args.get("band").asText() : null;
            TopicDtos.DrawResponse drawn;
            try {
                drawn = svc.draw(turn.userId(), new TopicDtos.DrawRequest(UUID.randomUUID(), style, category, band, null, null, true));
            } catch (TopicException ex) {
                String code = ex.getMessage() == null ? "unavailable" : ex.getMessage();
                if ("UNKNOWN_CATEGORY".equals(code) && category != null) {
                    drawn = svc.draw(turn.userId(), new TopicDtos.DrawRequest(UUID.randomUUID(), style, null, band, null, null, true));
                } else {
                    return "{\"error\":\"" + code.toLowerCase(Locale.ROOT) + "\"}";
                }
            }
            if (drawn == null || drawn.item() == null) {
                return "{\"outcome\":\"" + (drawn == null ? "EMPTY" : drawn.outcome()) + "\"}";
            }
            TopicDtos.ItemView item = drawn.item();
            ObjectNode out = mapper.createObjectNode()
                    .put("outcome", drawn.outcome())
                    .put("drawId", drawn.drawId() == null ? 0L : drawn.drawId())
                    .put("style", item.style())
                    .put("level", item.level() == null ? "" : item.level())
                    .put("title", item.title());
            ArrayNode questions = out.putArray("questions");
            List<EchoCard.Item> cardItems = new ArrayList<>();
            for (String q : item.questions() == null ? List.<String>of() : item.questions()) {
                questions.add(q);
                if (cardItems.size() < 4) {
                    cardItems.add(new EchoCard.Item(clip(q, 110), turn.vi() ? item.categoryVi() : item.categoryEn(), item.style(), "/speaking?mode=topic", null));
                }
            }
            if (!cardItems.isEmpty()) {
                turn.card(EchoCard.of("resources", turn.t("Chủ đề nói: ", "Speaking topic: ") + clip(item.title(), 60), cardItems, null));
            }
            String topicHref = EchoDestinations.Dest.SPEAKING_TOPIC.pattern();
            if (!turn.hasNavigateAction() && CaMeLPolicyEngine.canOfferNavigation(turn, EchoDestinations.Dest.SPEAKING_TOPIC, topicHref)) {
                boolean auto = CaMeLPolicyEngine.canAutoNavigate(turn, EchoDestinations.Dest.SPEAKING_TOPIC, topicHref);
                turn.action(EchoAction.navigate(topicHref, EchoDestinations.Dest.SPEAKING_TOPIC.label(turn.vi()), auto));
                if (auto && CaMeLPolicyEngine.isWorkRoute(turn.page(), topicHref)) {
                    out.put("opened", false).put("awaitingConfirmation", true).put("reason", "active_work_route");
                } else {
                    out.put("opened", auto);
                }
            }
            return out.toString();
        }
    }
}
