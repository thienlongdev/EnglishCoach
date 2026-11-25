package com.englishcoach.grammar;

import com.englishcoach.grammar.GrammarDtos.*;
import com.englishcoach.progress.service.LearningEventService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

/**
 * The real V108 schema on PostgreSQL 17 (after V94), used as production does: through the least-privilege application role,
 * with the real curated content on the classpath. Covers the rules that make a grammar record trustworthy: a repeated request
 * id stores once, a check scores once (also under two simultaneous submits), a foreign session is a 404, mastery comes only
 * from a submitted check with enough scored items at the threshold (a practice attempt never sets it), check-only items are
 * never practised, bookmarks and mistakes belong to one learner, and the review ladder moves.
 */
class GrammarPostgresTest {

    private static final ObjectMapper MAPPER = new ObjectMapper().registerModule(new JavaTimeModule());
    private static JdbcTemplate sql;
    private static GrammarService service;
    private static GrammarContent content;
    private static TransactionTemplate tx;
    private static long nextUser = 1000;
    private static PostgreSQLContainer<?> pg;
    private static GrammarRepository repository;

    @BeforeAll
    static void start() throws Exception {
        pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        var admin = new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        try (Connection c = admin.getConnection(); Statement st = c.createStatement()) {
            st.execute("""
                    CREATE SCHEMA exams;
                    CREATE TABLE public.users (id BIGINT PRIMARY KEY, name VARCHAR(255) NOT NULL);
                    INSERT INTO public.users SELECT g, 'Learner ' || g FROM generate_series(1, 3000) g;
                    CREATE TABLE public.premium_feature_definitions (feature_key VARCHAR(64) PRIMARY KEY, display_name VARCHAR(255),
                        description TEXT, premium_required BOOLEAN, free_trial_limit INT, premium_monthly_limit INT, enabled BOOLEAN, sort_order INT);
                    """);
            for (String v : List.of("V94__database_runtime_least_privilege.sql", "V108__grammar_academy.sql"))
                st.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/" + v)));
            st.execute("ALTER ROLE english_coach_app PASSWORD 'grammar-test-only'");
        }
        sql = new JdbcTemplate(admin);
        var app = new DriverManagerDataSource(pg.getJdbcUrl(), "english_coach_app", "grammar-test-only");
        content = new GrammarContent(MAPPER);
        repository = new GrammarRepository(new NamedParameterJdbcTemplate(app), MAPPER);
        var manager = new DataSourceTransactionManager(app);
        ProxyFactory proxy = new ProxyFactory(new GrammarService(content, repository, mock(LearningEventService.class), MAPPER));
        proxy.setProxyTargetClass(true);
        proxy.addAdvice(new TransactionInterceptor(manager, new AnnotationTransactionAttributeSource()));
        service = (GrammarService) proxy.getProxy();
        tx = new TransactionTemplate(manager);
    }

    @AfterAll
    static void stop() { if (pg != null) pg.stop(); }

    private static synchronized long newUser() { return nextUser++; }

    // ---- the content, read for what a test needs ---------------------------------------------------------------

    private static boolean gradable(JsonNode ex) {
        return !"open".equals(ex.path("type").asText()) && !"practice".equals(ex.path("use").asText());
    }

    /** The answer the curated key accepts, for any exercise type. */
    private static ObjectNode correct(JsonNode ex) {
        ObjectNode a = MAPPER.createObjectNode();
        switch (ex.path("type").asText()) {
            case "choice" -> { for (int i = 0; i < ex.path("options").size(); i++) if (ex.path("options").get(i).path("ok").asBoolean()) { a.put("choice", i); break; } }
            case "multi" -> { ArrayNode all = a.putArray("choices"); for (int i = 0; i < ex.path("options").size(); i++) if (ex.path("options").get(i).path("ok").asBoolean()) all.add(i); }
            case "cloze" -> { ObjectNode b = a.putObject("blanks"); ex.path("blanks").fields().forEachRemaining(e -> b.put(e.getKey(), e.getValue().path("accept").get(0).asText())); }
            case "order" -> a.set("seq", ex.path("accept").get(0));
            case "transform" -> a.put("text", ex.path("accept").get(0).asText());
            case "error" -> {
                ArrayNode picked = a.putArray("picked");
                for (int i = 0; i < ex.path("segments").size(); i++) if (ex.path("segments").get(i).path("bad").asBoolean()) picked.add(i);
                if (picked.isEmpty()) { a.remove("picked"); a.put("none", true); }
            }
            case "match" -> { ObjectNode p = a.putObject("pairs"); for (int i = 0; i < ex.path("pairs").size(); i++) p.put(String.valueOf(i), ex.path("pairs").get(i).path("b").asText()); }
            case "classify" -> { ObjectNode p = a.putObject("cats"); for (int i = 0; i < ex.path("items").size(); i++) p.put(String.valueOf(i), ex.path("items").get(i).path("cat").asText()); }
            default -> a.put("text", "x");
        }
        return a;
    }

    /** A choice item has exactly one right and one wrong answer: the cleanest way to score a precise percentage. */
    private static List<JsonNode> choiceItems(String slug) {
        return content.load(slug).exercises().values().stream().filter(e -> "choice".equals(e.path("type").asText())).toList();
    }

    private static ObjectNode wrongChoice(JsonNode ex) {
        for (int i = 0; i < ex.path("options").size(); i++) if (!ex.path("options").get(i).path("ok").asBoolean()) return MAPPER.createObjectNode().put("choice", i);
        throw new AssertionError("no wrong option in " + ex.path("id").asText());
    }

    /** Types whose every answer is simply right (score 1) or wrong (score 0): never half-right, never "not recognised". */
    private static final Set<String> BINARY = Set.of("choice", "multi", "error", "classify", "match");

    private static List<JsonNode> binaryItems(String slug) {
        return content.load(slug).exercises().values().stream().filter(GrammarPostgresTest::gradable).filter(e -> BINARY.contains(e.path("type").asText())).toList();
    }

