package com.englishcoach.grammar;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.grammar.GrammarDtos.*;
import com.englishcoach.premium.config.PremiumProperties;
import com.englishcoach.premium.exception.PremiumExceptionHandler;
import com.englishcoach.premium.interceptor.PremiumFeatureGatingInterceptor;
import com.englishcoach.premium.repository.PremiumAiUsageRepository;
import com.englishcoach.premium.repository.PremiumFeatureDefinitionRepository;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumUsageService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.hibernate.jpa.HibernatePersistenceProvider;
import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.data.jpa.repository.support.JpaRepositoryFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.orm.jpa.*;
import org.springframework.orm.jpa.vendor.HibernateJpaVendorAdapter;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.method.annotation.AuthenticationPrincipalArgumentResolver;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.testcontainers.containers.PostgreSQLContainer;

import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Real PostgreSQL + JPA usage ledger + JDBC receipts + MVC. Only entitlement and external inference are mocked. */
class GrammarProfessorReceiptPostgresTest {
    static final ObjectMapper MAPPER = new ObjectMapper();
    static final ProfessorRequest QUESTION = new ProfessorRequest("verb-be", "When do I use am?", "I am ready.");
    static final ProfessorAnswer RESPONSE = new ProfessorAnswer("Use am with I in the present.", List.of(), "HIGH", true);
    static final AtomicLong NEXT_USER = new AtomicLong(10);
    static PostgreSQLContainer<?> pg;
    static LocalContainerEntityManagerFactoryBean emf;
    static JdbcTemplate sql;
    static DriverManagerDataSource app;
    static JpaTransactionManager manager;
    static PremiumUsageService usage;
    static PremiumEntitlementService entitlements;
    static GrammarContent content;
    GrammarProfessorService provider;
    GrammarProfessorReceipts receipts;
    GrammarProfessorFacade facade;
    long owner;

    @BeforeAll
    static void start() throws Exception {
        pg = new PostgreSQLContainer<>("postgres:17"); pg.start();
        var admin = new DriverManagerDataSource(pg.getJdbcUrl(), pg.getUsername(), pg.getPassword());
        sql = new JdbcTemplate(admin);
        sql.execute("CREATE SCHEMA exams; CREATE TABLE public.users(id bigint PRIMARY KEY); INSERT INTO public.users SELECT generate_series(1,500);");
        for (String file : List.of("V36__premium_foundation.sql", "V94__database_runtime_least_privilege.sql", "V99__free_daily_allowances.sql",
                "V108__grammar_academy.sql", "V109__grammar_professor_receipts.sql"))
            sql.execute(Files.readString(Path.of("src/main/resources/db/migration/exams", file)));
        sql.execute("ALTER ROLE english_coach_app PASSWORD 'grammar-receipt-test-only'; UPDATE public.premium_feature_definitions SET premium_monthly_limit=2 WHERE feature_key='GRAMMAR_PROFESSOR';");
        app = new DriverManagerDataSource(pg.getJdbcUrl(), "english_coach_app", "grammar-receipt-test-only");
        emf = new LocalContainerEntityManagerFactoryBean(); emf.setDataSource(app);
        emf.setManagedTypes(org.springframework.orm.jpa.persistenceunit.PersistenceManagedTypes.of(List.of(
                "com.englishcoach.premium.entity.PremiumAiUsage", "com.englishcoach.premium.entity.PremiumFeatureDefinition"), List.of()));
        emf.setJpaVendorAdapter(new HibernateJpaVendorAdapter()); emf.setPersistenceProviderClass(HibernatePersistenceProvider.class);
        emf.setJpaPropertyMap(Map.of("hibernate.hbm2ddl.auto", "none")); emf.afterPropertiesSet();
        manager = new JpaTransactionManager(emf.getObject()); manager.setDataSource(app);
        var factory = new JpaRepositoryFactory(SharedEntityManagerCreator.createSharedEntityManager(emf.getObject()));
        usage = spy(new PremiumUsageService(factory.getRepository(PremiumAiUsageRepository.class),
                factory.getRepository(PremiumFeatureDefinitionRepository.class), new PremiumProperties()));
        ReflectionTestUtils.setField(usage, "jdbcTemplate", new JdbcTemplate(app));
        entitlements = mock(PremiumEntitlementService.class); content = new GrammarContent(MAPPER);
    }

    static GrammarProfessorReceipts newReceipts() {
        var target = new GrammarProfessorReceipts(new NamedParameterJdbcTemplate(app), usage, entitlements, MAPPER);
        var proxy = new ProxyFactory(target); proxy.setProxyTargetClass(true);
        proxy.addAdvice(new TransactionInterceptor(manager, new AnnotationTransactionAttributeSource()));
        return (GrammarProfessorReceipts) proxy.getProxy();
    }

