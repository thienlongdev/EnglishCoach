import { NextRequest, NextResponse } from 'next/server';
import { busyResponse, fetchUpstream, ProxyBusyError, readBoundedJson, withUpstreamSlot } from '@/lib/server/public-proxy';

/** Longest text one lookup may carry (a dictation segment is far shorter). */
const MAX_QUERY_CHARS = 2000;
const MAX_UPSTREAM_BYTES = 256 * 1024;

/**
 * Server-side proxy for Google Translate.
 * Client cannot call translate.googleapis.com directly due to CORS.
 * This route makes the request from the Next.js server (no CORS restriction).
 *
 * GET /api/translate?q=<word>&tl=<target_lang>
 */
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q') ?? '';
    const requestedTl = searchParams.get('tl') ?? 'vi';
    const tl = /^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$/.test(requestedTl) ? requestedTl : 'vi';

    if (!q.trim()) {
        return NextResponse.json({ error: 'Missing query' }, { status: 400 });
    }
    if (q.length > MAX_QUERY_CHARS) {
        return NextResponse.json({ error: 'Query too long' }, { status: 413 });
    }

    try {
        return await withUpstreamSlot(() => translate(q, tl));
    } catch (err) {
        if (err instanceof ProxyBusyError) return busyResponse();
        console.error('[/api/translate] fetch failed:', err instanceof Error ? err.name : 'error');
        return NextResponse.json({ error: 'Translation service unavailable' }, { status: 502 });
    }
}

async function translate(q: string, tl: string): Promise<Response> {
    {
        const upstreamUrl = `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=en&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(q)}`;
        const res = await fetchUpstream(upstreamUrl, {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*'
        });

        if (!res.ok) {
            // Fallback to clients5 endpoint if primary returns error
            const fallbackUrl = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(q)}`;
            await res.body?.cancel();
            const fallbackRes = await fetchUpstream(fallbackUrl, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
            if (fallbackRes.ok) {
                const fbData = await readBoundedJson(fallbackRes, MAX_UPSTREAM_BYTES);
                // If fbData is ["translated text"], wrap it in standard shape [[["translated text", q]]]
                const translatedStr = Array.isArray(fbData) ? fbData[0] : String(fbData);
                return NextResponse.json([[[translatedStr, q]]]);
            }
            return NextResponse.json({ error: `Upstream error ${res.status}` }, { status: 502 });
        }

        const data = await readBoundedJson(res, MAX_UPSTREAM_BYTES);
        return NextResponse.json(data);
    }
}