    /** An answer that scores exactly zero on a binary item. */
    private static ObjectNode wrongAnswer(JsonNode ex) {
        return switch (ex.path("type").asText()) {
            case "choice" -> wrongChoice(ex);
            case "multi" -> { ObjectNode a = MAPPER.createObjectNode(); a.putArray("choices"); yield a; }
            case "error" -> { ObjectNode a = MAPPER.createObjectNode(); a.putArray("picked"); yield a; }
            case "classify" -> { ObjectNode a = MAPPER.createObjectNode(); a.putObject("cats"); yield a; }
            case "match" -> { ObjectNode a = MAPPER.createObjectNode(); a.putObject("pairs"); yield a; }
            default -> throw new AssertionError("not a binary item");
        };
    }

    /** A topic with at least {@code n} gradable items, for a real topic check. */
    private static String topicWith(int n) {
        return content.topics().stream().filter(GrammarContent.TopicMeta::available)
                .filter(t -> content.load(t.slug()).exercises().values().stream().filter(GrammarPostgresTest::gradable).count() >= n)
                .map(GrammarContent.TopicMeta::slug).findFirst().orElseThrow();
    }

    /** A topic with at least {@code n} binary items usable in a crafted check. */
    private static String topicWithBinary(int n) {
        return content.topics().stream().filter(GrammarContent.TopicMeta::available).filter(t -> binaryItems(t.slug()).size() >= n)
                .map(GrammarContent.TopicMeta::slug).findFirst().orElseThrow(() -> new AssertionError("no topic has " + n + " binary items"));
    }

    private static String topicWithChoices(int n) {
        return content.topics().stream().filter(GrammarContent.TopicMeta::available).filter(t -> choiceItems(t.slug()).size() >= n)
                .map(GrammarContent.TopicMeta::slug).findFirst().orElseThrow(() -> new AssertionError("no topic has " + n + " choice items"));
    }

    /** A topic with both enough choice items for a crafted check and a big enough pool for a server-issued one. */
    private static String topicForLadder() {
        return content.topics().stream().filter(GrammarContent.TopicMeta::available)
                .filter(t -> binaryItems(t.slug()).size() >= 5 && content.load(t.slug()).exercises().values().stream().filter(GrammarPostgresTest::gradable).count() >= 5)
                .map(GrammarContent.TopicMeta::slug).findFirst().orElseThrow(() -> new AssertionError("no topic fits the review ladder"));
    }

    private static CheckResult submitAll(long user, CheckView check, boolean right) {
        Map<String, JsonNode> answers = new LinkedHashMap<>();
        for (JsonNode shown : check.exercises()) {
            JsonNode ex = content.exercise(shown.path("id").asText());
            answers.put(ex.path("id").asText(), right ? correct(ex) : BINARY.contains(ex.path("type").asText()) ? wrongAnswer(ex) : MAPPER.createObjectNode());
        }
        return tx.execute(s -> service.submit(user, check.id(), new CheckSubmit(answers)));
    }

    /** A TOPIC check crafted from {@code n} binary items; {@code wrong} of them are answered wrongly. Crafted by SQL so its size is exact. */
    private static CheckResult craftedTopicCheck(long user, String slug, int n, int wrong) {
        List<JsonNode> items = binaryItems(slug).subList(0, n);
        UUID id = UUID.randomUUID();
        repository.createSession(id, user, "TOPIC", slug, items.stream()
                .map(e -> new GrammarRepository.CheckItem(slug, content.meta(slug).orElseThrow().version(), e)).toList());
        Map<String, JsonNode> answers = new LinkedHashMap<>();
        for (int i = 0; i < n; i++) answers.put(items.get(i).path("id").asText(), i < wrong ? wrongAnswer(items.get(i)) : correct(items.get(i)));
        return tx.execute(s -> service.submit(user, id, new CheckSubmit(answers)));
    }

    private static TopicStateView state(long user, String slug) {
        return service.me(user).states().stream().filter(s -> s.slug().equals(slug)).findFirst().orElse(null);
    }

    private static int status(Runnable r) {
        try { r.run(); } catch (GrammarException e) { return e.status; }
        return 200;
    }

    // ---- the tests ---------------------------------------------------------------------------------------------

    @Test
    void migrationAppliesWithRestrictingOwnerKeysAndTheRuntimeRoleCannotChangeTheSchema() {
        assertThat(sql.queryForList("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'grammar_%' ORDER BY 1", String.class))
                .containsExactly("grammar_attempt", "grammar_bookmark", "grammar_check_session", "grammar_profile", "grammar_report", "grammar_topic_state");
        // every owner key restricts deletion (AGENTS 21): a learner's record can never vanish with a cascade
        assertThat(sql.queryForList("SELECT DISTINCT confdeltype::text FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text LIKE 'grammar_%' "
                + "AND confrelid = 'public.users'::regclass", String.class)).containsExactly("r");
        assertThat(sql.queryForObject("SELECT count(*) FROM public.premium_feature_definitions WHERE feature_key = 'GRAMMAR_PROFESSOR'", Integer.class)).isEqualTo(1);
        assertThat(sql.queryForObject("SELECT has_table_privilege('english_coach_app', 'public.grammar_attempt', 'INSERT') AND NOT has_table_privilege('english_coach_app', 'public.grammar_attempt', 'TRUNCATE')", Boolean.class)).isTrue();
    }