    @BeforeEach
    void arrange() {
        owner = NEXT_USER.getAndIncrement(); receipts = newReceipts(); provider = mock(GrammarProfessorService.class);
        when(provider.ask(any())).thenAnswer(call -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).as("never hold a DB transaction during inference").isFalse();
            return RESPONSE;
        });
        facade = new GrammarProfessorFacade(content, provider, receipts, MAPPER, new GrammarProfessorAvailability(true, "unit-test-only"));
    }

    @AfterEach
    void clearAuth() { SecurityContextHolder.clearContext(); }

    @AfterAll
    static void stop() { if (emf != null) emf.destroy(); if (pg != null) pg.stop(); }

    long count(String table, String condition) {
        return sql.queryForObject("SELECT count(*) FROM public." + table + " WHERE user_id=? " + condition, Long.class, owner);
    }

    @ParameterizedTest
    @ValueSource(strings = {"X-Request-Id", "X-Client-Turn-Id", "X-Client-Attempt-Id", "Idempotency-Key"})
    void eachHeaderReplaysAfterQuotaExhaustionAndRejectsChangedContentWithoutCallingProvider(String header) throws Exception {
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(
                new UserDetailsImpl(owner, "synthetic@example.test", "unused", List.of()), null, List.of()));
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new GrammarController(content, mock(GrammarService.class), facade))
                .addInterceptors(new PremiumFeatureGatingInterceptor(entitlements, usage))
                .setCustomArgumentResolvers(new AuthenticationPrincipalArgumentResolver())
                .setControllerAdvice(new GrammarExceptionHandler(), new PremiumExceptionHandler()).build();
        for (String id : List.of("K", "K2", "K3", "K")) mvc.perform(post("/api/v1/grammar/professor/ask")
                .header(header, id).contentType("application/json").content(MAPPER.writeValueAsString(QUESTION)))
                .andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"));
        mvc.perform(post("/api/v1/grammar/professor/ask").header(header, "K4").contentType("application/json")
                .content(MAPPER.writeValueAsString(QUESTION))).andExpect(status().isForbidden());
        mvc.perform(post("/api/v1/grammar/professor/ask").header(header, "K").contentType("application/json")
                .content(MAPPER.writeValueAsString(new ProfessorRequest("verb-be", "Changed question", null))))
                .andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("REQUEST_ID_REUSED"));
        assertThat(count("premium_ai_usage", "AND status='COMPLETED'")).isEqualTo(3);
        assertThat(count("grammar_professor_receipt", "")).isEqualTo(3);
        verify(provider, times(3)).ask(QUESTION);
    }

    @Test
    void durableReplaySurvivesServiceReplacementAndTopicRemoval() {
        assertThat(facade.ask(owner, "K", QUESTION)).isEqualTo(RESPONSE);
        var removedContent = mock(GrammarContent.class);
        var restarted = new GrammarProfessorFacade(removedContent, provider, newReceipts(), MAPPER, new GrammarProfessorAvailability(true, "unit-test-only"));
        assertThat(restarted.ask(owner, "K", QUESTION)).isEqualTo(RESPONSE);
        verify(provider).ask(QUESTION);
        assertThat(count("premium_ai_usage", "")).isEqualTo(1);
    }

    @Test
    void sameIdIsIndependentForDifferentOwnersAndLegacyCallsWithoutIdAreNewActions() {
        facade.ask(owner, "K", QUESTION);
        facade.ask(NEXT_USER.getAndIncrement(), "K", new ProfessorRequest("verb-be", "Another learner", null));
        facade.ask(owner, null, QUESTION); facade.ask(owner, null, QUESTION);
        assertThat(count("premium_ai_usage", "AND status='COMPLETED'")).isEqualTo(3);
        verify(provider, times(4)).ask(any());
    }

    @Test
    void premiumMonthlyQuotaStillAllowsACompletedReplay() {
        when(entitlements.isUserPremium(owner)).thenReturn(true);
        facade.ask(owner, "K", QUESTION); facade.ask(owner, "K2", QUESTION);
        assertThat(facade.ask(owner, "K", QUESTION)).isEqualTo(RESPONSE);
        assertThatThrownBy(() -> facade.ask(owner, "K3", QUESTION)).isInstanceOf(com.englishcoach.premium.exception.PremiumLimitReachedException.class);
        assertThat(count("premium_ai_usage", "AND usage_kind='PREMIUM' AND status='COMPLETED'")).isEqualTo(2);
        verify(provider, times(2)).ask(QUESTION);
    }

    @Test
    void concurrentRetriesExecuteOnceAndPendingConflictDoesNotReserveAgain() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        when(provider.ask(any())).thenAnswer(call -> { entered.countDown(); assertThat(release.await(20, TimeUnit.SECONDS)).isTrue(); return RESPONSE; });
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<ProfessorAnswer> first = pool.submit(() -> facade.ask(owner, "K", QUESTION));
            assertThat(entered.await(20, TimeUnit.SECONDS)).isTrue();
            var second = new GrammarProfessorFacade(content, provider, newReceipts(), MAPPER, new GrammarProfessorAvailability(true, "unit-test-only"));
            assertThatThrownBy(() -> second.ask(owner, "K", QUESTION)).isInstanceOfSatisfying(GrammarException.class, e -> assertThat(e.status).isEqualTo(409));
            assertThat(count("premium_ai_usage", "")).isEqualTo(1);
            release.countDown(); assertThat(first.get(20, TimeUnit.SECONDS)).isEqualTo(RESPONSE);
            assertThat(second.ask(owner, "K", QUESTION)).isEqualTo(RESPONSE);
            verify(provider).ask(QUESTION);
        } finally { release.countDown(); pool.shutdownNow(); }
    }

    @Test
    void knownProviderFailureReleasesQuotaAndSameRequestCanRetryOnce() {
        when(provider.ask(any())).thenThrow(new GrammarException(503, "PROFESSOR_UNAVAILABLE")).thenReturn(RESPONSE);
        assertThatThrownBy(() -> facade.ask(owner, "K", QUESTION)).isInstanceOf(GrammarException.class);
        assertThat(count("premium_ai_usage", "AND status='RELEASED'")).isEqualTo(1);
        assertThat(facade.ask(owner, "K", QUESTION)).isEqualTo(RESPONSE);
        assertThat(facade.ask(owner, "K", QUESTION)).isEqualTo(RESPONSE);
        assertThat(count("premium_ai_usage", "AND status='COMPLETED'")).isEqualTo(1);
        verify(provider, times(2)).ask(QUESTION);
    }

    @Test
    void receiptAndQuotaCommitRollBackTogetherAndUnknownOutcomesNeverReexecute() {
        var ticket = receipts.begin(owner, "K", "0".repeat(64), true);
        doThrow(new IllegalStateException("test settlement failure")).when(usage).commitReservation(ticket.reservationId());
        try {
            assertThatThrownBy(() -> receipts.complete(ticket, RESPONSE)).isInstanceOf(IllegalStateException.class);
            assertThat(count("grammar_professor_receipt", "AND status='PENDING' AND response IS NULL")).isEqualTo(1);
            assertThat(count("premium_ai_usage", "AND status='RESERVED'")).isEqualTo(1);
            assertThatThrownBy(() -> newReceipts().begin(owner, "K", "0".repeat(64), true)).isInstanceOfSatisfying(GrammarException.class, e -> assertThat(e.status).isEqualTo(409));
            verifyNoInteractions(provider);
        } finally { doCallRealMethod().when(usage).commitReservation(ticket.reservationId()); }
    }

    @Test
    void interruptedPendingRequestHasAnExplicitOutcomeWithoutCallingProviderOrReleasingLiveHolds() {
        receipts.begin(owner, "K", "0".repeat(64), true);
        sql.update("UPDATE public.grammar_professor_receipt SET updated_at=now()-interval '6 minutes' WHERE user_id=?", owner);
        assertThatThrownBy(() -> receipts.begin(owner, "K", "0".repeat(64), true))
                .isInstanceOfSatisfying(GrammarException.class, e -> { assertThat(e.status).isEqualTo(503); assertThat(e.getMessage()).isEqualTo("PROFESSOR_INTERRUPTED"); });
        assertThat(count("premium_ai_usage", "AND status='RESERVED'")).isEqualTo(1);
        verifyNoInteractions(provider);
    }

    @Test
    void newMissingTopicsAndOversizedIdsNeverReserveAndRuntimeCannotChangeSchema() {
        assertThatThrownBy(() -> facade.ask(owner, "K", new ProfessorRequest("missing", "Question", null))).isInstanceOf(GrammarException.class);
        assertThatThrownBy(() -> facade.ask(owner, "x".repeat(129), QUESTION)).isInstanceOf(GrammarException.class);
        assertThat(count("premium_ai_usage", "")).isZero();
        assertThat(count("grammar_professor_receipt", "")).isZero();
        assertThat(sql.queryForObject("SELECT has_table_privilege('english_coach_app','public.grammar_professor_receipt','INSERT') AND NOT has_schema_privilege('english_coach_app','public','CREATE')", Boolean.class)).isTrue();
        assertThat(sql.queryForList("SELECT confdeltype::text FROM pg_constraint WHERE conrelid='public.grammar_professor_receipt'::regclass AND contype='f'", String.class)).containsOnly("r");
    }
}
