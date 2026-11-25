package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.grammar.GrammarContent;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Authored practice items of one grammar topic for an in-chat mini-check, so Echo checks the learner with reviewed items
 * and their keys instead of inventing exercises. Only {@code use: practice} items (choice / cloze): check-only items never
 * leave the Grammar module. Nothing is recorded: an Echo mini-check is aided practice and never Grammar evidence.
 */
@Component
public class GrammarPracticeTool implements EchoTool {
    private final ObjectProvider<GrammarContent> content;
    private final ObjectMapper mapper;

    public GrammarPracticeTool(ObjectProvider<GrammarContent> content, ObjectMapper mapper) { this.content = content; this.mapper = mapper; }

    public String name() { return "get_grammar_practice"; }
    public String description() {
        return "Use ONLY when the learner explicitly asks for a quiz or practice check. "
                + "Get 1-3 authored practice items (with answer keys) of one Grammar Academy topic for a short independent mini-check "
                + "in the chat. Ask the learner the item WITHOUT revealing the key, wait for their answer, then mark it with the key. "
                + "Needs a slug from search_grammar_topics.";
    }
    public Map<String, Object> parameters() {
        Map<String, Object> props = new LinkedHashMap<>();
        Map<String, Object> slug = EchoToolRegistry.str("Topic slug from search_grammar_topics", 80);
        slug.put("pattern", "[a-z0-9-]{1,80}");
        props.put("topic_slug", slug);
        props.put("count", EchoToolRegistry.integer("How many items (1-3)", 1, 3));
        return EchoToolRegistry.schema(props, List.of("topic_slug"));
    }
    public Kind kind() { return Kind.READ; }
    public String status(boolean vi) { return vi ? "Echo đang chọn câu luyện tập…" : "Echo is picking practice items…"; }

    public String run(EchoTurn turn, JsonNode args) {
        GrammarContent catalog = content.getIfAvailable();
        String slug = args.path("topic_slug").asText();
        if (catalog == null || catalog.meta(slug).isEmpty()) return "{\"error\":\"unknown_topic\"}";
        int count = Math.max(1, Math.min(3, args.path("count").asInt(2)));
        List<JsonNode> pool = new ArrayList<>();
        for (JsonNode ex : catalog.load(slug).exercises().values()) {
            String type = ex.path("type").asText();
            if ("practice".equals(ex.path("use").asText()) && ("choice".equals(type) || "cloze".equals(type))) pool.add(ex);
        }
        Collections.shuffle(pool, new Random(Objects.hash(turn.userId(), slug, System.currentTimeMillis() / 600_000)));
        ObjectNode out = mapper.createObjectNode().put("topic", slug).put("instruction",
                "Present one item at a time without the key; mark the learner's own answer; this is practice only, never a score.");
        ArrayNode items = out.putArray("items");
        for (JsonNode ex : pool.subList(0, Math.min(count, pool.size()))) {
            ObjectNode item = items.addObject().put("type", ex.path("type").asText()).put("instruction", text(ex.path("prompt")))
                    .put("stem", text(ex.path("stem"))).put("explanation", text(ex.path("explain")));
            if ("choice".equals(ex.path("type").asText())) {
                ArrayNode options = item.putArray("options");
                for (JsonNode o : ex.path("options")) {
                    options.add(text(o.path("t")));
                    if (o.path("ok").asBoolean(false)) item.put("key", text(o.path("t")));
                }
            } else {
                ArrayNode keys = item.putArray("acceptedAnswers");
                ex.path("blanks").fields().forEachRemaining(b -> b.getValue().path("accept").forEach(a -> keys.add(text(a))));
            }
        }
        if (items.isEmpty()) out.put("note", "this topic has no short practice items; explain and ask an open question instead");
        return out.toString();
    }

    private static String text(JsonNode n) {
        String s = n == null || n.isMissingNode() || n.isNull() ? "" : n.asText("");
        return s.length() <= 300 ? s : s.substring(0, 299) + "…";
    }
}
