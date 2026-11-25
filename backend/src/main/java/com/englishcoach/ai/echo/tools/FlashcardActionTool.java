package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoAction;
import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.echo.EchoLearnerBrain;
import com.englishcoach.ai.echo.EchoRouter;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.ai.service.EchoPolicy;
import com.englishcoach.flashcard.dto.VocabDeckSummaryResponse;
import com.englishcoach.flashcard.service.FlashcardService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * Principal-scoped Flashcard tools:
 * - {@code search_flashcard_decks}: searches visible system and enrolled decks for this learner.
 * - {@code enroll_flashcard_deck}: idempotently enrolls this learner in a visible system deck.
 * - {@code create_flashcard}: idempotently saves a custom word/phrase card to this learner's deck.
 */
@Component
public class FlashcardActionTool implements EchoTool {
    private final ObjectProvider<FlashcardService> flashcards;
    private final ObjectMapper mapper;

    public FlashcardActionTool(ObjectProvider<FlashcardService> flashcards, ObjectMapper mapper) {
        this.flashcards = flashcards;
        this.mapper = mapper;
    }

    @Override public String name() { return "search_flashcard_decks"; }
    @Override public String description() {
        return "Search real Flashcard vocabulary decks available to this learner by topic, exam (IELTS, TOEIC, Oxford, CEFR, "
                + "phrasal verbs, idioms, collocations) or title keywords. Returns up to 5 decks with deck id, title, word count "
                + "and enrollment status.";
    }
    @Override public Map<String, Object> parameters() {
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("query", EchoToolRegistry.str("Topic, exam or deck title keywords", 80));
        props.put("category", EchoToolRegistry.str("Optional deck category filter (e.g. IELTS_BAND, TOEIC_SCORE, OXFORD, IDIOMS)", 40));
        return EchoToolRegistry.schema(props, List.of());
    }
    @Override public Kind kind() { return Kind.READ; }
    @Override public String status(boolean vi) { return vi ? "Echo đang tìm bộ thẻ từ vựng…" : "Echo is searching flashcard decks…"; }

    @Override
    public String run(EchoTurn turn, JsonNode args) {
        FlashcardService svc = flashcards.getIfAvailable();
        if (svc == null) return "{\"error\":\"unavailable\"}";
        String query = args.path("query").asText(null);
        String category = args.path("category").asText(null);
        List<String> words = queryWords(query);

        List<VocabDeckSummaryResponse> matched = svc.getDecks(turn.userId()).stream()
                .filter(d -> d.getId() != null && d.getTotalWords() > 0)
                .filter(d -> category == null || category.equalsIgnoreCase(d.getCategory()))
                .filter(d -> words.isEmpty() || words.stream().anyMatch(w -> matchesDeck(d, w)))
                .limit(5)
                .toList();

        ObjectNode out = mapper.createObjectNode();
        ArrayNode decks = out.putArray("decks");
        List<EchoCard.Item> items = new ArrayList<>();
        for (VocabDeckSummaryResponse d : matched) {
            decks.addObject()
                    .put("id", d.getId())
                    .put("title", clip(d.getTitle(), 80))
                    .put("category", d.getCategory() == null ? "" : d.getCategory())
                    .put("totalWords", d.getTotalWords())
                    .put("enrolled", d.isEnrolled())
                    .put("dueCount", d.getDueCount());
            String href = "/flashcards?deck=" + d.getId();
            turn.authorizeResourceHref(href);
            String sub = d.getTotalWords() + turn.t(" từ", " words")
                    + (d.isEnrolled() ? " · " + turn.t("đã tham gia", "enrolled") : "");
            items.add(new EchoCard.Item(clip(d.getTitle(), 80), sub, d.getCategory() == null ? "" : d.getCategory(), href, null));
        }
        if (matched.isEmpty()) {
            out.put("note", "no flashcard deck matched; widen the search or open flashcards");
        } else {
            turn.card(EchoCard.of("resources", turn.t("Bộ thẻ từ vựng gợi ý", "Suggested flashcard decks"), items, null));
        }
        return out.toString();
    }

