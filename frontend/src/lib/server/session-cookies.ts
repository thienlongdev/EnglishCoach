import { NextRequest, NextResponse } from "next/server";

/**
 * The browser's API session cookies. This file is their only writer (through /api/auth/refresh and
 * /api/auth/logout); the backend only reads them (SessionCookies.java).
 *
 *  - access cookie: the short-lived application token. HttpOnly, so no page script can read or export it.
 *  - CSRF cookie: the session's CSRF token, readable by the page, which sends it back in X-CSRF-Token.
 *
 * On HTTPS the names carry the __Host- prefix: the browser then accepts them only with Secure, Path=/ and no
 * Domain, so another host of the site cannot plant one. The unprefixed names are for plain-HTTP local development.
 */
const SECURE =
    (process.env.NEXTAUTH_URL || "").startsWith("https://") ||
    (process.env.NODE_ENV === "production" && !process.env.NEXTAUTH_URL);

export const ACCESS_COOKIE = SECURE ? "__Host-ec_at" : "ec_at";
export const CSRF_COOKIE = SECURE ? "__Host-ec_csrf" : "ec_csrf";

/** The page refreshes a little before the token itself expires, so no request is sent with a dying token. */
const EARLY_REFRESH_SECONDS = 60;

export function setSessionCookies(response: NextResponse, accessToken: string, csrfToken: string, expiresInSeconds: number) {
    const accessMaxAge = Math.max(60, Math.floor(expiresInSeconds) - 15);
    response.cookies.set(ACCESS_COOKIE, accessToken, {
        path: "/", httpOnly: true, secure: SECURE, sameSite: SECURE ? "strict" : "lax", maxAge: accessMaxAge,
    });
    // The readable cookie doubles as the page's "is the API session fresh" signal: it lapses first.
    response.cookies.set(CSRF_COOKIE, csrfToken, {
        path: "/", httpOnly: false, secure: SECURE, sameSite: SECURE ? "strict" : "lax",
        maxAge: Math.max(30, accessMaxAge - EARLY_REFRESH_SECONDS),
    });
}

export function clearSessionCookies(response: NextResponse) {
    for (const [name, httpOnly] of [[ACCESS_COOKIE, true], [CSRF_COOKIE, false]] as const) {
        response.cookies.set(name, "", {
            path: "/", httpOnly, secure: SECURE, sameSite: SECURE ? "strict" : "lax", maxAge: 0,
        });
    }
}

/** Expires every chunk of the NextAuth session cookie (the grant it holds is no longer valid). */
export function clearNextAuthSessionCookies(request: NextRequest, response: NextResponse) {
    for (const cookie of request.cookies.getAll()) {
        if (/^(?:__Secure-)?next-auth\.session-token(?:\.\d+)?$/.test(cookie.name)) {
            response.cookies.set(cookie.name, "", {
                path: "/", maxAge: 0, httpOnly: true, secure: cookie.name.startsWith("__Secure-"), sameSite: "lax",
            });
        }
    }
}

/**
 * True when a state-changing request to one of this server's own auth routes was made by this site's own page:
 * Fetch Metadata (when the browser sends it) says same-origin, and the Origin (or Referer) matches the canonical
 * configured origin. In production, the raw Host header is never trusted for origin authorization.
 */
export function isSameOriginRequest(request: NextRequest): boolean {
    const fetchSite = request.headers.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin") return false;
    const source = request.headers.get("origin") || request.headers.get("referer");
    if (!source) return false;

    let sourceUrl: URL;
    try {
        sourceUrl = new URL(source);
    } catch {
        return false;
    }

    if (process.env.NODE_ENV === "production") {
        if (!process.env.NEXTAUTH_URL) return false;
        try {
            return sourceUrl.origin === new URL(process.env.NEXTAUTH_URL).origin;
        } catch {
            return false;
        }
    }

    const allowedHosts = new Set<string>();
    if (request.nextUrl?.host) allowedHosts.add(request.nextUrl.host);
    const hostHeader = request.headers.get("host");
    if (hostHeader) allowedHosts.add(hostHeader);
    if (process.env.NEXTAUTH_URL) {
        try { allowedHosts.add(new URL(process.env.NEXTAUTH_URL).host); } catch { /* ignore */ }
    }
    return allowedHosts.has(sourceUrl.host);
}
