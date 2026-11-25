package com.englishcoach.premium;

import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.flashcard.memory.FlashcardMemoryController;
import com.englishcoach.notification.service.NotificationService;
import com.englishcoach.payment.config.PaymentProperties;
import com.englishcoach.payment.entity.PaymentOrder;
import com.englishcoach.payment.entity.PaymentOrderStatus;
import com.englishcoach.payment.entity.PaymentTransaction;
import com.englishcoach.payment.entity.PaymentTransactionStatus;
import com.englishcoach.payment.repository.PaymentOrderRepository;
import com.englishcoach.payment.repository.PaymentTransactionRepository;
import com.englishcoach.payment.service.PaymentReconciliationService;
import com.englishcoach.payment.service.SepayWebhookVerifier;
import com.englishcoach.premium.config.PremiumProperties;
import com.englishcoach.premium.config.PremiumWebMvcConfig;
import com.englishcoach.premium.entity.PremiumAiUsage;
import com.englishcoach.premium.entity.PremiumFeatureDefinition;
import com.englishcoach.premium.entity.PremiumPlan;
import com.englishcoach.premium.entity.PremiumSubscription;
import com.englishcoach.premium.exception.PremiumRequiredException;
import com.englishcoach.premium.interceptor.PremiumFeatureGatingInterceptor;
import com.englishcoach.premium.interceptor.RequirePremiumAi;
import com.englishcoach.premium.promo.PromoPremiumService;
import com.englishcoach.premium.repository.PremiumAiUsageRepository;
import com.englishcoach.premium.repository.PremiumFeatureDefinitionRepository;
import com.englishcoach.premium.repository.PremiumPlanRepository;
import com.englishcoach.premium.repository.PremiumSubscriptionRepository;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumSubscriptionService;
import com.englishcoach.premium.service.PremiumUsageService;
import com.englishcoach.premium.voucher.AiVoucherProperties;
import com.englishcoach.premium.voucher.AiVoucherService;
import jakarta.persistence.EntityManager;
import jakarta.persistence.Query;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.config.annotation.InterceptorRegistration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.lang.reflect.Constructor;
import java.lang.reflect.Parameter;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Security regression tests for:
 * - EC-SEC-2026-002: Universal @RequirePremiumAi quota/paywall bypass, RESERVED->RELEASED zero-credit race, 3x voucher multiplication
 * - EC-SEC-2026-003: Unversioned /api/flashcards/** interceptor & bulkhead bypass
 * - PAY-04 / PAY-05 / PAY-06 / PAY-07: SePay verifier, subAccount trimming, inactive quoted plan settlement, shared advisory lock
 */
class QuotaPaywallHardeningRegressionTest {

    private PremiumAiUsageRepository usageRepository;
    private PremiumFeatureDefinitionRepository featureRepository;
    private PremiumEntitlementService entitlementService;
    private PremiumUsageService usageService;
    private PremiumFeatureGatingInterceptor interceptor;
    private Map<Long, PremiumAiUsage> ledger;

    static class DefaultGatedController {
        @RequirePremiumAi("SPEAKING_ROLEPLAY")
        public void invoke() {}
    }

    static class ExplicitOptInReplayController {
        @RequirePremiumAi(value = "SPEAKING_ROLEPLAY", reuseClientRequestId = true)
        public void invoke() {}
    }