    private static boolean matchesDeck(VocabDeckSummaryResponse d, String word) {
        String hay = EchoPolicy.normalize(
                Objects.toString(d.getTitle(), "") + " " + Objects.toString(d.getDescription(), "") + " "
                + Objects.toString(d.getCategory(), "") + " " + Objects.toString(d.getSlug(), ""));
        return hay.contains(word);
    }

    private static List<String> queryWords(String query) {
        if (query == null || query.isBlank()) return List.of();
        return Arrays.stream(EchoPolicy.normalize(query).split(" "))
                .filter(w -> w.length() >= 2 && w.matches("[a-z0-9]+"))
                .limit(5)
                .toList();
    }

    static String clip(String s, int max) {
        return s == null ? "" : s.length() <= max ? s : s.substring(0, max - 1) + "…";
    }

    /** Idempotently enrolls the authenticated learner into a visible system vocabulary deck. */
    @Component
    public static class EnrollFlashcardDeckTool implements EchoTool {
        private final ObjectProvider<FlashcardService> flashcards;
        private final ObjectProvider<EchoLearnerBrain> brain;
        private final ObjectMapper mapper;

        public EnrollFlashcardDeckTool(ObjectProvider<FlashcardService> flashcards,
                                       ObjectProvider<EchoLearnerBrain> brain,
                                       ObjectMapper mapper) {
            this.flashcards = flashcards;
            this.brain = brain;
            this.mapper = mapper;
        }

        @Override public String name() { return "enroll_flashcard_deck"; }
        @Override public String description() {
            return "Enroll this learner into a real system Flashcard deck (found via search_flashcard_decks) and offer to open it. "
                    + "Additive and idempotent: existing progress is never overwritten.";
        }
        @Override public Map<String, Object> parameters() {
            Map<String, Object> props = new LinkedHashMap<>();
            props.put("deck_id", EchoToolRegistry.integer("System vocabulary deck id from search_flashcard_decks", 1, 2_000_000_000));
            return EchoToolRegistry.schema(props, List.of("deck_id"));
        }
        @Override public Kind kind() { return Kind.NAVIGATE; }
        @Override public boolean readOnlyTransaction() { return false; }
        @Override public String status(boolean vi) { return vi ? "Echo đang thêm bộ thẻ vào kho của bạn…" : "Echo is enrolling your flashcard deck…"; }

        @Override
        public String run(EchoTurn turn, JsonNode args) throws Exception {
            // Strict CaMeL predicate: require learner's own unquoted words to authorize deck enrollment (blocks indirect passage injections)
            if (!com.englishcoach.ai.echo.camel.CaMeLPolicyEngine.canEnrollDeck(turn)) {
                return mapper.writeValueAsString(Map.of("enrolled", false, "reason", "not_authorized_by_learner"));
            }
            FlashcardService svc = flashcards.getIfAvailable();
            if (svc == null) return "{\"error\":\"unavailable\"}";
            long deckId = args.get("deck_id").asLong();
            Optional<VocabDeckSummaryResponse> target = svc.getDecks(turn.userId()).stream()
                    .filter(d -> d.getId() != null && d.getId().equals(deckId))
                    .findFirst();
            if (target.isEmpty()) {
                return mapper.writeValueAsString(Map.of("enrolled", false, "reason", "deck_not_found"));
            }
            int added = svc.enrollDeck(turn.userId(), deckId);
            EchoLearnerBrain b = brain.getIfAvailable();
            if (b != null) b.forget(turn.userId());
            String title = clip(target.get().getTitle(), 70);
            String href = "/flashcards?deck=" + deckId;
            turn.action(EchoAction.navigate(href, turn.t("Bộ thẻ: ", "Deck: ") + title, EchoRouter.explicitOpen(turn.userText())));
            return mapper.writeValueAsString(Map.of("enrolled", true, "deckId", deckId, "title", title, "addedCards", added));
        }
    }