    @Test
    void aRepeatedRequestIdStoresOnce() {
        long user = newUser();
        String slug = topicWithChoices(1);
        JsonNode ex = choiceItems(slug).stream().filter(e -> !"check".equals(e.path("use").asText())).findFirst().orElseThrow();
        AttemptRequest request = new AttemptRequest(UUID.randomUUID(), ex.path("id").asText(), correct(ex));
        VerdictView first = service.attempt(user, request);
        VerdictView again = service.attempt(user, request);
        assertThat(first.outcome()).isEqualTo("CORRECT");
        assertThat(again.outcome()).isEqualTo(first.outcome());
        assertThat(sql.queryForObject("SELECT count(*) FROM public.grammar_attempt WHERE user_id = ?", Integer.class, user)).isEqualTo(1);
        assertThat(sql.queryForObject("SELECT practice_scored FROM public.grammar_topic_state WHERE user_id = ? AND topic_slug = ?", Integer.class, user, slug))
                .as("the counter is not bumped by the repeat").isEqualTo(1);
        // a new press is a new request id: it counts
        service.attempt(user, new AttemptRequest(UUID.randomUUID(), ex.path("id").asText(), correct(ex)));
        assertThat(sql.queryForObject("SELECT practice_scored FROM public.grammar_topic_state WHERE user_id = ? AND topic_slug = ?", Integer.class, user, slug)).isEqualTo(2);
    }

    @Test
    void aCheckIsScoredOnceAndARepeatedOrSimultaneousSubmitReturnsTheSameResult() throws Exception {
        long user = newUser();
        String slug = topicWith(4);
        CheckView check = service.startCheck(user, new CheckRequest("TOPIC", slug));
        assertThat(check.exercises()).hasSizeGreaterThanOrEqualTo(4);
        Map<String, JsonNode> answers = new LinkedHashMap<>();
        for (JsonNode shown : check.exercises()) answers.put(shown.path("id").asText(), correct(content.exercise(shown.path("id").asText())));
        ExecutorService pool = Executors.newFixedThreadPool(2);
        List<Future<CheckResult>> both = new ArrayList<>();
        for (int i = 0; i < 2; i++) both.add(pool.submit(() -> tx.execute(s -> service.submit(user, check.id(), new CheckSubmit(answers)))));
        CheckResult a = both.get(0).get(30, TimeUnit.SECONDS), b = both.get(1).get(30, TimeUnit.SECONDS);
        pool.shutdown();
        CheckResult third = tx.execute(s -> service.submit(user, check.id(), new CheckSubmit(Map.of())));
        assertThat(a.pct()).isEqualTo(b.pct()).isEqualTo(third.pct());
        assertThat(a.mastery()).isEqualTo(b.mastery()).isEqualTo(third.mastery());
        assertThat(third.pct()).as("an empty repeat does not rescore").isEqualTo(a.pct());
        assertThat(sql.queryForObject("SELECT count(*) FROM public.grammar_attempt WHERE user_id = ? AND mode = 'CHECK'", Integer.class, user)).isEqualTo(check.exercises().size());
        assertThat(sql.queryForObject("SELECT count(*) FROM public.grammar_check_session WHERE user_id = ? AND submitted_at IS NOT NULL", Integer.class, user)).isEqualTo(1);
        // Reload keeps the frozen safe questions and the actual submitted answers, not just a score.
        CheckView after = service.check(user, check.id());
        assertThat(after.submitted()).isTrue();
        assertThat(after.exercises()).isEqualTo(check.exercises());
        for (ItemResult item : after.result().items()) assertThat(item.answer()).isEqualTo(answers.get(item.exerciseId()));
        assertThat(after.result().pct()).isEqualTo(a.pct());
    }

    @Test
    void completedFeedbackRestoresAllNineInputTypesAfterContentReloadWithoutClientStorage() {
        long user = newUser();
        Map<String, JsonNode> byType = new LinkedHashMap<>();
        for (var meta : content.topics()) if (meta.available()) {
            for (JsonNode ex : content.load(meta.slug()).exercises().values()) byType.putIfAbsent(ex.path("type").asText(), ex);
            if (byType.size() == 9) break;
        }
        assertThat(byType).hasSize(9);
        UUID id = UUID.randomUUID();
        repository.createSession(id, user, "DOMAIN", null, byType.values().stream().map(ex ->
                new GrammarRepository.CheckItem(content.topicOfExercise(ex.path("id").asText()).orElseThrow(), 1, ex)).toList());
        CheckView before = service.check(user, id);
        Map<String, JsonNode> answers = new LinkedHashMap<>();
        for (JsonNode ex : byType.values()) answers.put(ex.path("id").asText(), correct(ex));
        String choice = byType.get("choice").path("id").asText();
        answers.put(choice, wrongChoice(byType.get("choice")));
        ((ObjectNode) answers.get(choice)).put("unjudgedClientField", "must not persist");
        CheckResult first = service.submit(user, id, new CheckSubmit(answers));
        var restarted = new GrammarService(new GrammarContent(MAPPER), repository, mock(LearningEventService.class), MAPPER);
        CheckView restored = restarted.check(user, id);
        assertThat(restored.exercises()).isEqualTo(before.exercises());
        assertThat(restored.result()).isEqualTo(first);
        for (ItemResult item : restored.result().items()) {
            ObjectNode expected = answers.get(item.exerciseId()).deepCopy();
            expected.remove("unjudgedClientField");
            assertThat(item.answer()).as(item.exerciseId()).isEqualTo(expected);
        }
        assertThat(restored.result().items()).anyMatch(item -> "WRONG".equals(item.outcome()));
        assertThat(status(() -> restarted.check(newUser(), id))).isEqualTo(404);
    }

