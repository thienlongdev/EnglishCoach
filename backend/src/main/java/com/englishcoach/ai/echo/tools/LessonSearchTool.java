package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoAction;
import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.echo.EchoDestinations;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.ai.echo.camel.CaMeLPolicyEngine;
import com.englishcoach.ai.service.EchoPolicy;
import com.englishcoach.listening.dto.ListeningLibraryItemDto;
import com.englishcoach.listening.dto.ListeningMaterialSummaryDto;
import com.englishcoach.listening.service.ListeningService;
import com.englishcoach.reading.dto.BilingualReadingCatalogResponse;
import com.englishcoach.reading.service.BilingualReadingService;
import com.englishcoach.reading.service.ReadingCatalogService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Structured search of the real Reading, Bilingual Reading, and Listening catalogs (SYSTEM content plus the learner's
 * own private texts/materials; repository visibility predicates enforced so quarantined and foreign rows never appear).
 * Supports CEFR A1-C2 and "continue" mode for resuming in-progress reading.
 */
@Component
public class LessonSearchTool implements EchoTool {
    private final JdbcTemplate jdbc;
    private final ObjectProvider<ListeningService> listening;
    private final ObjectMapper mapper;
    @Autowired(required = false)
    private ReadingCatalogService readingCatalog;
    @Autowired(required = false)
    private ObjectProvider<BilingualReadingService> bilingualReading;

    /** Backward-compatible 3-arg constructor preserved for slim unit tests. */
    public LessonSearchTool(JdbcTemplate jdbc, ObjectProvider<ListeningService> listening, ObjectMapper mapper) {
        this(jdbc, listening, mapper, null);
    }

    @Autowired
    public LessonSearchTool(JdbcTemplate jdbc,
                            ObjectProvider<ListeningService> listening,
                            ObjectMapper mapper,
                            @Autowired(required = false) ObjectProvider<BilingualReadingService> bilingualReading) {
        this.jdbc = jdbc;
        this.listening = listening;
        this.mapper = mapper;
        this.bilingualReading = bilingualReading;
    }

