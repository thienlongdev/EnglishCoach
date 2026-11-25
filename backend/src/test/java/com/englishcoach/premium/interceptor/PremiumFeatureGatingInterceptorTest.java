package com.englishcoach.premium.interceptor;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.premium.exception.PremiumRequiredException;
import com.englishcoach.premium.service.PremiumEntitlementService;
import com.englishcoach.premium.service.PremiumUsageService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.method.HandlerMethod;

import java.lang.reflect.Method;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class PremiumFeatureGatingInterceptorTest {

    @Mock
    private PremiumEntitlementService entitlementService;

    @Mock
    private PremiumUsageService usageService;

    @Mock
    private HttpServletRequest request;

    @Mock
    private HttpServletResponse response;

    @InjectMocks
    private PremiumFeatureGatingInterceptor interceptor;

    private UserDetailsImpl userDetails;

    static class SampleController {
        @RequirePremiumAi("SPEAKING_ROLEPLAY")
        public void premiumMethod() {}

        public void unannotatedMethod() {}
    }

    @BeforeEach
    void setUp() {
        userDetails = new UserDetailsImpl(
                100L,
                "learner@example.com",
                "password",
                java.util.Collections.emptyList()
        );
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(userDetails, null, userDetails.getAuthorities())
        );
    }

    @Test
    @DisplayName("Interceptor allows request when trial is available and commits reservation on success")
    void testPreHandleAllowsWhenTrialAvailable() throws Exception {
        Method method = SampleController.class.getMethod("premiumMethod");
        HandlerMethod handlerMethod = new HandlerMethod(new SampleController(), method);

        lenient().when(request.getHeader(anyString())).thenReturn(null);
        lenient().when(request.getHeader("X-Request-Id")).thenReturn("req-123");
        when(entitlementService.isUserPremium(100L)).thenReturn(false);
        // EC-SEC-2026-002: @RequirePremiumAi defaults reuseClientRequestId=false, minting a fresh server UUID per request
        when(usageService.reserveUsage(eq(100L), eq("SPEAKING_ROLEPLAY"), argThat(id -> id != null && !"req-123".equals(id)), eq(false)))
                .thenReturn(555L);

        boolean allowed = interceptor.preHandle(request, response, handlerMethod);
        assertThat(allowed).isTrue();
        verify(request).setAttribute(eq(PremiumFeatureGatingInterceptor.RESERVATION_ATTR), eq(555L));

        // After completion with 200 OK
        when(request.getAttribute(PremiumFeatureGatingInterceptor.RESERVATION_ATTR)).thenReturn(555L);
        when(response.getStatus()).thenReturn(200);

        interceptor.afterCompletion(request, response, handlerMethod, null);
        verify(usageService).commitReservation(555L);
        verify(usageService, never()).releaseReservation(555L);
    }

    @Test
    @DisplayName("Interceptor releases reservation when controller throws exception")
    void testAfterCompletionReleasesOnException() throws Exception {
        Method method = SampleController.class.getMethod("premiumMethod");
        HandlerMethod handlerMethod = new HandlerMethod(new SampleController(), method);

        when(request.getAttribute(PremiumFeatureGatingInterceptor.RESERVATION_ATTR)).thenReturn(555L);
        when(response.getStatus()).thenReturn(500);

        interceptor.afterCompletion(request, response, handlerMethod, new RuntimeException("AI provider failed"));
        verify(usageService).releaseReservation(555L);
        verify(usageService, never()).commitReservation(555L);
    }

    @Test
    @DisplayName("Interceptor throws PremiumRequiredException when trial exhausted")
    void testPreHandleBlocksWhenTrialExhausted() throws Exception {
        Method method = SampleController.class.getMethod("premiumMethod");
        HandlerMethod handlerMethod = new HandlerMethod(new SampleController(), method);

        lenient().when(request.getHeader(anyString())).thenReturn(null);
        lenient().when(request.getHeader("X-Request-Id")).thenReturn("req-999");
        when(entitlementService.isUserPremium(100L)).thenReturn(false);
        // EC-SEC-2026-002: default reuseClientRequestId=false ignores client X-Request-Id
        when(usageService.reserveUsage(eq(100L), eq("SPEAKING_ROLEPLAY"), argThat(id -> id != null && !"req-999".equals(id)), eq(false)))
                .thenThrow(new PremiumRequiredException("SPEAKING_ROLEPLAY", 0, "/premium"));

        assertThatThrownBy(() -> interceptor.preHandle(request, response, handlerMethod))
                .isInstanceOf(PremiumRequiredException.class);
    }

    @Test
    @DisplayName("Unannotated method bypasses interceptor with no check")
    void testUnannotatedMethodBypasses() throws Exception {
        Method method = SampleController.class.getMethod("unannotatedMethod");
        HandlerMethod handlerMethod = new HandlerMethod(new SampleController(), method);

        boolean allowed = interceptor.preHandle(request, response, handlerMethod);
        assertThat(allowed).isTrue();
        verifyNoInteractions(usageService);
    }
}
