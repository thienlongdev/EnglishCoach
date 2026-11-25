package com.englishcoach.premium.interceptor;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.premium.exception.PremiumLimitReachedException;
import com.englishcoach.premium.exception.PremiumRequiredException;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumUsageService;
import com.englishcoach.premium.voucher.AiVoucherService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.method.HandlerMethod;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * AI vouchers at the real enforcement point of every gated AI request: the included quota always goes first, a voucher
 * pays only when it is exhausted, and the voucher is spent on success and returned on failure.
 */
@ExtendWith(MockitoExtension.class)
class PremiumVoucherFallbackTest {

    @Mock private PremiumEntitlementService entitlementService;
    @Mock private PremiumUsageService usageService;
    @Mock private AiVoucherService voucherService;
    @Mock private HttpServletRequest request;
    @Mock private HttpServletResponse response;

    private PremiumFeatureGatingInterceptor interceptor;
    private HandlerMethod handler;

    static class SampleController {
        @RequirePremiumAi(value = "WRITING_AI_FEEDBACK", requestIdParam = "clientMutationId")
        public void feedback() {}
    }

    @BeforeEach
    void setUp() throws Exception {
        interceptor = new PremiumFeatureGatingInterceptor(entitlementService, usageService);
        ReflectionTestUtils.setField(interceptor, "voucherService", voucherService);
        handler = new HandlerMethod(new SampleController(), SampleController.class.getMethod("feedback"));
        var user = new UserDetailsImpl(100L, "learner@example.com", "password", java.util.Collections.emptyList());
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(user, null, user.getAuthorities()));
        lenient().when(request.getHeader(anyString())).thenReturn(null);
        lenient().when(request.getParameter("clientMutationId")).thenReturn("mut-1");
        lenient().when(request.getAttribute(PremiumFeatureGatingInterceptor.RESERVATION_ATTR)).thenReturn(null);
    }

    @Test
    void includedQuotaIsUsedFirstAndNoVoucherIsTouched() throws Exception {
        when(entitlementService.isUserPremium(100L)).thenReturn(false);
        // EC-SEC-2026-002: default reuseClientRequestId=false mints a fresh server UUID instead of reusing client "mut-1"
        when(usageService.reserveUsage(eq(100L), eq("WRITING_AI_FEEDBACK"), argThat(id -> id != null && !"mut-1".equals(id)), eq(false)))
                .thenReturn(7L);

        assertThat(interceptor.preHandle(request, response, handler)).isTrue();

        verify(request).setAttribute(PremiumFeatureGatingInterceptor.RESERVATION_ATTR, 7L);
        verifyNoInteractions(voucherService);
    }

    @Test
    void anExhaustedTrialIsPaidByOneVoucherWhichIsSpentOnSuccess() throws Exception {
        when(entitlementService.isUserPremium(100L)).thenReturn(false);
        when(usageService.reserveUsage(eq(100L), eq("WRITING_AI_FEEDBACK"), argThat(id -> id != null && !"mut-1".equals(id)), eq(false)))
                .thenThrow(new PremiumRequiredException("WRITING_AI_FEEDBACK", 0, "/premium"));
        when(voucherService.reserve(eq(100L), eq("WRITING_AI_FEEDBACK"), argThat(id -> id != null && !"mut-1".equals(id))))
                .thenReturn(55L);

        assertThat(interceptor.preHandle(request, response, handler)).isTrue();
        verify(request).setAttribute(PremiumFeatureGatingInterceptor.VOUCHER_USE_ATTR, 55L);
        verify(request, never()).setAttribute(eq(PremiumFeatureGatingInterceptor.RESERVATION_ATTR), any());

        when(request.getAttribute(PremiumFeatureGatingInterceptor.VOUCHER_USE_ATTR)).thenReturn(55L);
        when(response.getStatus()).thenReturn(200);
        interceptor.afterCompletion(request, response, handler, null);

        verify(voucherService).consume(55L);
        verify(voucherService, never()).release(55L);
    }

    @Test
    void aPremiumMonthlyLimitIsAlsoCoveredAndAFailedRequestReturnsTheVoucher() throws Exception {
        when(entitlementService.isUserPremium(100L)).thenReturn(true);
        when(usageService.reserveUsage(eq(100L), eq("WRITING_AI_FEEDBACK"), argThat(id -> id != null && !"mut-1".equals(id)), eq(true)))
                .thenThrow(new PremiumLimitReachedException("WRITING_AI_FEEDBACK", 200, 0));
        when(voucherService.reserve(eq(100L), eq("WRITING_AI_FEEDBACK"), argThat(id -> id != null && !"mut-1".equals(id))))
                .thenReturn(56L);

        assertThat(interceptor.preHandle(request, response, handler)).isTrue();

        when(request.getAttribute(PremiumFeatureGatingInterceptor.VOUCHER_USE_ATTR)).thenReturn(56L);
        when(response.getStatus()).thenReturn(503);
        interceptor.afterCompletion(request, response, handler, null);
        verify(voucherService).release(56L);
        verify(voucherService, never()).consume(56L);

        // an exception with a 200 status line is still a failure
        when(response.getStatus()).thenReturn(200);
        interceptor.afterCompletion(request, response, handler, new RuntimeException("AI provider failed"));
        verify(voucherService, never()).consume(56L);
    }

    @Test
    void withoutAnEligibleVoucherTheOriginalRefusalStands() {
        when(entitlementService.isUserPremium(100L)).thenReturn(false);
        when(usageService.reserveUsage(eq(100L), eq("WRITING_AI_FEEDBACK"), argThat(id -> id != null && !"mut-1".equals(id)), eq(false)))
                .thenThrow(new PremiumRequiredException("WRITING_AI_FEEDBACK", 0, "/premium"));
        when(voucherService.reserve(eq(100L), eq("WRITING_AI_FEEDBACK"), argThat(id -> id != null && !"mut-1".equals(id))))
                .thenReturn(null);

        assertThatThrownBy(() -> interceptor.preHandle(request, response, handler)).isInstanceOf(PremiumRequiredException.class);
        verify(request, never()).setAttribute(eq(PremiumFeatureGatingInterceptor.VOUCHER_USE_ATTR), any());
    }
}