    @BeforeEach
    void setUp() {
        ledger = new LinkedHashMap<>();
        usageRepository = mock(PremiumAiUsageRepository.class);
        featureRepository = mock(PremiumFeatureDefinitionRepository.class);
        entitlementService = mock(PremiumEntitlementService.class);

        usageService = new PremiumUsageService(usageRepository, featureRepository, new PremiumProperties());
        interceptor = new PremiumFeatureGatingInterceptor(entitlementService, usageService);

        lenient().when(featureRepository.findByFeatureKey(anyString())).thenAnswer(inv -> Optional.of(
                PremiumFeatureDefinition.builder()
                        .featureKey(inv.getArgument(0))
                        .premiumRequired(true)
                        .premiumMonthlyLimit(10)
                        .enabled(true)
                        .build()
        ));
        lenient().when(usageRepository.findByUserIdAndFeatureKeyAndRequestId(anyLong(), anyString(), anyString()))
                .thenAnswer(inv -> ledger.values().stream()
                        .filter(row -> Objects.equals(row.getUserId(), inv.getArgument(0))
                                && Objects.equals(row.getFeatureKey(), inv.getArgument(1))
                                && Objects.equals(row.getRequestId(), inv.getArgument(2)))
                        .findFirst());
        lenient().when(usageRepository.findById(anyLong()))
                .thenAnswer(inv -> Optional.ofNullable(ledger.get(inv.getArgument(0))));
        lenient().when(usageRepository.save(any(PremiumAiUsage.class))).thenAnswer(inv -> {
            PremiumAiUsage row = inv.getArgument(0);
            if (row.getId() == null) {
                row.setId((long) ledger.size() + 1);
                row.setCreatedAt(Instant.now());
            }
            ledger.put(row.getId(), row);
            return row;
        });
        lenient().when(usageRepository.countTrialPerFeatureSince(anyLong(), anyCollection(), any(Instant.class)))
                .thenAnswer(inv -> {
                    Collection<String> statuses = inv.getArgument(1);
                    Instant since = inv.getArgument(2);
                    return ledger.values().stream()
                            .filter(row -> Objects.equals(row.getUserId(), inv.getArgument(0))
                                    && "TRIAL".equals(row.getUsageKind())
                                    && statuses.contains(row.getStatus())
                                    && !row.getCreatedAt().isBefore(since))
                            .collect(Collectors.groupingBy(PremiumAiUsage::getFeatureKey, Collectors.counting()))
                            .entrySet().stream()
                            .map(e -> new Object[]{e.getKey(), e.getValue()})
                            .toList();
                });

        UserDetailsImpl principal = new UserDetailsImpl(501L, "learner@example.test", "unused", List.of());
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(principal, null, List.of())
        );
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    @Test
    @DisplayName("EC-SEC-2026-002: Reused X-Request-Id / Idempotency-Key does NOT bypass quota on default @RequirePremiumAi")
    void reusedClientRequestIdDoesNotBypassQuotaOnDefaultAnnotation() throws Exception {
        HandlerMethod handler = new HandlerMethod(new DefaultGatedController(), DefaultGatedController.class.getMethod("invoke"));
        assertThat(handler.getMethodAnnotation(RequirePremiumAi.class).reuseClientRequestId()).isFalse();

        for (int i = 0; i < 3; i++) {
            MockHttpServletRequest req = new MockHttpServletRequest();
            req.addHeader("X-Request-Id", "fixed-attacker-key");
            req.addHeader("Idempotency-Key", "fixed-attacker-key");
            MockHttpServletResponse resp = new MockHttpServletResponse();
            resp.setStatus(200);
            assertThat(interceptor.preHandle(req, resp, handler)).isTrue();
            interceptor.afterCompletion(req, resp, handler, null);
        }

        // All 3 uses must be distinct server-generated UUIDs, never "fixed-attacker-key"
        assertThat(ledger).hasSize(3);
        assertThat(ledger.values()).extracting(PremiumAiUsage::getRequestId)
                .doesNotContain("fixed-attacker-key")
                .doesNotHaveDuplicates();

        // 4th attempt with the SAME X-Request-Id must be blocked with PremiumRequiredException
        MockHttpServletRequest fourth = new MockHttpServletRequest();
        fourth.addHeader("X-Request-Id", "fixed-attacker-key");
        assertThatThrownBy(() -> interceptor.preHandle(fourth, new MockHttpServletResponse(), handler))
                .isInstanceOf(PremiumRequiredException.class);
    }