    @Test
    void newerCheckOnlyErrorsCannotHideAnOlderEligiblePracticeMistake() {
        long user = newUser();
        JsonNode ex = content.load("verb-be").exercises().values().stream()
                .filter(e -> "choice".equals(e.path("type").asText()) && !"check".equals(e.path("use").asText())).findFirst().orElseThrow();
        String exerciseId = ex.path("id").asText();
        service.attempt(user, new AttemptRequest(UUID.randomUUID(), exerciseId, wrongChoice(ex)));
        sql.update("UPDATE public.grammar_attempt SET created_at = now() - interval '1 hour' WHERE user_id = ?", user);
        int checkErrors = 0;
        for (var meta : content.topics()) {
            if (!meta.available() || meta.checkItems() < 4) continue;
            CheckView check = service.startCheck(user, new CheckRequest("TOPIC", meta.slug()));
            service.submit(user, check.id(), new CheckSubmit(Map.of()));
            checkErrors += check.exercises().size();
            if (checkErrors > 8) break;
        }
        assertThat(checkErrors).isGreaterThan(8);
        PracticeSet mistakes = service.practice(user, "mistakes", null, null, null, 8);
        assertThat(mistakes.note()).isNull();
        assertThat(mistakes.exercises()).extracting(e -> e.path("id").asText()).containsExactly(exerciseId);
        assertThat(service.practice(newUser(), "mistakes", null, null, null, 8).exercises()).isEmpty();
        service.attempt(user, new AttemptRequest(UUID.randomUUID(), exerciseId, correct(ex)));
        assertThat(service.practice(user, "mistakes", null, null, null, 8).note()).isEqualTo("NO_MISTAKES");
    }

    @Test
    void aForeignSessionIsAMissingOne() {
        long owner = newUser(), stranger = newUser();
        CheckView check = service.startCheck(owner, new CheckRequest("TOPIC", topicWith(4)));
        assertThat(status(() -> service.check(stranger, check.id()))).isEqualTo(404);
        assertThat(status(() -> tx.execute(s -> service.submit(stranger, check.id(), new CheckSubmit(Map.of()))))).isEqualTo(404);
        assertThat(status(() -> service.check(owner, UUID.randomUUID()))).isEqualTo(404);
        assertThat(sql.queryForObject("SELECT submitted_at IS NULL FROM public.grammar_check_session WHERE id = ?", Boolean.class, check.id())).isTrue();
        assertThat(service.history(stranger)).isEmpty();
        assertThat(service.history(owner)).hasSize(1);
    }

    @Test
    void masteryComesOnlyFromACheckWithEnoughScoredItemsAtTheThreshold() {
        String slug = topicWithBinary(5);

        long wrongLearner = newUser();
        CheckResult failed = submitAll(wrongLearner, service.startCheck(wrongLearner, new CheckRequest("TOPIC", topicWith(4))), false);
        assertThat(failed.mastery()).isIn("NOT_YET", "INSUFFICIENT");
        assertThat(sql.queryForObject("SELECT count(*) FROM public.grammar_topic_state WHERE user_id = ? AND mastered_at IS NOT NULL", Integer.class, wrongLearner)).isZero();

        long thin = newUser(); // three right answers out of three: perfect, but not enough evidence
        CheckResult thinResult = craftedTopicCheck(thin, slug, 3, 0);
        assertThat(thinResult.pct()).isEqualTo(100);
        assertThat(thinResult.enoughEvidence()).isFalse();
        assertThat(thinResult.mastery()).isEqualTo("INSUFFICIENT");
        assertThat(state(thin, slug).masteredAt()).isNull();

        long below = newUser(); // 3 of 5 = 60 %
        CheckResult belowResult = craftedTopicCheck(below, slug, 5, 2);
        assertThat(belowResult.pct()).isEqualTo(60);
        assertThat(belowResult.mastery()).isEqualTo("NOT_YET");
        assertThat(state(below, slug).masteredAt()).isNull();

        long edge = newUser(); // 4 of 5 = exactly 80 %
        CheckResult edgeResult = craftedTopicCheck(edge, slug, 5, 1);
        assertThat(edgeResult.pct()).isEqualTo(80);
        assertThat(edgeResult.mastery()).isEqualTo("MASTERED");
        TopicStateView mastered = state(edge, slug);
        assertThat(mastered.masteredAt()).isNotNull();
        assertThat(mastered.status()).isEqualTo("MASTERED");
        assertThat(Duration.between(Instant.now(), mastered.reviewDueAt()).toDays()).as("first review in 3 days").isBetween(2L, 3L);

        long real = newUser(); // a real, server-issued check of the whole topic mix, every answer right
        CheckResult full = submitAll(real, service.startCheck(real, new CheckRequest("TOPIC", topicWith(4))), true);
        assertThat(full.enoughEvidence()).isTrue();
        assertThat(full.pct()).isEqualTo(100);
        assertThat(full.mastery()).isEqualTo("MASTERED");
    }

    @Test
    void practisingNeverSetsMasteryHoweverMuchOfIt() {
        long user = newUser();
        String slug = topicWithChoices(1);
        JsonNode ex = choiceItems(slug).stream().filter(e -> !"check".equals(e.path("use").asText())).findFirst().orElseThrow();
        for (int i = 0; i < 25; i++) service.attempt(user, new AttemptRequest(UUID.randomUUID(), ex.path("id").asText(), correct(ex)));
        TopicStateView s = state(user, slug);
        assertThat(s.practiceScored()).isEqualTo(25);
        assertThat(s.practiceCorrectPct()).isEqualTo(100);
        assertThat(s.masteredAt()).isNull();
        assertThat(s.status()).isNotEqualTo("MASTERED").isEqualTo("READY");
        assertThat(service.me(user).counts().mastered()).isZero();
        // the one page that can say "mastered" is a check, and one that was never started cannot be forged by an answer
        assertThat(status(() -> service.startCheck(user, new CheckRequest("REVIEW", slug)))).as("review needs mastery").isEqualTo(409);
    }

    @Test
    void aCheckOnlyExerciseIsRefusedInPracticeAndNeverShownThere() {
        long user = newUser();
        JsonNode checkOnly = null;
        for (var meta : content.topics()) {
            if (!meta.available()) continue;
            checkOnly = content.load(meta.slug()).exercises().values().stream().filter(e -> "check".equals(e.path("use").asText())).findFirst().orElse(null);
            if (checkOnly != null) break;
        }
        assertThat(checkOnly).as("the curated content has a check-only exercise").isNotNull();
        JsonNode item = checkOnly;
        assertThat(status(() -> service.attempt(user, new AttemptRequest(UUID.randomUUID(), item.path("id").asText(), correct(item))))).isEqualTo(404);
        assertThat(sql.queryForObject("SELECT count(*) FROM public.grammar_attempt WHERE user_id = ?", Integer.class, user)).isZero();
        // the topic the learner downloads carries no check-only item either
        String slug = content.topicOfExercise(item.path("id").asText()).orElseThrow();
        assertThat(content.load(slug).learnerJson()).doesNotContain("\"" + item.path("id").asText() + "\"");
        for (JsonNode shown : service.practice(user, "mixed", null, null, null, 12).exercises()) assertThat(shown.path("use").asText()).isNotEqualTo("check");
    }

