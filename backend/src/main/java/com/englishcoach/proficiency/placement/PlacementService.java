package com.englishcoach.proficiency.placement;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Server-side placement quiz (model 2): the server picks vocabulary + grammar multiple-choice questions per level,
 * shuffles questions and options, stores the issue (with the correct indexes), the client sends only the chosen
 * option index per question (or null = "Tôi chưa biết"), the server scores. No evidence, no rating / confidence /
 * peak / relativeMult change (Proficiency pipeline; the division level is read through leaderboard_division_level).
 * <p>V69 reliability: every answer is autosaved in {@code proficiency_placement_progress}; an unfinished attempt can be
 * resumed (same questions, same order, answers restored) until the issue expires; a learner has at most one attempt in
 * progress (start never replaces it silently — {@code replace = true} abandons it explicitly); submit is idempotent
 * (a resubmit of the same attempt returns the stored result, never a second one).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PlacementService {

    /** 409 reason when an unfinished attempt exists (the client offers "Tiếp tục" / "Làm lại từ đầu"). */
    public static final String ACTIVE_ATTEMPT = "ACTIVE_ATTEMPT";

    private final PlacementQuizProperties props;
    private final PlacementRepository repository;
    private final ObjectProvider<PlacementCompletionListener> completionListeners;
    private final SecureRandom random = new SecureRandom();

    /** What the learner sees: skill (VOCABULARY / GRAMMAR), the sentence with one blank, four options. No level, no key. */
    public record IssuedItem(int index, String skill, String prompt, List<String> options) {}

    public record StartResponse(UUID attemptId, List<IssuedItem> items, Instant expiresAt) {}

    public record SkillScore(int correct, int total) {}

    public record SubmitResponse(String status, String resultCefr, boolean lowConfidence, Instant retakeAvailableAt,
                                 SkillScore vocabulary, SkillScore grammar) {}

    /** Summary of the unfinished attempt (resume banner). */
    public record ActiveSummary(UUID attemptId, int answered, int total, Instant updatedAt, Instant expiresAt) {}

    /** Full resume payload: the same questions (no keys) + the answers saved so far. */
    public record ActiveResponse(UUID attemptId, List<IssuedItem> items, List<Integer> answers, int answered, int total,
                                 Instant startedAt, Instant updatedAt, Instant expiresAt) {}

    public record SaveResponse(UUID attemptId, int answered, int total, Instant savedAt) {}

    /**
     * @param outdated      the latest VALID result comes from the retired model 1 (yes/no word list): a retake is open
     * @param activeAttempt unfinished attempt that can be resumed (null when none)
     */
    public record MeResponse(String latestStatus, String resultCefr, boolean lowConfidence, Instant takenAt,
                             boolean canRetake, Instant retakeAvailableAt, int itemCount, boolean outdated,
                             ActiveSummary activeAttempt) {}

    @Transactional
    public StartResponse start(long userId, Instant now) {
        return start(userId, now, false);
    }

    /** @param replace abandon an unfinished attempt explicitly ("Làm lại từ đầu"); false ⇒ 409 ACTIVE_ATTEMPT if one exists */
    @Transactional
    public StartResponse start(long userId, Instant now, boolean replace) {
        requireEnabled();
        Instant retakeAt = retakeAvailableAt(userId);
        if (retakeAt != null && now.isBefore(retakeAt)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "RETAKE_LOCKED until " + retakeAt);
        }
        Optional<PlacementRepository.Progress> active = activeProgress(userId, now);
        if (active.isPresent()) {
            if (!replace) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, ACTIVE_ATTEMPT);
            }
            repository.closeProgress(active.get().issueId(), "ABANDONED", now);
        }
        List<PlacementQuestionValidator.Question> picked = new ArrayList<>();
        picked.addAll(pick(PlacementScorer.VOCABULARY, props.getVocabularyPerLevel()));
        picked.addAll(pick(PlacementScorer.GRAMMAR, props.getGrammarPerLevel()));
        Collections.shuffle(picked, random);

        List<PlacementScorer.Item> stored = new ArrayList<>(picked.size());
        for (int i = 0; i < picked.size(); i++) {
            PlacementQuestionValidator.Question q = picked.get(i);
            List<Integer> order = new ArrayList<>(List.of(0, 1, 2, 3));
            Collections.shuffle(order, random);
            List<String> options = new ArrayList<>(4);
            int answer = -1;
            for (int pos = 0; pos < 4; pos++) {
                int original = order.get(pos);
                options.add(q.options().get(original).trim());
                if (original == q.answerIndex()) answer = pos;
            }
            stored.add(new PlacementScorer.Item(i, q.id(), q.skill(), q.cefr(), q.prompt(), options, answer));
        }
        UUID id = UUID.randomUUID();
        Instant expires = now.plus(Duration.ofMinutes(props.getIssueTtlMinutes()));
        repository.insertIssue(id, userId, stored, now, expires, PlacementQuizProperties.MODEL_VERSION);
        try {
            repository.insertProgress(id, userId, now);
        } catch (DuplicateKeyException ex) { // concurrent start in another tab
            throw new ResponseStatusException(HttpStatus.CONFLICT, ACTIVE_ATTEMPT);
        }
        return new StartResponse(id, shown(stored), expires);
    }

    /** {@code perLevel} valid questions of one skill for every level; malformed rows are skipped and logged. */
    private List<PlacementQuestionValidator.Question> pick(String skill, int perLevel) {
        List<PlacementQuestionValidator.Question> rows = repository.randomQuestions(props.getLevels(), skill, perLevel + 3);
        List<PlacementQuestionValidator.Question> out = new ArrayList<>();
        for (String level : props.getLevels()) {
            int taken = 0;
            for (PlacementQuestionValidator.Question q : rows) {
                if (taken >= perLevel || !level.equals(q.cefr())) continue;
                List<String> problems = PlacementQuestionValidator.problems(q);
                if (!problems.isEmpty()) {
                    log.warn("[Placement] Skipping malformed question {}: {}", q.key(), problems);
                    continue;
                }
                out.add(q);
                taken++;
            }
            if (taken < perLevel) {
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                        "placement question bank incomplete for " + level + " " + skill);
            }
        }
        return out;
    }

    /** Unfinished attempt with its questions and saved answers (empty when none / expired). */
    @Transactional
    public Optional<ActiveResponse> active(long userId, Instant now) {
        Optional<PlacementRepository.Progress> p = activeProgress(userId, now);
        if (p.isEmpty()) return Optional.empty();
        PlacementRepository.Issue issue = repository.findIssue(p.get().issueId()).orElseThrow();
        List<Integer> answers = p.get().answers();
        return Optional.of(new ActiveResponse(issue.id(), shown(issue.items()), answers, answers.size(), issue.items().size(),
                p.get().startedAt(), p.get().updatedAt(), issue.expiresAt()));
    }

    /** Autosave: the answers given so far (prefix in question order; null = "Tôi chưa biết"). */
    @Transactional
    public SaveResponse saveProgress(long userId, UUID attemptId, List<Integer> answers, Instant now) {
        requireEnabled();
        PlacementRepository.Issue issue = ownIssue(userId, attemptId);
        if (now.isAfter(issue.expiresAt()) || issue.modelVersion() != PlacementQuizProperties.MODEL_VERSION) {
            repository.closeProgress(attemptId, "ABANDONED", now);
            throw new ResponseStatusException(HttpStatus.GONE, "placement attempt expired");
        }
        if (answers == null || answers.size() > issue.items().size()
                || answers.stream().anyMatch(a -> a != null && (a < 0 || a > 3))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "answers must contain at most one option index (0–3) or null per issued question");
        }
        if (!repository.saveProgress(attemptId, userId, answers, now)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "placement attempt is no longer in progress");
        }
        return new SaveResponse(attemptId, answers.size(), issue.items().size(), now);
    }

    /** "Thoát" is NOT abandon (the attempt stays resumable); this is the explicit discard. Idempotent. */
    @Transactional
    public void abandon(long userId, UUID attemptId, Instant now) {
        ownIssue(userId, attemptId);
        repository.closeProgress(attemptId, "ABANDONED", now);
    }

    @Transactional
    public SubmitResponse submit(long userId, UUID attemptId, List<Integer> answers, Instant now) {
        requireEnabled();
        PlacementRepository.Issue issue = ownIssue(userId, attemptId);
        // Idempotent: a retry after a lost response returns the stored result (never a second result).
        Optional<PlacementRepository.StoredResult> stored = repository.findAttemptByIssue(attemptId);
        if (stored.isPresent()) {
            return fromStored(stored.get());
        }
        if (now.isAfter(issue.expiresAt()) || issue.modelVersion() != PlacementQuizProperties.MODEL_VERSION) {
            throw new ResponseStatusException(HttpStatus.GONE, "placement attempt expired");
        }
        if (answers == null || answers.size() != issue.items().size()
                || answers.stream().anyMatch(a -> a != null && (a < 0 || a > 3))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "answers must contain one option index (0–3) or null per issued question");
        }
        PlacementScorer.Result r = PlacementScorer.score(issue.items(), answers, props.scorerParams());
        try {
            repository.insertAttempt(attemptId, userId, issue.items(), answers, r, now, PlacementQuizProperties.MODEL_VERSION);
        } catch (DuplicateKeyException ex) {
            return repository.findAttemptByIssue(attemptId).map(this::fromStored)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.CONFLICT, "placement attempt already submitted"));
        }
        repository.closeProgress(attemptId, "COMPLETED", now);
        notifyCompleted(userId);
        Instant retake = "VALID".equals(r.status()) ? now.plus(Duration.ofDays(props.getRetakeDays())) : null;
        Map<String, PlacementScorer.SkillCount> s = r.skills();
        return new SubmitResponse(r.status(), r.resultCefr(), r.lowConfidence(), retake,
                skill(s.get(PlacementScorer.VOCABULARY)), skill(s.get(PlacementScorer.GRAMMAR)));
    }

    @Transactional
    public MeResponse me(long userId, Instant now) {
        Optional<PlacementRepository.Attempt> latest = repository.latestAttempt(userId, false, null);
        Optional<PlacementRepository.Attempt> valid = repository.latestAttempt(userId, true, null);
        Instant retakeAt = retakeAvailableAt(userId);
        boolean canRetake = props.isEnabled() && (retakeAt == null || !now.isBefore(retakeAt));
        boolean outdated = valid.map(a -> a.modelVersion() < PlacementQuizProperties.MODEL_VERSION).orElse(false);
        ActiveSummary active = activeProgress(userId, now).flatMap(p -> repository.findIssue(p.issueId())
                .map(i -> new ActiveSummary(i.id(), p.answers().size(), i.items().size(), p.updatedAt(), i.expiresAt())))
                .orElse(null);
        return new MeResponse(latest.map(PlacementRepository.Attempt::status).orElse(null),
                valid.map(PlacementRepository.Attempt::resultCefr).orElse(null),
                valid.map(PlacementRepository.Attempt::lowConfidence).orElse(false),
                valid.map(PlacementRepository.Attempt::createdAt).orElse(null), canRetake,
                canRetake ? null : retakeAt, props.itemCount(), outdated, active);
    }

    // ---------------------------------------------------------------------------------------------

    /** The caller's IN_PROGRESS attempt; an expired or retired-model one is closed as ABANDONED and not returned. */
    private Optional<PlacementRepository.Progress> activeProgress(long userId, Instant now) {
        Optional<PlacementRepository.Progress> p = repository.findActiveProgress(userId);
        if (p.isEmpty()) return p;
        Optional<PlacementRepository.Issue> issue = repository.findIssue(p.get().issueId());
        boolean submitted = repository.findAttemptByIssue(p.get().issueId()).isPresent();
        if (submitted || issue.isEmpty() || now.isAfter(issue.get().expiresAt())
                || issue.get().modelVersion() != PlacementQuizProperties.MODEL_VERSION) {
            repository.closeProgress(p.get().issueId(), submitted ? "COMPLETED" : "ABANDONED", now);
            return Optional.empty();
        }
        return p;
    }

    private PlacementRepository.Issue ownIssue(long userId, UUID attemptId) {
        return repository.findIssue(attemptId)
                .filter(i -> i.userId() == userId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
    }

    private static List<IssuedItem> shown(List<PlacementScorer.Item> items) {
        List<IssuedItem> out = new ArrayList<>(items.size());
        for (PlacementScorer.Item it : items) {
            out.add(new IssuedItem(it.index(), it.skill(), it.prompt(), it.options() == null ? List.of() : List.copyOf(it.options())));
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private SubmitResponse fromStored(PlacementRepository.StoredResult r) {
        Instant retake = "VALID".equals(r.status()) && r.modelVersion() == PlacementQuizProperties.MODEL_VERSION
                ? r.createdAt().plus(Duration.ofDays(props.getRetakeDays())) : null;
        Object skills = r.details() == null ? null : r.details().get("skills");
        Map<String, Object> m = skills instanceof Map<?, ?> map ? (Map<String, Object>) map : Map.of();
        return new SubmitResponse(r.status(), r.resultCefr(), r.lowConfidence(), retake,
                storedSkill(m.get(PlacementScorer.VOCABULARY)), storedSkill(m.get(PlacementScorer.GRAMMAR)));
    }

    private static SkillScore storedSkill(Object o) {
        if (o instanceof Map<?, ?> m && m.get("correct") instanceof Number c && m.get("total") instanceof Number t) {
            return new SkillScore(c.intValue(), t.intValue());
        }
        return new SkillScore(0, 0);
    }

    /** Retake lock comes only from a VALID attempt of the current model (old model-1 results can be redone now). */
    private Instant retakeAvailableAt(long userId) {
        return repository.latestAttempt(userId, true, PlacementQuizProperties.MODEL_VERSION)
                .map(a -> a.createdAt().plus(Duration.ofDays(props.getRetakeDays()))).orElse(null);
    }

    private void notifyCompleted(long userId) {
        completionListeners.orderedStream().forEach(l -> {
            try {
                l.placementCompleted(userId);
            } catch (RuntimeException ex) {
                log.warn("[Placement] Completion listener failed (ignored): {}", ex.getMessage());
            }
        });
    }

    private static SkillScore skill(PlacementScorer.SkillCount c) {
        return c == null ? new SkillScore(0, 0) : new SkillScore(c.correct(), c.total());
    }

    private void requireEnabled() {
        if (!props.isEnabled()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "placement quiz disabled");
        }
    }
}
