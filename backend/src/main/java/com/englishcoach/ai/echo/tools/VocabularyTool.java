package com.englishcoach.ai.echo.tools;

import com.englishcoach.ai.dto.EchoAction;
import com.englishcoach.ai.dto.EchoCard;
import com.englishcoach.ai.echo.EchoDestinations;
import com.englishcoach.ai.echo.EchoRouter;
import com.englishcoach.ai.echo.EchoTool;
import com.englishcoach.ai.echo.EchoToolRegistry;
import com.englishcoach.ai.echo.EchoTurn;
import com.englishcoach.flashcard.service.FlashcardService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.*;

/** Due vocabulary and the learner's enrolled decks with the most cards due (Flashcards scheduler is the authority). */
@Component
public class VocabularyTool implements EchoTool {
    private final ObjectProvider<FlashcardService> flashcards;
    private final ObjectMapper mapper;

    public VocabularyTool(ObjectProvider<FlashcardService> flashcards, ObjectMapper mapper) { this.flashcards = flashcards; this.mapper = mapper; }

    public String name() { return "get_vocabulary_status"; }
    public String description() {
        return "Read this learner's flashcard state: cards due for review now (the scheduler's stored dates), and up to 5 enrolled "
                + "decks with their due / mastered counts. Use for vocabulary review advice or 'my weakest vocabulary deck'.";
    }
    public Map<String, Object> parameters() { return EchoToolRegistry.schema(Map.of(), List.of()); }
    public Kind kind() { return Kind.READ; }
    public String status(boolean vi) { return vi ? "Echo đang xem thẻ từ vựng của bạn…" : "Echo is checking your flashcards…"; }

    public String run(EchoTurn turn, JsonNode args) {
        FlashcardService svc = flashcards.getIfAvailable();
        if (svc == null) return "{\"error\":\"unavailable\"}";
        long reviewDue = svc.countReviewDue(turn.userId());
        long due = svc.countActualDue(turn.userId());
        ObjectNode out = mapper.createObjectNode().put("reviewDueNow", reviewDue).put("dueIncludingNewCards", due);
        ArrayNode decks = out.putArray("enrolledDecks");
        List<EchoCard.Item> items = new ArrayList<>();
        svc.getDecks(turn.userId()).stream().filter(d -> d.isEnrolled() && d.getTotalWords() > 0)
                .sorted(Comparator.comparingLong((com.englishcoach.flashcard.dto.VocabDeckSummaryResponse d) -> d.getDueCount()).reversed()
                        .thenComparingDouble(d -> d.getTotalWords() == 0 ? 1 : (double) d.getMasteredCount() / d.getTotalWords()))
                .limit(5).forEach(d -> {
                    int mastered = d.getTotalWords() == 0 ? 0 : (int) Math.round(100.0 * d.getMasteredCount() / d.getTotalWords());
                    decks.addObject().put("title", clip(d.getTitle())).put("due", d.getDueCount()).put("words", d.getTotalWords())
                            .put("masteredPct", mastered);
                    items.add(new EchoCard.Item(clip(d.getTitle()), turn.t(d.getDueCount() + " thẻ đến hạn", d.getDueCount() + " due"),
                            turn.t("thành thạo " + mastered + "%", mastered + "% mastered"), "/flashcards", null));
                });
        if (!items.isEmpty()) turn.card(EchoCard.of("resources", turn.t("Bộ thẻ của bạn", "Your decks") + " · " + reviewDue + turn.t(" thẻ cần ôn", " due"), items, null));
        if (reviewDue > 0) turn.action(EchoAction.navigate(EchoDestinations.Dest.FLASHCARDS_REVIEW.pattern(),
                EchoDestinations.Dest.FLASHCARDS_REVIEW.label(turn.vi()), EchoRouter.explicitOpen(turn.userText())));
        return out.toString();
    }

    private static String clip(String s) { return s == null ? "" : s.length() <= 70 ? s : s.substring(0, 69) + "…"; }
}