    @Test
    void bookmarksAndMistakesBelongToOneLearner() {
        long a = newUser(), b = newUser();
        String slug = topicWithChoices(1);
        service.bookmark(a, slug, true);
        service.bookmark(a, slug, true); // idempotent
        assertThat(service.me(a).bookmarks()).containsExactly(slug);
        assertThat(service.me(b).bookmarks()).isEmpty();
        assertThat(status(() -> service.bookmark(a, "no-such-topic", true))).isEqualTo(404);
        service.bookmark(b, slug, false); // removing someone else's mark removes nothing of theirs
        assertThat(service.me(a).bookmarks()).containsExactly(slug);
        service.bookmark(a, slug, false);
        assertThat(service.me(a).bookmarks()).isEmpty();

        // a wrong answer whose option carries a misconception tag lands in that learner's mistakes only
        JsonNode tagged = null;
        outer:
        for (var meta : content.topics()) {
            if (!meta.available()) continue;
            for (JsonNode ex : choiceItems(meta.slug())) {
                if ("check".equals(ex.path("use").asText())) continue;
                for (JsonNode o : ex.path("options")) if (!o.path("ok").asBoolean() && !o.path("tag").asText("").isEmpty()) { tagged = ex; break outer; }
            }
        }
        assertThat(tagged).as("the curated content has a wrong option with a misconception tag").isNotNull();
        JsonNode ex = tagged;
        ObjectNode wrong = MAPPER.createObjectNode();
        for (int i = 0; i < ex.path("options").size(); i++) if (!ex.path("options").get(i).path("ok").asBoolean() && !ex.path("options").get(i).path("tag").asText("").isEmpty()) { wrong.put("choice", i); break; }
        VerdictView verdict = service.attempt(a, new AttemptRequest(UUID.randomUUID(), ex.path("id").asText(), wrong));
        assertThat(verdict.outcome()).isEqualTo("WRONG");
        assertThat(verdict.tags()).isNotEmpty();
        MistakesView mine = service.mistakes(a);
        assertThat(mine.groups()).isNotEmpty();
        assertThat(mine.groups().get(0).tag()).isEqualTo(verdict.tags().get(0));
        assertThat(mine.groups().get(0).exerciseId()).isEqualTo(ex.path("id").asText());
        assertThat(service.mistakes(b).groups()).isEmpty();
        assertThat(service.practice(b, "mistakes", null, null, null, 6).note()).isEqualTo("NO_MISTAKES");
        assertThat(service.practice(a, "mistakes", null, null, null, 6).exercises()).extracting(e -> e.path("id").asText()).contains(ex.path("id").asText());
        // reports and the learner level are theirs too
        service.report(a, new ReportRequest("ANSWER", slug, ex.path("id").asText(), "my sentence", null));
        assertThat(sql.queryForObject("SELECT count(*) FROM public.grammar_report WHERE user_id = ?", Integer.class, b)).isZero();
        service.setLevel(a, "B1");
        assertThat(service.me(a).startLevel()).isEqualTo("B1");
        assertThat(service.me(b).startLevel()).isNull();
    }

    @Test
    void theReviewLadderMovesUpOnAPassAndBackOnAFailure() {
        long user = newUser();
        String slug = topicForLadder();
        craftedTopicCheck(user, slug, 5, 0); // mastered, stage 0
        assertThat(state(user, slug).reviewStage()).isZero();
        int[] days = GrammarService.REVIEW_LADDER;
        for (int stage = 1; stage < days.length; stage++) {
            sql.update("UPDATE public.grammar_topic_state SET review_due_at = now() - interval '1 hour' WHERE user_id = ? AND topic_slug = ?", user, slug);
            assertThat(service.me(user).dueReviews()).containsExactly(slug);
            assertThat(state(user, slug).status()).isEqualTo("REVIEW_DUE");
            CheckView review = service.startCheck(user, new CheckRequest("REVIEW", slug));
            CheckResult kept = submitAll(user, review, true);
            assertThat(kept.mastery()).isEqualTo("KEPT");
            TopicStateView s = state(user, slug);
            assertThat(s.reviewStage()).isEqualTo(stage);
            assertThat(Duration.between(Instant.now(), s.reviewDueAt()).toHours()).as("stage " + stage).isBetween(days[stage] * 24L - 2, days[stage] * 24L);
            assertThat(s.status()).isEqualTo("MASTERED");
        }
        // the ladder stops at its last step
        sql.update("UPDATE public.grammar_topic_state SET review_due_at = now() - interval '1 hour' WHERE user_id = ? AND topic_slug = ?", user, slug);
        submitAll(user, service.startCheck(user, new CheckRequest("REVIEW", slug)), true);
        assertThat(state(user, slug).reviewStage()).isEqualTo(days.length - 1);
        // a failed review sends the topic back for a day and keeps the mastery record
        sql.update("UPDATE public.grammar_topic_state SET review_due_at = now() - interval '1 hour' WHERE user_id = ? AND topic_slug = ?", user, slug);
        CheckResult lapsed = submitAll(user, service.startCheck(user, new CheckRequest("REVIEW", slug)), false);
        assertThat(lapsed.mastery()).isEqualTo("NEEDS_REVIEW");
        TopicStateView s = state(user, slug);
        assertThat(s.reviewStage()).isZero();
        assertThat(s.needsReview()).isTrue();
        assertThat(s.masteredAt()).isNotNull();
        assertThat(s.status()).isEqualTo("NEEDS_REVIEW");
        assertThat(Duration.between(Instant.now(), s.reviewDueAt()).toHours()).isBetween(22L, 24L);
    }

