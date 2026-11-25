package com.englishcoach.grammar;

import com.englishcoach.grammar.GrammarContent.TopicMeta;
import com.englishcoach.grammar.GrammarDtos.*;
import com.englishcoach.grammar.GrammarEvaluator.Verdict;
import com.englishcoach.grammar.GrammarRepository.*;
import com.englishcoach.progress.service.LearningEventService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;
import java.util.concurrent.ThreadLocalRandom;
import java.util.stream.Collectors;

/**
 * Learner state of the Grammar Academy. Mastery is a server decision taken only from a submitted check the server issued:
 * reading a lesson or practising never sets it. No AI anywhere here (the optional Grammar Professor is its own service).
 *
 * The numbers below are design choices, not measured psychometrics: never present them as a validated scale. Mastery needs a
 * check of at least {@value #MIN_EVIDENCE} scored items at {@value #MASTERY_PCT} %. Reviews are spaced by a fixed ladder.
 */
@Service
public class GrammarService {

    static final int MIN_EVIDENCE = 4;
    static final int MASTERY_PCT = 80;
    static final int REVIEW_PASS_PCT = 70;
    static final int READY_MIN_SCORED = 5;
    static final int MAX_SESSIONS_PER_DAY = 60;
    static final int MAX_REPORTS_PER_DAY = 30;
    /** Days until the next review after each passed step. */
    static final int[] REVIEW_LADDER = {3, 7, 21, 60, 120};
    static final List<String> LEVELS = List.of("preA1", "A1", "A2", "B1", "B2", "C1", "C2");
    private static final List<String> DIAGNOSTIC_LEVELS = List.of("A1", "A2", "B1", "B2", "C1");
    private static final ZoneId ZONE = ZoneId.of("Asia/Ho_Chi_Minh");

    private final GrammarContent content;
    private final GrammarEvaluator evaluator;
    private final GrammarRepository repo;
    private final LearningEventService events;
    private final ObjectMapper mapper;

    public GrammarService(GrammarContent content, GrammarRepository repo, LearningEventService events, ObjectMapper mapper) {
        this.content = content;
        this.evaluator = new GrammarEvaluator(mapper);
        this.repo = repo;
        this.events = events;
        this.mapper = mapper;
    }

    public void open(long userId, String slug) {
        repo.open(userId, slug, content.meta(slug).orElseThrow(() -> new GrammarException(404, "NOT_FOUND")).version());
    }

    public void studied(long userId, String slug) {
        repo.studied(userId, slug, content.meta(slug).orElseThrow(() -> new GrammarException(404, "NOT_FOUND")).version());
    }

    @Transactional
    public VerdictView attempt(long userId, AttemptRequest request) {
        repo.lockLearner(userId);
        JsonNode ex = content.exercise(request.exerciseId());
        // A check-only item is never practised: its answer must stay unseen until a check issues it.
        if ("check".equals(ex.path("use").asText())) throw new GrammarException(404, "NOT_FOUND");
        String slug = content.topicOfExercise(request.exerciseId()).orElseThrow();
        Verdict v = evaluator.evaluate(ex, request.answer());
        NewAttempt proposed = new NewAttempt(userId, request.requestId(), slug, request.exerciseId(), ex.path("type").asText(),
                content.meta(slug).map(TopicMeta::version).orElse(1), "PRACTICE", v.outcome(), v.score(),
                v.answerText() == null ? answerDigest(request.answer()) : trim(v.answerText()), tags(v), null);
        repo.attempt(userId, request.requestId()).ifPresent(previous -> {
            if (!sameAttempt(previous, proposed)) throw new GrammarException(409, "REQUEST_ID_REUSED");
        });
        InsertOutcome stored = repo.insertPractice(proposed);
        if (stored.firstToday() && stored.inserted()) {
            events.recordEventSafely(userId, "GRAMMAR_PRACTICED", "grammar:" + LocalDate.now(ZONE), Instant.now());
        }
        return new VerdictView(request.exerciseId(), v.outcome(), v.score(), v.explain(), v.reveal(), v.tags());
    }

    private static boolean sameAttempt(NewAttempt a, NewAttempt b) {
        return a.exerciseId().equals(b.exerciseId()) && a.version() == b.version() && a.mode().equals(b.mode())
                && a.outcome().equals(b.outcome()) && Objects.equals(a.answer(), b.answer()) && Objects.equals(a.tags(), b.tags())
                && (a.score() == null ? b.score() == null : b.score() != null && Math.abs(a.score() - b.score()) < 0.00051);
    }

