package com.englishcoach.ai.echo;

import com.englishcoach.flashcard.service.FlashcardService;
import com.englishcoach.grammar.GrammarService;
import com.englishcoach.learningpath.LearningPathService;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.englishcoach.writing.repository.WritingErrorMemoryRepository;
import java.util.*;

/**
 * Proactive help without inference. Deterministic eligibility rules over stored state, template wording, at most three
 * suggestions; the client shows them only when the learner switched suggestions on, with its own cooldown and dismissal.
 * No model call, no background polling: read when the learner opens Echo.
 */
@Service
public class EchoSuggestionService {
    public record Suggestion(String key, String text, String href, String label) {}

    private final ObjectProvider<FlashcardService> flashcards;
    private final ObjectProvider<GrammarService> grammar;
    private final ObjectProvider<LearningPathService> learningPath;
    private final EchoDestinations destinations;
    private final WritingErrorMemoryRepository writing;

    public EchoSuggestionService(ObjectProvider<FlashcardService> flashcards, ObjectProvider<GrammarService> grammar,
                                 ObjectProvider<LearningPathService> learningPath, EchoDestinations destinations, WritingErrorMemoryRepository writing) {
        this.writing = writing;
        this.flashcards = flashcards; this.grammar = grammar; this.learningPath = learningPath; this.destinations = destinations;
    }

    @Transactional(readOnly = true, timeout = 10)
    public List<Suggestion> suggestions(long userId, boolean vi) {
        List<Suggestion> out = new ArrayList<>();
        try {
            Map<String, Object> plan = Optional.ofNullable(learningPath.getIfAvailable()).map(s -> s.planSummary(userId)).orElse(Map.of());
            if (plan.get("todayTasks") instanceof Number total && plan.get("todayDone") instanceof Number done && total.intValue() > done.intValue())
                out.add(new Suggestion("path-today", vi ? "Bạn còn " + (total.intValue() - done.intValue()) + " nhiệm vụ trong lộ trình hôm nay."
                        : "You have " + (total.intValue() - done.intValue()) + " Learning Path tasks left today.",
                        EchoDestinations.Dest.TODAY.pattern(), EchoDestinations.Dest.TODAY.label(vi)));
        } catch (RuntimeException ignored) { }
        try {
            FlashcardService cards = flashcards.getIfAvailable();
            long due = cards == null ? 0 : cards.countReviewDue(userId);
            if (due >= 5) out.add(new Suggestion("cards-due", vi ? "Có " + due + " thẻ từ vựng đến hạn ôn. Ôn ngay khi trí nhớ còn mới nhé."
                    : due + " flashcards are due. Review them while they are fresh.",
                    EchoDestinations.Dest.FLASHCARDS_REVIEW.pattern(), EchoDestinations.Dest.FLASHCARDS_REVIEW.label(vi)));
        } catch (RuntimeException ignored) { }
        try {
            GrammarService g = grammar.getIfAvailable();
            if (g != null) {
                var me = g.me(userId);
                if (!me.dueReviews().isEmpty()) {
                    var r = destinations.resolve(userId, EchoDestinations.Dest.GRAMMAR_TOPIC, me.dueReviews().get(0), null, null, null, vi);
                    if (r.ok()) out.add(new Suggestion("grammar-review", vi ? "Một chủ điểm ngữ pháp bạn đã thành thạo đến lúc ôn lại."
                            : "A grammar topic you mastered is due for review.", r.href(), r.label()));
                }
                var top = g.mistakes(userId).groups().stream().filter(m -> m.recent30d() >= 3).max(Comparator.comparingInt(m -> m.recent30d()));
                if (top.isPresent()) out.add(new Suggestion("grammar-mistake", vi ? "Bạn sai một mẫu ngữ pháp " + top.get().recent30d() + " lần trong 30 ngày. Xem lại lỗi này nhé?"
                        : "One grammar pattern went wrong " + top.get().recent30d() + " times in 30 days. Want to review it?",
                        EchoDestinations.Dest.GRAMMAR_MISTAKES.pattern(), EchoDestinations.Dest.GRAMMAR_MISTAKES.label(vi)));
            }
        } catch (RuntimeException ignored) { }
        if (out.size() < 3) {
            try {
                boolean due = writing.findTop3ByUserIdAndIsMutedFalseOrderByLastSeenAtDesc(userId).stream()
                        .anyMatch(p -> Boolean.TRUE.equals(p.getHasSufficientEvidence()) && Boolean.TRUE.equals(p.getDueForPractice()));
                if (due) out.add(new Suggestion("writing-review", vi ? "Một mẫu lỗi trong bài viết của bạn đã đến lúc ôn."
                        : "A pattern from your assessed writing is due for review.",
                        EchoDestinations.Dest.WRITING_SENTENCE_MISTAKES.pattern(), EchoDestinations.Dest.WRITING_SENTENCE_MISTAKES.label(vi)));
            } catch (RuntimeException ignored) { }
        }
        return out.stream().limit(3).toList();
    }
}