    @Test
    void theDiagnosticOnlySuggestsAndTheLearnerKeepsTheChoice() {
        long user = newUser();
        CheckView diag = service.startCheck(user, new CheckRequest("DIAGNOSTIC", null));
        assertThat(diag.exercises()).hasSizeGreaterThanOrEqualTo(GrammarService.MIN_EVIDENCE);
        CheckResult result = submitAll(user, diag, true);
        assertThat(result.suggestedLevel()).isNotNull();
        MeView me = service.me(user);
        assertThat(me.startBasis()).isEqualTo("DIAGNOSTIC");
        service.setLevel(user, "A2"); // the learner overrides the estimate
        assertThat(service.me(user).startLevel()).isEqualTo("A2");
        assertThat(service.me(user).startBasis()).isEqualTo("SELF");
        assertThat(service.me(user).counts().mastered()).as("a diagnostic never masters a topic").isZero();
    }

    @Test
    void practiceReceiptsCannotBeReusedForAnotherAnswerOrExerciseButRemainOwnerScoped() {
        long user = newUser(), other = newUser();
        JsonNode ex = service.practice(user, "mixed", null, null, "choice", 1).exercises().get(0);
        JsonNode key = content.exercise(ex.path("id").asText());
        UUID receipt = UUID.randomUUID();
        var request = new AttemptRequest(receipt, ex.path("id").asText(), correct(key));
        assertThat(service.attempt(user, request).outcome()).isEqualTo("CORRECT");
        assertThat(status(() -> service.attempt(user, new AttemptRequest(receipt, request.exerciseId(), wrongChoice(key))))).isEqualTo(409);
        assertThat(service.attempt(other, request).outcome()).isEqualTo("CORRECT");
        assertThat(service.attempt(user, request).outcome()).isEqualTo("CORRECT");
        assertThat(sql.queryForObject("SELECT count(*) FROM public.grammar_attempt WHERE user_id = ?", Integer.class, user)).isEqualTo(1);
    }