    /** Idempotently adds a custom vocabulary flashcard to the authenticated learner's personal collection. */
    @Component
    public static class CreateFlashcardTool implements EchoTool {
        private final ObjectProvider<FlashcardService> flashcards;
        private final ObjectProvider<EchoLearnerBrain> brain;
        private final ObjectMapper mapper;

        public CreateFlashcardTool(ObjectProvider<FlashcardService> flashcards,
                                   ObjectProvider<EchoLearnerBrain> brain,
                                   ObjectMapper mapper) {
            this.flashcards = flashcards;
            this.brain = brain;
            this.mapper = mapper;
        }

        @Override public String name() { return "create_flashcard"; }
        @Override public String description() {
            return "Create a personal flashcard for this learner when they explicitly ask to save a word or phrase to Flashcards. "
                    + "Idempotent: if the learner already has the word, their existing card is kept unchanged.";
        }
        @Override public Map<String, Object> parameters() {
            Map<String, Object> props = new LinkedHashMap<>();
            props.put("front", EchoToolRegistry.str("English word or short phrase", 120));
            props.put("back", EchoToolRegistry.str("Clear Vietnamese meaning or concise definition", 400));
            props.put("example", EchoToolRegistry.str("Natural English example sentence", 300));
            props.put("ipa", EchoToolRegistry.str("Optional IPA pronunciation, e.g. /rɪˈzɪliənt/", 80));
            props.put("cefr", EchoToolRegistry.enumOf("Optional CEFR level", List.of("A1", "A2", "B1", "B2", "C1", "C2")));
            props.put("part_of_speech", EchoToolRegistry.str("Optional part of speech (noun, verb, adjective, idiom)", 32));
            return EchoToolRegistry.schema(props, List.of("front", "back"));
        }
        @Override public Kind kind() { return Kind.READ; }
        @Override public boolean readOnlyTransaction() { return false; }
        @Override public String status(boolean vi) { return vi ? "Echo đang lưu thẻ từ vựng…" : "Echo is saving your flashcard…"; }

        @Override
        public String run(EchoTurn turn, JsonNode args) throws Exception {
            // Strict CaMeL predicate: require learner's own unquoted words to authorize flashcard creation (blocks indirect passage injections)
            if (!com.englishcoach.ai.echo.camel.CaMeLPolicyEngine.canSaveOrPrepareFlashcards(turn)) {
                return mapper.writeValueAsString(Map.of("saved", false, "reason", "not_authorized_by_learner"));
            }
            FlashcardService svc = flashcards.getIfAvailable();
            if (svc == null) return "{\"error\":\"unavailable\"}";
            String front = args.get("front").asText();
            String back = args.get("back").asText();
            String example = args.path("example").asText(null);
            String ipa = args.path("ipa").asText(null);
            String cefr = args.path("cefr").asText(null);
            String pos = args.path("part_of_speech").asText(null);
            FlashcardService.ContextSense sense = pos != null ? new FlashcardService.ContextSense(null, pos, null) : null;
            FlashcardService.SavedCard saved = svc.saveCustomFlashcard(turn.userId(), front, back, example, ipa, cefr, sense);
            EchoLearnerBrain b = brain.getIfAvailable();
            if (b != null) b.forget(turn.userId());
            String word = saved.card() != null && saved.card().getDictionaryEntry() != null
                    ? saved.card().getDictionaryEntry().getWord() : front;
            List<EchoCard.Item> items = List.of(new EchoCard.Item(
                    clip(word, 70),
                    clip(back, 90),
                    saved.created() ? turn.t("Đã tạo mới", "Created") : turn.t("Đã có trong bộ thẻ", "Already saved"),
                    "/flashcards",
                    null));
            turn.card(EchoCard.of("resources", turn.t("Thẻ từ vựng đã lưu", "Saved flashcard"), items, null));
            return mapper.writeValueAsString(Map.of(
                    "saved", true,
                    "created", saved.created(),
                    "word", clip(word, 70)));
        }
    }
}
