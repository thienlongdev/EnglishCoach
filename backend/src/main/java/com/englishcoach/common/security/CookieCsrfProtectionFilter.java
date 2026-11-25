package com.englishcoach.common.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.net.URI;
import java.util.Arrays;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Cross-site request forgery protection for requests authenticated by the session cookie. A browser attaches that
 * cookie by itself, so a state-changing request must also prove it was made by this site's own page:
 * <ol>
 *   <li>Fetch Metadata: {@code Sec-Fetch-Site}, when the browser sends it, must say the request is same-origin;</li>
 *   <li>source origin: {@code Origin} (or, without it, {@code Referer}) must be one of the configured origins, and
 *       at least one of the two must be present;</li>
 *   <li>the session's CSRF token ({@link CsrfTokenService}) in the {@code X-CSRF-Token} header.</li>
 * </ol>
 * All three must hold. Requests authenticated by an {@code Authorization} header, anonymous requests (provider
 * webhooks authenticate by signature) and safe methods are not affected. {@code SameSite=Strict} on the cookie is a
 * further layer, not the protection.
 */
@Slf4j
public class CookieCsrfProtectionFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-CSRF-Token";
    private static final Set<String> SAFE_METHODS = Set.of("GET", "HEAD", "OPTIONS", "TRACE");

    private final CsrfTokenService csrfTokenService;
    private final Set<String> allowedOrigins;
    private final boolean production;

    public CookieCsrfProtectionFilter(CsrfTokenService csrfTokenService, String allowedOriginsConfig,
                                      boolean production) {
        this.csrfTokenService = csrfTokenService;
        this.allowedOrigins = Arrays.stream(allowedOriginsConfig.split(","))
                .map(String::trim)
                .filter(s -> !s.isEmpty() && !"*".equals(s))
                .map(CookieCsrfProtectionFilter::normalizeOrigin)
                .filter(s -> s != null)
                .collect(Collectors.toUnmodifiableSet());
        this.production = production;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (Boolean.TRUE.equals(request.getAttribute(SessionCookies.COOKIE_AUTHENTICATED))
                && !SAFE_METHODS.contains(request.getMethod().toUpperCase(Locale.ROOT))) {
            String refusal = refusalReason(request);
            if (refusal != null) {
                log.warn("[Security:CSRF] Refused {} {} ({})", request.getMethod(), request.getRequestURI(), refusal);
                SecuritySignals.signal("CSRF_REJECTED", refusal);
                response.setStatus(HttpServletResponse.SC_FORBIDDEN);
                response.setContentType(MediaType.APPLICATION_JSON_VALUE);
                response.setHeader("Cache-Control", "no-store");
                response.getWriter().write(
                        "{\"code\":\"CSRF_REJECTED\",\"message\":\"The request could not be verified. Reload the page and try again.\"}");
                return;
            }
        }
        chain.doFilter(request, response);
    }

    /** Null when the request passes; otherwise a short reason for the log (never shown to the caller). */
    String refusalReason(HttpServletRequest request) {
        String fetchSite = request.getHeader("Sec-Fetch-Site");
        if (fetchSite != null) {
            String site = fetchSite.trim().toLowerCase(Locale.ROOT);
            // Local development serves the page and the API from two ports of one host, which a browser calls
            // same-site; production serves both from one origin.
            boolean accepted = "same-origin".equals(site) || (!production && "same-site".equals(site));
            if (!accepted) return "fetch-site";
        }

        String origin = request.getHeader("Origin");
        String source = origin != null ? normalizeOrigin(origin) : originOfReferer(request.getHeader("Referer"));
        if (origin == null && request.getHeader("Referer") == null) return "no-source-origin";
        if (source == null || !allowedOrigins.contains(source)) return "source-origin";

        AuthSessionContext session = AuthSessionContext.current();
        if (session == null || session.sessionId() == null) return "no-session";
        if (!csrfTokenService.matches(session.sessionId(), request.getHeader(HEADER))) return "token";
        return null;
    }

    private static String originOfReferer(String referer) {
        return referer == null ? null : normalizeOrigin(referer);
    }

    /** scheme://host[:port] in lower case without a default port, or null when the text is not an http(s) URL. */
    static String normalizeOrigin(String value) {
        try {
            URI uri = URI.create(value.trim());
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || host == null) return null;
            scheme = scheme.toLowerCase(Locale.ROOT);
            if (!"https".equals(scheme) && !"http".equals(scheme)) return null;
            int port = uri.getPort();
            boolean defaultPort = port == -1 || ("https".equals(scheme) && port == 443)
                    || ("http".equals(scheme) && port == 80);
            return scheme + "://" + host.toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + port);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
