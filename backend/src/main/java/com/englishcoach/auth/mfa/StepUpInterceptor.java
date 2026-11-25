package com.englishcoach.auth.mfa;

import com.englishcoach.common.security.AuthSecurityProperties;
import com.englishcoach.common.security.AuthSessionContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.http.MediaType;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.time.Duration;
import java.time.Instant;

/**
 * Enforces {@link RequireStepUp}. The handler was already reached through the administrator rules, so the session
 * is second-factor verified whenever a factor is enrolled; this adds freshness. While no factor is enrolled (the
 * enrolment phase, {@code admin-mfa-required=false}) there is nothing to step up with and the action proceeds;
 * once a factor exists it is always demanded.
 */
@Configuration
@RequiredArgsConstructor
@Slf4j
public class StepUpInterceptor implements HandlerInterceptor, WebMvcConfigurer {

    private final AdminMfaGate gate;
    private final AuthSecurityProperties properties;

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(this).addPathPatterns("/api/**");
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler)
            throws Exception {
        if (!(handler instanceof HandlerMethod method)) return true;
        boolean required = AnnotatedElementUtils.hasAnnotation(method.getMethod(), RequireStepUp.class)
                || AnnotatedElementUtils.hasAnnotation(method.getBeanType(), RequireStepUp.class);
        if (!required) return true;

        AuthSessionContext session = AuthSessionContext.current();
        if (session == null || session.userId() == null) {
            // No session facts: only a local test identity gets here; production tokens always name a session.
            if (!properties.isProduction()) return true;
            return refuse(request, response);
        }
        if (!gate.enrolled(session.userId())) return true;
        Instant freshSince = Instant.now().minus(Duration.ofMinutes(properties.getAdminStepUpMinutes()));
        if (session.stepUpAt() != null && session.stepUpAt().isAfter(freshSince)) return true;
        return refuse(request, response);
    }

    private boolean refuse(HttpServletRequest request, HttpServletResponse response) throws Exception {
        log.info("[MFA] Step-up required for {} {}", request.getMethod(), request.getRequestURI());
        response.setStatus(HttpServletResponse.SC_FORBIDDEN);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setHeader("Cache-Control", "no-store");
        response.getWriter().write(
                "{\"code\":\"STEP_UP_REQUIRED\",\"message\":\"Confirm your second factor to continue.\"}");
        return false;
    }
}