    /** Match/classify have per-position feedback but no prose answer: retain a canonical digest to detect changed retries. */
    private static String answerDigest(JsonNode answer) {
        try {
            return "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(canonical(answer).toString().getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static JsonNode canonical(JsonNode node) {
        if (node.isObject()) {
            var out = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode();
            List<String> fields = new ArrayList<>();
            node.fieldNames().forEachRemaining(fields::add);
            Collections.sort(fields);
            fields.forEach(k -> out.set(k, canonical(node.get(k))));
            return out;
        }
        if (node.isArray()) {
            var out = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.arrayNode();
            node.forEach(n -> out.add(canonical(n)));
            return out;
        }
        return node;
    }

    public MeView me(long userId) {
        List<State> rows = repo.states(userId);
        Instant now = Instant.now();
        Map<String, State> bySlug = rows.stream().filter(s -> content.meta(s.slug()).isPresent()).collect(Collectors.toMap(State::slug, s -> s));
        List<TopicStateView> views = bySlug.values().stream().map(s -> view(s, now)).toList();
        Optional<Profile> profile = repo.profile(userId);
        List<String> marks = repo.bookmarks(userId);
        List<String> due = bySlug.values().stream()
                .filter(s -> s.masteredAt() != null && s.reviewDueAt() != null && !s.reviewDueAt().isAfter(now))
                .sorted(Comparator.comparing(State::reviewDueAt)).map(State::slug).toList();
        int studied = 0, practising = 0, mastered = 0;
        for (State s : bySlug.values()) {
            if (s.studiedAt() != null) studied++;
            if (s.practiceScored() > 0) practising++;
            if (s.masteredAt() != null) mastered++;
        }
        return new MeView(profile.map(Profile::startLevel).orElse(null), profile.map(Profile::startBasis).orElse(null), views, marks,
                recommend(bySlug, profile.map(Profile::startLevel).orElse(null), now), due,
                new Counts(bySlug.size(), studied, practising, mastered, due.size(), repo.recentAttempts(userId, 30), marks.size()));
    }

    static String status(State s, Instant now) {
        if (s.masteredAt() != null) {
            if (s.needsReview()) return "NEEDS_REVIEW";
            if (s.reviewDueAt() != null && !s.reviewDueAt().isAfter(now)) return "REVIEW_DUE";
            return "MASTERED";
        }
        if (s.practiceScored() >= READY_MIN_SCORED && s.practicePoints() / s.practiceScored() >= 0.7) return "READY";
        if (s.practiceScored() > 0 || s.lastCheckPct() != null) return "PRACTISING";
        if (s.studiedAt() != null) return "STUDIED";
        return "OPENED";
    }

    private static TopicStateView view(State s, Instant now) {
        Integer pct = s.practiceScored() > 0 ? (int) Math.round(100 * s.practicePoints() / s.practiceScored()) : null;
        return new TopicStateView(s.slug(), status(s, now), s.firstOpenedAt(), s.studiedAt(), s.practiceScored(), pct, s.lastCheckPct(), s.bestCheckPct(),
                s.lastCheckAt(), s.masteredAt(), s.reviewDueAt(), s.needsReview(), s.reviewStage());
    }

    /** Deterministic: reviews that are due, what the learner is in the middle of, then the next topic of the guided path. */
    private List<Recommendation> recommend(Map<String, State> states, String startLevel, Instant now) {
        List<Recommendation> out = new ArrayList<>();
        states.values().stream()
                .filter(s -> s.masteredAt() != null && s.reviewDueAt() != null && !s.reviewDueAt().isAfter(now))
                .sorted(Comparator.comparing(State::reviewDueAt)).limit(2)
                .forEach(s -> out.add(new Recommendation(s.slug(), "REVIEW_DUE")));
        states.values().stream()
                .filter(s -> s.masteredAt() == null && "READY".equals(status(s, now)))
                .sorted(Comparator.comparing(State::lastOpenedAt).reversed()).limit(2)
                .forEach(s -> out.add(new Recommendation(s.slug(), "READY_FOR_CHECK")));
        states.values().stream()
                .filter(s -> s.masteredAt() == null && !"READY".equals(status(s, now)))
                .sorted(Comparator.comparing(State::lastOpenedAt).reversed()).limit(2)
                .forEach(s -> out.add(new Recommendation(s.slug(), "CONTINUE")));
        int start = startLevel == null ? 0 : Math.max(0, LEVELS.indexOf(startLevel));
        List<TopicMeta> path = content.topics().stream().filter(TopicMeta::available).filter(t -> "grammar".equals(t.domainKind()))
                .filter(t -> !"reference".equals(t.learningRole()))
                .sorted(Comparator.comparingInt(TopicMeta::path)).toList();
        Set<String> chosen = out.stream().map(Recommendation::slug).collect(Collectors.toSet());
        int added = 0;
        for (TopicMeta t : path) {
            if (added >= 3) break;
            if (chosen.contains(t.slug()) || LEVELS.indexOf(t.level()) < start) continue;
            State s = states.get(t.slug());
            if (s != null && s.masteredAt() != null) continue;
            boolean ready = t.prerequisites().stream().allMatch(p -> {
                State ps = states.get(p);
                TopicMeta pm = content.meta(p).orElse(null);
                return pm == null || LEVELS.indexOf(pm.level()) < start || (ps != null && (ps.masteredAt() != null || ps.studiedAt() != null || ps.practiceScored() > 0));
            });
            if (!ready) continue;
            out.add(new Recommendation(t.slug(), "NEXT_ON_PATH"));
            chosen.add(t.slug());
            added++;
        }
        return out;
    }

    public void setLevel(long userId, String level) {
        repo.setProfile(userId, level, "SELF", null);
    }

    @Transactional
    public CheckView startCheck(long userId, CheckRequest request) {
        repo.lockLearner(userId);
        if (repo.sessionsToday(userId) >= MAX_SESSIONS_PER_DAY) throw new GrammarException(429, "RATE_LIMITED");
        String kind = request.kind();
        String scope = request.scope();
        List<JsonNode> picked = switch (kind) {
            case "TOPIC" -> topicItems(userId, required(scope), 8);
            case "REVIEW" -> {
                State s = repo.state(userId, required(scope)).orElseThrow(() -> new GrammarException(409, "NOT_MASTERED"));
                if (s.masteredAt() == null) throw new GrammarException(409, "NOT_MASTERED");
                requireReviewDue(s);
                yield topicItems(userId, scope, 5);
            }
            case "DIAGNOSTIC" -> diagnosticItems();
            case "DOMAIN" -> mixedItems(content.topics().stream().filter(t -> t.domain().equals(required(scope))).toList(), 10);
            case "IELTS" -> mixedItems(content.topics().stream().filter(t -> t.domain().equals("ielts") || t.ielts()).toList(), 12);
            case "TOEIC" -> mixedItems(content.topics().stream().filter(t -> t.domain().equals("toeic") || t.toeic()).toList(), 12);
            default -> throw new GrammarException(400, "INVALID_REQUEST");
        };
        if (picked.size() < MIN_EVIDENCE) throw new GrammarException(409, "NOT_ENOUGH_ITEMS");
        UUID id = UUID.randomUUID();
        repo.createSession(id, userId, kind, scope, picked.stream().map(e -> {
            String slug = content.topicOfExercise(e.path("id").asText()).orElseThrow();
            TopicMeta meta = content.meta(slug).orElseThrow();
            var frozen = e.deepCopy();
            ((com.fasterxml.jackson.databind.node.ObjectNode) frozen).put("_academyLevel", meta.level());
            return new CheckItem(slug, meta.version(), frozen);
        }).toList());
        return new CheckView(id, kind, scope, Instant.now(), picked.stream().map(e -> (JsonNode) content.learnerExercise(e)).toList(), false, null);
    }

    private static String required(String scope) {
        if (scope == null || scope.isBlank()) throw new GrammarException(400, "INVALID_REQUEST");
        return scope;
    }

    private static boolean gradable(JsonNode ex) {
        return !"open".equals(ex.path("type").asText()) && !"practice".equals(ex.path("use").asText());
    }

    private static boolean productionItem(JsonNode ex) {
        return Set.of("cloze", "transform", "order").contains(ex.path("type").asText())
                && !"recognition".equals(ex.path("skill").asText());
    }

    private static boolean constructedResponse(JsonNode ex, JsonNode answer) {
        if (answer == null || answer.isNull()) return false;
        if ("cloze".equals(ex.path("type").asText())) {
            for (JsonNode value : answer.path("blanks")) if (value.isTextual() && !value.asText().isBlank()) return true;
            return false;
        }
        if ("order".equals(ex.path("type").asText())) return answer.path("seq").isArray() && !answer.path("seq").isEmpty();
        return answer.path("text").isTextual() && !answer.path("text").asText().isBlank();
    }

    /** Mastery and review use only held-out items: practice can reveal every shared item's key while a check is open. */
    private List<JsonNode> topicItems(long userId, String slug, int size) {
        Set<String> seen = repo.recentlySeen(userId, slug);
        List<JsonNode> pool = content.load(slug).exercises().values().stream().filter(GrammarService::gradable)
                .filter(e -> "check".equals(e.path("use").asText())).collect(Collectors.toCollection(ArrayList::new));
        boolean advanced = content.meta(slug).map(t -> LEVELS.indexOf(t.level()) >= 3).orElse(false);
        if (advanced && pool.stream().noneMatch(GrammarService::productionItem))
            throw new GrammarException(409, "NOT_ENOUGH_PRODUCTION_ITEMS");
        Collections.shuffle(pool, ThreadLocalRandom.current());
        pool.sort(Comparator.comparingInt((JsonNode e) -> seen.contains(e.path("id").asText()) ? 1 : 0)
                .thenComparingInt(e -> "check".equals(e.path("use").asText()) ? 0 : 1));
        List<JsonNode> out = new ArrayList<>(pool.subList(0, Math.min(size, pool.size())));
        Set<String> types = out.stream().map(e -> e.path("type").asText()).collect(Collectors.toSet());
        if (types.size() < 2 && !out.isEmpty()) {
            pool.stream().filter(e -> !types.contains(e.path("type").asText())).findFirst().ifPresent(e -> out.set(out.size() - 1, e));
        }
        if (advanced && !out.isEmpty() && out.stream().noneMatch(GrammarService::productionItem)) {
            pool.stream().filter(GrammarService::productionItem).findFirst().ifPresent(e -> out.set(out.size() - 1, e));
        }
        return out;
    }

    private List<JsonNode> diagnosticItems() {
        List<JsonNode> out = new ArrayList<>();
        for (String level : DIAGNOSTIC_LEVELS) {
            List<TopicMeta> band = content.topics().stream().filter(TopicMeta::available).filter(t -> "grammar".equals(t.domainKind()) && level.equals(t.level()))
                    .collect(Collectors.toCollection(ArrayList::new));
            Collections.shuffle(band, ThreadLocalRandom.current());
            int taken = 0;
            for (TopicMeta t : band) {
                if (taken >= 5) break;
                List<JsonNode> pool = content.load(t.slug()).exercises().values().stream().filter(GrammarService::gradable)
                        .filter(e -> level.equals(e.path("level").asText())).collect(Collectors.toCollection(ArrayList::new));
                if (pool.isEmpty()) continue;
                out.add(pool.get(ThreadLocalRandom.current().nextInt(pool.size())));
                taken++;
            }
        }
        return out;
    }

    private List<JsonNode> mixedItems(List<TopicMeta> topics, int size) {
        List<TopicMeta> available = topics.stream().filter(TopicMeta::available).collect(Collectors.toCollection(ArrayList::new));
        Collections.shuffle(available, ThreadLocalRandom.current());
        List<JsonNode> out = new ArrayList<>();
        for (TopicMeta t : available.subList(0, Math.min(size, available.size()))) {
            List<JsonNode> pool = content.load(t.slug()).exercises().values().stream().filter(GrammarService::gradable).collect(Collectors.toCollection(ArrayList::new));
            if (!pool.isEmpty()) out.add(pool.get(ThreadLocalRandom.current().nextInt(pool.size())));
        }
        return out;
    }

    public CheckView check(long userId, UUID id) {
        Session s = repo.session(id, userId, false).orElseThrow(() -> new GrammarException(404, "NOT_FOUND"));
        if (s.submittedAt() != null) return new CheckView(s.id(), s.kind(), s.scope(), s.startedAt(),
                s.items().stream().map(e -> (JsonNode) content.learnerExercise(e.exercise())).toList(), true, parse(s.resultJson()));
        requireSnapshot(s);
        List<JsonNode> items = s.items().stream().map(e -> (JsonNode) content.learnerExercise(e.exercise())).toList();
        return new CheckView(s.id(), s.kind(), s.scope(), s.startedAt(), items, false, null);
    }

    public List<CheckSummary> history(long userId) {
        return repo.sessions(userId, 40).stream().map(s -> new CheckSummary(s.id(), s.kind(), s.scope(), s.startedAt(), s.submittedAt(), s.pct(), s.scoredItems())).toList();
    }

    @Transactional
    public CheckResult submit(long userId, UUID id, CheckSubmit submit) {
        repo.lockLearner(userId);
        Session s = repo.session(id, userId, true).orElseThrow(() -> new GrammarException(404, "NOT_FOUND"));
        if (s.submittedAt() != null) return parse(s.resultJson()); // a repeated submit returns the same result, never a second scoring
        requireSnapshot(s);
        if (submit.answers() == null || !new HashSet<>(s.exerciseIds()).containsAll(submit.answers().keySet()))
            throw new GrammarException(400, "INVALID_ANSWER");

        List<ItemResult> items = new ArrayList<>();
        List<NewAttempt> attempts = new ArrayList<>();
        Map<String, double[]> byLevel = new LinkedHashMap<>();
        double sum = 0;
        int scored = 0, unscored = 0, productionScored = 0, productionCorrect = 0;
        boolean topicEvidence = Set.of("TOPIC", "REVIEW").contains(s.kind());
        int productionRequired = topicEvidence && s.items().stream().anyMatch(item -> {
            String level = item.exercise().path("_academyLevel").asText(
                    content.meta(item.topic()).map(TopicMeta::level).orElse(item.exercise().path("level").asText()));
            return LEVELS.indexOf(level) >= 3;
        }) ? 1 : 0;
        for (CheckItem item : s.items()) {
            JsonNode ex = item.exercise();
            String exerciseId = ex.path("id").asText();
            String slug = item.topic();
            JsonNode answer = submit.answers().get(exerciseId);
            Verdict v = answer == null || answer.isNull() ? unanswered(ex) : evaluator.evaluate(ex, answer);
            items.add(new ItemResult(exerciseId, slug, v.outcome(), v.score(), v.explain(), v.reveal(), snapshotAnswer(ex, answer)));
            attempts.add(new NewAttempt(userId, UUID.randomUUID(), slug, exerciseId, ex.path("type").asText(),
                    item.version(), "CHECK", v.outcome(), v.score(), trim(v.answerText()), tags(v), id));
            if (v.score() == null) { unscored++; continue; }
            if (productionItem(ex) && constructedResponse(ex, answer)) {
                productionScored++;
                if (v.score() >= 1) productionCorrect++;
            }
            sum += v.score();
            scored++;
            double[] band = byLevel.computeIfAbsent(ex.path("level").asText(), k -> new double[2]);
            band[0] += v.score();
            band[1]++;
        }
        // Never round a result below a passing threshold up into mastery or a passed review.
        int pct = scored == 0 ? 0 : (int) Math.floor(100 * sum / scored);
        boolean enough = scored >= MIN_EVIDENCE && productionScored >= productionRequired;
        String mastery = null;
        Instant next = null;
        String suggested = null;
        List<LevelResult> levels = new ArrayList<>();
        Instant now = Instant.now();
        repo.insertCheckAttempts(attempts);

        switch (s.kind()) {
            case "TOPIC" -> {
                State before = repo.state(userId, s.scope()).orElse(null);
                boolean already = before != null && before.masteredAt() != null;
                int version = s.items().get(0).version();
                if (!enough) {
                    mastery = "INSUFFICIENT";
                    repo.recordCheck(userId, s.scope(), version, pct, false, null, null, already && before.needsReview());
                } else if (pct >= MASTERY_PCT && productionCorrect >= productionRequired) {
                    mastery = "MASTERED";
                    next = now.plus(Duration.ofDays(REVIEW_LADDER[0]));
                    repo.recordCheck(userId, s.scope(), version, pct, true, 0, next, false);
                } else {
                    mastery = already ? "NEEDS_REVIEW" : "NOT_YET";
                    if (already) next = now.plus(Duration.ofDays(1));
                    repo.recordCheck(userId, s.scope(), version, pct, false, already ? 0 : null, next, already);
                }
            }
            case "REVIEW" -> {
                State before = repo.state(userId, s.scope()).orElseThrow(() -> new GrammarException(409, "NOT_MASTERED"));
                if (before.masteredAt() == null) throw new GrammarException(409, "NOT_MASTERED");
                requireReviewDue(before);
                int version = s.items().get(0).version();
                if (!enough) {
                    mastery = "INSUFFICIENT";
                    repo.recordCheck(userId, s.scope(), version, pct, false, null, null, before.needsReview());
                } else if (pct >= REVIEW_PASS_PCT && productionCorrect >= productionRequired) {
                    int stage = Math.min(before.reviewStage() + 1, REVIEW_LADDER.length - 1);
                    next = now.plus(Duration.ofDays(REVIEW_LADDER[stage]));
                    mastery = "KEPT";
                    repo.recordCheck(userId, s.scope(), version, pct, false, stage, next, false);
                } else {
                    next = now.plus(Duration.ofDays(1));
                    mastery = "NEEDS_REVIEW";
                    repo.recordCheck(userId, s.scope(), version, pct, false, 0, next, true);
                }
            }
            case "DIAGNOSTIC" -> {
                for (String level : DIAGNOSTIC_LEVELS) {
                    double[] band = byLevel.get(level);
                    if (band != null && band[1] > 0) levels.add(new LevelResult(level, (int) band[1], (int) Math.round(100 * band[0] / band[1])));
                }
                suggested = suggestLevel(levels);
                if (enough) repo.setProfile(userId, suggested, "DIAGNOSTIC", id);
            }
            default -> { /* DOMAIN, IELTS, TOEIC: practice with a result. Never mastery, band or score. */ }
        }
        CheckResult result = new CheckResult(pct, scored, unscored, enough, mastery, next, suggested, levels, items,
                productionScored, productionCorrect, productionRequired);
        repo.finishSession(id, userId, pct, scored, result);
        events.recordEventSafely(userId, "GRAMMAR_PRACTICED", "grammar:" + LocalDate.now(ZONE), now);
        return result;
    }

    private static void requireSnapshot(Session s) {
        if (s.items().isEmpty() || s.items().size() != s.exerciseIds().size())
            throw new GrammarException(409, "CHECK_CONTENT_CHANGED");
    }

    /** Persist only the judged fields, not arbitrary extra client JSON. Owner-scoped result JSON survives reload/deploy. */
    private JsonNode snapshotAnswer(JsonNode ex, JsonNode answer) {
        if (answer == null || answer.isNull()) return null;
        String field = switch (ex.path("type").asText()) {
            case "choice" -> "choice";
            case "multi" -> "choices";
            case "cloze" -> "blanks";
            case "order" -> "seq";
            case "error" -> "picked";
            case "match" -> "pairs";
            case "classify" -> "cats";
            default -> "text";
        };
        var saved = mapper.createObjectNode();
        if (answer.has(field)) saved.set(field, answer.get(field).deepCopy());
        if ("error".equals(ex.path("type").asText()) && answer.has("none")) saved.set("none", answer.get("none"));
        return saved;
    }

    private static void requireReviewDue(State state) {
        if (state.reviewDueAt() == null || state.reviewDueAt().isAfter(Instant.now()))
            throw new GrammarException(409, "REVIEW_NOT_DUE");
    }

    /** Where to start: the first band not yet solid. Provisional: a short mixed check cannot place anyone exactly. */
    static String suggestLevel(List<LevelResult> levels) {
        for (LevelResult r : levels) if (r.pct() < REVIEW_PASS_PCT) return r.level();
        return levels.isEmpty() ? "A1" : levels.get(levels.size() - 1).level();
    }

    private Verdict unanswered(JsonNode ex) {
        return new Verdict(GrammarEvaluator.WRONG, 0.0, ex.path("explain").asText(""), mapper.createObjectNode().put("unanswered", true), List.of(), null);
    }

    private CheckResult parse(String json) {
        try {
            return mapper.readValue(json, CheckResult.class);
        } catch (IOException e) {
            throw new IllegalStateException("grammar check result", e);
        }
    }

    public MistakesView mistakes(long userId) {
        int window = 180;
        List<Wrong> rows = repo.recentWrong(userId, window, 600);
        Map<String, MistakeGroup> groups = new LinkedHashMap<>();
        Instant cut = Instant.now().minus(Duration.ofDays(30));
        for (Wrong w : rows) {
            for (String tag : w.misconceptions().split(",")) {
                if (tag.isBlank()) continue;
                MistakeGroup g = groups.get(tag);
                int recent = w.at().isAfter(cut) ? 1 : 0;
                groups.put(tag, g == null
                        ? new MistakeGroup(tag, 1, w.at(), w.topic(), w.exerciseId(), w.answer(), recent)
                        : new MistakeGroup(tag, g.count() + 1, g.lastAt(), g.topic(), g.exerciseId(), g.lastAnswer(), g.recent30d() + recent));
            }
        }
        List<MistakeGroup> sorted = groups.values().stream().sorted(Comparator.comparingInt(MistakeGroup::count).reversed().thenComparing(MistakeGroup::lastAt, Comparator.reverseOrder())).toList();
        return new MistakesView(sorted, window, rows.size());
    }

    /** Exercises for the Practice Studio. Read-only: each answer is judged by {@link #attempt}. */
    public PracticeSet practice(long userId, String kind, String domain, String level, String type, int size) {
        int n = Math.max(1, Math.min(size, 12));
        List<JsonNode> out = new ArrayList<>();
        if ("mistakes".equals(kind)) {
            for (String id : repo.wrongExercises(userId, content.practiceExerciseIds(), n)) {
                JsonNode ex = content.exercise(id);
                if (!"check".equals(ex.path("use").asText())) out.add(content.learnerExercise(ex));
            }
            return new PracticeSet(out, out.isEmpty() ? "NO_MISTAKES" : null);
        }
        Instant now = Instant.now();
        List<TopicMeta> topics;
        if ("due".equals(kind)) {
            topics = repo.states(userId).stream().filter(s -> s.masteredAt() != null && s.reviewDueAt() != null && !s.reviewDueAt().isAfter(now))
                    .map(s -> content.meta(s.slug()).orElse(null)).filter(Objects::nonNull).collect(Collectors.toCollection(ArrayList::new));
        } else {
            topics = content.topics().stream().filter(TopicMeta::available)
                    .filter(t -> domain == null || domain.isBlank() || t.domain().equals(domain))
                    .filter(t -> level == null || level.isBlank() || t.level().equals(level))
                    .collect(Collectors.toCollection(ArrayList::new));
        }
        Collections.shuffle(topics, ThreadLocalRandom.current());
        for (TopicMeta t : topics.subList(0, Math.min(10, topics.size()))) {
            if (out.size() >= n) break;
            List<JsonNode> pool = content.load(t.slug()).exercises().values().stream()
                    .filter(e -> !"check".equals(e.path("use").asText()))
                    .filter(e -> type == null || type.isBlank() || type.equals(e.path("type").asText()))
                    .collect(Collectors.toCollection(ArrayList::new));
            Collections.shuffle(pool, ThreadLocalRandom.current());
            int take = Math.max(1, n / Math.max(1, Math.min(topics.size(), 6)));
            pool.stream().limit(take).forEach(e -> { if (out.size() < n) out.add(content.learnerExercise(e)); });
        }
        return new PracticeSet(out, out.isEmpty() ? "NO_ITEMS" : null);
    }

    public void bookmark(long userId, String slug, boolean on) {
        if (content.meta(slug).isEmpty()) throw new GrammarException(404, "NOT_FOUND");
        repo.bookmark(userId, slug, on);
    }

    @Transactional
    public void report(long userId, ReportRequest r) {
        repo.lockLearner(userId);
        if (repo.reportsToday(userId) >= MAX_REPORTS_PER_DAY) throw new GrammarException(429, "RATE_LIMITED");
        repo.report(userId, r.topic(), r.exerciseId(), r.kind(), trim(r.answer()), r.message());
    }

    private static String tags(Verdict v) {
        if (v.tags() == null || v.tags().isEmpty()) return null;
        String joined = String.join(",", new LinkedHashSet<>(v.tags()));
        return joined.length() > 200 ? joined.substring(0, joined.lastIndexOf(',', 200) > 0 ? joined.lastIndexOf(',', 200) : 200) : joined;
    }

    private static String trim(String s) {
        return s == null ? null : s.length() > 400 ? s.substring(0, 400) : s;
    }
}
