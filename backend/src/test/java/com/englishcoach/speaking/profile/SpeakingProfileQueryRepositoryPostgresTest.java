package com.englishcoach.speaking.profile;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.listening.entity.ListeningExercise;
import com.englishcoach.listening.entity.ListeningMaterial;
import com.englishcoach.listening.entity.ListeningSession;
import com.englishcoach.listening.entity.TranscriptSegment;
import com.englishcoach.speaking.entity.*;
import com.englishcoach.speaking.profile.SpeakingProfileQueryRepository.*;
import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;
import org.hibernate.jpa.HibernatePersistenceProvider;
import org.junit.jupiter.api.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean;
import org.springframework.orm.jpa.vendor.HibernateJpaVendorAdapter;
import org.springframework.test.util.ReflectionTestUtils;
import org.testcontainers.containers.PostgreSQLContainer;

import javax.sql.DataSource;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.Statement;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Real PostgreSQL 17 + Hibernate 6 verification for every JPQL projection and batch aggregation
 * in {@link SpeakingProfileQueryRepository} (verifies JPQL grammar, return types, 0 N+1, and AGENTS.md §21 isolation).
 */
class SpeakingProfileQueryRepositoryPostgresTest {

    private static PostgreSQLContainer<?> postgres;
    private static EntityManagerFactory emf;
    private static JdbcTemplate jdbc;
    private static final AtomicInteger sqlCount = new AtomicInteger();
    private static final List<String> sqlLog = new ArrayList<>();

    private EntityManager em;
    private SpeakingProfileQueryRepository repo;

    @BeforeAll
    static void initPostgresAndHibernate() throws Exception {
        postgres = new PostgreSQLContainer<>("postgres:17");
        postgres.start();

        DriverManagerDataSource rawDs = new DriverManagerDataSource(
                postgres.getJdbcUrl(),
                postgres.getUsername(),
                postgres.getPassword()
        );
        jdbc = new JdbcTemplate(rawDs);

        try (Connection conn = rawDs.getConnection(); Statement st = conn.createStatement()) {
            st.execute("CREATE SCHEMA IF NOT EXISTS exams;");
        }

        DataSource countingDs = wrapCountingDataSource(rawDs);

        LocalContainerEntityManagerFactoryBean fb = new LocalContainerEntityManagerFactoryBean();
        fb.setDataSource(countingDs);
        fb.setPersistenceProviderClass(HibernatePersistenceProvider.class);
        fb.setJpaVendorAdapter(new HibernateJpaVendorAdapter());
        fb.setPackagesToScan(
                "com.englishcoach.auth.entity",
                "com.englishcoach.listening.entity",
                "com.englishcoach.speaking.entity"
        );
        Properties props = new Properties();
        props.setProperty("hibernate.hbm2ddl.auto", "create");
        props.setProperty("hibernate.dialect", "org.hibernate.dialect.PostgreSQLDialect");
        fb.setJpaProperties(props);
        fb.afterPropertiesSet();
        emf = fb.getObject();
    }

    @AfterAll
    static void tearDown() {
        if (emf != null) emf.close();
        if (postgres != null) postgres.stop();
    }

    @BeforeEach
    void setUp() {
        em = emf.createEntityManager();
        repo = new SpeakingProfileQueryRepository();
        ReflectionTestUtils.setField(repo, "em", em);
        sqlCount.set(0);
        sqlLog.clear();
    }

    @AfterEach
    void closeEm() {
        if (em != null && em.isOpen()) {
            em.close();
        }
    }

