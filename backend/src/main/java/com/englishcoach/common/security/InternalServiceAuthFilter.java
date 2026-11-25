package com.englishcoach.common.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The endpoints that hand out an application token or a session grant are called by the frontend's server code
 * (NextAuth, {@code /api/auth/refresh}), never by a page script. Being on the container network is transport, not
 * identity: each such call carries
 * <pre>X-EC-Internal: v2.&lt;epoch seconds&gt;.&lt;nonce, 32 hex&gt;.&lt;hex HMAC-SHA256&gt;</pre>
 * over {@code "v2\n<epoch>\n<nonce>\nPOST\n<path>\n<hex SHA-256 of the exact body bytes>"} under the dedicated key
 * {@code APP_SECURITY_INTERNAL_SERVICE_KEY} (the frontend holds this key and nothing else of the backend's secrets).
 * A signature is valid for two minutes, binds the body (a captured header cannot carry another password or grant)
 * and is single-use (its nonce is remembered until the signature has expired anyway).
 *
 * In production every call to these paths must be signed, from the first second: there is no unsigned window and
 * no setting that opens one. Outside production a missing signature is tolerated until
 * {@code app.security.internal-auth-enforce-after} (blank = never; local development and tests).
 *
 * The nonce memory is per process: this application runs as exactly one backend instance (10-rules §Q).
 */
@Slf4j
public class InternalServiceAuthFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-EC-Internal";
    static final long MAX_SKEW_SECONDS = 120;
    /** Bodies of the token-issuing calls are a few hundred bytes; anything far larger is not ours. */
    static final int MAX_BODY_BYTES = 16 * 1024;
    static final int MAX_REMEMBERED_NONCES = 50_000;

    private static final Set<String> TOKEN_ISSUING_PATHS = Set.of(
            "/auth/login", "/auth/refresh", "/auth/session/refresh", "/auth/session/exchange",
            "/auth/google/exchange", "/auth/google/link");

    private final byte[] key;
    private final boolean alwaysEnforced;
    private final Instant enforceAfter;
    private final Clock clock;
    private final Map<String, Long> usedNonces = new ConcurrentHashMap<>();

    public InternalServiceAuthFilter(AuthSecurityProperties properties, Clock clock) {
        this.key = keyOf(properties);
        this.alwaysEnforced = properties.isProduction();
        this.enforceAfter = properties.internalAuthEnforceAfterInstant();
        this.clock = clock;
    }

    /** The dedicated key; outside production, when none is configured, a key derived from the signing secret. */
    public static byte[] keyOf(AuthSecurityProperties properties) {
        String dedicated = properties.getInternalServiceKey();
        if (dedicated != null && !dedicated.isBlank()) {
            return DerivedKeys.derive(dedicated.trim(), DerivedKeys.INTERNAL_SERVICE);
        }
        return DerivedKeys.derive(properties.getJwtSecret(), DerivedKeys.INTERNAL_SERVICE);
    }

    static boolean isTokenIssuingPath(String uri) {
        if (uri == null) return false;
        String rest = uri.startsWith("/api/v1/") ? uri.substring("/api/v1".length())
                : uri.startsWith("/api/") ? uri.substring("/api".length()) : null;
        return rest != null && TOKEN_ISSUING_PATHS.contains(rest);
    }

    public static String bodyDigest(byte[] body) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    public static String sign(byte[] key, long epochSeconds, String nonce, String method, String path, byte[] body) {
        String canonical = "v2\n" + epochSeconds + "\n" + nonce + "\n" + method + "\n" + path + "\n" + bodyDigest(body);
        return "v2." + epochSeconds + "." + nonce + "." + DerivedKeys.hmacHex(key, canonical);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String uri = request.getRequestURI();
        if (!"POST".equalsIgnoreCase(request.getMethod()) || !isTokenIssuingPath(uri)) {
            chain.doFilter(request, response);
            return;
        }
        String presented = request.getHeader(HEADER);
        Instant now = clock.instant();
        if (presented == null || presented.isBlank()) {
            if (!alwaysEnforced && (enforceAfter == null || now.isBefore(enforceAfter))) {
                chain.doFilter(request, response);
                return;
            }
            refuse(response, uri, "missing");
            return;
        }
        byte[] body = readBounded(request.getInputStream());
        if (body == null) {
            refuse(response, uri, "body too large");
            return;
        }
        String why = check(presented.trim(), now, uri, body);
        if (why != null) {
            refuse(response, uri, why);
            return;
        }
        chain.doFilter(new CachedBodyRequest(request, body), response);
    }

    /** Null when the signature is good (and its nonce is now spent); otherwise the reason category. */
    private String check(String presented, Instant now, String uri, byte[] body) {
        String[] parts = presented.split("\\.", 4);
        if (parts.length != 4 || !"v2".equals(parts[0]) || parts[1].length() > 12
                || !parts[2].matches("[0-9a-f]{32}")) return "malformed";
        long epochSeconds;
        try {
            epochSeconds = Long.parseLong(parts[1]);
        } catch (NumberFormatException e) {
            return "malformed";
        }
        if (Math.abs(now.getEpochSecond() - epochSeconds) > MAX_SKEW_SECONDS) return "expired";
        if (!DerivedKeys.constantTimeEquals(sign(key, epochSeconds, parts[2], "POST", uri, body), presented)) {
            return "invalid";
        }
        return spendNonce(parts[2], now) ? null : "replayed";
    }

    private boolean spendNonce(String nonce, Instant now) {
        long nowSeconds = now.getEpochSecond();
        if (usedNonces.size() >= MAX_REMEMBERED_NONCES / 2) {
            usedNonces.values().removeIf(expiry -> expiry < nowSeconds);
        }
        if (usedNonces.size() >= MAX_REMEMBERED_NONCES) return false; // flood: fail closed rather than forget
        return usedNonces.putIfAbsent(nonce, nowSeconds + 2 * MAX_SKEW_SECONDS + 1) == null;
    }

    private static byte[] readBounded(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int n;
        while ((n = in.read(buffer)) != -1) {
            if (out.size() + n > MAX_BODY_BYTES) return null;
            out.write(buffer, 0, n);
        }
        return out.toByteArray();
    }

    private void refuse(HttpServletResponse response, String uri, String why) throws IOException {
        log.warn("[Security:Internal] Refused call to {} (signature {})", uri, why);
        SecuritySignals.signal("INTERNAL_AUTH_REFUSED", why);
        response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setHeader("Cache-Control", "no-store");
        response.getWriter().write(
                "{\"code\":\"INTERNAL_AUTH_REQUIRED\",\"message\":\"This endpoint is not available to browsers.\"}");
    }

    /** The request with its already-read body available again to the controller. */
    static final class CachedBodyRequest extends HttpServletRequestWrapper {
        private final byte[] body;

        CachedBodyRequest(HttpServletRequest request, byte[] body) {
            super(request);
            this.body = body;
        }

        @Override
        public ServletInputStream getInputStream() {
            ByteArrayInputStream in = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override public boolean isFinished() { return in.available() == 0; }
                @Override public boolean isReady() { return true; }
                @Override public void setReadListener(ReadListener listener) { throw new UnsupportedOperationException(); }
                @Override public int read() { return in.read(); }
                @Override public int read(byte[] b, int off, int len) { return in.read(b, off, len); }
            };
        }

        @Override
        public BufferedReader getReader() {
            return new BufferedReader(new InputStreamReader(getInputStream(), StandardCharsets.UTF_8));
        }

        @Override
        public int getContentLength() { return body.length; }

        @Override
        public long getContentLengthLong() { return body.length; }
    }
}