    @Test
    @DisplayName("EC-SEC-2026-002: Concurrent failing request sharing X-Request-Id gets 409 Conflict and NEVER releases Request A's RESERVED row")
    void concurrentBadRequestCannotReleaseInFlightReservation() throws Exception {
        HandlerMethod handler = new HandlerMethod(
                new ExplicitOptInReplayController(),
                ExplicitOptInReplayController.class.getMethod("invoke")
        );

        // Request A acquires RESERVED row #1
        MockHttpServletRequest reqA = new MockHttpServletRequest();
        reqA.addHeader("X-Request-Id", "race-key-1");
        MockHttpServletResponse respA = new MockHttpServletResponse();
        respA.setStatus(200);
        assertThat(interceptor.preHandle(reqA, respA, handler)).isTrue();
        Long reservationId = (Long) reqA.getAttribute(PremiumFeatureGatingInterceptor.RESERVATION_ATTR);
        assertThat(reservationId).isEqualTo(1L);
        assertThat(ledger.get(1L).getStatus()).isEqualTo("RESERVED");

        // Request B arrives concurrently with the SAME X-Request-Id while Request A is still in-flight
        MockHttpServletRequest reqB = new MockHttpServletRequest();
        reqB.addHeader("X-Request-Id", "race-key-1");
        MockHttpServletResponse respB = new MockHttpServletResponse();
        respB.setStatus(400);

        assertThatThrownBy(() -> interceptor.preHandle(reqB, respB, handler))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> {
                    ResponseStatusException rse = (ResponseStatusException) ex;
                    assertThat(rse.getStatusCode().value()).isEqualTo(409);
                    assertThat(rse.getReason()).isEqualTo("AI_REQUEST_IN_FLIGHT");
                });

        // Request B never received RESERVATION_ATTR; even if afterCompletion runs with 400, row #1 remains RESERVED
        assertThat(reqB.getAttribute(PremiumFeatureGatingInterceptor.RESERVATION_ATTR)).isNull();
        interceptor.afterCompletion(reqB, respB, handler, new IllegalArgumentException("bad payload"));
        assertThat(ledger.get(1L).getStatus()).isEqualTo("RESERVED");

        // Request A completes successfully -> row #1 transitions to COMPLETED (1 credit charged!)
        interceptor.afterCompletion(reqA, respA, handler, null);
        assertThat(ledger.get(1L).getStatus()).isEqualTo("COMPLETED");

