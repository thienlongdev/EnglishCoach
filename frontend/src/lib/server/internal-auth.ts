import crypto from "crypto";

/**
 * Signature of a server-to-server call to one of the backend's token-issuing endpoints. Being on the container
 * network is transport, not identity: the backend (InternalServiceAuthFilter) accepts such a call only with
 * `X-EC-Internal: v2.<epoch seconds>.<nonce>.<hex HMAC-SHA256>` over
 * "v2\n<epoch>\n<nonce>\nPOST\n<path>\n<hex SHA-256 of the exact body>", under the dedicated key
 * APP_SECURITY_INTERNAL_SERVICE_KEY. The signature binds the body and is single-use (fresh nonce per call). This
 * container holds no other backend secret (not the token-signing secret). Server code only: never import from a
 * client component.
 */
const LABEL = "ec-internal-service-v1";

function serviceKey(): Buffer | null {
    const secret = (process.env.APP_SECURITY_INTERNAL_SERVICE_KEY || "").trim();
    if (!secret) return null;
    return crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update(LABEL).digest();
}

/** Header for a POST of exactly `body` to `path` (the backend request path); empty without a key. */
export function internalAuthHeader(path: string, body: string): Record<string, string> {
    const key = serviceKey();
    if (!key) return {};
    const seconds = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");
    const digest = crypto.createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");
    const canonical = ["v2", String(seconds), nonce, "POST", path, digest].join("\n");
    const mac = crypto.createHmac("sha256", key).update(canonical).digest("hex");
    return { "X-EC-Internal": "v2." + seconds + "." + nonce + "." + mac };
}

export { backendCandidates } from "./backend-origin";

/** The browser address Nginx accepted the connection from (Nginx overwrites X-Real-IP); null when not an address. */
export function clientIpOf(req: Request): string | null {
    const value = (req.headers.get("x-real-ip") || "").trim();
    return /^[0-9a-fA-F:.]{3,45}$/.test(value) ? value : null;
}

/**
 * Headers of a signed JSON POST of exactly `body` to the backend on behalf of the browser at `clientIp`. Call it
 * once per attempt: each signature can be used once.
 */
export function backendPostHeaders(path: string, clientIp: string | null, body: string): Record<string, string> {
    return {
        "Content-Type": "application/json",
        ...(clientIp ? { "X-Real-IP": clientIp } : {}),
        ...internalAuthHeader(path, body),
    };
}
