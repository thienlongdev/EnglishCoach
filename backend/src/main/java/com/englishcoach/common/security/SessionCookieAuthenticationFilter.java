package com.englishcoach.common.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * Authenticates a browser by its session cookie ({@link SessionCookies#ACCESS}). The cookie carries the same
 * application token an {@code Authorization} header would, and goes through the same decoder and the same
 * per-request session read; only the transport differs, so a page script never holds the token.
 *
 * An {@code Authorization} header, when present, wins and the cookie is ignored (the header path needs no CSRF
 * token: another site cannot set that header). A cookie that no longer authenticates (expired, revoked session,
 * disabled account) is dropped and the request goes on anonymous: a public endpoint still answers, a protected one
 * answers 401.
 */
@Slf4j
public class SessionCookieAuthenticationFilter extends OncePerRequestFilter {

    private final JwtDecoder jwtDecoder;
    private final CustomJwtAuthenticationConverter converter;
    private final AuthSecurityProperties properties;

    public SessionCookieAuthenticationFilter(JwtDecoder jwtDecoder, CustomJwtAuthenticationConverter converter,
                                             AuthSecurityProperties properties) {
        this.jwtDecoder = jwtDecoder;
        this.converter = converter;
        this.properties = properties;
    }

    /**
     * The account endpoints that never act on the caller's session (register, verify, reset, sign-in, refresh by
     * grant, sign-out by grant): the session cookie is not consulted for them, so a stale cookie cannot disturb
     * them and they need no CSRF token. The three that DO act on the session are authenticated as usual.
     */
    static boolean identityLessAuthEndpoint(String uri) {
        if (uri == null) return false;
        String rest = uri.startsWith("/api/v1/auth/") ? uri.substring("/api/v1/auth/".length())
                : uri.startsWith("/api/auth/") ? uri.substring("/api/auth/".length()) : null;
        if (rest == null) return false;
        return !(rest.equals("me") || rest.equals("csrf") || rest.equals("change-password"));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (SecurityContextHolder.getContext().getAuthentication() == null
                && request.getHeader("Authorization") == null
                && !identityLessAuthEndpoint(request.getRequestURI())) {
            boolean production = properties.isProduction();
            String token = SessionCookies.accessToken(request, production);
            if (token != null) {
                try {
                    Jwt jwt = jwtDecoder.decode(token);
                    AbstractAuthenticationToken authentication = converter.convert(jwt);
                    if (authentication != null) {
                        SecurityContext context = SecurityContextHolder.createEmptyContext();
                        context.setAuthentication(authentication);
                        SecurityContextHolder.setContext(context);
                        request.setAttribute(SessionCookies.COOKIE_AUTHENTICATED, Boolean.TRUE);
                    }
                } catch (JwtException | AuthenticationException e) {
                    // Never the token, never the address: only why the cookie was dropped.
                    log.debug("[Auth:Cookie] Session cookie no longer valid: {}", e.getClass().getSimpleName());
                    SessionCookies.expire(response, production);
                }
            }
        }
        chain.doFilter(request, response);
    }
}