        // A later replay after COMPLETED does NOT attach RESERVATION_ATTR so it cannot mutate row #1
        MockHttpServletRequest reqC = new MockHttpServletRequest();
        reqC.addHeader("X-Request-Id", "race-key-1");
        assertThat(interceptor.preHandle(reqC, new MockHttpServletResponse(), handler)).isTrue();
        assertThat(reqC.getAttribute(PremiumFeatureGatingInterceptor.RESERVATION_ATTR)).isNull();
    }

    @Test
    @DisplayName("EC-SEC-2026-002: AiVoucherService blocks concurrent RESERVED race (409) and eliminates 3x voucher multiplication on interceptor requests")
    void voucherServiceBlocksInFlightRaceAndThreeTimesMultiplication() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        PlatformTransactionManager txManager = mock(PlatformTransactionManager.class);
        when(txManager.getTransaction(any())).thenReturn(new SimpleTransactionStatus());

        AiVoucherProperties props = new AiVoucherProperties();
        Clock fixedClock = Clock.fixed(Instant.parse("2026-11-21T10:00:00Z"), ZoneOffset.UTC);
        AiVoucherService vouchers = new AiVoucherService(jdbc, txManager, props, fixedClock);

        record UseRow(long id, long userId, long grantId, String featureKey, String requestId, String status, int replays, Instant createdAt) {}
        Map<Long, UseRow> useRows = new LinkedHashMap<>();
        AtomicLong nextUseId = new AtomicLong(10L);
        AtomicInteger grantRemaining = new AtomicInteger(2);

        // Stale release lookup -> empty
        lenient().when(jdbc.queryForList(contains("status = 'RESERVED' AND created_at <"), eq(Long.class), anyLong(), any()))
                .thenReturn(List.of());
        // Existing use lookup
        lenient().when(jdbc.query(contains("SELECT id, status, replays, created_at FROM public.ai_voucher_use"), any(RowMapper.class), anyLong(), anyString(), anyString()))
                .thenAnswer(inv -> {
                    long uid = inv.getArgument(2);
                    String fk = inv.getArgument(3);
                    String reqKey = inv.getArgument(4);
                    return useRows.values().stream()
                            .filter(r -> r.userId == uid && r.featureKey.equals(fk) && r.requestId.equals(reqKey))
                            .map(r -> new Object[]{r.id, r.status, r.replays, r.createdAt})
                            .toList();
                });
        // Grant deduction
        lenient().when(jdbc.queryForList(contains("UPDATE public.ai_voucher_grant SET remaining = remaining - 1"), eq(Long.class), anyLong(), any()))
                .thenAnswer(inv -> grantRemaining.get() > 0 ? List.of(100L + grantRemaining.getAndDecrement()) : List.of());
        // Insert new use
        lenient().when(jdbc.queryForObject(contains("INSERT INTO public.ai_voucher_use"), eq(Long.class), anyLong(), anyLong(), anyString(), anyString(), any()))
                .thenAnswer(inv -> {
                    long id = nextUseId.incrementAndGet();
                    useRows.put(id, new UseRow(id, inv.getArgument(2), inv.getArgument(3), inv.getArgument(4), inv.getArgument(5), "RESERVED", 0, fixedClock.instant()));
                    return id;
                });
        // Consume
        lenient().when(jdbc.update(contains("SET status = 'CONSUMED'"), any(), anyLong()))
                .thenAnswer(inv -> {
                    long id = inv.getArgument(2);
                    UseRow cur = useRows.get(id);
                    if (cur != null && "RESERVED".equals(cur.status)) {
                        useRows.put(id, new UseRow(cur.id, cur.userId, cur.grantId, cur.featureKey, cur.requestId, "CONSUMED", cur.replays, cur.createdAt));
                        return 1;
                    }
                    return 0;
                });

        // 1. First interceptor reservation succeeds and consumes 1 credit
        AiVoucherService.VoucherReservation first = vouchers.reserveForInterceptor(501L, "WRITING_AI_FEEDBACK", "client-dup");
        assertThat(first.useId()).isNotNull();
        assertThat(first.idempotentReplay()).isFalse();
        assertThat(grantRemaining.get()).isEqualTo(1);

        // 2. Concurrent request sharing the same requestId while RESERVED MUST throw 409 Conflict (AI_REQUEST_IN_FLIGHT)
        assertThatThrownBy(() -> vouchers.reserveForInterceptor(501L, "WRITING_AI_FEEDBACK", "client-dup"))
                .isInstanceOf(ResponseStatusException.class)
                .satisfies(ex -> {
                    ResponseStatusException rse = (ResponseStatusException) ex;
                    assertThat(rse.getStatusCode().value()).isEqualTo(409);
                    assertThat(rse.getReason()).isEqualTo("AI_REQUEST_IN_FLIGHT");
                });
        assertThat(grantRemaining.get()).isEqualTo(1);

        // 3. After first is CONSUMED, a second interceptor call with the SAME requestId MUST NOT replay for free;
        //    it must spend the 2nd credit (zero free replays -> no 3x multiplication!)
        vouchers.consume(first.useId());
        AiVoucherService.VoucherReservation second = vouchers.reserveForInterceptor(501L, "WRITING_AI_FEEDBACK", "client-dup");
        assertThat(second.useId()).isNotNull().isNotEqualTo(first.useId());
        assertThat(second.idempotentReplay()).isFalse();
        assertThat(grantRemaining.get()).isEqualTo(0);

        // 4. With 0 credits left, a 3rd call with the SAME requestId is refused (returns useId == null)
        vouchers.consume(second.useId());
        AiVoucherService.VoucherReservation third = vouchers.reserveForInterceptor(501L, "WRITING_AI_FEEDBACK", "client-dup");
        assertThat(third.useId()).isNull();
    }

    @Test
    @DisplayName("EC-SEC-2026-003: PremiumWebMvcConfig matches /api/** and FlashcardMemoryController removes unversioned /api/flashcards alias")
    void webMvcConfigCoversAllApiPathsAndFlashcardMemoryDropsUnversionedAlias() {
        InterceptorRegistry registry = mock(InterceptorRegistry.class);
        InterceptorRegistration registration = mock(InterceptorRegistration.class);
        when(registry.addInterceptor(interceptor)).thenReturn(registration);

        new PremiumWebMvcConfig(interceptor).addInterceptors(registry);
        verify(registration).addPathPatterns("/api/**");

        RequestMapping mapping = FlashcardMemoryController.class.getAnnotation(RequestMapping.class);
        assertThat(mapping).isNotNull();
        assertThat(mapping.value()).containsExactly("/api/v1/flashcards");
        assertThat(mapping.value()).doesNotContain("/api/flashcards");
    }

    @Test
    @DisplayName("PAY-04: SepayWebhookVerifier defaults allowLegacyTimestampLess=false in Spring and caps future skew to 5 minutes")
    void sepayWebhookVerifierRejectsTimestampLessByDefaultAndCapsFutureSkewToFiveMinutes() throws Exception {
        // Verify Spring @Autowired constructor declares @Value("${app.payment.sepay.allow-legacy-timestamp-less:false}")
        Constructor<SepayWebhookVerifier> autowiredCtor =
                SepayWebhookVerifier.class.getDeclaredConstructor(PaymentProperties.class, boolean.class);
        Parameter flagParam = autowiredCtor.getParameters()[1];
        Value valueAnn = flagParam.getAnnotation(Value.class);
        assertThat(valueAnn).isNotNull();
        assertThat(valueAnn.value()).isEqualTo("${app.payment.sepay.allow-legacy-timestamp-less:false}");

        PaymentProperties props = new PaymentProperties();
        props.getSepay().setWebhookSecret("test-secret-key-999");
        props.getSepay().setWebhookFutureSkewMinutes(15); // even if config is 15m, verifier caps at 5m

        SepayWebhookVerifier strictVerifier = new SepayWebhookVerifier(props, false);
        byte[] body = "{\"id\":\"tx-1\"}".getBytes(StandardCharsets.UTF_8);

        // Timestamp-less delivery must be rejected when allowLegacyTimestampLess=false
        String legacySig = hmacHex(new String(body, StandardCharsets.UTF_8), "test-secret-key-999");
        assertThat(strictVerifier.verifySignature(body, "sha256=" + legacySig, null)).isFalse();

        // Future timestamp +10 minutes (milliseconds) must be rejected because skew is capped at 5m
        String futureMs = String.valueOf(Instant.now().plus(Duration.ofMinutes(10)).toEpochMilli());
        String futureSig = hmacHex(futureMs + "." + new String(body, StandardCharsets.UTF_8), "test-secret-key-999");
        assertThat(strictVerifier.verifySignature(body, "sha256=" + futureSig, futureMs)).isFalse();

        // Valid timestamp (+2 minutes, milliseconds) is accepted
        String validMs = String.valueOf(Instant.now().plus(Duration.ofMinutes(2)).toEpochMilli());
        String validSig = hmacHex(validMs + "." + new String(body, StandardCharsets.UTF_8), "test-secret-key-999");
        assertThat(strictVerifier.verifySignature(body, "sha256=" + validSig, validMs)).isTrue();
    }

    @Test
    @DisplayName("PAY-05/06/07: Payment reconciliation trims subAccount, settles deactivated quoted plan, and shares subscription lock key with PromoPremiumService")
    void paymentReconciliationTrimsSubAccountSettlesDeactivatedPlanAndSharesLockKey() {
        PaymentTransactionRepository txRepo = mock(PaymentTransactionRepository.class);
        PaymentOrderRepository orderRepo = mock(PaymentOrderRepository.class);
        PremiumSubscriptionRepository subRepo = mock(PremiumSubscriptionRepository.class);
        PremiumPlanRepository planRepo = mock(PremiumPlanRepository.class);
        UserRepository userRepo = mock(UserRepository.class);
        EntityManager em = mock(EntityManager.class);
        JdbcTemplate jdbc = mock(JdbcTemplate.class);

        PaymentProperties payProps = new PaymentProperties();
        payProps.getBank().setBankCode("MB");
        payProps.getBank().setAccountNumber("0987654321");

        Query lockQuery = mock(Query.class);
        when(em.createNativeQuery(anyString())).thenReturn(lockQuery);
        when(lockQuery.setParameter(anyString(), any())).thenReturn(lockQuery);
        when(lockQuery.getResultList()).thenReturn(List.of());

        User user = new User();
        user.setId(77L);
        PremiumPlan deactivatedPlan = PremiumPlan.builder()
                .id(5L).code("PLAN_LEGACY_1M").name("Legacy 1M").durationMonths(1).priceVnd(59000L).active(false).build();
        PaymentOrder order = PaymentOrder.builder()
                .id(900L).user(user).plan(deactivatedPlan).planCodeSnapshot("PLAN_LEGACY_1M")
                .planNameSnapshot("Legacy 1M").durationMonthsSnapshot(1).amountVnd(59000L)
                .currency("VND").provider("SEPAY").transferCode("ECTRIM1234")
                .status(PaymentOrderStatus.PENDING).expiresAt(Instant.now().plus(Duration.ofMinutes(10))).build();

        when(orderRepo.findByTransferCode("ECTRIM1234")).thenReturn(Optional.of(order));
        when(userRepo.findById(77L)).thenReturn(Optional.of(user));
        when(planRepo.findById(5L)).thenReturn(Optional.of(deactivatedPlan));
        when(subRepo.findFirstByUserIdAndStatusAndExpiresAtAfterOrderByExpiresAtDesc(eq(77L), eq("ACTIVE"), any()))
                .thenReturn(Optional.empty());
        when(subRepo.save(any(PremiumSubscription.class))).thenAnswer(inv -> inv.getArgument(0));

        PremiumSubscriptionService subService = new PremiumSubscriptionService(subRepo, planRepo, userRepo, new PremiumProperties());
        ReflectionTestUtils.setField(subService, "jdbcTemplate", jdbc);

        PaymentReconciliationService reconService = new PaymentReconciliationService(
                txRepo, orderRepo, subService, mock(NotificationService.class), payProps, em
        );

        // Transaction matches via subAccount with surrounding whitespace
        PaymentTransaction tx = PaymentTransaction.builder()
                .provider("SEPAY").providerTransactionId("tx-trim-1").gateway(" MB ")
                .transferType("in").transferAmountVnd(59000L)
                .accountNumber("OTHER").subAccount("  0987654321  ").content("CK ECTRIM1234").build();

        reconService.reconcileTransaction(tx);

        assertThat(tx.getProcessingStatus()).isEqualTo(PaymentTransactionStatus.PROCESSED);
        assertThat(order.getStatus()).isEqualTo(PaymentOrderStatus.PAID);
        verify(subRepo).save(any(PremiumSubscription.class));

        // Non-SEPAY call against inactive plan is still refused
        assertThatThrownBy(() -> subService.extendOrActivateSubscription(77L, 5L, "MANUAL", 1))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Plan is inactive");

        // Namespaced advisory lock key is shared across PaymentReconciliationService, PremiumSubscriptionService, and PromoPremiumService
        ArgumentCaptor<Object> lockKeyCaptor = ArgumentCaptor.forClass(Object.class);
        verify(lockQuery).setParameter(eq("lockKey"), lockKeyCaptor.capture());
        assertThat(lockKeyCaptor.getValue()).isEqualTo(PremiumSubscriptionService.userSubscriptionLockKey(77L));

        PromoPremiumService promo = new PromoPremiumService(jdbc);
        when(jdbc.queryForObject(contains("SELECT count(*) FROM public.premium_subscriptions"), eq(Integer.class), eq(77L), any()))
                .thenReturn(0);
        when(jdbc.queryForList(contains("FROM public.premium_plans"), eq(Long.class), eq("GARDEN_REWARD_7D")))
                .thenReturn(List.of(99L));
        when(jdbc.queryForObject(contains("INSERT INTO public.premium_subscriptions"), eq(Long.class), any(), any(), any(), any(), any()))
                .thenReturn(1234L);

        assertThat(promo.grant(77L, "GARDEN_REWARD_7D", "GARDEN_REWARD", Instant.now(), 168)).isEqualTo(1234L);
        verify(jdbc, atLeast(2)).query(
                eq("SELECT pg_advisory_xact_lock(hashtext(?))"),
                any(RowCallbackHandler.class),
                eq(PremiumSubscriptionService.userSubscriptionLockKey(77L))
        );
    }

    private static String hmacHex(String data, String secret) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] bytes = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }
}
