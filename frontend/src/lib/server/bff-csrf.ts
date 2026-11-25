import { NextRequest } from "next/server";
import crypto from "crypto";

export const CSRF_COOKIE_NAME = "ec.csrf";
/**
 * The name used over HTTPS: the __Host- prefix makes the browser accept the cookie only with Secure, Path=/ and no
 * Domain, so another host of the site cannot plant one. The unprefixed name is still read for cookies issued
 * before the prefix existed (they live a day) and for plain-HTTP local development.
 */
export const CSRF_COOKIE_NAME_SECURE = "__Host-ec.csrf";

/**
 * Returns true when only `__Host-`-prefixed cookies should be trusted (production or HTTPS origin).
 * Prevents a sibling subdomain from planting an unprefixed `ec.csrf` cookie and having it accepted or promoted.
 */
function strictHostCookies(): boolean {
    return process.env.NODE_ENV === "production" || (process.env.NEXTAUTH_URL || "").startsWith("https://");
}

function timingSafeStringEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/** The double-submit token this browser holds. Over HTTPS / in production, never promote or trust unprefixed `ec.csrf`. */
export function readCsrfCookie(request: NextRequest): string | undefined {
    if (strictHostCookies()) {
        return request.cookies.get(CSRF_COOKIE_NAME_SECURE)?.value;
    }
    return request.cookies.get(CSRF_COOKIE_NAME_SECURE)?.value || request.cookies.get(CSRF_COOKIE_NAME)?.value;
}

/**
 * Generate a cryptographically secure random CSRF token.
 */
export function generateCsrfToken(): string {
    return crypto.randomBytes(32).toString("hex");
}

/**
 * Extract origin from Origin or Referer header.
 */
function getRequestOrigin(request: NextRequest): string | null {
    const origin = request.headers.get("origin");
    if (origin) {
        return origin;
    }
    const referer = request.headers.get("referer");
    if (referer) {
        try {
            return new URL(referer).origin;
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Validates Origin and CSRF token for state-changing requests.
 */
export function validateBffCsrf(request: NextRequest): { valid: boolean; status: number; error?: string } {
    const method = request.method.toUpperCase();
    // Safe HTTP methods do not require CSRF or Origin checks
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
        return { valid: true, status: 200 };
    }

    // 1. Origin validation
    const requestOrigin = getRequestOrigin(request);
    const isProd = process.env.NODE_ENV === "production";

    if (isProd) {
        if (!requestOrigin) {
            return {
                valid: false,
                status: 403,
                error: "Forbidden: Missing origin header"
            };
        }
        const allowedOrigins = new Set<string>();
        if (process.env.NEXTAUTH_URL) {
            try {
                allowedOrigins.add(new URL(process.env.NEXTAUTH_URL).origin);
            } catch {}
        }
        if (allowedOrigins.size === 0) {
            return {
                valid: false,
                status: 403,
                error: "Forbidden: Production origin policy is not configured"
            };
        }
        try {
            const originUrl = new URL(requestOrigin);
            if (!allowedOrigins.has(originUrl.origin)) {
                return {
                    valid: false,
                    status: 403,
                    error: `Forbidden: Forged or untrusted origin: ${requestOrigin}`
                };
            }
        } catch {
            return {
                valid: false,
                status: 403,
                error: `Forbidden: Malformed origin header`
            };
        }
    } else {
        const hostHeader = request.headers.get("host") || "";
        const canonicalHost = request.nextUrl.host;
        const allowedHosts = new Set([
            canonicalHost,
            hostHeader,
            "localhost:3000",
            "127.0.0.1:3000",
            "frontend:3000"
        ]);

        if (process.env.NEXTAUTH_URL) {
            try {
                allowedHosts.add(new URL(process.env.NEXTAUTH_URL).host);
            } catch {}
        }

        if (requestOrigin) {
            try {
                const originUrl = new URL(requestOrigin);
                if (!allowedHosts.has(originUrl.host)) {
                    return {
                        valid: false,
                        status: 403,
                        error: `Forbidden: Forged or untrusted origin: ${requestOrigin}`
                    };
                }
            } catch {
                return {
                    valid: false,
                    status: 403,
                    error: `Forbidden: Malformed origin header`
                };
            }
        }
    }

    // 2. CSRF token validation
    const headerCsrf = request.headers.get("x-csrf-token") || request.headers.get("csrf-token");
    if (!headerCsrf || headerCsrf.trim().length === 0) {
        return {
            valid: false,
            status: 403,
            error: "Forbidden: Missing CSRF token in request headers"
        };
    }

    // Check ec.csrf cookie or next-auth.csrf-token cookie (strict __Host- only in production / HTTPS)
    const ecCsrfCookie = readCsrfCookie(request);
    const nextAuthCsrfCookie = strictHostCookies()
        ? request.cookies.get("__Host-next-auth.csrf-token")?.value
        : (request.cookies.get("__Host-next-auth.csrf-token")?.value ||
           request.cookies.get("next-auth.csrf-token")?.value);

    let match = false;
    if (ecCsrfCookie && timingSafeStringEqual(ecCsrfCookie, headerCsrf)) {
        match = true;
    } else if (nextAuthCsrfCookie) {
        // NextAuth formats csrf cookie as `<token>|<hash>`
        const rawNextAuthToken = nextAuthCsrfCookie.split("|")[0];
        if (timingSafeStringEqual(rawNextAuthToken, headerCsrf) || timingSafeStringEqual(nextAuthCsrfCookie, headerCsrf)) {
            match = true;
        }
    }

    if (!match) {
        return {
            valid: false,
            status: 403,
            error: "Forbidden: Invalid or mismatched CSRF token"
        };
    }

    return { valid: true, status: 200 };
}