    @Test
    @DisplayName("PG17 + Hibernate 6: Principal isolation, quarantine material filtering, and 0 N+1 batch pagination")
    void verifyAllRepositoryQueriesAgainstRealPostgres17() {
        em.getTransaction().begin();

        User alice = User.builder().email("alice@englishcoach.io.vn").password("pw").name("Alice").role(Role.ROLE_USER).build();
        User bob = User.builder().email("bob@englishcoach.io.vn").password("pw").name("Bob").role(Role.ROLE_USER).build();
        em.persist(alice);
        em.persist(bob);

        ListeningMaterial sysMat = ListeningMaterial.builder()
                .title("System TED Talk")
                .audioUrl("https://youtube.com/watch?v=sys1")
                .isSystem(true)
                .ownerUserId(null)
                .cefrLevel("B2")
                .youtubeVideoId("sys1")
                .build();
        ListeningMaterial quarantinedMat = ListeningMaterial.builder()
                .title("Quarantined Legacy Audio")
                .audioUrl("https://youtube.com/watch?v=quar1")
                .isSystem(false)
                .ownerUserId(null)
                .cefrLevel("B1")
                .build();
        ListeningMaterial bobPrivateMat = ListeningMaterial.builder()
                .title("Bob Private Audio")
                .audioUrl("https://youtube.com/watch?v=bob1")
                .isSystem(false)
                .ownerUserId(null) // set after bob gets ID
                .build();
        em.persist(sysMat);
        em.persist(quarantinedMat);
        em.flush();

        bobPrivateMat.setOwnerUserId(bob.getId());
        em.persist(bobPrivateMat);
        em.flush();

        // Create 12 completed + 1 active session for Alice, and 3 sessions for Bob
        for (int i = 0; i < 12; i++) {
            SpeakingSession s = SpeakingSession.builder()
                    .user(alice)
                    .mode(i % 2 == 0 ? "SHADOWING" : "ROLEPLAY")
                    .status("COMPLETED")
                    .sourceId(i % 2 == 0 ? sysMat.getId() : null)
                    .completedUnitsCount(5)
                    .totalUnitsCount(5)
                    .durationSeconds(60)
                    .build();
            em.persist(s);
            em.flush();

            if (i % 2 == 0) {
                SpeakingShadowingAttempt att = SpeakingShadowingAttempt.builder()
                        .user(alice)
                        .session(s)
                        .clientAttemptId("alice-att-" + i)
                        .accuracyScore(90.0)
                        .pronunciationScore(84.0)
                        .fluencyScore(82.0)
                        .durationSeconds(10)
                        .primaryIssueType("PHONE_SUBSTITUTION")
                        .targetWord("think")
                        .productSafeResultJson("{\"huge_blob\":true}")
                        .build();
                em.persist(att);
            } else {
                SpeakingTurn t = SpeakingTurn.builder()
                        .session(s)
                        .clientTurnId("alice-turn-" + i)
                        .sequenceNumber(1)
                        .speaker("LEARNER")
                        .text("Hello world")
                        .detectedVocabulary(List.of("negotiate", "deadline"))
                        .durationSeconds(12)
                        .pronunciationScore(86)
                        .pronunciationResultJson("{\"huge_turn_blob\":true}")
                        .build();
                em.persist(t);
            }
        }

        SpeakingSession aliceActive = SpeakingSession.builder()
                .user(alice)
                .mode("SHADOWING")
                .status("ACTIVE")
                .sourceId(sysMat.getId())
                .currentUnitIndex(2)
                .completedUnitsCount(2)
                .totalUnitsCount(8)
                .build();
        em.persist(aliceActive);

        SpeakingSession bobSession = SpeakingSession.builder()
                .user(bob)
                .mode("SHADOWING")
                .status("COMPLETED")
                .sourceId(bobPrivateMat.getId())
                .completedUnitsCount(4)
                .totalUnitsCount(4)
                .durationSeconds(120)
                .build();
        em.persist(bobSession);

        em.getTransaction().commit();
        em.clear();

        // 1. Visibility & Quarantine check (AGENTS.md §21)
        Map<Long, VisibleMaterialMeta> aliceVisible = repo.findVisibleMaterialsByIds(
                alice.getId(), List.of(sysMat.getId(), quarantinedMat.getId(), bobPrivateMat.getId()));
        assertThat(aliceVisible).containsOnlyKeys(sysMat.getId());
        assertThat(aliceVisible).doesNotContainKey(quarantinedMat.getId());
        assertThat(aliceVisible).doesNotContainKey(bobPrivateMat.getId());

        // 2. Active header & distinct dates & lifetime stats
        Optional<ActiveShadowingHeader> activeHdr = repo.findActiveShadowingHeader(alice.getId());
        assertThat(activeHdr).isPresent();
        assertThat(activeHdr.get().completedUnitsCount()).isEqualTo(2);
        assertThat(activeHdr.get().totalUnitsCount()).isEqualTo(8);

        Set<LocalDate> activeDates = repo.findDistinctActiveDates(alice.getId());
        assertThat(activeDates).contains(LocalDate.now());

        LifetimeAggregateStats life = repo.getLifetimeAggregateStats(alice.getId());
        assertThat(life.shadowingAttemptsCount()).isEqualTo(6L);
        assertThat(life.roleplayLearnerTurnsCount()).isEqualTo(6L);
        assertThat(life.distinctTargetVocabCount()).isEqualTo(2L);
        assertThat(life.averageContentMatchScore()).isEqualTo(90.0);

        List<ShadowingIssueMarkerRow> markers = repo.findShadowingIssueMarkersSince(alice.getId(), LocalDateTime.now().minusDays(30));
        assertThat(markers).hasSize(6);

        // 3. Zero-N+1 History Page check across 10 sessions on Page 0
        sqlCount.set(0);
        sqlLog.clear();

        List<SessionStatusModeRow> counts = repo.getSessionStatusAndModeCounts(alice.getId());
        List<SpeakingSession> page0 = repo.findPaginatedSessions(alice.getId(), "ALL", "ALL", 0, 10);
        List<Long> pageIds = page0.stream().map(SpeakingSession::getId).toList();
        Map<Long, ShadowingSessionBatchStats> shStats = repo.aggregateShadowingStatsBySessionIds(pageIds);
        Map<Long, RoleplaySessionBatchStats> rpStats = repo.aggregateRoleplayStatsBySessionIds(pageIds);
        Map<Long, QuickCheckSessionBatchSummary> qcStats = repo.findQuickCheckSummariesBySessionIds(pageIds);

        assertThat(counts.stream().mapToLong(SessionStatusModeRow::count).sum()).isEqualTo(13L); // Bob's session excluded!
        assertThat(page0).hasSize(10);
        assertThat(shStats).isNotEmpty();
        assertThat(rpStats).isNotEmpty();
        assertThat(qcStats).isEmpty();

        // Constant 5 bounded SQL queries for a 10-item page (never 1 + 10*N!), and 0 JSON blob columns fetched!
        assertThat(sqlCount.get()).isEqualTo(5);
        assertThat(sqlLog).noneMatch(sql -> sql.contains("product_safe_result_json") || sql.contains("pronunciation_result_json"));
    }

    private static DataSource wrapCountingDataSource(DataSource delegate) {
        return (DataSource) Proxy.newProxyInstance(
                DataSource.class.getClassLoader(),
                new Class<?>[]{DataSource.class},
                (proxy, method, args) -> {
                    Object result = method.invoke(delegate, args);
                    if ("getConnection".equals(method.getName()) && result instanceof Connection conn) {
                        return Proxy.newProxyInstance(
                                Connection.class.getClassLoader(),
                                new Class<?>[]{Connection.class},
                                (cProxy, cMethod, cArgs) -> {
                                    if (("prepareStatement".equals(cMethod.getName()) || "createStatement".equals(cMethod.getName()))
                                            && cArgs != null && cArgs.length > 0 && cArgs[0] instanceof String sql) {
                                        sqlCount.incrementAndGet();
                                        sqlLog.add(sql.toLowerCase(Locale.ROOT));
                                    }
                                    return cMethod.invoke(conn, cArgs);
                                }
                        );
                    }
                    return result;
                }
        );
    }
}
