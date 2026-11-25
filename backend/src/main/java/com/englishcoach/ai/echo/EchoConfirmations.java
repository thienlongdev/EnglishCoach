package com.englishcoach.ai.echo;

import com.englishcoach.common.cache.BoundedTtlCache;
import com.englishcoach.flashcard.service.FlashcardService;
import com.englishcoach.learningpath.LearningPathDtos;
import com.englishcoach.learningpath.LearningPathException;
import com.englishcoach.learningpath.LearningPathService;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * PREPARE → PREVIEW → CONFIRM → VALIDATE → COMMIT for changes Echo proposes. A PREPARE tool stores the exact change under a
 * random single-use token bound to the learner (10 minutes, in memory, bounded); nothing changes until the learner presses
 * "Xác nhận". The commit re-validates through the owning service ({@link LearningPathService#setGoal},
 * {@link LearningPathService#apply}, or {@link FlashcardService#saveCustomFlashcard}: its own rules, lock and idempotence)
 * and the token is removed on first use, so a double click or a replayed voice turn cannot apply twice. A token of another
 * learner answers exactly like a missing one.
 */
@Service
public class EchoConfirmations {
    public static final long TTL_MS = 10 * 60_000;
    private static final SecureRandom RANDOM = new SecureRandom();

    public sealed interface PreparedChange permits PlanChange, DnaProposalCommit, FlashcardBatchCommit {}

    public record PlanChange(String goal, Integer dailyMinutes, String target) implements PreparedChange {}

    public record DnaProposalCommit(long proposalId) implements PreparedChange {}

    public record FlashcardDraft(String front, String back, String example, String ipa, String cefr, String partOfSpeech) {}

    public record FlashcardBatchCommit(List<FlashcardDraft> cards) implements PreparedChange {}

    record Pending(long userId, PreparedChange change, Instant expiresAt) {}

    public record Outcome(String status, Map<String, Object> plan) {}

    private final BoundedTtlCache<String, Pending> pending = new BoundedTtlCache<>(20_000, TTL_MS);
    private final ObjectProvider<LearningPathService> learningPath;
    private final ObjectProvider<FlashcardService> flashcards;

    /** Backward-compatible 1-arg constructor preserved for slim unit tests. */
    public EchoConfirmations(ObjectProvider<LearningPathService> learningPath) {
        this(learningPath, null);
    }

    @Autowired
    public EchoConfirmations(ObjectProvider<LearningPathService> learningPath,
                             @Autowired(required = false) ObjectProvider<FlashcardService> flashcards) {
        this.learningPath = learningPath;
        this.flashcards = flashcards;
    }

    public String issue(long userId, PlanChange change) {
        return issueChange(userId, change);
    }

    public String issue(long userId, DnaProposalCommit commit) {
        return issueChange(userId, commit);
    }

    public String issue(long userId, FlashcardBatchCommit batch) {
        return issueChange(userId, batch);
    }

    private String issueChange(long userId, PreparedChange change) {
        byte[] bytes = new byte[24];
        RANDOM.nextBytes(bytes);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        pending.put(token, new Pending(userId, change, Instant.now().plusMillis(TTL_MS)));
        return token;
    }

    /** Applies (accept) or discards a prepared change. Unknown, foreign, used or expired tokens: 404. */
    public Outcome decide(long userId, String token, boolean accept) {
        if (token == null || !token.matches("[A-Za-z0-9_-]{20,64}")) throw notFound();
        Pending p;
        synchronized (pending) { // read-and-remove is one step: two concurrent presses cannot both obtain the change
            p = Optional.ofNullable(pending.getIfPresent(token)).filter(x -> x.userId() == userId).orElseThrow(EchoConfirmations::notFound);
            pending.invalidate(token);
        }
        if (p.expiresAt().isBefore(Instant.now())) throw notFound();
        if (p.change() instanceof PlanChange pc) {
            if (!accept) return new Outcome("CANCELLED", Map.of());
            LearningPathService svc = requireLearningPath();
            var view = svc.setGoal(userId, new LearningPathDtos.GoalRequest(pc.goal(), pc.dailyMinutes(), pc.target()));
            return new Outcome("APPLIED", toPlanMap(view));
        }
        if (p.change() instanceof DnaProposalCommit dna) {
            LearningPathService svc = requireLearningPath();
            try {
                if (!accept) {
                    svc.cancel(userId, dna.proposalId());
                    return new Outcome("CANCELLED", Map.of("proposalId", dna.proposalId()));
                }
                var view = svc.apply(userId, dna.proposalId());
                return new Outcome("APPLIED", toPlanMap(view));
            } catch (LearningPathException ex) {
                String code = ex.getMessage() == null ? "CONFLICT" : ex.getMessage();
                HttpStatus status = switch (code) {
                    case "NO_PLAN", "NOT_FOUND" -> HttpStatus.NOT_FOUND;
                    case "EXPIRED" -> HttpStatus.GONE;
                    case "RATE_LIMITED" -> HttpStatus.TOO_MANY_REQUESTS;
                    case "DNA_UNAVAILABLE" -> HttpStatus.SERVICE_UNAVAILABLE;
                    default -> HttpStatus.CONFLICT;
                };
                throw new ResponseStatusException(status, code);
            }
        }
        if (p.change() instanceof FlashcardBatchCommit batch) {
            if (!accept) {
                return new Outcome("CANCELLED", Map.of("count", batch.cards().size()));
            }
            FlashcardService svc = flashcards == null ? null : flashcards.getIfAvailable();
            if (svc == null) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "UNAVAILABLE");
            int created = 0;
            int existing = 0;
            for (FlashcardDraft d : batch.cards()) {
                FlashcardService.ContextSense sense = d.partOfSpeech() != null && !d.partOfSpeech().isBlank()
                        ? new FlashcardService.ContextSense(null, d.partOfSpeech(), null) : null;
                FlashcardService.SavedCard saved = svc.saveCustomFlashcard(
                        userId, d.front(), d.back(), d.example(), d.ipa(), d.cefr(), sense);
                if (saved != null && saved.created()) created++; else existing++;
            }
            return new Outcome("APPLIED", Map.of(
                    "created", created,
                    "existing", existing,
                    "total", batch.cards().size(),
                    "href", "/flashcards"));
        }
        throw notFound();
    }

    private LearningPathService requireLearningPath() {
        LearningPathService svc = learningPath.getIfAvailable();
        if (svc == null) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "UNAVAILABLE");
        return svc;
    }

    private static Map<String, Object> toPlanMap(LearningPathDtos.TodayView view) {
        return view == null || view.plan() == null ? Map.of() : Map.of(
                "goal", view.plan().goal(),
                "dailyMinutes", view.plan().dailyMinutes(),
                "target", view.plan().target() == null ? "" : view.plan().target());
    }

    private static ResponseStatusException notFound() { return new ResponseStatusException(HttpStatus.NOT_FOUND, "NOT_FOUND"); }
}
