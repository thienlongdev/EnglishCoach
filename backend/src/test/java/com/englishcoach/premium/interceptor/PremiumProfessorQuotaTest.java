package com.englishcoach.premium.interceptor;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.grammar.*;
import com.englishcoach.premium.config.PremiumProperties;
import com.englishcoach.premium.entity.PremiumAiUsage;
import com.englishcoach.premium.entity.PremiumFeatureDefinition;
import com.englishcoach.premium.exception.PremiumExceptionHandler;
import com.englishcoach.premium.repository.PremiumAiUsageRepository;
import com.englishcoach.premium.repository.PremiumFeatureDefinitionRepository;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumUsageService;
import com.englishcoach.premium.voucher.AiVoucherService;
import com.englishcoach.reading.service.ContextTranslationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.method.annotation.AuthenticationPrincipalArgumentResolver;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.method.HandlerMethod;

import java.time.Instant;
import java.util.*;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Non-replaying-handler policy regression. Production Professor now uses durable receipts, tested separately on PostgreSQL. */
class PremiumProfessorQuotaTest {
    private static final String FEATURE = "GRAMMAR_PROFESSOR";
    private static final String ANSWER = "{\"answer\":\"Test explanation\",\"examples\":[],\"confidence\":\"LOW\"}";
    private final ObjectMapper mapper = new ObjectMapper();
    private final PremiumAiUsageRepository repository = mock(PremiumAiUsageRepository.class);
    private final PremiumFeatureDefinitionRepository features = mock(PremiumFeatureDefinitionRepository.class);
    private final PremiumEntitlementService entitlement = mock(PremiumEntitlementService.class);
    private final ContextTranslationService transport = mock(ContextTranslationService.class);
    private final Map<Long, PremiumAiUsage> ledger = new LinkedHashMap<>();
    private PremiumUsageService usage;
    private PremiumFeatureGatingInterceptor interceptor;
    private MockMvc mvc;

    static class ReplayController {
        // Explicit opt-in required since EC-SEC-2026-002 changed reuseClientRequestId default to false
        @RequirePremiumAi(value = "SPEAKING_ROLEPLAY", requestIdParam = "clientMutationId", reuseClientRequestId = true)
        public void invoke() {}
    }

    @RequirePremiumAi(value = FEATURE, requestIdParam = "clientMutationId", reuseClientRequestId = false)
    static class FreshController {
        public void invoke() {}
    }

