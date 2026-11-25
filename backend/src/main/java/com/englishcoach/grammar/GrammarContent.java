package com.englishcoach.grammar;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.util.*;

/**
 * The curated curriculum, read from the classpath ({@code grammar/**}) and versioned with the backend image: no rows, no
 * seeding, no generation at runtime. Only the small catalog stays in memory; a topic file is parsed when asked for and a
 * bounded number stay cached, so a large curriculum costs the VPS little. Only {@link #learnerTopic} and its siblings
 * leave the server: answer keys, notes and tags stay here until an answer has been submitted.
 */
@Component
public class GrammarContent {

    private static final Logger log = LoggerFactory.getLogger(GrammarContent.class);
    private static final String ROOT = "grammar/";
    private static final int CACHED = 48;

    public record TopicMeta(String slug, String domain, String domainKind, int version, String level, String kind, boolean available,
                            List<String> prerequisites, int path, int checkItems, boolean ielts, boolean toeic, String titleVi,
                            String learningRole) {}

    public record Loaded(JsonNode topic, Map<String, JsonNode> exercises, String learnerJson, String etag) {}

    private final ObjectMapper mapper;
    private final JsonNode catalog;
    private final String catalogJson;
    private final String revision;
    private final Map<String, TopicMeta> topics = new LinkedHashMap<>();
    private final Map<String, String> exerciseIndex = new HashMap<>();
    private volatile Set<String> practiceIds;
    private final Map<String, Loaded> cache = Collections.synchronizedMap(new LinkedHashMap<>(CACHED, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Loaded> eldest) {
            return size() > CACHED;
        }
    });

    public GrammarContent(ObjectMapper mapper) {
        this.mapper = mapper;
        JsonNode root = read(ROOT + "catalog.json");
        if (root == null) throw new IllegalStateException("grammar/catalog.json is missing: run scripts/grammar/build-catalog.mjs");
        this.revision = root.path("revision").asText("0");
        for (JsonNode d : root.path("domains")) {
            for (JsonNode t : d.path("topics")) {
                List<String> prereq = new ArrayList<>();
                for (JsonNode p : t.path("prerequisites")) prereq.add(p.asText());
                topics.put(t.path("slug").asText(), new TopicMeta(t.path("slug").asText(), d.path("id").asText(), d.path("kind").asText("grammar"),
                        t.path("version").asInt(1), t.path("level").asText(), t.path("kind").asText("grammar"), t.path("available").asBoolean(false),
                        List.copyOf(prereq), t.path("path").asInt(Integer.MAX_VALUE), t.path("checkItems").asInt(0),
                        t.path("exam").path("ielts").asBoolean(false), t.path("exam").path("toeic").asBoolean(false), t.path("title").path("vi").asText(),
                        t.path("learningRole").asText("core")));
            }
        }
        for (Iterator<Map.Entry<String, JsonNode>> it = root.path("exerciseIndex").fields(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> e = it.next();
            exerciseIndex.put(e.getKey(), e.getValue().asText());
        }
        // The browser never needs the exercise → topic map.
        ObjectNode publicCatalog = root.deepCopy();
        publicCatalog.remove("exerciseIndex");
        this.catalog = publicCatalog;
        try {
            this.catalogJson = mapper.writeValueAsString(publicCatalog);
        } catch (IOException e) {
            throw new IllegalStateException("grammar catalog serialisation", e);
        }
        log.info("Grammar catalog {}: {} topics available of {}", revision, topics.values().stream().filter(TopicMeta::available).count(), topics.size());
    }

    public String revision() { return revision; }

    public String catalogJson() { return catalogJson; }

    public JsonNode catalog() { return catalog; }

    public Collection<TopicMeta> topics() { return topics.values(); }

    public Optional<TopicMeta> meta(String slug) { return Optional.ofNullable(topics.get(slug)).filter(TopicMeta::available); }

    public Optional<String> topicOfExercise(String exerciseId) { return Optional.ofNullable(exerciseIndex.get(exerciseId)); }

    public Loaded load(String slug) {
        TopicMeta meta = meta(slug).orElseThrow(() -> new GrammarException(404, "NOT_FOUND"));
        Loaded hit = cache.get(slug);
        if (hit != null) return hit;
        JsonNode topic = read(ROOT + "topics/" + meta.domain() + "/" + slug + ".json");
        if (topic == null) throw new GrammarException(404, "NOT_FOUND");
        Map<String, JsonNode> exercises = new LinkedHashMap<>();
        for (JsonNode ex : topic.path("exercises")) exercises.put(ex.path("id").asText(), presentationExercise(ex));
        ObjectNode learner = topic.deepCopy();
        ArrayNode safe = mapper.createArrayNode();
        // Check-only items never reach the page: a check issues them one by one, so their answers stay unseen.
        for (JsonNode ex : exercises.values()) if (!"check".equals(ex.path("use").asText())) safe.add(learnerExercise(ex));
        learner.set("exercises", safe);
        String json;
        try {
            json = mapper.writeValueAsString(learner);
        } catch (IOException e) {
            throw new IllegalStateException("grammar topic serialisation", e);
        }
        Loaded loaded = new Loaded(topic, exercises, json, "\"g2-" + revision + "-" + slug + "\"");
        cache.put(slug, loaded);
        return loaded;
    }

    public JsonNode exercise(String exerciseId) {
        String slug = topicOfExercise(exerciseId).orElseThrow(() -> new GrammarException(404, "NOT_FOUND"));
        JsonNode ex = load(slug).exercises().get(exerciseId);
        if (ex == null) throw new GrammarException(404, "NOT_FOUND");
        return ex;
    }

    /** Eligibility is content-owned. Cache the small ID set once; SQL filters it BEFORE ranking/limiting mistakes. */
    public Set<String> practiceExerciseIds() {
        Set<String> ids = practiceIds;
        if (ids != null) return ids;
        synchronized (this) {
            if (practiceIds == null) {
                Set<String> built = new HashSet<>();
                for (TopicMeta meta : topics.values()) if (meta.available()) {
                    for (JsonNode ex : load(meta.slug()).exercises().values())
                        if (!"check".equals(ex.path("use").asText())) built.add(ex.path("id").asText());
                }
                practiceIds = Set.copyOf(built);
            }
            return practiceIds;
        }
    }

    /**
     * Presentation indices must carry no information about authors' answer positions (often correct-first).
     * Canonicalise by VISIBLE fields only before assigning indices. The private, re-ordered key travels with
     * the check snapshot. Public display shuffling can be reproduced, but only recovers the visible alphabetical
     * order, never the author's order. No secret, process-local map or mutable resource file is needed.
     */
    static JsonNode presentationExercise(JsonNode authored) {
        ObjectNode ex = authored.deepCopy();
        String field = switch (ex.path("type").asText()) {
            case "choice", "multi" -> "options";
            case "classify" -> "items";
            default -> null;
        };
        if (field != null) {
            List<JsonNode> ordered = new ArrayList<>();
            ex.path(field).forEach(ordered::add);
            ordered.sort(Comparator.comparing(n -> n.path("t").asText() + "\u0000" + n.path("diagram").toString()));
            ArrayNode array = ex.putArray(field);
            ordered.forEach(array::add);
        }
        return ex;
    }

    /** Stories, Lab experiments and Detective cases carry no graded evidence, so they are served whole. */
    public Optional<String> resource(String kind, String id) {
        if (!Set.of("stories", "lab", "detective").contains(kind) || !id.matches("[a-z0-9-]{1,80}")) return Optional.empty();
        JsonNode node = read(ROOT + kind + "/" + id + ".json");
        if (node == null) return Optional.empty();
        try {
            return Optional.of(mapper.writeValueAsString(node));
        } catch (IOException e) {
            throw new IllegalStateException("grammar resource serialisation", e);
        }
    }

    /** What a learner may see before answering: an allow-list, so a new key field can never leak by accident. */
    public ObjectNode learnerExercise(JsonNode ex) {
        ObjectNode out = mapper.createObjectNode();
        for (String field : List.of("id", "type", "level", "use", "skill", "prompt", "context", "turns", "stem", "instruction", "source", "task", "end")) {
            if (ex.has(field)) out.set(field, ex.get(field));
        }
        Random shuffle = new Random(ex.path("id").asText().hashCode() * 31L + 17);
        switch (ex.path("type").asText()) {
            case "choice", "multi" -> {
                List<ObjectNode> options = new ArrayList<>();
                int i = 0;
                for (JsonNode o : ex.path("options")) {
                    ObjectNode safe = mapper.createObjectNode().put("i", i++);
                    if (o.has("t")) safe.set("t", o.get("t"));
                    if (o.has("diagram")) safe.set("diagram", o.get("diagram"));
                    options.add(safe);
                }
                Collections.shuffle(options, shuffle);
                out.set("options", mapper.valueToTree(options));
            }
            case "cloze" -> {
                ObjectNode blanks = mapper.createObjectNode();
                for (Iterator<Map.Entry<String, JsonNode>> it = ex.path("blanks").fields(); it.hasNext(); ) {
                    Map.Entry<String, JsonNode> b = it.next();
                    ObjectNode safe = mapper.createObjectNode();
                    if (b.getValue().has("hint")) safe.set("hint", b.getValue().get("hint"));
                    blanks.set(b.getKey(), safe);
                }
                out.set("blanks", blanks);
            }
            case "order" -> {
                List<String> tokens = new ArrayList<>();
                for (JsonNode t : ex.path("tokens")) tokens.add(t.asText());
                // Remove authored order before a publicly reproducible display permutation.
                Collections.sort(tokens);
                // Do not condition a reproducible shuffle on the key: skipping a permutation would reveal
                // that the skipped order was accepted. The learner still builds a sentence from an empty tray.
                Collections.shuffle(tokens, shuffle);
                out.set("tokens", mapper.valueToTree(tokens));
            }
            case "error" -> {
                ArrayNode segments = mapper.createArrayNode();
                for (JsonNode s : ex.path("segments")) segments.add(mapper.createObjectNode().put("t", s.path("t").asText()));
                out.set("segments", segments);
            }
            case "match" -> {
                ArrayNode left = mapper.createArrayNode();
                List<String> right = new ArrayList<>();
                for (JsonNode p : ex.path("pairs")) {
                    left.add(p.path("a").asText());
                    right.add(p.path("b").asText());
                }
                // A public seed must never let a learner invert the authored left/right correspondence.
                Collections.sort(right);
                Collections.shuffle(right, shuffle);
                out.set("left", left);
                out.set("right", mapper.valueToTree(right));
            }
            case "classify" -> {
                out.set("cats", ex.path("cats"));
                List<ObjectNode> items = new ArrayList<>();
                int i = 0;
                for (JsonNode it : ex.path("items")) items.add(mapper.createObjectNode().put("i", i++).put("t", it.path("t").asText()));
                Collections.shuffle(items, shuffle);
                out.set("items", mapper.valueToTree(items));
            }
            default -> { /* transform, open: the allow-listed fields say everything */ }
        }
        return out;
    }

    private JsonNode read(String resource) {
        try (InputStream in = getClass().getClassLoader().getResourceAsStream(resource)) {
            return in == null ? null : mapper.readTree(in);
        } catch (IOException e) {
            log.warn("Grammar resource unreadable: {}", resource);
            return null;
        }
    }
}
