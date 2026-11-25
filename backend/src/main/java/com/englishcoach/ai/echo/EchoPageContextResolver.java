package com.englishcoach.ai.echo;

import com.englishcoach.ai.dto.EchoPageContextDto;
import com.englishcoach.grammar.GrammarContent;
import com.englishcoach.listening.repository.ListeningMaterialRepository;
import com.englishcoach.reading.dto.BilingualReadingDetailResponse;
import com.englishcoach.reading.repository.ReadingMaterialRepository;
import com.englishcoach.reading.service.BilingualReadingService;
import com.englishcoach.speaking.repository.SpeakingScenarioRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Turns the client's typed page context into what Echo may see of it, for this learner only:
 * - GRAMMAR_TOPIC: the published topic's title, level and quick summary (catalog content).
 * - READING_MATERIAL: resolved via {@link ReadingMaterialRepository#findByIdAndVisibleToUser} (SYSTEM or own; foreign/quarantined => unavailable).
 * - BILINGUAL_READING: resolved via {@link BilingualReadingService#detail(Long)} (strictly SYSTEM {@code is_system=TRUE AND owner_user_id IS NULL}).
 * - LISTENING_LESSON / SHADOWING_LESSON: resolved via {@link ListeningMaterialRepository#findByIdAndVisibleToUser} (excluding DOCUMENT for Shadowing).
 * - SPEAKING_SCENARIO: resolved via {@link SpeakingScenarioRepository#findByIdAndAccessible}.
 * - BOOK_EXCERPT / BOOK_ACTIVE: learner-shared on-demand local book excerpt and/or metadata (10 §AB).
 * - COSMOS_WORD / EXAM_FAMILY / MODULE: the word / family / module name.
 */
@Component
public class EchoPageContextResolver {
    static final int MAX_EXCERPT = 2_800;

    private final ObjectMapper mapper;
    private final ObjectProvider<GrammarContent> grammar;
    private final ObjectProvider<ReadingMaterialRepository> reading;
    private final ObjectProvider<ListeningMaterialRepository> listening;
    private final ObjectProvider<SpeakingScenarioRepository> speaking;
    private final ObjectProvider<PlatformTransactionManager> transactions;
    private final EchoDestinations destinations;
    private ObjectProvider<BilingualReadingService> bilingualReading;

    /** Backward-compatible 6-arg constructor preserved for slim unit tests. */
    public EchoPageContextResolver(ObjectMapper mapper, ObjectProvider<GrammarContent> grammar, ObjectProvider<ReadingMaterialRepository> reading,
                                   ObjectProvider<ListeningMaterialRepository> listening, ObjectProvider<PlatformTransactionManager> transactions,
                                   EchoDestinations destinations) {
        this(mapper, grammar, reading, listening, null, transactions, destinations, null);
    }

    /** Backward-compatible 7-arg constructor preserved for existing unit tests. */
    public EchoPageContextResolver(ObjectMapper mapper, ObjectProvider<GrammarContent> grammar, ObjectProvider<ReadingMaterialRepository> reading,
                                   ObjectProvider<ListeningMaterialRepository> listening,
                                   ObjectProvider<SpeakingScenarioRepository> speaking,
                                   ObjectProvider<PlatformTransactionManager> transactions,
                                   EchoDestinations destinations) {
        this(mapper, grammar, reading, listening, speaking, transactions, destinations, null);
    }

    @Autowired
    public EchoPageContextResolver(ObjectMapper mapper, ObjectProvider<GrammarContent> grammar, ObjectProvider<ReadingMaterialRepository> reading,
                                   ObjectProvider<ListeningMaterialRepository> listening,
                                   @Autowired(required = false) ObjectProvider<SpeakingScenarioRepository> speaking,
                                   ObjectProvider<PlatformTransactionManager> transactions,
                                   EchoDestinations destinations,
                                   @Autowired(required = false) ObjectProvider<BilingualReadingService> bilingualReading) {
        this.mapper = mapper;
        this.grammar = grammar;
        this.reading = reading;
        this.listening = listening;
        this.speaking = speaking;
        this.transactions = transactions;
        this.destinations = destinations;
        this.bilingualReading = bilingualReading;
    }

    /** {@code detailed}: include page text (the learner referred to "this"); otherwise only where they are. */
    public String resolve(long userId, EchoPageContextDto page, boolean detailed, boolean vi) {
        if (page == null || page.kind() == null) return null;
        PlatformTransactionManager tm = transactions.getIfAvailable();
        if (tm == null) return build(userId, page, detailed, vi);
        TransactionTemplate template = new TransactionTemplate(tm);
        template.setReadOnly(true);
        template.setTimeout(5);
        return template.execute(s -> build(userId, page, detailed, vi));
    }

    String build(long userId, EchoPageContextDto page, boolean detailed, boolean vi) {
        ObjectNode out = mapper.createObjectNode().put("kind", page.kind());
        try {
            switch (page.kind()) {
                case "GRAMMAR_TOPIC" -> {
                    GrammarContent content = grammar.getIfAvailable();
                    var meta = content == null || page.slug() == null ? java.util.Optional.<GrammarContent.TopicMeta>empty() : content.meta(page.slug());
                    if (meta.isEmpty()) return unavailable(out);
                    out.put("available", true).put("topicSlug", page.slug()).put("level", meta.get().level())
                            .put("title", destinations.topicTitle(content, page.slug(), vi).orElse(page.slug()));
                    if (detailed) {
                        var prerequisites = out.putArray("prerequisites");
                        meta.get().prerequisites().stream().filter(slug -> content.meta(slug).map(GrammarContent.TopicMeta::available).orElse(false))
                                .limit(4).forEach(slug -> prerequisites.addObject().put("slug", slug)
                                        .put("title", destinations.topicTitle(content, slug, vi).orElse(slug)));
                        JsonNode topic = content.load(page.slug()).topic();
                        out.put("subtitle", clip(topic.path("subtitle").path(vi ? "vi" : "en").asText(""), 300));
                        out.put("quickSummary", clip(flatten(topic.path("quick")), 900));
                    }
                }
                case "READING_MATERIAL" -> {
                    var repo = reading.getIfAvailable();
                    var m = repo == null || page.id() == null ? java.util.Optional.<com.englishcoach.reading.entity.ReadingMaterial>empty()
                            : repo.findByIdAndVisibleToUser(page.id(), userId);
                    if (m.isEmpty()) return unavailable(out);
                    out.put("available", true).put("title", clip(m.get().getTitle(), 140))
                            .put("level", m.get().getDifficultyLevel() == null ? "unknown" : m.get().getDifficultyLevel());
                    if (detailed && m.get().getContentText() != null) {
                        String selected = page.selection();
                        if (selected != null && !selected.isBlank()
                                && !m.get().getContentText().replaceAll("\\s+", " ").contains(selected.strip().replaceAll("\\s+", " ")))
                            return unavailable(out);
                        if (selected != null && !selected.isBlank()) {
                            out.put("passageExcerpt", excerpt(m.get().getContentText(), selected));
                        } else if (page.viewportAnchorChar() != null && page.viewportAnchorChar() >= 0) {
                            out.put("passageExcerpt", excerptAtChar(m.get().getContentText(), page.viewportAnchorChar()));
                        } else {
                            out.put("passageExcerpt", excerpt(m.get().getContentText(), page.clientVisibleExcerpt()));
                        }
                    }
                }
                case "BILINGUAL_READING" -> {
                    BilingualReadingService biSvc = bilingualReading == null ? null : bilingualReading.getIfAvailable();
                    if (biSvc == null || page.id() == null) return unavailable(out);
                    BilingualReadingDetailResponse detail = biSvc.detail(page.id());
                    if (detail == null) return unavailable(out);
                    String displayTitle = vi && detail.titleVi() != null && !detail.titleVi().isBlank()
                            ? detail.titleVi() : detail.titleEn();
                    out.put("available", true)
                            .put("title", clip(displayTitle, 140))
                            .put("titleEn", clip(detail.titleEn(), 140))
                            .put("level", detail.difficultyLevel() == null ? "unknown" : detail.difficultyLevel())
                            .put("contentType", detail.contentType() == null ? "ARTICLE" : detail.contentType());
                    if (detailed && detail.segments() != null && !detail.segments().isEmpty()) {
                        String fullEnText = detail.segments().stream()
                                .map(BilingualReadingDetailResponse.Segment::en)
                                .filter(t -> t != null && !t.isBlank())
                                .collect(Collectors.joining("\n\n"));
                        String combinedEnVi = detail.segments().stream()
                                .map(s -> (s.en() == null ? "" : s.en()) + " " + (s.vi() == null ? "" : s.vi()))
                                .collect(Collectors.joining(" "))
                                .replaceAll("\\s+", " ");
                        String selected = page.selection();
                        if (selected != null && !selected.isBlank()
                                && !combinedEnVi.contains(selected.strip().replaceAll("\\s+", " "))) {
                            return unavailable(out);
                        }
                        if (!fullEnText.isBlank()) {
                            if (selected != null && !selected.isBlank()) {
                                out.put("passageExcerpt", excerpt(fullEnText, selected));
                            } else if (page.viewportAnchorChar() != null && page.viewportAnchorChar() >= 0) {
                                out.put("passageExcerpt", excerptAtChar(fullEnText, page.viewportAnchorChar()));
                            } else {
                                out.put("passageExcerpt", excerpt(fullEnText, page.clientVisibleExcerpt()));
                            }
                        }
                    }
                }
                case "LISTENING_LESSON", "SHADOWING_LESSON" -> {
                    var repo = listening.getIfAvailable();
                    var m = repo == null || page.id() == null ? java.util.Optional.<com.englishcoach.listening.entity.ListeningMaterial>empty()
                            : repo.findByIdAndVisibleToUser(page.id(), userId);
                    if (m.isEmpty()) return unavailable(out);
                    if ("SHADOWING_LESSON".equals(page.kind()) && "DOCUMENT".equalsIgnoreCase(m.get().getSourceType())) {
                        return unavailable(out);
                    }
                    out.put("available", true).put("title", clip(m.get().getTitle(), 140))
                            .put("level", m.get().getCefrLevel() == null ? "unknown" : m.get().getCefrLevel())
                            .put("topic", m.get().getTopic() == null ? "" : clip(m.get().getTopic(), 60));
                    if (m.get().getAccent() != null && !m.get().getAccent().isBlank()) {
                        out.put("accent", clip(m.get().getAccent(), 30));
                    }
                    if (page.playbackTimeSec() != null && page.playbackTimeSec() >= 0) {
                        out.put("playbackTimeSec", page.playbackTimeSec());
                    }
                }
                case "SPEAKING_SCENARIO" -> {
                    var repo = speaking == null ? null : speaking.getIfAvailable();
                    var s = repo == null || page.id() == null ? java.util.Optional.<com.englishcoach.speaking.entity.SpeakingScenario>empty()
                            : repo.findByIdAndAccessible(page.id(), userId);
                    if (s.isEmpty()) return unavailable(out);
                    out.put("available", true).put("title", clip(s.get().getTitle(), 140))
                            .put("level", s.get().getCefrLevel() == null ? "unknown" : s.get().getCefrLevel().name())
                            .put("category", s.get().getCategory() == null ? "" : s.get().getCategory().name())
                            .put("aiRole", clip(s.get().getAiRole(), 80))
                            .put("learnerRole", clip(s.get().getLearnerRole(), 80));
                }
                case "BOOK_EXCERPT", "BOOK_ACTIVE" -> {
                    boolean hasSel = page.selection() != null && !page.selection().isBlank();
                    boolean hasViewport = page.clientVisibleExcerpt() != null && !page.clientVisibleExcerpt().isBlank();
                    boolean hasMeta = page.bookMeta() != null && page.bookMeta().title() != null && !page.bookMeta().title().isBlank();
                    if (!hasSel && !hasViewport && !("BOOK_ACTIVE".equals(page.kind()) && hasMeta)) return unavailable(out);
                    out.put("available", true).put("source", "learner-shared excerpt only");
                    if (detailed && hasViewport) {
                        out.put("passageExcerpt", clip(page.clientVisibleExcerpt().replaceAll("\\s+", " ").strip(), MAX_EXCERPT));
                    }
                    if (page.bookMeta() != null) {
                        ObjectNode bm = out.putObject("bookMeta");
                        if (page.bookMeta().title() != null && !page.bookMeta().title().isBlank()) bm.put("title", clip(page.bookMeta().title().strip(), 140));
                        if (page.bookMeta().author() != null && !page.bookMeta().author().isBlank()) bm.put("author", clip(page.bookMeta().author().strip(), 100));
                        if (page.bookMeta().chapter() != null && !page.bookMeta().chapter().isBlank()) bm.put("chapter", clip(page.bookMeta().chapter().strip(), 100));
                        if (page.bookMeta().pageNumber() != null && page.bookMeta().pageNumber() > 0) bm.put("pageNumber", page.bookMeta().pageNumber());
                        if (page.bookMeta().totalPages() != null && page.bookMeta().totalPages() > 0) bm.put("totalPages", page.bookMeta().totalPages());
                        if (page.bookMeta().progressPct() != null && Double.isFinite(page.bookMeta().progressPct())) {
                            bm.put("progressPct", Math.max(0.0, Math.min(100.0, Math.round(page.bookMeta().progressPct() * 10.0) / 10.0)));
                        }
                        if (page.bookMeta().recentHighlights() != null && !page.bookMeta().recentHighlights().isEmpty()) {
                            ArrayNode hl = bm.putArray("recentHighlights");
                            page.bookMeta().recentHighlights().stream()
                                    .filter(h -> h != null && !h.isBlank())
                                    .limit(5)
                                    .forEach(h -> hl.add(clip(h.replaceAll("\\s+", " ").strip(), 240)));
                        }
                    }
                }
                case "COSMOS_WORD" -> {
                    if (page.word() == null) return unavailable(out);
                    out.put("available", true).put("word", page.word().toLowerCase(Locale.ROOT));
                }
                case "EXAM_FAMILY" -> out.put("available", true).put("family", page.family() == null ? "unknown" : page.family().toUpperCase(Locale.ROOT));
                case "MODULE" -> {
                    if (page.module() == null || !Set.of("dashboard","learning-path","flashcards","reading","listening",
                            "speaking","writing","grammar","exams","leaderboard","community","progress","profile","games",
                            "music","study-space","premium","knowledge-universe").contains(page.module())) return unavailable(out);
                    out.put("available", true).put("module", page.module());
                }
                default -> { return unavailable(out); }
            }
        } catch (RuntimeException e) {
            return unavailable(out);
        }
        if (Set.of("READING_MATERIAL", "BILINGUAL_READING", "BOOK_EXCERPT", "BOOK_ACTIVE", "GRAMMAR_TOPIC", "LISTENING_LESSON", "SHADOWING_LESSON").contains(page.kind())
                && detailed && page.selection() != null && !page.selection().isBlank())
            out.put("learnerSelectedText", clip(page.selection().replaceAll("\\s+", " ").strip(), 600));
        return out.toString();
    }

    private String unavailable(ObjectNode out) {
        out.removeAll();
        return out.put("available", false).put("note", "the current page could not be read for this learner").toString();
    }

    /** Anchors a bounded 2,800-char slice of the authorized DB text around a client viewport character offset. */
    static String excerptAtChar(String text, int anchorChar) {
        String t = text.replace("\r", "");
        if (t.length() <= MAX_EXCERPT) return t.strip();
        int clamped = Math.max(0, Math.min(t.length() - 1, anchorChar));
        int start = Math.max(0, clamped - MAX_EXCERPT / 3);
        int paraBefore = t.lastIndexOf("\n\n", clamped);
        if (paraBefore >= 0 && clamped - paraBefore <= MAX_EXCERPT / 2) {
            start = paraBefore + 2;
        }
        int end = Math.min(t.length(), start + MAX_EXCERPT);
        return t.substring(start, end).strip();
    }

    /** The paragraph that contains the selection (or the opening of the text), bounded. */
    static String excerpt(String text, String selection) {
        String t = text.replace("\r", "");
        int at = selection == null || selection.isBlank() ? -1 : t.indexOf(selection.strip().substring(0, Math.min(60, selection.strip().length())));
        if (at < 0) return clip(t.strip(), MAX_EXCERPT);
        int start = Math.max(0, t.lastIndexOf("\n\n", at));
        int end = t.indexOf("\n\n", at + 1);
        if (end < 0) end = t.length();
        if (end - start > MAX_EXCERPT) { start = Math.max(0, at - MAX_EXCERPT / 2); end = Math.min(t.length(), start + MAX_EXCERPT); }
        return t.substring(start, end).strip();
    }

    private static String flatten(JsonNode node) {
        StringBuilder sb = new StringBuilder();
        node.forEach(n -> { if (n.isTextual()) sb.append(n.asText()).append(' '); else if (n.isContainerNode()) sb.append(flatten(n)).append(' '); });
        if (node.isTextual()) sb.append(node.asText());
        return sb.toString().replaceAll("\\s+", " ").strip();
    }

    private static String clip(String s, int n) { return s == null ? "" : s.length() <= n ? s : s.substring(0, n - 1) + "…"; }
}
