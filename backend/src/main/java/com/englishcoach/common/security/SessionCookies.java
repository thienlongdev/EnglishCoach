package com.englishcoach.common.security;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * The browser's session cookies. Both are written by the frontend's server code ({@code /api/auth/refresh}) and only
 * read here:
 * <ul>
 *   <li>{@code __Host-ec_at}: the short-lived application token. {@code HttpOnly; Secure; SameSite=Strict; Path=/};
 *       a page script can never read it.</li>
 *   <li>{@code __Host-ec_csrf}: the session's CSRF token, readable by the page so it can be sent back in a header.</li>
 * </ul>
 * The {@code __Host-} prefix makes the browser refuse a cookie of that name set for a parent domain or without
 * {@code Secure}, so a sibling host cannot plant one. The unprefixed names exist only for plain-HTTP local
 * development and are never read under a production profile.
 */
public final class SessionCookies {

    public static final String ACCESS = "__Host-ec_at";
    public static final String CSRF = "__Host-ec_csrf";
    public static final String ACCESS_DEV = "ec_at";
    public static final String CSRF_DEV = "ec_csrf";

    /** Request attribute: this request was authenticated by the session cookie (so the CSRF rules apply to it). */
    public static final String COOKIE_AUTHENTICATED = "ec.auth.cookie";

    private SessionCookies() {
    }

    /** The application token carried by the session cookie, or null. */
    public static String accessToken(HttpServletRequest request, boolean production) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) return null;
        String dev = null;
        for (Cookie cookie : cookies) {
            String value = cookie.getValue();
            if (value == null || value.isBlank()) continue;
            if (ACCESS.equals(cookie.getName())) return value.trim();
            if (!production && ACCESS_DEV.equals(cookie.getName())) dev = value.trim();
        }
        return dev;
    }

    /** Tells the browser to drop a session cookie that no longer authenticates anything. */
    public static void expire(HttpServletResponse response, boolean production) {
        response.addHeader("Set-Cookie", ACCESS + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
        response.addHeader("Set-Cookie", CSRF + "=; Path=/; Max-Age=0; Secure; SameSite=Strict");
        if (!production) {
            response.addHeader("Set-Cookie", ACCESS_DEV + "=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
            response.addHeader("Set-Cookie", CSRF_DEV + "=; Path=/; Max-Age=0; SameSite=Lax");
        }
    }
}
