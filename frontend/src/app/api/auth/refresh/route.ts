import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { backendCandidates, backendPostHeaders, clientIpOf } from "@/lib/server/internal-auth";
import {
    clearNextAuthSessionCookies, clearSessionCookies, isSameOriginRequest, setSessionCookies,
} from "@/lib/server/session-cookies";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const REFRESH_PATH = "/api/v1/auth/refresh";

/**
 * Establishes or renews the browser's API session. The session grant never leaves this server: it is read from
 * the encrypted HttpOnly NextAuth cookie, exchanged at the backend for a short-lived application token, and that
 * token is handed to the browser only as an HttpOnly cookie. The answer carries no token and no grant, so a page
 * script (or an injected one) has nothing durable to take away.
 */
export async function POST(request: NextRequest) {
    if (!isSameOriginRequest(request)) {
        return NextResponse.json({ code: "FORBIDDEN_ORIGIN" }, { status: 403, headers: NO_STORE });
    }

    let token: Awaited<ReturnType<typeof getToken>> = null;
    try {
        token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
    } catch {
        token = null;
    }
    const grant = typeof token?.sessionGrant === "string" ? token.sessionGrant : "";
    if (!grant) {
        const response = NextResponse.json({ code: "NO_SESSION" }, { status: 401, headers: NO_STORE });
        clearSessionCookies(response);
        return response;
    }

    const body = JSON.stringify({ sessionGrant: grant });
    for (const base of backendCandidates()) {
        let backend: Response;
        try {
            backend = await fetch(`${base}${REFRESH_PATH}`, {
                method: "POST",
                headers: backendPostHeaders(REFRESH_PATH, clientIpOf(request), body),
                body,
                signal: AbortSignal.timeout(10000),
            });
        } catch {
            continue; // next candidate
        }

        if (backend.ok) {
            const data = await backend.json().catch(() => null);
            if (!data?.accessToken || !data?.csrfToken) break;
            const expiresIn = Number(data.expiresIn) > 0 ? Number(data.expiresIn) : 1800;
            const response = NextResponse.json(
                { ok: true, expiresIn, user: data.user ? { id: data.user.id, role: data.user.role } : null },
                { headers: NO_STORE },
            );
            setSessionCookies(response, data.accessToken, data.csrfToken, expiresIn);
            return response;
        }

        const refusal = backend.status === 401 ? await backend.json().catch(() => null) : null;
        if (refusal?.code === "INVALID_REFRESH_TOKEN") {
            // The grant is revoked or expired: the session is over everywhere, including this server's cookie.
            // (Any other refusal, such as a rejected server signature, is a fault of ours, not of the learner.)
            const response = NextResponse.json({ code: "SESSION_ENDED" }, { status: 401, headers: NO_STORE });
            clearSessionCookies(response);
            clearNextAuthSessionCookies(request, response);
            return response;
        }
        break; // any other answer: the backend is reachable but unwell; do not sign the learner out for that
    }

    return NextResponse.json(
        { code: "GATEWAY_UNAVAILABLE", message: "Auth backend service is temporarily unreachable" },
        { status: 503, headers: NO_STORE },
    );
}
