package com.englishcoach.speaking.topic;

import com.englishcoach.speaking.topic.TopicDtos.*;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.util.*;
import java.util.concurrent.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The real V95 schema on PostgreSQL 17 (after V94), used exactly as production does: through the least-privilege
 * application role. Covers grants, idempotent and serialised draws, account isolation, honest lifecycle facts and the
 * server-side bound on reported speaking time.
 */
class TopicPracticePostgresTest {

    private static DriverManagerDataSource raw;
    private static TopicService service;
    private static TransactionTemplate tx;
    private static final TopicBank BANK = new TopicBank();

    @BeforeAll
    static void start() throws Exception {
        PostgreSQLContainer<?> pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        raw = new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        try (Connection c = raw.getConnection(); Statement st = c.createStatement()) {
            st.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY, name VARCHAR(255) NOT NULL);"
                    + "INSERT INTO public.users SELECT g, 'Learner ' || g FROM generate_series(1, 5) g;");
            for (String v : List.of("V94__database_runtime_least_privilege.sql", "V95__speaking_topic_practice.sql")) {
                st.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/" + v)));
            }
            st.execute("ALTER ROLE english_coach_app PASSWORD 'topic-test-only'");
        }
        var app = new DriverManagerDataSource(pg.getJdbcUrl(), "english_coach_app", "topic-test-only");
        service = new TopicService(BANK, new TopicRepository(new JdbcTemplate(app)), new Random(3));
        tx = new TransactionTemplate(new DataSourceTransactionManager(app));
    }

    private static DrawResponse draw(long user, String style, String category, String band, Long previous, boolean replay) {
        DrawRequest req = new DrawRequest(UUID.randomUUID(), style, category, band, previous, null, replay);
        return tx.execute(s -> service.draw(user, req));
    }

    @Test
    void drawsAreIdempotentPerRequestId() {
        DrawRequest req = new DrawRequest(UUID.randomUUID(), "QUICK", null, null, null, null, false);
        DrawResponse first = tx.execute(s -> service.draw(1, req));
        DrawResponse again = tx.execute(s -> service.draw(1, req));
        assertThat(again.drawId()).isEqualTo(first.drawId());
        assertThat(again.item().id()).isEqualTo(first.item().id());
    }

    @Test
    void concurrentSpinsOfOneLearnerNeverReturnTheSameItem() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(6);
        List<Future<DrawResponse>> futures = new ArrayList<>();
        for (int i = 0; i < 12; i++) futures.add(pool.submit(() -> draw(2, "IELTS2", null, null, null, false)));
        Set<String> items = new HashSet<>();
        for (Future<DrawResponse> f : futures) items.add(f.get(60, TimeUnit.SECONDS).item().id());
        pool.shutdown();
        assertThat(items).hasSize(12);
    }

    @Test
    void narrowFilterExhaustsHonestlyAndReplayIsExplicit() {
        int size = BANK.pool(TopicBank.Style.QUICK, "travel", TopicBank.Band.ADVANCED).size();
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < size; i++) {
            DrawResponse r = draw(3, "QUICK", "travel", "ADVANCED", null, false);
            assertThat(r.outcome()).isEqualTo("DRAWN");
            assertThat(r.item().category()).isEqualTo("travel");
            assertThat(r.item().band()).isEqualTo("ADVANCED");
            seen.add(r.item().id());
        }
        assertThat(seen).hasSize(size);
        DrawResponse exhausted = draw(3, "QUICK", "travel", "ADVANCED", null, false);
        assertThat(exhausted.outcome()).isEqualTo("EXHAUSTED");
        assertThat(exhausted.drawId()).isNull();
        DrawResponse replay = draw(3, "QUICK", "travel", "ADVANCED", null, true);
        assertThat(replay.outcome()).isEqualTo("DRAWN");
        assertThat(replay.item().category()).isEqualTo("travel");
    }

    @Test
    void lifecycleIsHonestAndOwnerScoped() {
        DrawResponse shown = draw(4, "DEEP", null, null, null, false);
        // changing topic before speaking marks the shown topic SKIPPED, never practised
        DrawResponse next = draw(4, "DEEP", null, null, shown.drawId(), false);
        assertThat(next.item().id()).isNotEqualTo(shown.item().id());
        assertThatThrownBy(() -> service.start(4, shown.drawId(), new StartRequest(60)))
                .isInstanceOf(TopicException.class).hasMessage("DRAW_NOT_STARTABLE");

        // another learner can neither start, finish nor see this draw
        assertThatThrownBy(() -> service.start(5, next.drawId(), new StartRequest(60))).hasMessage("DRAW_NOT_FOUND");
        assertThatThrownBy(() -> service.finish(5, next.drawId(), new FinishRequest(60, true))).hasMessage("DRAW_NOT_FOUND");
        assertThat(service.summary(5).topicsDrawn()).isZero();

        // a finish before a start is refused; a start then an immediate finish claiming 60 s stores at most the elapsed time
        assertThatThrownBy(() -> service.finish(4, next.drawId(), new FinishRequest(30, false))).hasMessage("ROUND_NOT_STARTED");
        service.start(4, next.drawId(), new StartRequest(60));
        RoundView done = service.finish(4, next.drawId(), new FinishRequest(60, true));
        assertThat(done.status()).isEqualTo("FINISHED");
        assertThat(done.spokenSeconds()).isLessThanOrEqualTo(4);
        assertThat(done.reachedTarget()).isFalse();
        assertThat(done.recorded()).isTrue();

        Summary s = service.summary(4);
        assertThat(s.topicsDrawn()).isEqualTo(2);
        assertThat(s.roundsFinished()).isEqualTo(1);
        assertThat(s.roundsReachedTarget()).isZero();
        assertThat(s.recent()).extracting(HistoryEntry::drawId).containsExactly(next.drawId());
    }

    @Test
    void favouritesAreValidatedAndPrivate() {
        String id = BANK.items(TopicBank.Style.IELTS1).getFirst().id();
        service.favorite(1, id, true);
        service.favorite(1, id, true);
        assertThat(service.summary(1).favorites()).extracting(ItemView::id).containsExactly(id);
        assertThat(service.summary(5).favorites()).isEmpty();
        assertThatThrownBy(() -> service.favorite(1, "NOPE-01", true)).hasMessage("ITEM_NOT_FOUND");
        service.favorite(1, id, false);
        assertThat(service.summary(1).favorites()).isEmpty();
    }

    @Test
    void runtimeRoleCannotChangeTheSchema() {
        JdbcTemplate app = new JdbcTemplate(new DriverManagerDataSource(
                raw.getUrl(), "english_coach_app", "topic-test-only"));
        assertThatThrownBy(() -> app.execute("ALTER TABLE public.speaking_topic_draws ADD COLUMN x INT"))
                .rootCause().hasMessageContaining("must be owner");
    }
}
