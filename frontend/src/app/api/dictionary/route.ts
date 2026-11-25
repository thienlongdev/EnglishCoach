import { NextRequest, NextResponse } from 'next/server';
import { busyResponse, fetchUpstream, ProxyBusyError, readBoundedJson, withUpstreamSlot } from '@/lib/server/public-proxy';

/** Longest English headword worth a lookup; longer input is not a word. */
const MAX_WORD_CHARS = 48;
const MAX_UPSTREAM_BYTES = 512 * 1024;
/** One request makes at most this many upstream lookups (the word itself plus base-form candidates). */
const MAX_LOOKUPS_PER_REQUEST = 5;
/** All lookups of one request share this much time; a slow upstream ends the search instead of holding the caller. */
const REQUEST_BUDGET_MS = 8000;

/**
 * Server-side proxy for dictionaryapi.dev with conservative inflection/lemma fallback.
 * Bypasses CORS / rate-limit issues and resolves inflected words (e.g., "screamed" -> "scream").
 *
 * GET /api/dictionary?word=<word>
 */
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const rawWord = searchParams.get('word') ?? '';
    const word = rawWord.replace(/[^a-zA-Z0-9']/g, '').toLowerCase();

    if (!word) {
        return NextResponse.json({ error: 'Missing word' }, { status: 400 });
    }
    if (word.length > MAX_WORD_CHARS) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    try {
        return await withUpstreamSlot(() => lookup(word));
    } catch (err) {
        if (err instanceof ProxyBusyError) return busyResponse();
        console.error('[/api/dictionary] fetch failed:', err instanceof Error ? err.name : 'error');
        return NextResponse.json({ error: 'Dictionary service unavailable' }, { status: 502 });
    }
}

async function lookup(word: string): Promise<Response> {
    {
        const deadline = Date.now() + REQUEST_BUDGET_MS;
        // 1. Try exact word lookup
        const exactResult = await fetchDictionaryWord(word, deadline);
        if (exactResult.ok && exactResult.data) {
            return NextResponse.json(exactResult.data);
        }

        // 2. Generate conservative lemma candidates if exact lookup 404s
        const candidates = generateLemmaCandidates(word).slice(0, MAX_LOOKUPS_PER_REQUEST - 1);
        for (const candidate of candidates) {
            if (candidate === word) continue;
            if (Date.now() >= deadline) break;
            const fallbackResult = await fetchDictionaryWord(candidate, deadline);
            if (fallbackResult.ok && fallbackResult.data && Array.isArray(fallbackResult.data) && fallbackResult.data.length > 0) {
                // Annotate fallback data with lemma metadata without faking surface IPA
                const annotated = fallbackResult.data.map((entry: any) => ({
                    ...entry,
                    inflectedFrom: word,
                    baseLemma: candidate,
                    inflectionNote: `Base form of "${word}"`
                }));
                return NextResponse.json(annotated);
            }
        }

        // If all candidates failed, return the original not found status
        return NextResponse.json({ error: `Not found: ${word}` }, { status: 404 });
    }
}

async function fetchDictionaryWord(w: string, deadline: number): Promise<{ ok: boolean; status: number; data?: any }> {
    try {
        const upstreamUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`;
        const res = await fetchUpstream(upstreamUrl, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, deadline - Date.now());

        if (!res.ok) {
            await res.body?.cancel();
            return { ok: false, status: res.status };
        }

        const data = await readBoundedJson(res, MAX_UPSTREAM_BYTES);
        return { ok: true, status: 200, data };
    } catch {
        return { ok: false, status: 500 };
    }
}

function generateLemmaCandidates(word: string): string[] {
    const candidates: string[] = [];
    const len = word.length;

    // Past tense / participles: -ed
    if (word.endsWith('ed') && len > 3) {
        if (word.endsWith('ied') && len > 4) {
            candidates.push(word.slice(0, -3) + 'y'); // cried -> cry
        }
        // Doubled consonant: stopped -> stop, planned -> plan, robbed -> rob
        if (len > 4 && word[len - 3] === word[len - 4] && !['l', 's', 'z'].includes(word[len - 3])) {
            candidates.push(word.slice(0, -3));
        }
        // screamed -> scream, walked -> walk, played -> play
        candidates.push(word.slice(0, -2));
        // loved -> love, moved -> move, danced -> dance
        candidates.push(word.slice(0, -1));
    }

    // Continuous: -ing
    if (word.endsWith('ing') && len > 4) {
        if (word.endsWith('ying') && len > 4) {
            candidates.push(word.slice(0, -4) + 'ie'); // dying -> die, lying -> lie
        }
        // Doubled consonant: running -> run, swimming -> swim, hitting -> hit
        if (len > 5 && word[len - 4] === word[len - 5]) {
            candidates.push(word.slice(0, -4));
        }
        // making -> make, hoping -> hope, taking -> take
        candidates.push(word.slice(0, -3) + 'e');
        // talking -> talk, screaming -> scream, walking -> walk
        candidates.push(word.slice(0, -3));
    }

    // Plurals / 3rd person singular: -s, -es, -ies, -ves
    if (word.endsWith('ies') && len > 4) {
        candidates.push(word.slice(0, -3) + 'y'); // babies -> baby, flies -> fly
    }
    if (word.endsWith('ves') && len > 4) {
        candidates.push(word.slice(0, -3) + 'f');  // wolves -> wolf, halves -> half
        candidates.push(word.slice(0, -3) + 'fe'); // knives -> knife, lives -> life
    }
    if (word.endsWith('es') && len > 3) {
        candidates.push(word.slice(0, -2)); // boxes -> box, watches -> watch, matches -> match
    }
    if (word.endsWith('s') && !word.endsWith('ss') && len > 3) {
        candidates.push(word.slice(0, -1)); // cats -> cat, screams -> scream, talks -> talk
    }

    // Comparatives / Superlatives: -er, -est
    if (word.endsWith('er') && len > 4) {
        if (word.endsWith('ier')) candidates.push(word.slice(0, -3) + 'y'); // easier -> easy
        candidates.push(word.slice(0, -2)); // faster -> fast
        candidates.push(word.slice(0, -1)); // larger -> large
    }
    if (word.endsWith('est') && len > 4) {
        if (word.endsWith('iest')) candidates.push(word.slice(0, -4) + 'y'); // happiest -> happy
        candidates.push(word.slice(0, -3)); // fastest -> fast
        candidates.push(word.slice(0, -2)); // largest -> large
    }

    return Array.from(new Set(candidates));
}
