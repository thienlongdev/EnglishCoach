import { NextResponse } from 'next/server';
import { busyResponse, fetchUpstream, ProxyBusyError, readBounded, withUpstreamSlot } from '@/lib/server/public-proxy';

/** 500 characters of speech are well below this; anything larger is not the audio this route serves. */
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const text = searchParams.get('text');
    let lang = searchParams.get('lang') || 'en-US';

    if (!text || text.trim().length === 0) {
        return new NextResponse('Missing or empty text parameter', {
            status: 400,
            headers: { 'Cache-Control': 'no-store' },
        });
    }

    // Cap text to 500 characters to prevent upstream TTS truncation and query overflow
    const sanitizedText = text.trim().slice(0, 500);

    // Validate language tag format (e.g. en-US, en, vi-VN)
    if (!/^[a-zA-Z]{2}(-[a-zA-Z]{2,4})?$/.test(lang)) {
        lang = 'en-US';
    }

    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(sanitizedText)}&tl=${lang}&client=tw-ob`;

    try {
        // Read the binary audio (bounded) inside its own per-route pool and verify upstream Content-Type
        const audio = await withUpstreamSlot(async () => {
            const response = await fetchUpstream(url, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' });
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error('Upstream failed');
            }
            const contentType = (response.headers.get('content-type') || '').toLowerCase();
            if (!contentType.startsWith('audio/')) {
                await response.body?.cancel();
                throw new Error('Invalid upstream content-type');
            }
            const bytes = await readBounded(response, MAX_AUDIO_BYTES);
            if (bytes.byteLength === 0) {
                throw new Error('Empty upstream audio');
            }
            return bytes;
        }, 'tts');

        return new NextResponse(audio as BodyInit, {
            headers: {
                'Content-Type': 'audio/mpeg',
                'Content-Length': audio.byteLength.toString(),
                'Cache-Control': 'private, max-age=3600',
                'X-Content-Type-Options': 'nosniff',
            },
        });
    } catch (error) {
        if (error instanceof ProxyBusyError) return busyResponse();
        console.error('[/api/tts] error:', error instanceof Error ? error.name : 'error');
        return new NextResponse('Audio proxy error', {
            status: 502,
            headers: { 'Cache-Control': 'no-store' },
        });
    }
}