    @org.springframework.web.bind.annotation.RestController
    static class NonReplayingProfessorController {
        private final GrammarProfessorService professor;
        NonReplayingProfessorController(GrammarProfessorService professor) { this.professor = professor; }
        @RequirePremiumAi(value = FEATURE, reuseClientRequestId = false)
        @org.springframework.web.bind.annotation.PostMapping("/api/v1/grammar/professor/ask")
        public GrammarDtos.ProfessorAnswer ask(@org.springframework.web.bind.annotation.RequestBody GrammarDtos.ProfessorRequest request) {
            try { return professor.ask(request); }
            catch (GrammarException unavailable) {
                // This generic policy fixture is outside the production Grammar advice's package scope.
                throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.SERVICE_UNAVAILABLE);
            }
        }
    }

    @BeforeEach
    void setUp() throws Exception {
        signIn(100L);
        usage = new PremiumUsageService(repository, features, new PremiumProperties());
        interceptor = new PremiumFeatureGatingInterceptor(entitlement, usage);
        when(features.findByFeatureKey(anyString())).thenAnswer(call -> Optional.of(PremiumFeatureDefinition.builder()
                .featureKey(call.getArgument(0)).premiumRequired(true).premiumMonthlyLimit(2).enabled(true).build()));
        when(repository.findByUserIdAndFeatureKeyAndRequestId(anyLong(), anyString(), anyString())).thenAnswer(call ->
                ledger.values().stream().filter(row -> row.getUserId().equals(call.getArgument(0))
                        && row.getFeatureKey().equals(call.getArgument(1)) && row.getRequestId().equals(call.getArgument(2)))
                        .findFirst());
        when(repository.findById(anyLong())).thenAnswer(call -> Optional.ofNullable(ledger.get(call.getArgument(0))));
        when(repository.save(any(PremiumAiUsage.class))).thenAnswer(call -> {
            PremiumAiUsage row = call.getArgument(0);
            if (row.getId() == null) {
                row.setId((long) ledger.size() + 1);
                row.setCreatedAt(Instant.now());
            }
            ledger.put(row.getId(), row);
            return row;
        });
        when(repository.countTrialPerFeatureSince(anyLong(), anyCollection(), any(Instant.class))).thenAnswer(call -> {
            Collection<String> statuses = call.getArgument(1);
            Instant since = call.getArgument(2);
            return ledger.values().stream().filter(row -> row.getUserId().equals(call.getArgument(0))
                            && row.getUsageKind().equals("TRIAL") && statuses.contains(row.getStatus())
                            && !row.getCreatedAt().isBefore(since))
                    .collect(Collectors.groupingBy(PremiumAiUsage::getFeatureKey, Collectors.counting()))
                    .entrySet().stream().map(entry -> new Object[]{entry.getKey(), entry.getValue()}).toList();
        });
        when(repository.countByUserIdAndFeatureKeyAndUsageKindAndBillingCycleMonthAndStatusIn(
                anyLong(), anyString(), anyString(), anyString(), anyCollection())).thenAnswer(call -> {
            Collection<String> statuses = call.getArgument(4);
            return (int) ledger.values().stream().filter(row -> row.getUserId().equals(call.getArgument(0))
                    && row.getFeatureKey().equals(call.getArgument(1)) && row.getUsageKind().equals(call.getArgument(2))
                    && row.getBillingCycleMonth().equals(call.getArgument(3)) && statuses.contains(row.getStatus())).count();
        });
        GrammarContent content = mock(GrammarContent.class);
        when(content.load("topic")).thenReturn(new GrammarContent.Loaded(mapper.readTree("""
                {"title":{"vi":"Test lesson"},"editorial":{"status":"drafted"},"quick":{"what":"Test rule"}}
                """), Map.of(), "{}", "test"));
        when(transport.completeJson(anyString(), anyString(), eq(900))).thenReturn(ANSWER);
        GrammarProfessorService professor = new GrammarProfessorService(content, transport, mapper);
        mvc = MockMvcBuilders.standaloneSetup(new NonReplayingProfessorController(professor))
                .addInterceptors(interceptor)
                .setCustomArgumentResolvers(new AuthenticationPrincipalArgumentResolver())
                .setControllerAdvice(new GrammarExceptionHandler(), new PremiumExceptionHandler()).build();
    }

    @AfterEach
    void clear() { SecurityContextHolder.clearContext(); }

    @ParameterizedTest
    @ValueSource(strings = {"X-Request-Id", "X-Client-Turn-Id", "X-Client-Attempt-Id", "Idempotency-Key"})
    void repeatedClientIdChargesIdenticalAndChangedProfessorExecutionsThenBlocksBeforeProvider(String header) throws Exception {
        ask(header, "Same question").andExpect(status().isOk());
        ask(header, "Same question").andExpect(status().isOk());
        ask(header, "Different question").andExpect(status().isOk());

        assertThat(ledger).hasSize(3);
        assertThat(ledger.values()).allSatisfy(row -> {
            assertThat(row.getUserId()).isEqualTo(100L);
            assertThat(row.getFeatureKey()).isEqualTo(FEATURE);
            assertThat(row.getStatus()).isEqualTo("COMPLETED");
            assertThat(row.getRequestId()).isNotEqualTo("K");
            assertThat(UUID.fromString(row.getRequestId()).toString()).isEqualTo(row.getRequestId());
        });
        assertThat(ledger.values()).extracting(PremiumAiUsage::getRequestId).doesNotHaveDuplicates();
        assertThat(usage.dailyAllowances(100L).get(PremiumUsageService.Pool.AI).used()).isEqualTo(3);

        ask(header, "Another question").andExpect(status().isForbidden())
                .andExpect(jsonPath("$.errorCode").value("PREMIUM_REQUIRED"));
        assertThat(ledger).hasSize(3);
        ArgumentCaptor<String> bodies = ArgumentCaptor.forClass(String.class);
        verify(transport, times(3)).completeJson(anyString(), bodies.capture(), eq(900));
        assertThat(mapper.readTree(bodies.getAllValues().get(0)).path("question").asText()).isEqualTo("Same question");
        assertThat(mapper.readTree(bodies.getAllValues().get(2)).path("question").asText()).isEqualTo("Different question");
    }

    @Test
    void repeatedIdAlsoConsumesPremiumMonthlyQuota() throws Exception {
        when(entitlement.isUserPremium(100L)).thenReturn(true);
        ask("X-Request-Id", "First question").andExpect(status().isOk());
        ask("X-Request-Id", "Changed question").andExpect(status().isOk());
        ask("X-Request-Id", "Over limit").andExpect(status().isForbidden())
                .andExpect(jsonPath("$.errorCode").value("PREMIUM_LIMIT_REACHED"));
        assertThat(ledger).hasSize(2);
        assertThat(ledger.values()).allSatisfy(row -> {
            assertThat(row.getUsageKind()).isEqualTo("PREMIUM");
            assertThat(row.getStatus()).isEqualTo("COMPLETED");
        });
        verify(transport, times(2)).completeJson(anyString(), anyString(), eq(900));
    }

    @Test
    void reservationsAndLimitsRemainScopedToTheAuthenticatedOwner() throws Exception {
        for (int i = 0; i < 3; i++) ask("X-Request-Id", "Owner A").andExpect(status().isOk());
        signIn(200L);
        ask("X-Request-Id", "Owner B").andExpect(status().isOk());
        assertThat(usage.dailyAllowances(100L).get(PremiumUsageService.Pool.AI).used()).isEqualTo(3);
        assertThat(usage.dailyAllowances(200L).get(PremiumUsageService.Pool.AI).used()).isEqualTo(1);
        assertThat(ledger.get(4L).getUserId()).isEqualTo(200L);
        verify(transport, times(4)).completeJson(anyString(), anyString(), eq(900));
    }

    @Test
    void providerFailureReleasesOnlyItsReservationAndRetryGetsANewOne() throws Exception {
        when(transport.completeJson(anyString(), anyString(), eq(900))).thenThrow(new IllegalStateException("test failure"))
                .thenReturn(ANSWER);
        ask("X-Request-Id", "Question").andExpect(status().isServiceUnavailable());
        assertThat(ledger.get(1L).getStatus()).isEqualTo("RELEASED");
        ask("X-Request-Id", "Question").andExpect(status().isOk());
        assertThat(ledger).hasSize(2);
        assertThat(ledger.get(2L).getStatus()).isEqualTo("COMPLETED");
        assertThat(ledger.get(2L).getRequestId()).isNotEqualTo(ledger.get(1L).getRequestId());
        assertThat(usage.dailyAllowances(100L).get(PremiumUsageService.Pool.AI).used()).isEqualTo(1);
    }

    @ParameterizedTest
    @ValueSource(strings = {"clientMutationId", "X-Request-Id", "X-Client-Turn-Id", "X-Client-Attempt-Id", "Idempotency-Key"})
    void explicitOptInHandlersRejectInFlightConflictAndReuseOnlySettledClientReceipts(String source) throws Exception {
        HandlerMethod handler = new HandlerMethod(new ReplayController(), ReplayController.class.getMethod("invoke"));
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockHttpServletRequest first = clientId(source);
        MockHttpServletRequest concurrent = clientId(source);
        assertThat(interceptor.preHandle(first, response, handler)).isTrue();
        // EC-SEC-2026-002: concurrent request reusing an in-flight RESERVED request ID gets 409 Conflict (never shares RESERVATION_ATTR)
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> interceptor.preHandle(concurrent, response, handler))
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
                .satisfies(ex -> assertThat(((org.springframework.web.server.ResponseStatusException) ex).getStatusCode().value()).isEqualTo(409));
        assertThat(concurrent.getAttribute(PremiumFeatureGatingInterceptor.RESERVATION_ATTR)).isNull();
        interceptor.afterCompletion(first, response, handler, null);
        // After settlement (COMPLETED), an explicit opt-in replay succeeds WITHOUT attaching RESERVATION_ATTR
        MockHttpServletRequest settledReplay = clientId(source);
        assertThat(interceptor.preHandle(settledReplay, response, handler)).isTrue();
        assertThat(settledReplay.getAttribute(PremiumFeatureGatingInterceptor.RESERVATION_ATTR)).isNull();
        assertThat(ledger).hasSize(1);
        assertThat(ledger.get(1L).getRequestId()).isEqualTo("K");
        assertThat(ledger.get(1L).getStatus()).isEqualTo("COMPLETED");
        verifyNoInteractions(transport);
    }

    @Test
    void optOutIgnoresConfiguredParameterAndAllHeadersIncludingForVoucherFallback() throws Exception {
        HandlerMethod handler = new HandlerMethod(new FreshController(), FreshController.class.getMethod("invoke"));
        AiVoucherService vouchers = mock(AiVoucherService.class);
        ReflectionTestUtils.setField(interceptor, "voucherService", vouchers);
        // Fill the normal allowance, then verify that fallback receives fresh IDs too (no eligibility change).
        for (int i = 0; i < 3; i++) ask("X-Request-Id", "Question").andExpect(status().isOk());
        when(vouchers.reserve(eq(100L), eq(FEATURE), anyString())).thenReturn(11L, 12L);
        MockHttpServletRequest first = allClientIds();
        MockHttpServletRequest second = allClientIds();
        MockHttpServletResponse response = new MockHttpServletResponse();
        assertThat(interceptor.preHandle(first, response, handler)).isTrue();
        interceptor.afterCompletion(first, response, handler, null);
        assertThat(interceptor.preHandle(second, response, handler)).isTrue();
        interceptor.afterCompletion(second, response, handler, null);
        ArgumentCaptor<String> ids = ArgumentCaptor.forClass(String.class);
        verify(vouchers, times(2)).reserve(eq(100L), eq(FEATURE), ids.capture());
        assertThat(ids.getAllValues()).doesNotHaveDuplicates().doesNotContain("K");
        ids.getAllValues().forEach(id -> assertThat(UUID.fromString(id).toString()).isEqualTo(id));
        verify(vouchers).consume(11L);
        verify(vouchers).consume(12L);
        assertThat(first.getAttribute(PremiumFeatureGatingInterceptor.RESERVATION_ATTR)).isNull();
        assertThat(second.getAttribute(PremiumFeatureGatingInterceptor.RESERVATION_ATTR)).isNull();
        assertThat(ledger).hasSize(3);
    }

    private ResultActions ask(String header, String question) throws Exception {
        return mvc.perform(post("/api/v1/grammar/professor/ask").header(header, "K").contentType("application/json")
                .content(mapper.writeValueAsString(new GrammarDtos.ProfessorRequest("topic", question, "Test sentence."))));
    }

    private static MockHttpServletRequest clientId(String source) {
        MockHttpServletRequest request = new MockHttpServletRequest();
        if (source.equals("clientMutationId")) request.setParameter(source, "K");
        else request.addHeader(source, "K");
        return request;
    }

    private static MockHttpServletRequest allClientIds() {
        MockHttpServletRequest request = clientId("clientMutationId");
        for (String header : List.of("X-Request-Id", "X-Client-Turn-Id", "X-Client-Attempt-Id", "Idempotency-Key")) {
            request.addHeader(header, "K");
        }
        return request;
    }

    private static void signIn(long id) {
        UserDetailsImpl user = new UserDetailsImpl(id, "learner@example.test", "unused", List.of());
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(user, null, List.of()));
    }
}