    @Test
    void practiceCannotPreclaimACheckAttemptReceipt() {
        long user = newUser();
        CheckView check = service.startCheck(user, new CheckRequest("TOPIC", topicWith(4)));
        String issued = check.exercises().get(0).path("id").asText();
        UUID predictable = UUID.nameUUIDFromBytes((check.id() + ":" + issued).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        JsonNode practice = service.practice(user, "mixed", null, null, "choice", 1).exercises().get(0);
        String practiceId = practice.path("id").asText();
        service.attempt(user, new AttemptRequest(predictable, practiceId, correct(content.exercise(practiceId))));
        submitAll(user, check, true);
        assertThat(sql.queryForObject("SELECT count(*) FROM public.grammar_attempt WHERE user_id = ? AND session_id = ?", Integer.class, user, check.id()))
                .isEqualTo(check.exercises().size());
    }

    @Test
    void checksPinTheirKeysAndResumeIndependentlyOfTheCurrentContent() {
        long user = newUser();
        CheckView check = service.startCheck(user, new CheckRequest("TOPIC", topicWith(4)));
        Map<String, JsonNode> answers = new LinkedHashMap<>();
        for (JsonNode shown : check.exercises()) answers.put(shown.path("id").asText(), correct(content.exercise(shown.path("id").asText())));
        ObjectNode live = (ObjectNode) content.exercise(check.exercises().get(0).path("id").asText());
        ObjectNode original = live.deepCopy();
        try {
            live.put("type", "open"); // simulate the key changing in a later content release, without editing a resource
            assertThat(service.check(user, check.id()).exercises()).isEqualTo(check.exercises());
            CheckResult result = service.submit(user, check.id(), new CheckSubmit(answers));
            assertThat(result.pct()).isEqualTo(100);
            assertThat(result.scoredItems()).isEqualTo(check.exercises().size());
        } finally {
            live.removeAll();
            live.setAll(original);
        }
        assertThat(sql.queryForObject("SELECT exercise_ids->>'schema' FROM public.grammar_check_session WHERE id = ?", String.class, check.id())).isEqualTo("1");
    }

    @Test
    void legacyUnpinnedChecksFailClosedButTerminalResultsStillReload() {
        long user = newUser();
        CheckView check = service.startCheck(user, new CheckRequest("TOPIC", topicWith(4)));
        UUID legacy = UUID.randomUUID();
        sql.update("INSERT INTO public.grammar_check_session (id, user_id, kind, scope, exercise_ids) VALUES (?, ?, 'TOPIC', ?, CAST(? AS jsonb))",
                legacy, user, check.scope(), MAPPER.valueToTree(check.exercises().stream().map(e -> e.path("id").asText()).toList()).toString());
        assertThat(status(() -> service.check(user, legacy))).isEqualTo(409);
        assertThat(status(() -> service.submit(user, legacy, new CheckSubmit(Map.of())))).isEqualTo(409);
        CheckResult result = submitAll(user, check, true);
        sql.update("UPDATE public.grammar_check_session SET exercise_ids = '[]'::jsonb WHERE id = ?", check.id());
        assertThat(service.check(user, check.id()).result()).isEqualTo(result);
        assertThat(service.submit(user, check.id(), new CheckSubmit(Map.of()))).isEqualTo(result);
    }

    @Test
    void malformedOrForeignAnswersDoNotConsumeACheckOrWritePartialEvidence() {
        long user = newUser();
        CheckView check = service.startCheck(user, new CheckRequest("TOPIC", topicWith(4)));
        String id = check.exercises().get(0).path("id").asText();
        assertThat(status(() -> service.submit(user, check.id(), new CheckSubmit(Map.of(id, MAPPER.createArrayNode()))))).isEqualTo(400);
        assertThat(status(() -> service.submit(user, check.id(), new CheckSubmit(Map.of("not-issued", MAPPER.createObjectNode()))))).isEqualTo(400);
        assertThat(sql.queryForObject("SELECT count(*) FROM public.grammar_attempt WHERE user_id = ?", Integer.class, user)).isZero();
        assertThat(service.check(user, check.id()).submitted()).isFalse();
        assertThat(submitAll(user, check, true).mastery()).isEqualTo("MASTERED");
    }

    @Test
    void masteryChecksNeverIssueAPracticeRevealableItemAndFailClosedWithoutFourHeldOutItems() {
        long user = newUser();
        String slug = topicWith(4);
        CheckView check = service.startCheck(user, new CheckRequest("TOPIC", slug));
        for (JsonNode shown : check.exercises()) {
            assertThat(shown.path("use").asText()).isEqualTo("check");
            assertThat(status(() -> service.attempt(user, new AttemptRequest(UUID.randomUUID(), shown.path("id").asText(), MAPPER.createObjectNode())))).isEqualTo(404);
        }
        Map<ObjectNode, String> uses = new LinkedHashMap<>();
        for (JsonNode ex : content.load(slug).exercises().values()) {
            if ("check".equals(ex.path("use").asText())) uses.put((ObjectNode) ex, "check");
        }
        // Keep references in a list: JsonNode hash codes change when their fields change.
        var nodes = new ArrayList<>(uses.keySet());
        try {
            nodes.forEach(e -> e.put("use", "both"));
            assertThat(status(() -> service.startCheck(user, new CheckRequest("TOPIC", slug)))).isEqualTo(409);
        } finally {
            nodes.forEach(e -> e.put("use", "check"));
        }
    }

    @Test
    void twoDifferentReviewsCannotAdvanceTheSameDueStepTwice() throws Exception {
        long user = newUser();
        String slug = topicForLadder();
        craftedTopicCheck(user, slug, 5, 0);
        assertThat(status(() -> service.startCheck(user, new CheckRequest("REVIEW", slug)))).isEqualTo(409);
        sql.update("UPDATE public.grammar_topic_state SET review_due_at = now() - interval '1 hour' WHERE user_id = ? AND topic_slug = ?", user, slug);
        CheckView a = service.startCheck(user, new CheckRequest("REVIEW", slug));
        CheckView b = service.startCheck(user, new CheckRequest("REVIEW", slug));
        try (ExecutorService pool = Executors.newFixedThreadPool(2)) {
            CountDownLatch start = new CountDownLatch(1);
            Callable<Integer> one = () -> { start.await(); return status(() -> submitAll(user, a, true)); };
            Callable<Integer> two = () -> { start.await(); return status(() -> submitAll(user, b, true)); };
            Future<Integer> first = pool.submit(one), second = pool.submit(two);
            start.countDown();
            assertThat(List.of(first.get(30, TimeUnit.SECONDS), second.get(30, TimeUnit.SECONDS))).containsExactlyInAnyOrder(200, 409);
        }
        assertThat(state(user, slug).reviewStage()).isEqualTo(1);
        assertThat(sql.queryForObject("SELECT count(*) FROM public.grammar_check_session WHERE user_id = ? AND kind = 'REVIEW' AND submitted_at IS NOT NULL", Integer.class, user)).isEqualTo(1);
    }

    @Test
    void concurrentStartsRespectTheDailySessionLimit() throws Exception {
        long user = newUser();
        for (int i = 0; i < GrammarService.MAX_SESSIONS_PER_DAY - 1; i++)
            repository.createSession(UUID.randomUUID(), user, "TOPIC", "quota-fixture", List.of());
        String slug = topicWith(4);
        try (ExecutorService pool = Executors.newFixedThreadPool(2)) {
            CountDownLatch start = new CountDownLatch(1);
            Callable<Integer> call = () -> { start.await(); return status(() -> service.startCheck(user, new CheckRequest("TOPIC", slug))); };
            Future<Integer> a = pool.submit(call), b = pool.submit(call);
            start.countDown();
            assertThat(List.of(a.get(30, TimeUnit.SECONDS), b.get(30, TimeUnit.SECONDS))).containsExactlyInAnyOrder(200, 429);
        }
        assertThat(repository.sessionsToday(user)).isEqualTo(GrammarService.MAX_SESSIONS_PER_DAY);
    }

    @Test
    void differentPerPositionFeedbackCannotReuseAPracticeReceiptAtTheSamePartialScore() {
        long user = newUser();
        JsonNode shown = service.practice(user, "mixed", null, null, "classify", 1).exercises().get(0);
        JsonNode ex = content.exercise(shown.path("id").asText());
        ObjectNode a = correct(ex), b = correct(ex);
        ((ObjectNode) a.path("cats")).put("0", "no-such-category");
        ((ObjectNode) b.path("cats")).put("1", "no-such-category");
        UUID request = UUID.randomUUID();
        service.attempt(user, new AttemptRequest(request, ex.path("id").asText(), a));
        assertThat(status(() -> service.attempt(user, new AttemptRequest(request, ex.path("id").asText(), b)))).isEqualTo(409);
        ObjectNode reordered = MAPPER.createObjectNode(), reversedCats = reordered.putObject("cats");
        for (int i = ex.path("items").size() - 1; i >= 0; i--) reversedCats.set(String.valueOf(i), a.path("cats").get(String.valueOf(i)));
        assertThat(service.attempt(user, new AttemptRequest(request, ex.path("id").asText(), reordered)).score())
                .isEqualTo((ex.path("items").size() - 1.0) / ex.path("items").size());
    }

    @Test
    void unknownProductionIsStoredWithoutScoredPracticeCreditAndCanBeRetried() {
        long user = newUser();
        JsonNode ex = service.practice(user, "mixed", null, null, "transform", 1).exercises().get(0);
        String exercise = ex.path("id").asText();
        var request = new AttemptRequest(UUID.randomUUID(), exercise, MAPPER.createObjectNode().put("text", "A novel response outside this curated key"));
        assertThat(service.attempt(user, request).outcome()).isEqualTo("UNRECOGNIZED");
        assertThat(service.attempt(user, request).score()).isNull();
        String slug = content.topicOfExercise(exercise).orElseThrow();
        assertThat(state(user, slug).practiceScored()).isZero();
        assertThat(state(user, slug).masteredAt()).isNull();
        assertThat(sql.queryForObject("SELECT count(*) FROM public.grammar_attempt WHERE user_id = ?", Integer.class, user)).isEqualTo(1);
    }

    @Test
    void advancedReviewIncludesConstructionEvenWhenOnlyThatItemWasRecentlySeen() {
        long user = newUser();
        String slug = "generic-reference";
        CheckView initial = service.startCheck(user, new CheckRequest("TOPIC", slug));
        assertThat(initial.exercises()).allMatch(e -> !e.has("_academyLevel"));
        assertThat(repository.session(initial.id(), user, false).orElseThrow().items())
                .allMatch(i -> i.exercise().path("_academyLevel").asText().equals("B2"));
        CheckResult first = submitAll(user, initial, true);
        assertThat(first.mastery()).isEqualTo("MASTERED");
        assertThat(first.productionCorrect()).isGreaterThanOrEqualTo(1);
        Instant historical = state(user, slug).masteredAt();
        String productionId = initial.exercises().stream().filter(e -> Set.of("cloze", "transform", "order").contains(e.path("type").asText()))
                .findFirst().orElseThrow().path("id").asText();
        // Isolated fixture: recognition items become unseen, as when new content adds them.
        sql.update("DELETE FROM public.grammar_attempt WHERE user_id=? AND exercise_id<>?", user, productionId);
        sql.update("UPDATE public.grammar_topic_state SET review_due_at=now()-interval '1 hour' WHERE user_id=? AND topic_slug=?", user, slug);
        CheckView review = service.startCheck(user, new CheckRequest("REVIEW", slug));
        assertThat(review.exercises()).anyMatch(e -> e.path("id").asText().equals(productionId));
        CheckResult result = submitAll(user, review, true);
        assertThat(result.mastery()).isEqualTo("KEPT");
        assertThat(result.productionRequired()).isEqualTo(1);
        assertThat(state(user, slug).masteredAt()).isEqualTo(historical);
        assertThat(service.check(user, review.id()).result().productionCorrect()).isGreaterThanOrEqualTo(1);
    }

    @Test
    void recognitionOnlySuccessWithUnrecognisedProductionPersistsWithoutMastery() {
        long user = newUser(); String slug = "generic-reference"; UUID id = UUID.randomUUID();
        List<GrammarRepository.CheckItem> items = new ArrayList<>();
        Map<String, JsonNode> answers = new LinkedHashMap<>();
        for (int i=0;i<5;i++) {
            ObjectNode ex=MAPPER.createObjectNode().put("id","evidence-rec-"+i).put("type","choice")
                    .put("use","check").put("skill","recognition").put("level","B2").put("_academyLevel","B2");
            ex.putArray("options").addObject().put("t","Known answer").put("ok",true);
            items.add(new GrammarRepository.CheckItem(slug,1,ex));
            answers.put(ex.path("id").asText(),MAPPER.createObjectNode().put("choice",0));
        }
        ObjectNode production=MAPPER.createObjectNode().put("id","evidence-production").put("type","transform")
                .put("use","check").put("skill","production").put("level","B2").put("_academyLevel","B2")
                .put("model","The manager has already left.");
        production.putArray("accept").add("The manager has already left.");
        items.add(new GrammarRepository.CheckItem(slug,1,production));
        answers.put("evidence-production",MAPPER.createObjectNode().put("text","The manager has left already."));
        repository.createSession(id,user,"TOPIC",slug,items);
        CheckResult result=service.submit(user,id,new CheckSubmit(answers));
        assertThat(result.pct()).isEqualTo(100);
        assertThat(result.mastery()).isEqualTo("INSUFFICIENT");
        assertThat(result.productionScored()).isZero();
        assertThat(state(user,slug).masteredAt()).isNull();
        assertThat(service.check(user,id).result().productionRequired()).isEqualTo(1);
        assertThat(sql.queryForObject("SELECT outcome FROM public.grammar_attempt WHERE user_id=? AND exercise_id='evidence-production'",String.class,user)).isEqualTo("UNRECOGNIZED");
    }

    @Test
    void fractionalScoresBelowEightyPercentDoNotRoundUpIntoMastery() {
        long user = newUser();
        String slug = topicWith(4);
        List<GrammarRepository.CheckItem> items = new ArrayList<>();
        Map<String, JsonNode> answers = new LinkedHashMap<>();
        for (int i = 0; i < 4; i++) {
            String id = "threshold-" + i;
            ObjectNode ex = MAPPER.createObjectNode().put("id", id).put("type", "multi").put("use", "check").put("level", "A1");
            ArrayNode options = ex.putArray("options");
            ObjectNode answer = MAPPER.createObjectNode();
            ArrayNode selected = answer.putArray("choices");
            int total = i == 3 ? 50 : 1, right = i == 3 ? 9 : 1;
            for (int j = 0; j < total; j++) {
                options.addObject().put("t", "Option " + j).put("ok", true);
                if (j < right) selected.add(j);
            }
            items.add(new GrammarRepository.CheckItem(slug, 1, ex));
            answers.put(id, answer);
        }
        UUID id = UUID.randomUUID();
        repository.createSession(id, user, "TOPIC", slug, items);
        CheckResult result = service.submit(user, id, new CheckSubmit(answers));
        assertThat(result.pct()).isEqualTo(79); // 3.18 / 4 = 79.5 %, never an 80 % pass
        assertThat(result.enoughEvidence()).isTrue();
        assertThat(result.mastery()).isEqualTo("NOT_YET");
        assertThat(state(user, slug).masteredAt()).isNull();
    }
}
