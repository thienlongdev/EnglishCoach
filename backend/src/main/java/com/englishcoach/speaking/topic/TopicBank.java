package com.englishcoach.speaking.topic;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.InputStream;
import java.text.Normalizer;
import java.util.*;
import java.util.regex.Pattern;

/**
 * The curated English question bank of "Nói theo chủ đề", loaded once from the classpath ({@code speaking/topics/*.json}).
 * It is immutable for the life of the process and versioned with the backend image: no database rows, no seeding,
 * no runtime generation. Every item passes the structural gate below; an item that fails is EXCLUDED from the live
 * pool (fail closed) and listed in {@link #problems()} — {@code TopicBankQualityTest} requires that list to be empty.
 */
@Component
public final class TopicBank {

    private static final Logger log = LoggerFactory.getLogger(TopicBank.class);
    private static final String ROOT = "speaking/topics/";

    /** Practice style; the three IELTS parts are separate styles because their formats never mix. */
    public enum Style { QUICK, DEEP, IELTS1, IELTS2, IELTS3 }

    /** Learner-facing difficulty filter over the CEFR estimate of an item. */
    public enum Band {
        BASIC, INTERMEDIATE, ADVANCED;

        public static Band of(String cefr) {
            return switch (cefr) {
                case "A1", "A2" -> BASIC;
                case "B1", "B2" -> INTERMEDIATE;
                default -> ADVANCED;
            };
        }
    }

    public record Category(String key, String vi, String en) {}

    public record Definition(String term, String en, String vi) {}

    /**
     * One question unit. QUICK / DEEP: one prompt in {@code questions}. IELTS1 / IELTS3: a titled set of linked questions.
     * IELTS2: the cue-card task in {@code questions[0]}, its bullet points and its closing "and explain" line.
     * {@code task} (cognitive task type) and {@code cluster} (semantic family) are internal selection metadata only.
     */
    public record Item(String id, Style style, String category, String level, String task, String cluster, String title,
                       List<String> questions, List<String> bullets, String explain, Definition definition, String linkedId) {
        public Band band() { return Band.of(level); }
    }

    static final Set<String> LEVELS = Set.of("A1", "A2", "B1", "B2", "C1", "C2");
    static final Set<String> TASKS = Set.of("DESCRIBE", "EXPLAIN", "RECALL", "STORY", "CHOOSE", "OPINION", "COMPARE",
            "DEFEND", "HYPOTHETICAL", "TRADEOFF", "REFLECT", "PREDICT", "CAUSES", "CONSEQUENCES", "SOLVE", "VALUES",
            "TREND", "CONCEPT", "INTERVIEW", "LONG_TURN", "DISCUSSION");
    private static final Pattern ID = Pattern.compile("^[A-Z0-9-]{3,24}$");
    private static final Pattern CLUSTER = Pattern.compile("^[a-z0-9-]{2,40}$");

    private final String version;
    private final String provenance;
    private final String reviewStatus;
    private final List<Category> categories;
    private final Map<String, Category> categoryByKey;
    private final Map<String, Item> byId;
    private final Map<Style, List<Item>> byStyle;
    private final Map<String, String> followUps;
    private final List<String> problems;

    public TopicBank() {
        this(new ObjectMapper());
    }