    public String name() { return "search_lessons"; }
    public String description() {
        return "Find real Reading texts, Bilingual Reading stories/articles, or Listening lessons (system + personal library) "
                + "in English Coach by CEFR level (A1-C2) and topic words, or use mode='continue' on reading to resume "
                + "the learner's most recent in-progress texts. Returns up to 5 items with id, title, level and topic.";
    }
    public Map<String, Object> parameters() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("module", EchoToolRegistry.enumOf("Which catalog", List.of("reading", "bilingual", "listening")));
        props.put("level", EchoToolRegistry.enumOf("CEFR level", List.of("A1", "A2", "B1", "B2", "C1", "C2")));
        props.put("topic", EchoToolRegistry.str("Optional topic or title words in English or Vietnamese", 60));
        props.put("mode", EchoToolRegistry.enumOf("Search catalog or continue recent progress", List.of("search", "continue")));
        return EchoToolRegistry.schema(props, List.of("module"));
    }
    public Kind kind() { return Kind.READ; }
    public String status(boolean vi) { return vi ? "Echo đang tìm bài học thật trong kho…" : "Echo is searching the lesson library…"; }

    record Lesson(long id, String title, String level, String topic, String meta, String href) {}

    public String run(EchoTurn turn, JsonNode args) {
        String module = args.path("module").asText();
        String level = args.path("level").asText(null);
        String topic = args.path("topic").asText(null);
        String mode = args.path("mode").asText("search");
        boolean continueMode = "continue".equals(mode);
        List<Lesson> found = switch (module) {
            case "reading" -> continueMode ? continueReading(turn.userId(), level) : reading(turn.userId(), level, topic);
            case "bilingual" -> bilingual(level, topic, turn.vi());
            default -> listening(turn.userId(), level, topic);
        };
        ObjectNode out = mapper.createObjectNode().put("module", module).put("mode", mode);
        ArrayNode list = out.putArray("lessons");
        List<EchoCard.Item> items = new ArrayList<>();
        Set<String> seenCardHrefs = new LinkedHashSet<>();
        for (Lesson l : found) {
            list.addObject()
                    .put("id", l.id)
                    .put("title", l.title)
                    .put("level", l.level == null ? "unknown" : l.level)
                    .put("topic", l.topic == null ? "" : l.topic)
                    .put("meta", l.meta == null ? "" : l.meta);
            boolean firstForHref = l.href != null && seenCardHrefs.add(l.href);
            if (firstForHref && !("bilingual".equals(module) && found.size() > 1)) {
                turn.authorizeResourceHref(l.href);
            }
            items.add(new EchoCard.Item(l.title, l.topic, (l.level == null ? "" : l.level + " · ") + l.meta, l.href, null));
        }
        if (found.isEmpty()) {
            out.put("note", continueMode
                    ? "no in-progress reading found; search the catalog or suggest the Reading home"
                    : "nothing matched; widen the level or topic, or suggest the module home");
        } else {
            String cardTitle = continueMode
                    ? turn.t("Bài đọc đang dở", "Continue reading")
                    : switch (module) {
                        case "reading" -> turn.t("Bài đọc gợi ý", "Suggested reading");
                        case "bilingual" -> turn.t("Bài đọc song ngữ gợi ý", "Suggested bilingual reading");
                        default -> turn.t("Bài nghe gợi ý", "Suggested listening");
                    };
            turn.card(EchoCard.of("resources", cardTitle, items, null));
            if (continueMode && !turn.hasNavigateAction()
                    && CaMeLPolicyEngine.canAutoNavigate(turn, EchoDestinations.Dest.READING_MATERIAL, found.get(0).href)) {
                Lesson first = found.get(0);
                turn.action(EchoAction.navigate(first.href, first.title, true));
                if (CaMeLPolicyEngine.isWorkRoute(turn.page(), first.href)) {
                    out.put("opened", false).put("awaitingConfirmation", true).put("reason", "active_work_route");
                } else {
                    out.put("opened", true);
                }
            }
        }
        return out.toString();
    }

    List<Lesson> continueReading(long userId, String level) {
        List<Object> params = new ArrayList<>(List.of(userId, userId));
        StringBuilder sql = new StringBuilder("""
                SELECT r.id, r.title, r.difficulty_level, r.source_name, r.word_count, p.percent
                FROM public.reading_materials r
                JOIN (
                    SELECT reading_material_id, MAX(scroll_percentage) AS percent, MAX(last_read_at) AS last_read
                    FROM public.user_reading_progress
                    WHERE user_id = ?
                    GROUP BY reading_material_id
                ) p ON r.id = p.reading_material_id
                WHERE ((r.is_system = true AND r.owner_user_id IS NULL) OR (r.is_system = false AND r.owner_user_id = ?))""");
        if (level != null) { sql.append(" AND r.difficulty_level = ?"); params.add(level); }
        sql.append(" ORDER BY p.last_read DESC NULLS LAST, r.id DESC LIMIT 5");
        return jdbc.query(sql.toString(), (rs, i) -> {
            long id = rs.getLong(1);
            int pct = Math.max(0, Math.min(100, rs.getInt(6)));
            String words = rs.getObject(5) == null ? "" : rs.getInt(5) + " words";
            String meta = words.isEmpty() ? pct + "% read" : pct + "% read · " + words;
            return new Lesson(id, clip(rs.getString(2)), rs.getString(3), rs.getString(4), meta, "/reading?materialId=" + id);
        }, params.toArray());
    }

    List<Lesson> reading(long userId, String level, String topic) {
        List<Object> params = new ArrayList<>(List.of(userId));
        StringBuilder sql = new StringBuilder("""
                SELECT id, title, difficulty_level, source_name, word_count, source_url FROM public.reading_materials
                WHERE ((is_system = true AND owner_user_id IS NULL) OR (is_system = false AND owner_user_id = ?))""");
        if (level != null) { sql.append(" AND difficulty_level = ?"); params.add(level); }
        List<String> words = words(topic);
        if (!words.isEmpty()) {
            sql.append(" AND (");
            for (int i = 0; i < words.size(); i++) {
                if (i > 0) sql.append(" OR ");
                sql.append("title ILIKE ? OR source_name ILIKE ?");
                params.add("%" + words.get(i) + "%"); params.add("%" + words.get(i) + "%");
            }
            sql.append(")");
        }
        sql.append(" ORDER BY is_system DESC, id DESC LIMIT 5");
        return jdbc.query(sql.toString(), (rs, i) -> {
            long id = rs.getLong(1);
            String url = rs.getString(6);
            String sourceOrTopic = rs.getString(4);
            if (readingCatalog != null && url != null) {
                String catTopic = readingCatalog.metadata(url, "topic", "");
                if (catTopic != null && !catTopic.isBlank() && !"Other".equalsIgnoreCase(catTopic)) {
                    sourceOrTopic = catTopic;
                }
            }
            return new Lesson(id, clip(rs.getString(2)), rs.getString(3), sourceOrTopic,
                    rs.getObject(5) == null ? "" : rs.getInt(5) + " words",
                    "/reading?materialId=" + id);
        }, params.toArray());
    }

    List<Lesson> bilingual(String level, String topic, boolean vi) {
        BilingualReadingService svc = bilingualReading == null ? null : bilingualReading.getIfAvailable();
        if (svc == null) return List.of();
        BilingualReadingCatalogResponse catalog = svc.catalog(null);
        if (catalog == null || catalog.content() == null) return List.of();
        List<String> words = words(topic);
        return catalog.content().stream()
                .filter(c -> level == null || level.equalsIgnoreCase(c.difficultyLevel()))
                .filter(c -> words.isEmpty() || words.stream().anyMatch(w ->
                        contains(c.titleEn(), w) || contains(c.titleVi(), w) || contains(c.contentType(), w)))
                .limit(5)
                .map(c -> {
                    String title = vi && c.titleVi() != null && !c.titleVi().isBlank() ? c.titleVi() : c.titleEn();
                    String subtitle = vi ? c.titleEn() : c.titleVi();
                    String meta = (c.wordCount() > 0 ? c.wordCount() + " words" : "")
                            + (c.estimatedMinutes() > 0 ? " · " + c.estimatedMinutes() + " min" : "");
                    return new Lesson(c.id(), clip(title), c.difficultyLevel(), clip(subtitle), meta.replaceAll("^\\s*·\\s*", ""), "/reading?section=bilingual");
                })
                .toList();
    }

    List<Lesson> listening(String level, String topic) {
        return listening(0L, level, topic);
    }

    List<Lesson> listening(long userId, String level, String topic) {
        ListeningService svc = listening.getIfAvailable();
        if (svc == null) return List.of();
        List<String> words = words(topic);
        Map<Long, Lesson> merged = new LinkedHashMap<>();

        if (userId > 0) {
            List<ListeningMaterialSummaryDto> personal = svc.getPersonalMaterials(level, topic, null, userId);
            if (personal != null) {
                for (ListeningMaterialSummaryDto m : personal) {
                    if (m == null || m.getId() == null) continue;
                    if (level != null && m.getCefrLevel() != null && !level.equalsIgnoreCase(m.getCefrLevel())) continue;
                    if (!words.isEmpty() && words.stream().noneMatch(w -> contains(m.getTitle(), w) || contains(m.getTopic(), w))) continue;
                    String dur = m.getDurationSeconds() == null ? "" : Math.max(1, m.getDurationSeconds() / 60) + " min";
                    merged.putIfAbsent(m.getId(), new Lesson(
                            m.getId(), clip(m.getTitle()), m.getCefrLevel(), m.getTopic(), dur, "/listening/" + m.getId()));
                    if (merged.size() >= 5) break;
                }
            }
        }

        if (merged.size() < 5) {
            List<ListeningLibraryItemDto> shared = svc.getSharedLibrary();
            if (shared != null) {
                for (ListeningLibraryItemDto l : shared) {
                    if (l == null || l.getId() == null || merged.containsKey(l.getId())) continue;
                    if (level != null && !level.equalsIgnoreCase(l.getLevel())) continue;
                    if (!words.isEmpty() && words.stream().noneMatch(w ->
                            contains(l.getTitle(), w) || contains(l.getTopic(), w) || contains(l.getChannel(), w))) continue;
                    String dur = l.getDurationSeconds() == null ? "" : Math.max(1, l.getDurationSeconds() / 60) + " min";
                    merged.put(l.getId(), new Lesson(
                            l.getId(), clip(l.getTitle()), l.getLevel(), l.getTopic(), dur, "/listening/" + l.getId()));
                    if (merged.size() >= 5) break;
                }
            }
        }
        return List.copyOf(merged.values());
    }

    private static List<String> words(String topic) {
        if (topic == null || topic.isBlank()) return List.of();
        return Arrays.stream(EchoPolicy.normalize(topic).split(" ")).filter(w -> w.length() >= 3 && w.matches("[a-z0-9]+")).limit(4).toList();
    }

    private static boolean contains(String text, String word) { return text != null && EchoPolicy.normalize(text).contains(word); }

    private static String clip(String s) { return s == null ? "" : s.length() <= 90 ? s : s.substring(0, 89) + "…"; }
}
