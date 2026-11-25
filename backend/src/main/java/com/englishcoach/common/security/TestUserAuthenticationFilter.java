package com.englishcoach.common.security;

import com.englishcoach.auth.entity.Role;
import com.englishcoach.auth.entity.User;
import com.englishcoach.auth.repository.UserRepository;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import jakarta.servlet.http.HttpServletRequestWrapper;
import java.io.IOException;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;

/**
 * Filter supporting deterministic test identity for E2E / browser journeys and performance benchmarking
 * without requiring external third-party interactive Google OAuth redirects.
 */
@Component
@RequiredArgsConstructor
public class TestUserAuthenticationFilter extends OncePerRequestFilter {

    private final UserRepository userRepository;

    @org.springframework.beans.factory.annotation.Value("${app.security.test-filter.enabled:false}")
    private boolean testFilterEnabled;

    /** The header identity exists for local journeys only: under a production profile it is never honoured. */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private org.springframework.core.env.Environment environment;

    private boolean productionProfile() {
        if (environment == null) return false;
        for (String profile : environment.getActiveProfiles()) {
            if ("prod".equalsIgnoreCase(profile) || "production".equalsIgnoreCase(profile)) return true;
        }
        return false;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        String testUserEmail = request.getHeader("X-Test-User");
        if (testFilterEnabled && !productionProfile() && testUserEmail != null && !testUserEmail.isBlank()) {
            User user = userRepository.findByEmail(testUserEmail).orElse(null);
            if (user != null) {
                UserDetailsImpl userDetails = UserDetailsImpl.build(user);
                UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(
                        userDetails, null, userDetails.getAuthorities());
                SecurityContextHolder.getContext().setAuthentication(auth);
            }
        }

        String uri = request.getRequestURI();
        String method = request.getMethod();
        boolean isRead = "GET".equalsIgnoreCase(method) || "HEAD".equalsIgnoreCase(method);
        boolean isPublicCatalogOrWebhook = (isRead && (uri.equals("/api/v1/exams/catalog")
                || uri.startsWith("/api/v1/exams/catalog/")
                || uri.equals("/api/v1/exams/capabilities")
                || uri.startsWith("/api/v1/exams/media/")
                || uri.startsWith("/api/v1/exams/forms/")))
                || ("POST".equalsIgnoreCase(method) && uri.equals("/api/v1/payments/webhooks/sepay"));

        // For public catalog and webhook endpoints, if user is not authenticated via test header,
        // suppress Authorization header so an expired or third-party client bearer token
        // does not cause BearerTokenAuthenticationFilter to reject the permitAll request with 401.
        if (isPublicCatalogOrWebhook && SecurityContextHolder.getContext().getAuthentication() == null && request.getHeader("Authorization") != null) {
            HttpServletRequest wrappedRequest = new HttpServletRequestWrapper(request) {
                @Override
                public String getHeader(String name) {
                    if ("Authorization".equalsIgnoreCase(name)) {
                        return null;
                    }
                    return super.getHeader(name);
                }

                @Override
                public Enumeration<String> getHeaders(String name) {
                    if ("Authorization".equalsIgnoreCase(name)) {
                        return Collections.emptyEnumeration();
                    }
                    return super.getHeaders(name);
                }

                @Override
                public Enumeration<String> getHeaderNames() {
                    List<String> names = Collections.list(super.getHeaderNames());
                    names.removeIf(n -> "Authorization".equalsIgnoreCase(n));
                    return Collections.enumeration(names);
                }
            };
            filterChain.doFilter(wrappedRequest, response);
            return;
        }

        filterChain.doFilter(request, response);
    }
}
