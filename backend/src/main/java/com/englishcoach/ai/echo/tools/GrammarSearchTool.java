package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.ai.service.EchoPolicy;
import com.englishcoach.grammar.GrammarContent;
import com.englishcoach.grammar.GrammarService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Lexical search of the authored Grammar Academy catalog (221 topics plus Grammar Stories, 257 Grammar Lab experiments
 * and Grammar Detective cases): the structured-retrieval layer (memory layer 2) for grammar. Deterministic, no embeddings,
 * no model. Only published topics and verifiable activities are returned, each with a validated destination.
 */
@Component
public class GrammarSearchTool implements EchoTool {
    private static final List<String> LEVELS = List.of("preA1", "A1", "A2", "B1", "B2", "C1");

    private final ObjectProvider<GrammarContent> content;
    private final ObjectProvider<GrammarService> service;
    private final ObjectMapper mapper;

    public GrammarSearchTool(ObjectProvider<GrammarContent> content, ObjectProvider<GrammarService> service, ObjectMapper mapper) {
        this.content = content; this.service = service; this.mapper = mapper;
    }

    public String name() { return "search_grammar_topics"; }
    public String description() {
        return "Find real Grammar Academy lessons, Stories, Grammar Lab experiments or Detective cases by topic words in English "
                + "or Vietnamese (e.g. 'second conditional', 'câu điều kiện', 'present perfect'). Returns up to 5 published items "
                + "with slug or activity id, title, CEFR level and learner status. Never guess a slug or id.";
    }
    public Map<String, Object> parameters() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("query", EchoToolRegistry.str("Topic words in English or Vietnamese", 80));
        props.put("level", EchoToolRegistry.enumOf("Optional CEFR level to prefer", List.of("A1", "A2", "B1", "B2", "C1")));
        props.put("kind", EchoToolRegistry.enumOf("Optional section filter", List.of("topics", "stories", "lab", "detective", "all")));
        return EchoToolRegistry.schema(props, List.of("query"));
    }
    public Kind kind() { return Kind.READ; }
    public String status(boolean vi) { return vi ? "Echo đang tìm bài ngữ pháp phù hợp…" : "Echo is finding matching grammar lessons…"; }

    public String run(EchoTurn turn, JsonNode args) {
        GrammarContent catalog = content.getIfAvailable();
        if (catalog == null) return "{\"error\":\"unavailable\"}";
        String query = args.path("query").asText();
        String level = args.path("level").asText(null);
        String kind = args.path("kind").asText(inferredKind(query));
        boolean includeTopics = "topics".equals(kind) || "all".equals(kind);
        boolean includeActivities = !"topics".equals(kind);

        ObjectNode out = mapper.createObjectNode();
        List<EchoCard.Item> items = new ArrayList<>();

        if (includeTopics) {
            Map<String, String> statuses = new HashMap<>();
            GrammarService grammar = service.getIfAvailable();
            if (grammar != null) {
                try { for (var s : grammar.me(turn.userId()).states()) statuses.put(s.slug(), s.status()); } catch (RuntimeException ignored) { }
            }
            List<Hit> hits = search(catalog.catalog(), query, level, catalog);
            ArrayNode topics = out.putArray("topics");
            for (Hit h : hits) {
                String status = statuses.getOrDefault(h.slug, "NOT_STARTED");
                topics.addObject().put("slug", h.slug).put("titleVi", h.vi).put("titleEn", h.en).put("level", h.level).put("learnerStatus", status);
                if (items.size() < 5) {
                    String topicHref = "/grammar/topics/" + h.slug;
                    turn.authorizeResourceHref(topicHref);
                    items.add(new EchoCard.Item(turn.vi() ? h.vi : h.en, turn.vi() ? h.en : h.vi, h.level + " · " + statusLabel(status, turn), topicHref, status));
                }
            }
            if (hits.isEmpty() && !includeActivities) {
                includeActivities = true;
            }
        }

        if (includeActivities) {
            List<String> sections = "all".equals(kind) || "topics".equals(kind)
                    ? List.of("stories", "lab", "detective")
                    : List.of(kind);
            List<ActivityHit> acts = searchActivities(catalog.catalog(), query, level, sections, catalog);
            if (!acts.isEmpty()) {
                ArrayNode activities = out.putArray("activities");
                for (ActivityHit a : acts) {
                    String href = "/grammar/" + a.section + "/" + a.id;
                    turn.authorizeResourceHref(href);
                    activities.addObject()
                            .put("kind", a.section)
                            .put("id", a.id)
                            .put("title", a.title)
                            .put("level", a.level)
                            .put("destination", destinationOf(a.section));
                    if (items.size() < 5) {
                        items.add(new EchoCard.Item(a.title, a.summary, a.level + " · " + sectionLabel(a.section, turn), href, null));
                    }
                }
            }
        }

        if (items.isEmpty()) {
            out.put("note", "no published topic or activity matched; suggest the Grammar Academy home or ask the learner to rephrase");
        } else {
            turn.card(EchoCard.of("resources", turn.t("Bài ngữ pháp phù hợp", "Matching grammar lessons"), items, null));
        }
        return out.toString();
    }

    private static String inferredKind(String query) {
        String q = EchoPolicy.normalize(query);
        if (q.matches(".*\\b(story|stories|truyen)\\b.*")) return "stories";
        if (q.matches(".*\\b(lab|thi nghiem)\\b.*")) return "lab";
        if (q.matches(".*\\b(detective|tham tu|vu an)\\b.*")) return "detective";
        return "topics";
    }

    private static String destinationOf(String section) {
        return switch (section) {
            case "stories" -> "grammar_story";
            case "lab" -> "grammar_lab_item";
            case "detective" -> "grammar_detective_case";
            default -> "grammar_topic";
        };
    }

    private static String sectionLabel(String section, EchoTurn turn) {
        return switch (section) {
            case "stories" -> turn.t("Truyện ngữ pháp", "Grammar story");
            case "lab" -> turn.t("Phòng thí nghiệm", "Grammar Lab");
            case "detective" -> turn.t("Thám tử ngữ pháp", "Grammar Detective");
            default -> turn.t("Bài ngữ pháp", "Grammar");
        };
    }

    record Hit(String slug, String vi, String en, String level, double score) {}
    record ActivityHit(String section, String id, String title, String summary, String level, double score) {}

    static List<Hit> search(JsonNode root, String query, String level, GrammarContent catalog) {
        String q = EchoPolicy.normalize(query);
        Set<String> qTokens = new LinkedHashSet<>(Arrays.asList(q.split(" ")));
        qTokens.removeIf(t -> t.length() < 2 || STOP.contains(t));
        List<Hit> hits = new ArrayList<>();
        for (JsonNode domain : root.path("domains")) {
            for (JsonNode topic : domain.path("topics")) {
                String slug = topic.path("slug").asText();
                if (catalog != null && catalog.meta(slug).isEmpty()) continue; // published topics only
                String vi = topic.path("title").path("vi").asText(slug), en = topic.path("title").path("en").asText(slug);
                StringBuilder hay = new StringBuilder(slug.replace('-', ' ')).append(' ').append(vi).append(' ').append(en)
                        .append(' ').append(topic.path("subtitle").path("en").asText("")).append(' ');
                List<String> aliases = new ArrayList<>();
                for (JsonNode a : topic.path("aliases")) aliases.add(EchoPolicy.normalize(a.asText()));
                String text = EchoPolicy.normalize(hay.toString());
                double score = 0;
                if (!q.isBlank() && (aliases.contains(q) || EchoPolicy.normalize(vi).equals(q) || EchoPolicy.normalize(en).equals(q))) score += 10;
                for (String a : aliases) if (!q.isBlank() && (a.contains(q) || (q.contains(a) && a.length() > 4))) score += 4;
                for (String t : qTokens) {
                    if ((" " + text + " ").contains(" " + t + " ")) score += 1.5;
                    else if (aliases.stream().anyMatch(a -> (" " + a + " ").contains(" " + t + " "))) score += 1.2;
                    else if (t.length() >= 4 && text.contains(t)) score += 0.6;
                }
                if (score <= 0) continue;
                String lvl = topic.path("level").asText("");
                if (level != null && level.equals(lvl)) score += 1.0;
                else if (level != null && LEVELS.contains(lvl) && LEVELS.contains(level)) score -= 0.3 * Math.abs(LEVELS.indexOf(lvl) - LEVELS.indexOf(level));
                hits.add(new Hit(slug, vi, en, lvl, score));
            }
        }
        hits.sort(Comparator.comparingDouble(Hit::score).reversed());
        double best = hits.isEmpty() ? 0 : hits.get(0).score();
        return hits.stream().filter(h -> h.score() >= Math.max(1.2, best * 0.35)).limit(5).toList();
    }

    static List<ActivityHit> searchActivities(JsonNode root, String query, String level, List<String> sections, GrammarContent catalog) {
        String q = EchoPolicy.normalize(query);
        Set<String> qTokens = new LinkedHashSet<>(Arrays.asList(q.split(" ")));
        qTokens.removeIf(t -> t.length() < 2 || STOP.contains(t) || ACTIVITY_STOP.contains(t));
        List<ActivityHit> hits = new ArrayList<>();
        for (String section : sections) {
            for (JsonNode item : root.path(section)) {
                String id = item.path("id").asText("");
                if (!id.matches("[a-z0-9-]{1,80}")) continue;
                if (catalog != null && catalog.resource(section, id).isEmpty()) continue;
                String title = item.path("title").asText(id);
                String summary = item.hasNonNull("summary") ? item.path("summary").asText("") : item.path("brief").asText("");
                StringBuilder hay = new StringBuilder(id.replace('-', ' ')).append(' ').append(title).append(' ').append(summary);
                for (JsonNode topicSlug : item.path("topics")) {
                    hay.append(' ').append(topicSlug.asText("").replace('-', ' '));
                }
                String text = EchoPolicy.normalize(hay.toString());
                double score = qTokens.isEmpty() ? 1.0 : 0.0;
                for (String t : qTokens) {
                    if ((" " + text + " ").contains(" " + t + " ")) score += 1.6;
                    else if (t.length() >= 4 && text.contains(t)) score += 0.7;
                }
                if (score <= 0) continue;
                String lvl = item.path("level").asText("");
                if (level != null && level.equals(lvl)) score += 1.2;
                else if (level != null && LEVELS.contains(lvl) && LEVELS.contains(level)) score -= 0.25 * Math.abs(LEVELS.indexOf(lvl) - LEVELS.indexOf(level));
                String clippedSummary = summary.length() <= 90 ? summary : summary.substring(0, 89) + "…";
                hits.add(new ActivityHit(section, id, title, clippedSummary, lvl, score));
            }
        }
        hits.sort(Comparator.comparingDouble(ActivityHit::score).reversed());
        return hits.stream().limit(5).toList();
    }

    private static final Set<String> STOP = Set.of("the", "and", "of", "in", "to", "a", "an", "ve", "cua", "cho", "bai", "hoc", "ngu",
            "phap", "grammar", "lesson", "topic", "chu", "diem", "cach", "dung", "use", "how", "khi", "nao", "la", "gi", "minh", "toi");
    private static final Set<String> ACTIVITY_STOP = Set.of("story", "stories", "truyen", "lab", "thi", "nghiem", "detective", "tham", "tu", "vu");

    private static String statusLabel(String status, EchoTurn turn) {
        return switch (status) {
            case "MASTERED" -> turn.t("đã thành thạo", "mastered");
            case "REVIEW_DUE", "NEEDS_REVIEW" -> turn.t("cần ôn lại", "review due");
            case "READY" -> turn.t("sẵn sàng kiểm tra", "ready for a check");
            case "PRACTISING" -> turn.t("đang luyện", "practising");
            case "STUDIED", "OPENED" -> turn.t("đã mở", "opened");
            default -> turn.t("chưa học", "not started");
        };
    }
}