    TopicBank(ObjectMapper json) {
        try {
            JsonNode meta = read(json, "meta.json");
            this.version = meta.path("version").asText();
            this.provenance = meta.path("provenance").asText();
            this.reviewStatus = meta.path("reviewStatus").asText();
            List<Category> cats = new ArrayList<>();
            for (JsonNode c : meta.path("categories")) {
                cats.add(new Category(c.path("key").asText(), c.path("vi").asText(), c.path("en").asText()));
            }
            this.categories = List.copyOf(cats);
            Map<String, Category> catMap = new LinkedHashMap<>();
            cats.forEach(c -> catMap.put(c.key(), c));
            this.categoryByKey = Collections.unmodifiableMap(catMap);

            List<Item> raw = new ArrayList<>();
            for (JsonNode row : read(json, "quick.json").path("items")) raw.add(tuple(Style.QUICK, row));
            for (JsonNode row : read(json, "deep.json").path("items")) raw.add(tuple(Style.DEEP, row));
            JsonNode ielts = read(json, "ielts.json");
            for (JsonNode s : ielts.path("part1")) raw.add(set(Style.IELTS1, s));
            for (JsonNode s : ielts.path("part2")) raw.add(card(s));
            for (JsonNode s : ielts.path("part3")) raw.add(set(Style.IELTS3, s));

            List<String> found = new ArrayList<>();
            Map<String, Item> ids = new LinkedHashMap<>();
            Set<String> texts = new HashSet<>();
            for (Item item : raw) {
                List<String> issues = validate(item);
                if (ids.containsKey(item.id())) issues.add("duplicate id");
                for (String q : item.questions()) {
                    if (!texts.add(normalize(q))) issues.add("duplicate text: " + q);
                }
                if (issues.isEmpty()) {
                    ids.put(item.id(), item);
                } else {
                    found.add(item.id() + ": " + String.join("; ", issues));
                }
            }
            // a Part 3 set may name the Part 2 card it continues; a dangling link is a defect, not a silent gap
            for (Item item : List.copyOf(ids.values())) {
                if (item.linkedId() != null) {
                    Item target = ids.get(item.linkedId());
                    if (target == null || target.style() != Style.IELTS2) {
                        ids.remove(item.id());
                        found.add(item.id() + ": linked card " + item.linkedId() + " missing");
                    }
                }
            }
            this.byId = Collections.unmodifiableMap(ids);
            Map<Style, List<Item>> styles = new EnumMap<>(Style.class);
            for (Style s : Style.values()) styles.put(s, new ArrayList<>());
            ids.values().forEach(i -> styles.get(i.style()).add(i));
            styles.replaceAll((s, l) -> List.copyOf(l));
            this.byStyle = Collections.unmodifiableMap(styles);
            Map<String, String> next = new HashMap<>();
            styles.get(Style.IELTS3).forEach(p3 -> next.putIfAbsent(p3.linkedId(), p3.id()));
            this.followUps = Collections.unmodifiableMap(next);
            this.problems = List.copyOf(found);
            if (!found.isEmpty()) {
                log.warn("Speaking topic bank {}: {} item(s) excluded by the structural gate", version, found.size());
            }
        } catch (IOException ex) {
            throw new IllegalStateException("Speaking topic bank cannot be read", ex);
        }
    }

    public String version() { return version; }
    public String provenance() { return provenance; }
    public String reviewStatus() { return reviewStatus; }
    public List<Category> categories() { return categories; }
    public Optional<Category> category(String key) { return Optional.ofNullable(categoryByKey.get(key)); }
    public Optional<Item> item(String id) { return Optional.ofNullable(id == null ? null : byId.get(id)); }
    public List<Item> items(Style style) { return byStyle.get(style); }
    public Collection<Item> all() { return byId.values(); }
    public List<String> problems() { return problems; }
    /** The Part 3 discussion set that continues a Part 2 card's theme, if one exists. */
    public Optional<String> followUp(String part2Id) { return Optional.ofNullable(followUps.get(part2Id)); }

    /** Items of a style, optionally narrowed to one category and one difficulty band. */
    public List<Item> pool(Style style, String category, Band band) {
        return byStyle.get(style).stream()
                .filter(i -> category == null || i.category().equals(category))
                .filter(i -> band == null || i.band() == band)
                .toList();
    }

