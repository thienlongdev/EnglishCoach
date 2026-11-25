package com.englishcoach.reading;

import com.englishcoach.reading.service.DocumentRecognitionLedger;
import com.englishcoach.reading.service.ReadingImportGuard;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.web.server.ResponseStatusException;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;

import java.lang.reflect.Constructor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The durable daily document-recognition allowance (V100) on PostgreSQL 17: 20 documents a day per account, the 21st
 * refused; parallel uploads through two backend processes never overspend; a restart (a new guard and ledger on the
 * same database) does not reset the day; the next local day is a new bucket; a document that never reached the host
 * and one refused by the checks before sending are not counted.
 */
class DocumentRecognitionLedgerPostgresTest {

    static PostgreSQLContainer<?> pg;
    static DriverManagerDataSource ds;
    static JdbcTemplate sql;
    static long nextUser = 10;

    @BeforeAll
    static void start() throws Exception {
        assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker not available");
        pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        ds = new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        sql = new JdbcTemplate(ds);
        sql.execute("CREATE TABLE public.users (id BIGINT PRIMARY KEY); INSERT INTO public.users SELECT g FROM generate_series(1, 200) g;");
        sql.execute(Files.readString(Path.of("src/main/resources/db/migration/exams/V100__document_recognition_usage.sql")));
    }

    @AfterAll
    static void stop() {
        if (pg != null) pg.stop();
    }

    /** A ledger as one backend process builds it, with its own clock. */
    static DocumentRecognitionLedger ledger(Clock clock) throws Exception {
        Constructor<DocumentRecognitionLedger> c = DocumentRecognitionLedger.class.getDeclaredConstructor(
                JdbcTemplate.class, org.springframework.transaction.support.TransactionTemplate.class, Clock.class);
        c.setAccessible(true);
        return c.newInstance(new JdbcTemplate(ds),
                new org.springframework.transaction.support.TransactionTemplate(new DataSourceTransactionManager(ds)), clock);
    }

    static int status(Throwable e) {
        return ((ResponseStatusException) e).getStatusCode().value();
    }

    static int rows(long user, String status) {
        return sql.queryForObject("SELECT count(*) FROM document_recognition_usage WHERE user_id = ? AND status = ?", Integer.class, user, status);
    }

    @Test
    void twentyADayThenRefusedAndARestartDoesNotResetTheDay() throws Exception {
        long u = nextUser++;
        ReadingImportGuard guard = new ReadingImportGuard(ledger(Clock.systemUTC()));
        for (int i = 0; i < ReadingImportGuard.DAILY_UPLOADS; i++) {
            try (var permit = guard.enter(u)) {
                if (i % 2 == 0) permit.succeeded(); // the others count as sent and failed
            }
        }
        assertThatThrownBy(() -> guard.enter(u)).satisfies(e -> assertThat(status(e)).isEqualTo(429)).hasMessageContaining("hôm nay");
        assertThat(rows(u, "SUCCEEDED")).isEqualTo(10);
        assertThat(rows(u, "FAILED")).isEqualTo(10);
        // the backend restarts: a new guard and ledger on the same database still see today's twenty
        ReadingImportGuard restarted = new ReadingImportGuard(ledger(Clock.systemUTC()));
        assertThatThrownBy(() -> restarted.enter(u)).satisfies(e -> assertThat(status(e)).isEqualTo(429));
        // the refusal released the slot and the account: another account is served at once
        restarted.enter(nextUser++).close();
        // the next local day is a new bucket; nothing was deleted
        ReadingImportGuard tomorrow = new ReadingImportGuard(ledger(Clock.offset(Clock.systemUTC(), Duration.ofDays(1))));
        tomorrow.enter(u).close();
        assertThat(sql.queryForObject("SELECT count(*) FROM document_recognition_usage WHERE user_id = ?", Integer.class, u)).isEqualTo(21);
    }

    @Test
    void parallelUploadsThroughTwoProcessesNeverOverspend() throws Exception {
        long u = nextUser++;
        DocumentRecognitionLedger a = ledger(Clock.systemUTC()), b = ledger(Clock.systemUTC());
        ExecutorService pool = Executors.newFixedThreadPool(8);
        CountDownLatch go = new CountDownLatch(1);
        AtomicInteger granted = new AtomicInteger(), refused = new AtomicInteger();
        List<Future<?>> all = new ArrayList<>();
        for (int i = 0; i < 32; i++) {
            DocumentRecognitionLedger l = i % 2 == 0 ? a : b;
            all.add(pool.submit(() -> {
                go.await();
                try {
                    l.reserve(u, ReadingImportGuard.DAILY_UPLOADS);
                    granted.incrementAndGet();
                } catch (ResponseStatusException e) {
                    if (status(e) == 429) refused.incrementAndGet();
                }
                return null;
            }));
        }
        go.countDown();
        for (Future<?> f : all) f.get(60, TimeUnit.SECONDS);
        pool.shutdown();
        assertThat(granted.get()).isEqualTo(20);
        assertThat(refused.get()).isEqualTo(12);
        assertThat(rows(u, "STARTED")).isEqualTo(20); // never settled (a crash): still counted
    }

    @Test
    void notSentAndRefusedBeforeSendingAreNotCountedAndSettlingIsOnce() throws Exception {
        long u = nextUser++;
        DocumentRecognitionLedger l = ledger(Clock.systemUTC());
        ReadingImportGuard guard = new ReadingImportGuard(l);
        // refused by the checks before sending: no slot, no ledger row
        assertThatThrownBy(() -> guard.preflight(new MockMultipartFile("file", "x.pdf", "application/pdf", "not a pdf".getBytes())))
                .satisfies(e -> assertThat(status(e)).isEqualTo(400));
        // the host was never reached: settled NOT_SENT, not counted
        try (var permit = guard.enter(u)) { permit.notSent(); }
        assertThat(l.usedToday(u)).isZero();
        assertThat(rows(u, "NOT_SENT")).isEqualTo(1);
        // a settled row is never settled again
        long id = l.reserve(u, ReadingImportGuard.DAILY_UPLOADS);
        l.settle(id, "SUCCEEDED");
        l.settle(id, "NOT_SENT");
        assertThat(l.usedToday(u)).isEqualTo(1);
        // Reading's upload recognises inside the transaction that stores the material: when that rolls back (failed
        // recognition), the count and its settlement stay (the ledger writes in its own transaction)
        var outer = new org.springframework.transaction.support.TransactionTemplate(new DataSourceTransactionManager(ds));
        long w = nextUser++;
        assertThatThrownBy(() -> outer.executeWithoutResult(t -> {
            try (var permit = guard.enter(w)) { /* recognition failed */ }
            throw new IllegalStateException("material not stored");
        })).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> outer.executeWithoutResult(t -> {
            try (var permit = guard.enter(w)) { permit.notSent(); }
            throw new IllegalStateException("host unreachable");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(rows(w, "FAILED")).isEqualTo(1);
        assertThat(rows(w, "NOT_SENT")).isEqualTo(1);
        assertThat(l.usedToday(w)).isEqualTo(1);
        // a busy account is refused before any unit is taken
        try (var first = guard.enter(u)) {
            assertThatThrownBy(() -> guard.enter(u)).satisfies(e -> assertThat(status(e)).isEqualTo(429));
            assertThat(l.usedToday(u)).isEqualTo(2);
        }
    }
}
