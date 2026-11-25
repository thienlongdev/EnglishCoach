import NextAuth, { type AuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { backendCandidates as resolveBackendCandidates, backendPostHeaders, clientIpOf } from "@/lib/server/internal-auth";

/** What a log line may say about an account's address: first character and domain, never the address itself. */
function maskEmail(address?: string | null): string {
    if (!address) return "(none)";
    const at = address.lastIndexOf("@");
    return at > 0 ? `${address[0]}***${address.slice(at)}` : "***";
}

export const dynamic = "force-dynamic";

/**
 * Server-side calls to the backend's token-issuing endpoints: signed (the backend accepts them from this server
 * only) and carrying the browser's address, which the backend throttles sign-in by.
 */
const backendHeaders = (path: string, clientIp: string | null, body: string) => backendPostHeaders(path, clientIp, body);

/** Only a connection that never opened may go to the next address: a request that reached a backend has spent its Turnstile token. */
function neverDelivered(error: any): boolean {
    return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH"].includes(error?.cause?.code ?? error?.code);
}

const authOptions = (clientIp: string | null): AuthOptions => ({
    providers: [
        GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID || "",
            clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
        }),
        CredentialsProvider({
            name: "Learner Account",
            credentials: {
                email: { label: "Email", type: "email", placeholder: "learner@englishcoach.app" },
                password: { label: "Password", type: "password" },
                linkTicket: { label: "Google Link Ticket", type: "text" },
                turnstileToken: { label: "Turnstile Token", type: "text" }
            },
            async authorize(credentials) {
                const backendCandidates = resolveBackendCandidates();

                // Linking Google to an existing password account: the ticket from the Google exchange plus the
                // account's password. The backend's answer (a session grant) stays on this server.
                if (credentials?.linkTicket) {
                    if (!credentials.password) return null;
                    const linkBody = JSON.stringify({ ticket: credentials.linkTicket, password: credentials.password });
                    for (const base of backendCandidates) {
                        try {
                            const res = await fetch(`${base}/api/v1/auth/google/link`, {
                                method: "POST",
                                signal: AbortSignal.timeout(8000),
                                headers: backendHeaders("/api/v1/auth/google/link", clientIp, linkBody),
                                body: linkBody
                            });
                            if (res.ok) {
                                const data = await res.json();
                                if (!data.user?.id || !data.sessionGrant) return null;
                                return {
                                    id: String(data.user.id),
                                    email: data.user.email,
                                    name: data.user.name,
                                    role: data.user.role,
                                    sessionGrant: data.sessionGrant,
                                };
                            }
                            if (res.status === 429) throw new Error("RATE_LIMIT");
                            console.warn(`[NextAuth] Google link rejected (${res.status})`);
                            return null;
                        } catch (e: any) {
                            if (e?.message === "RATE_LIMIT") throw e;
                            continue;
                        }
                    }
                    console.error("[NextAuth] Google link could not reach the backend");
                    return null;
                }

                if (!credentials?.email || !credentials?.password) {
                    console.warn("[NextAuth] Authorize rejected: email or password missing");
                    return null;
                }

                const email = credentials.email.trim().toLowerCase();
                const password = credentials.password;
                const turnstileToken = credentials.turnstileToken;

                const bodyPayload: any = { email, password };
                if (turnstileToken) {
                    bodyPayload.turnstileToken = turnstileToken;
                }

                const loginBody = JSON.stringify(bodyPayload);
                for (const base of backendCandidates) {
                    let res: Response;
                    try {
                        // Siteverify alone may take 10 s on the backend (5 s connect + 5 s read).
                        res = await fetch(`${base}/api/v1/auth/login`, {
                            method: "POST",
                            signal: AbortSignal.timeout(15000),
                            headers: backendHeaders("/api/v1/auth/login", clientIp, loginBody),
                            body: loginBody
                        });
                    } catch (e: any) {
                        if (neverDelivered(e)) continue;
                        console.error("[NextAuth] Sign-in request did not complete:", e?.name ?? "error");
                        throw new Error("AUTH_UNAVAILABLE");
                    }

                    if (res.ok) {
                        const data = await res.json();
                        console.log("[NextAuth] Authoritative credentials verification passed for:", maskEmail(email));
                        return {
                            id: String(data.id),
                            email: data.email,
                            name: data.name,
                            role: data.role,
                            sessionGrant: data.sessionGrant,
                        };
                    }
                    console.warn(`[NextAuth] Authoritative credentials rejected (${res.status}) for: ${maskEmail(email)}`);
                    if (res.status === 400) {
                        const errorData = await res.json().catch(() => ({}));
                        if (errorData.code === "CAPTCHA_FAILED") {
                            throw new Error("CAPTCHA_FAILED: " + (errorData.message || "Verification challenge failed"));
                        }
                        return null;
                    }
                    if (res.status === 401) return null;
                    if (res.status === 403) {
                        // The backend answers these two only AFTER the password matched, so naming them
                        // tells nothing to someone who does not know the password.
                        const errorData = await res.json().catch(() => ({}));
                        if (errorData.code === "EMAIL_VERIFICATION_REQUIRED" || errorData.code === "RESET_REQUIRED") {
                            throw new Error(errorData.code);
                        }
                        return null;
                    }
                    if (res.status === 429) throw new Error("RATE_LIMIT");
                    // A server fault is told as one: never as a wrong password, and the token is not sent again.
                    throw new Error("AUTH_UNAVAILABLE");
                }

                console.error("[NextAuth] Could not reach authoritative backend auth service");
                throw new Error("AUTH_UNAVAILABLE");
            }
        }),
    ],
    pages: {
        signIn: '/login',
        error: '/login',
    },
    callbacks: {
        async redirect({ url, baseUrl }: { url: string, baseUrl: string }) {
            // Strict open redirect protection: allow relative paths starting with '/' but not '//'
            if (url.startsWith('/') && !url.startsWith('//')) {
                return `${baseUrl}${url}`;
            }
            // Allow same-origin URLs
            try {
                const parsed = new URL(url);
                if (parsed.origin === baseUrl) {
                    return url;
                }
            } catch {
                // Ignore malformed URLs and fall through
            }
            return baseUrl;
        },
        async signIn({ user, account, profile, email, credentials }) {
            console.log("[NextAuth] signIn invoked", { email: maskEmail(user?.email), provider: account?.provider });
            if (account?.provider === "google" && account.id_token) {
                const backendCandidates = resolveBackendCandidates();

                const exchangeBody = JSON.stringify({ idToken: account.id_token });
                for (const base of backendCandidates) {
                    try {
                        const res = await fetch(`${base}/api/v1/auth/google/exchange`, {
                            method: "POST",
                            signal: AbortSignal.timeout(8000),
                            headers: backendHeaders("/api/v1/auth/google/exchange", clientIp, exchangeBody),
                            body: exchangeBody
                        });

                        if (res.ok) {
                            const data = await res.json();
                            if (!data.user?.id || !data.sessionGrant) return false;
                            Object.assign(user, { id: String(data.user.id), name: data.user.name, email: data.user.email,
                                role: data.user.role, sessionGrant: data.sessionGrant });
                            return true;
                        }

                        if (res.status === 409) {
                            const errData = await res.json();
                            if (errData.status === "LINK_REQUIRED") {
                                const redirectUrl = `/login?linkRequired=true&ticket=${encodeURIComponent(errData.ticket || "")}&email=${encodeURIComponent(errData.email || "")}`;
                                return redirectUrl;
                            }
                        }
                    } catch (e) {
                        continue;
                    }
                }
                return false;
            }
            return true;
        },
        async jwt({ token, account, user }: { token: any, account: any, user: any }) {
            // This token is the encrypted HttpOnly session cookie. It keeps the backend's canonical identity and
            // the session grant; it never keeps an application token (that one lives in its own short-lived
            // HttpOnly cookie, written by /api/auth/refresh).
            if (user && (account?.provider === "google" || account?.provider === "credentials")) {
                // For Google the signIn callback already made the single authoritative exchange; the provider's
                // subject and undefined role must not overwrite the backend identity.
                token.userId = user.id;
                token.sub = user.id;
                token.name = user.name;
                token.email = user.email;
                token.role = (user as any).role;
                token.sessionGrant = (user as any).sessionGrant;
            }
            // Cookies issued before this release also carried an application token: drop it on first use.
            delete token.accessToken;
            delete token.id_token;
            return token;
        },
        async session({ session, token }: { session: any, token: any }) {
            // What a page script may know: who is signed in. Never a token, never the grant.
            if (session?.user) {
                session.user.id = token.userId || token.sub;
                (session.user as any).role = token.role || "ROLE_USER";
            }
            return session;
        },
    },
    session: {
        strategy: "jwt",
    },
});

const handler = (req: Request, context: any) => NextAuth(authOptions(clientIpOf(req)))(req, context);

export { handler as GET, handler as POST };