    static String normalize(String text) {
        String n = Normalizer.normalize(text, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
        return n.replaceAll("[^a-z0-9 ]", " ").replaceAll("\\s+", " ").trim();
    }

    private List<String> validate(Item i) {
        List<String> issues = new ArrayList<>();
        if (!ID.matcher(i.id()).matches()) issues.add("bad id");
        if (!categoryByKey.containsKey(i.category())) issues.add("unknown category " + i.category());
        if (!LEVELS.contains(i.level())) issues.add("bad level " + i.level());
        if (!TASKS.contains(i.task())) issues.add("bad task " + i.task());
        if (!CLUSTER.matcher(i.cluster()).matches()) issues.add("bad cluster " + i.cluster());
        if (i.questions().isEmpty()) issues.add("no question");
        for (String q : i.questions()) {
            int words = q.trim().split("\\s+").length;
            if (q.isBlank() || words < 4 || words > 60) issues.add("question length " + words);
            if (!q.endsWith("?") && !q.endsWith(".")) issues.add("question punctuation");
            if (!q.equals(q.strip()) || q.contains("  ")) issues.add("spacing");
            if (!Character.isUpperCase(q.charAt(0))) issues.add("capitalisation");
        }
        switch (i.style()) {
            case QUICK, DEEP -> {
                if (i.questions().size() != 1) issues.add("one prompt expected");
            }
            case IELTS1, IELTS3 -> {
                if (i.questions().size() < 3 || i.questions().size() > 6) issues.add("3–6 linked questions expected");
                if (i.title() == null || i.title().isBlank()) issues.add("set title missing");
                for (String q : i.questions()) if (!q.endsWith("?")) issues.add("set question must be a question");
            }
            case IELTS2 -> {
                if (!i.questions().getFirst().startsWith("Describe ")) issues.add("cue card must start with Describe");
                if (i.bullets().size() < 3 || i.bullets().size() > 4) issues.add("3–4 cue points expected");
                if (i.explain() == null || !i.explain().startsWith("and explain ")) issues.add("closing 'and explain' line missing");
                if (i.title() == null || i.title().isBlank()) issues.add("card title missing");
            }
        }
        if (i.definition() != null) {
            Definition d = i.definition();
            if (d.term().isBlank() || d.en().isBlank() || d.vi().isBlank()) issues.add("incomplete definition");
            if (d.en().split("\\s+").length > 40 || d.vi().split("\\s+").length > 40) issues.add("definition too long");
        }
        return issues;
    }

    private static JsonNode read(ObjectMapper json, String name) throws IOException {
        try (InputStream in = TopicBank.class.getClassLoader().getResourceAsStream(ROOT + name)) {
            if (in == null) throw new IOException("missing " + ROOT + name);
            return json.readTree(in);
        }
    }

    /** QUICK / DEEP row: [id, category, level, task, cluster, prompt (, term, definitionEn, definitionVi)]. */
    private static Item tuple(Style style, JsonNode r) {
        Definition def = r.size() >= 9 ? new Definition(r.get(6).asText(), r.get(7).asText(), r.get(8).asText()) : null;
        return new Item(r.path(0).asText(), style, r.path(1).asText(), r.path(2).asText(), r.path(3).asText(),
                r.path(4).asText(), null, List.of(r.path(5).asText()), List.of(), null, def, null);
    }

    private static Item set(Style style, JsonNode s) {
        List<String> qs = new ArrayList<>();
        s.path("q").forEach(q -> qs.add(q.asText()));
        String linked = s.hasNonNull("linked") ? s.get("linked").asText() : null;
        return new Item(s.path("id").asText(), style, s.path("cat").asText(), s.path("level").asText(),
                style == Style.IELTS1 ? "INTERVIEW" : "DISCUSSION", s.path("cluster").asText(), s.path("title").asText(),
                List.copyOf(qs), List.of(), null, null, linked);
    }

    private static Item card(JsonNode s) {
        List<String> bullets = new ArrayList<>();
        s.path("bullets").forEach(b -> bullets.add(b.asText()));
        return new Item(s.path("id").asText(), Style.IELTS2, s.path("cat").asText(), s.path("level").asText(), "LONG_TURN",
                s.path("cluster").asText(), s.path("title").asText(), List.of(s.path("task").asText()),
                List.copyOf(bullets), s.path("explain").asText(null), null, null);
    }
}
