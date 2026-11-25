package com.englishcoach.premium.interceptor;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.premium.exception.PremiumRequiredException;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumUsageService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.method.HandlerMethod;

import java.util.Collections;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Capacity release 2026-10: AI requests in progress are bounded, refused ones cost nothing, permits never leak. */
class AiRequestBulkheadTest {

    static class SampleController {
        @RequirePremiumAi("SPEAKING_ROLEPLAY")
        public void ai() {}
    }

    private final PremiumEntitlementService entitlement = mock(PremiumEntitlementService.class);
    private final PremiumUsageService usage = mock(PremiumUsageService.class);
    private final AiRequestBulkhead bulkhead = new AiRequestBulkhead(2, 0);
    private PremiumFeatureGatingInterceptor interceptor;
    private HandlerMethod handler;

    @BeforeEach
    void setUp() throws Exception {
        interceptor = new PremiumFeatureGatingInterceptor(entitlement, usage);
        ReflectionTestUtils.setField(interceptor, "aiBulkhead", bulkhead);
        handler = new HandlerMethod(new SampleController(), SampleController.class.getMethod("ai"));
        UserDetailsImpl user = new UserDetailsImpl(7L, "learner@example.test", "x", Collections.emptyList());
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(user, null, user.getAuthorities()));
        when(usage.reserveUsage(anyLong(), anyString(), any(), anyBoolean())).thenReturn(1L, 2L, 3L, 4L);
    }

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void refusesBeyondTheBoundWithoutReservingAndRecoversAfterCompletion() throws Exception {
        MockHttpServletRequest a = new MockHttpServletRequest();
        MockHttpServletRequest b = new MockHttpServletRequest();
        assertThat(interceptor.preHandle(a, new MockHttpServletResponse(), handler)).isTrue();
        assertThat(interceptor.preHandle(b, new MockHttpServletResponse(), handler)).isTrue();
        assertThat(bulkhead.inUse()).isEqualTo(2);

        MockHttpServletRequest third = new MockHttpServletRequest();
        MockHttpServletResponse busy = new MockHttpServletResponse();
        assertThat(interceptor.preHandle(third, busy, handler)).isFalse();
        assertThat(busy.getStatus()).isEqualTo(503);
        assertThat(busy.getHeader("Retry-After")).isEqualTo("10");
        assertThat(busy.getContentAsString()).contains("\"code\":\"AI_BUSY\"");
        verify(usage, org.mockito.Mockito.times(2)).reserveUsage(anyLong(), anyString(), any(), anyBoolean());

        MockHttpServletResponse ok = new MockHttpServletResponse();
        interceptor.afterCompletion(a, ok, handler, null);
        assertThat(bulkhead.inUse()).isEqualTo(1);
        interceptor.afterCompletion(a, ok, handler, null); // a second completion of the same request releases nothing
        assertThat(bulkhead.inUse()).isEqualTo(1);
        assertThat(interceptor.preHandle(new MockHttpServletRequest(), new MockHttpServletResponse(), handler)).isTrue();
    }

    @Test
    void anAsynchronousRedispatchKeepsItsOnePermit() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest();
        assertThat(interceptor.preHandle(request, new MockHttpServletResponse(), handler)).isTrue();
        assertThat(interceptor.preHandle(request, new MockHttpServletResponse(), handler)).isTrue();
        assertThat(bulkhead.inUse()).isEqualTo(1);
        interceptor.afterCompletion(request, new MockHttpServletResponse(), handler, null);
        assertThat(bulkhead.inUse()).isZero();
    }

    @Test
    void aQuotaRefusalGivesThePermitBack() throws Exception {
        when(usage.reserveUsage(anyLong(), anyString(), any(), anyBoolean()))
                .thenThrow(new PremiumRequiredException("SPEAKING_ROLEPLAY"));
        assertThatThrownBy(() -> interceptor.preHandle(new MockHttpServletRequest(), new MockHttpServletResponse(), handler))
                .isInstanceOf(PremiumRequiredException.class);
        assertThat(bulkhead.inUse()).isZero();
        verify(usage, never()).commitReservation(anyLong());
    }
}
