package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoAction;
import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.echo.EchoDestinations;
import com.englishcoach.ai.echo.EchoLearnerBrain;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.ai.echo.camel.CaMeLPolicyEngine;
import com.englishcoach.speaking.shadowing.ShadowingCatalogPageDto;
import com.englishcoach.speaking.shadowing.ShadowingMaterialCardDto;
import com.englishcoach.speaking.shadowing.SpeakingShadowingCatalogService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Grounded read-only Shadowing catalog search tool ({@code search_shadowing_lessons}).
 * Enforces P0 user data isolation via {@link SpeakingShadowingCatalogService#getCatalog} (SYSTEM {@code is_system=true AND owner_user_id IS NULL}
 * plus learner private {@code is_system=false AND owner_user_id=:userId}; DOCUMENT and quarantined legacy rows excluded).
 */
@Component
public class ShadowingSearchTool implements EchoTool {

    private static final Set<String> VALID_CEFR = Set.of("A1", "A2", "B1", "B2", "C1", "C2");

    private final ObjectProvider<SpeakingShadowingCatalogService> catalog;
    private final ObjectProvider<EchoLearnerBrain> brain;
    private final ObjectMapper mapper;

    public ShadowingSearchTool(ObjectProvider<SpeakingShadowingCatalogService> catalog,
                               ObjectProvider<EchoLearnerBrain> brain,
                               ObjectMapper mapper) {
        this.catalog = catalog;
        this.brain = brain;
        this.mapper = mapper;
    }

    @Override
    public String name() {
        return "search_shadowing_lessons";
    }

    @Override
    public String description() {
        return "Search real playable Shadowing lessons visible to this learner (system + personal uploads, excluding non-audio documents) "
                + "by topic/title query, CEFR level (A1-C2), accent, or source (ALL, SYSTEM, USER). Returns up to 5 playable cards.";
    }

    @Override
    public Map<String, Object> parameters() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("query", EchoToolRegistry.str("Optional topic, title, or channel keywords", 80));
        props.put("level", EchoToolRegistry.enumOf("Optional CEFR level", List.of("A1", "A2", "B1", "B2", "C1", "C2")));
        props.put("accent", EchoToolRegistry.str("Optional accent filter (e.g. us, uk, au)", 30));
        props.put("source", EchoToolRegistry.enumOf("Catalog source filter", List.of("ALL", "SYSTEM", "USER")));
        return EchoToolRegistry.schema(props, List.of());
    }

    @Override
    public Kind kind() {
        return Kind.READ;
    }

    @Override
    public boolean readOnlyTransaction() {
        // SpeakingShadowingCatalogService manages its own @Transactional(readOnly = true)
        return false;
    }

    @Override
    public boolean parallelizableRead() {
        return true;
    }

    @Override
    public String status(boolean vi) {
        return vi ? "Echo đang tìm bài luyện Shadowing phù hợp…" : "Echo is searching Shadowing lessons…";
    }

    @Override
    public String run(EchoTurn turn, JsonNode args) throws Exception {
        SpeakingShadowingCatalogService svc = catalog.getIfAvailable();
        if (svc == null) return "{\"error\":\"unavailable\"}";

        String query = args.has("query") ? args.get("query").asText(null) : null;
        String explicitLevel = args.has("level") ? args.get("level").asText(null) : null;
        String accent = args.has("accent") ? args.get("accent").asText(null) : null;
        String source = args.path("source").asText("ALL");

        String effectiveLevel = explicitLevel;
        if (effectiveLevel == null) {
            EchoLearnerBrain b = brain == null ? null : brain.getIfAvailable();
            if (b != null) {
                try {
                    String candidateCefr = b.snapshot(turn.userId(), false, false).levelCefr();
                    if (candidateCefr != null && VALID_CEFR.contains(candidateCefr.toUpperCase(Locale.ROOT))) {
                        effectiveLevel = candidateCefr.toUpperCase(Locale.ROOT);
                    }
                } catch (RuntimeException ignored) { }
            }
        }

        boolean widened = false;
        ShadowingCatalogPageDto page = svc.getCatalog(turn.userId(), 0, 5, effectiveLevel, accent, source, query);
        if (page.content().isEmpty() && query != null && !query.isBlank()) {
            // Widen once with q = null at the requested/verified CEFR level so "suitable shadowing for my level" always finds playable cards
            page = svc.getCatalog(turn.userId(), 0, 5, effectiveLevel, accent, source, null);
            widened = true;
        }
        if (page.content().isEmpty() && explicitLevel == null && effectiveLevel != null) {
            page = svc.getCatalog(turn.userId(), 0, 5, null, accent, source, null);
            widened = true;
        }

        ObjectNode out = mapper.createObjectNode();
        if (effectiveLevel != null) out.put("levelUsed", effectiveLevel);
        if (widened) out.put("widenedSearch", true);
        ArrayNode arr = out.putArray("lessons");
        List<EchoCard.Item> cardItems = new ArrayList<>();

        for (ShadowingMaterialCardDto c : page.content()) {
            String href = "/speaking/shadowing/" + c.id();
            turn.authorizeResourceHref(href);
            String lvl = c.cefrLevel() == null ? "" : c.cefrLevel();
            String dur = c.durationSeconds() > 0 ? Math.max(1, c.durationSeconds() / 60) + " min" : "";
            String meta = (lvl.isEmpty() ? "" : lvl)
                    + (!lvl.isEmpty() && !dur.isEmpty() ? " · " : "")
                    + dur;
            arr.addObject()
                    .put("id", c.id())
                    .put("title", clip(c.title(), 80))
                    .put("level", lvl.isEmpty() ? "unknown" : lvl)
                    .put("topic", c.topic() == null ? "" : clip(c.topic(), 50))
                    .put("accent", c.accent() == null ? "" : c.accent())
                    .put("durationSeconds", c.durationSeconds())
                    .put("isSystem", c.isSystem());
            cardItems.add(new EchoCard.Item(
                    clip(c.title(), 80),
                    c.topic() == null || c.topic().isBlank() ? (c.channel() == null ? "" : clip(c.channel(), 50)) : clip(c.topic(), 50),
                    meta,
                    href,
                    null));
        }

        if (page.content().isEmpty()) {
            out.put("note", "no playable shadowing lesson matched; suggest opening speaking_shadowing hub");
        } else {
            turn.card(EchoCard.of("resources",
                    turn.t("Bài luyện Shadowing gợi ý", "Suggested Shadowing lessons"),
                    cardItems,
                    null));
            ShadowingMaterialCardDto best = page.content().get(0);
            String bestHref = "/speaking/shadowing/" + best.id();
            if (CaMeLPolicyEngine.canSearchToolAutoOpenItem(turn, EchoDestinations.Dest.SPEAKING_SHADOWING_LESSON, bestHref)) {
                turn.action(EchoAction.navigate(bestHref, clip(best.title(), 80), true));
                if (CaMeLPolicyEngine.isWorkRoute(turn.page(), bestHref)) {
                    out.put("opened", false);
                    out.put("awaitingConfirmation", true);
                    out.put("reason", "active_work_route");
                } else {
                    out.put("opened", true);
                    out.put("openedLessonId", best.id());
                }
            }
        }
        return out.toString();
    }

    private static String clip(String s, int max) {
        return s == null ? "" : s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }
}
