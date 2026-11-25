package com.englishcoach.premium.service;

import com.englishcoach.premium.config.PremiumProperties;
import com.englishcoach.premium.exception.PremiumRequiredException;
import com.englishcoach.premium.repository.PremiumAiUsageRepository;
import com.englishcoach.premium.repository.PremiumFeatureDefinitionRepository;
import org.hibernate.jpa.HibernatePersistenceProvider;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.data.jpa.repository.support.JpaRepositoryFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.orm.jpa.JpaTransactionManager;
import org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean;
import org.springframework.orm.jpa.SharedEntityManagerCreator;
import org.springframework.orm.jpa.vendor.HibernateJpaVendorAdapter;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.DockerClientFactory;
import org.testcontainers.containers.PostgreSQLContainer;

import jakarta.persistence.EntityManagerFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The free daily allowances on the real ledger schema (V36 + V99) on PostgreSQL 17: 3 AI uses a day shared by every AI
 * feature, 10 Echo Coach messages separately, 1 My Books import; parallel requests through TWO service instances (two
 * processes' worth of JVM locks) never overspend; yesterday's rows do not count; a book stays known after deletion.
 */
class FreeDailyAllowancePostgresTest {

    static PostgreSQLContainer<?> pg;
    static LocalContainerEntityManagerFactoryBean emfBean;
    static JdbcTemplate sql;
    static TransactionTemplate tx;
    static PremiumUsageService a, b;
    static long nextUser = 10;

    @BeforeAll
    static void start() throws Exception {
        assumeTrue(DockerClientFactory.instance().isDockerAvailable(), "Docker not available");
        pg = new PostgreSQLContainer<>("postgres:17");
        pg.start();
        DriverManagerDataSource ds = new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        sql = new JdbcTemplate(ds);
        sql.execute("CREATE SCHEMA IF NOT EXISTS exams; CREATE TABLE public.users (id BIGINT PRIMARY KEY);"
                + " INSERT INTO public.users SELECT g FROM generate_series(1, 200) g;");
        for (String v : List.of("V36__premium_foundation.sql", "V91__listening_document_import.sql", "V99__free_daily_allowances.sql")) {
            String text = Files.readString(Path.of("src/main/resources/db/migration/exams/" + v));
            if (v.startsWith("V91")) text = text.substring(text.indexOf("INSERT INTO public.premium_feature_definitions"),
                    text.indexOf("ON CONFLICT (feature_key) DO NOTHING;") + "ON CONFLICT (feature_key) DO NOTHING;".length());
            sql.execute(text);
        }
        emfBean = new LocalContainerEntityManagerFactoryBean();
        emfBean.setDataSource(ds);
        // only the ledger's two entities (the subscription entity maps the whole account model)
        emfBean.setManagedTypes(org.springframework.orm.jpa.persistenceunit.PersistenceManagedTypes.of(
                List.of("com.englishcoach.premium.entity.PremiumAiUsage", "com.englishcoach.premium.entity.PremiumFeatureDefinition"), List.of()));
        emfBean.setJpaVendorAdapter(new HibernateJpaVendorAdapter());
        emfBean.setPersistenceProviderClass(HibernatePersistenceProvider.class);
        emfBean.setJpaPropertyMap(Map.of("hibernate.hbm2ddl.auto", "none"));
        emfBean.afterPropertiesSet();
        EntityManagerFactory emf = emfBean.getObject();
        JpaTransactionManager tm = new JpaTransactionManager(emf);
        tm.setDataSource(ds);
        tx = new TransactionTemplate(tm);
        a = service(emf, ds);
        b = service(emf, ds);
    }

    static PremiumUsageService service(EntityManagerFactory emf, DriverManagerDataSource ds) {
        JpaRepositoryFactory factory = new JpaRepositoryFactory(SharedEntityManagerCreator.createSharedEntityManager(emf));
        PremiumUsageService s = new PremiumUsageService(factory.getRepository(PremiumAiUsageRepository.class),
                factory.getRepository(PremiumFeatureDefinitionRepository.class), new PremiumProperties());
        ReflectionTestUtils.setField(s, "jdbcTemplate", new JdbcTemplate(ds));
        return s;
    }

    @AfterAll
    static void stop() {
        if (emfBean != null) emfBean.destroy();
        if (pg != null) pg.stop();
    }

    static Long reserve(PremiumUsageService s, long user, String feature, String request) {
        return tx.execute(t -> s.reserveUsage(user, feature, request, false));
    }

    static void commit(Long id) {
        tx.executeWithoutResult(t -> a.commitReservation(id));
    }

    @Test
    void threeAiUsesADaySharedByEveryAiFeatureAndTheCoachIsSeparate() {
        long u = nextUser++;
        commit(reserve(a, u, "WRITING_AI_FEEDBACK", "w1"));
        commit(reserve(a, u, "SPEAKING_ROLEPLAY", "r1"));
        commit(reserve(b, u, "LISTENING_DOCUMENT_IMPORT", "d1"));
        assertThatThrownBy(() -> reserve(a, u, "READING_CONTEXT_EXPLANATION", "x1")).isInstanceOf(PremiumRequiredException.class);
        // Echo Coach: its own 10 a day, unaffected by the exhausted AI pool
        for (int i = 0; i < 10; i++) commit(reserve(i % 2 == 0 ? a : b, u, "COACH_CHAT", null));
        assertThatThrownBy(() -> reserve(a, u, "COACH_CHAT", null)).isInstanceOf(PremiumRequiredException.class);
        var daily = tx.execute(t -> a.dailyAllowances(u));
        assertThat(daily.get(PremiumUsageService.Pool.AI).used()).isEqualTo(3);
        assertThat(daily.get(PremiumUsageService.Pool.COACH).used()).isEqualTo(10);
        // a release gives the unit back; the same request id is then reserved again in place (no duplicate row)
        long v = nextUser++;
        Long first = reserve(a, v, "SPEAKING_ROLEPLAY", "turn-1");
        tx.executeWithoutResult(t -> a.releaseReservation(first));
        assertThat(reserve(b, v, "SPEAKING_ROLEPLAY", "turn-1")).isEqualTo(first);
        assertThat(sql.queryForObject("SELECT count(*) FROM premium_ai_usage WHERE user_id = ?", Integer.class, v)).isEqualTo(1);
    }

    @Test
    void parallelRequestsFromTwoProcessesNeverOverspendTheDailyPool() throws Exception {
        long u = nextUser++;
        List<String> features = List.of("WRITING_AI_FEEDBACK", "SPEAKING_ROLEPLAY", "SPEAKING_PRONUNCIATION", "TRANSLATION_AI_GRADING",
                "READING_CONTEXT_EXPLANATION", "SPEAKING_QUICK_CHECK", "SPEAKING_SHADOWING", "EXAM_AI_SCORING");
        ExecutorService pool = Executors.newFixedThreadPool(8);
        CountDownLatch go = new CountDownLatch(1);
        AtomicInteger granted = new AtomicInteger(), refused = new AtomicInteger();
        List<Future<?>> all = new ArrayList<>();
        for (int i = 0; i < 16; i++) {
            int n = i;
            all.add(pool.submit(() -> {
                go.await();
                try {
                    reserve(n % 2 == 0 ? a : b, u, features.get(n % features.size()), "p" + n);
                    granted.incrementAndGet();
                } catch (PremiumRequiredException e) {
                    refused.incrementAndGet();
                }
                return null;
            }));
        }
        go.countDown();
        for (Future<?> f : all) f.get(60, TimeUnit.SECONDS);
        pool.shutdown();
        assertThat(granted.get()).isEqualTo(3);
        assertThat(refused.get()).isEqualTo(13);
        assertThat(sql.queryForObject("SELECT count(*) FROM premium_ai_usage WHERE user_id = ? AND status = 'RESERVED'",
                Integer.class, u)).isEqualTo(3);
    }

    @Test
    void yesterdaysUsesDoNotCountAndNothingIsDeleted() {
        long u = nextUser++;
        for (int i = 0; i < 3; i++) commit(reserve(a, u, "WRITING_AI_FEEDBACK", "old" + i));
        // the same three rows, as if created before local midnight
        sql.update("UPDATE premium_ai_usage SET created_at = ? WHERE user_id = ?",
                java.sql.Timestamp.from(a.dayStart().minusSeconds(60)), u);
        assertThat(reserve(a, u, "WRITING_AI_FEEDBACK", "new1")).isNotNull();
        assertThat(sql.queryForObject("SELECT count(*) FROM premium_ai_usage WHERE user_id = ?", Integer.class, u)).isEqualTo(4);
    }

    @Test
    void oneNewBookADayEvenWithTwoTabsAndADeletedBookStaysKnown() throws Exception {
        long u = nextUser++;
        String x = "1".repeat(64), y = "2".repeat(64);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        Future<PremiumUsageService.BookGrant> g1 = pool.submit(() -> tx.execute(t -> a.grantBookImports(u, List.of(x), false)));
        Future<PremiumUsageService.BookGrant> g2 = pool.submit(() -> tx.execute(t -> b.grantBookImports(u, List.of(y), false)));
        int granted = g1.get(30, TimeUnit.SECONDS).granted().size() + g2.get(30, TimeUnit.SECONDS).granted().size();
        pool.shutdown();
        assertThat(granted).isEqualTo(1);
        String winner = sql.queryForObject("SELECT substring(request_id from 4) FROM premium_ai_usage WHERE user_id = ? AND feature_key = 'MY_BOOKS_IMPORT'",
                String.class, u);
        tx.executeWithoutResult(t -> a.completeBookImports(u, List.of(winner)));
        // the stored book was deleted on the device and imported again: the same book, granted, no second unit
        assertThat(tx.execute(t -> a.grantBookImports(u, List.of(winner), false)).granted()).containsExactly(winner);
        String loser = winner.equals(x) ? y : x;
        assertThat(tx.execute(t -> a.grantBookImports(u, List.of(loser), false)).refused()).containsExactly(loser);
        // a failed store gives the day's import back
        long v = nextUser++;
        tx.executeWithoutResult(t -> a.grantBookImports(v, List.of(x), false));
        tx.executeWithoutResult(t -> a.releaseBookImports(v, List.of(x)));
        assertThat(tx.execute(t -> a.grantBookImports(v, List.of(y), false)).granted()).containsExactly(y);
        // Premium: no daily cap
        long p = nextUser++;
        assertThat(tx.execute(t -> a.grantBookImports(p, List.of(x, y), true)).granted()).containsExactly(x, y);
    }

    @Test
    void releasingStoredBooksGainsAtMostOneExtraBookADay() {
        long u = nextUser++;
        String x = "3".repeat(64), y = "4".repeat(64), z = "5".repeat(64);
        // a client that "releases" every book it stored: the first give-back of the day is honoured...
        assertThat(tx.execute(t -> a.grantBookImports(u, List.of(x), false)).granted()).containsExactly(x);
        assertThat((Integer) tx.execute(t -> b.releaseBookImports(u, List.of(x)))).isEqualTo(1);
        assertThat(tx.execute(t -> a.grantBookImports(u, List.of(y), false)).granted()).containsExactly(y);
        // ...the second is not: the reservation is kept as used and no third book is granted today
        assertThat((Integer) tx.execute(t -> b.releaseBookImports(u, List.of(y)))).isZero();
        assertThat(sql.queryForObject("SELECT status FROM premium_ai_usage WHERE user_id = ? AND request_id = ?", String.class, u, "fp:" + y))
                .isEqualTo("COMPLETED");
        assertThat(tx.execute(t -> a.grantBookImports(u, List.of(z), false)).refused()).containsExactly(z);
        // a book kept as used is granted again for free (the same book never costs twice)
        assertThat(tx.execute(t -> a.grantBookImports(u, List.of(y), false)).granted()).containsExactly(y);
        // a give-back long after the grant (not the app's immediate "storing failed") is not honoured either
        long v = nextUser++;
        tx.executeWithoutResult(t -> a.grantBookImports(v, List.of(x), false));
        sql.update("UPDATE premium_ai_usage SET created_at = now() - interval '31 minutes' WHERE user_id = ?", v);
        assertThat((Integer) tx.execute(t -> a.releaseBookImports(v, List.of(x)))).isZero();
        assertThat(sql.queryForObject("SELECT status FROM premium_ai_usage WHERE user_id = ?", String.class, v)).isEqualTo("COMPLETED");
    }
}
