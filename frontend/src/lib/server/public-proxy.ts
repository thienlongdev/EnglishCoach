/**
 * Bounds for the three anonymous lookup proxies (/api/translate, /api/tts, /api/dictionary).
 *
 * Their upstream hosts are fixed in the route files, so a caller can never choose where the server connects. What a
 * caller could do is make this small server (192 MB heap) hold many slow or large upstream responses at once. Every
 * upstream call therefore has a time limit, a size limit and a share of one small pool of concurrent calls. The
 * per-address request rate is limited in Nginx (deploy/nginx/default.conf, zone `public_proxy`).
 */

const MAX_CONCURRENT_UPSTREAM_CALLS = 24;
const MAX_CONCURRENT_PER_ROUTE = 8;
const UPSTREAM_TIMEOUT_MS = 6000;

let inFlight = 0;
const routeInFlight = new Map<string, number>();

export class ProxyBusyError extends Error {
    constructor() {
        super('proxy busy');
    }
}

export class ProxyResponseTooLargeError extends Error {
    constructor() {
        super('upstream response too large');
    }
}

/**
 * Runs one upstream call inside a bounded per-route pool (so one anonymous lookup route cannot starve
 * the others) and the global pool cap; throws {@link ProxyBusyError} when either bound is full.
 */
export async function withUpstreamSlot<T>(
    work: () => Promise<T>,
    routeKey = 'default',
    maxPerRoute = MAX_CONCURRENT_PER_ROUTE,
): Promise<T> {
    const currentRoute = routeInFlight.get(routeKey) ?? 0;
    if (inFlight >= MAX_CONCURRENT_UPSTREAM_CALLS || currentRoute >= maxPerRoute) {
        throw new ProxyBusyError();
    }
    inFlight += 1;
    routeInFlight.set(routeKey, currentRoute + 1);
    try {
        return await work();
    } finally {
        inFlight -= 1;
        const next = (routeInFlight.get(routeKey) ?? 1) - 1;
        if (next <= 0) routeInFlight.delete(routeKey);
        else routeInFlight.set(routeKey, next);
    }
}

/** A fetch that gives up after {@link UPSTREAM_TIMEOUT_MS}, or sooner when the caller has less time left. */
export function fetchUpstream(url: string, headers: Record<string, string>, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<Response> {
    const limit = Math.max(1, Math.min(timeoutMs, UPSTREAM_TIMEOUT_MS));
    return fetch(url, { headers, signal: AbortSignal.timeout(limit), cache: 'no-store' });
}

/** Reads a response body, refusing more than `maxBytes` (declared or actual). */
export async function readBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel();
        throw new ProxyResponseTooLargeError();
    }
    if (!res.body) {
        return new Uint8Array(0);
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new ProxyResponseTooLargeError();
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

export async function readBoundedJson(res: Response, maxBytes: number): Promise<unknown> {
    return JSON.parse(new TextDecoder().decode(await readBounded(res, maxBytes)));
}

/** The answer for a full pool: the caller may simply try again. */
export function busyResponse(): Response {
    return new Response(JSON.stringify({ error: 'Busy, try again shortly' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '2', 'Cache-Control': 'no-store' },
    });
}
