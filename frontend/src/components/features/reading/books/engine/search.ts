/**
 * In-book search. Chapters (or PDF pages) are scanned one at a time with a yield between them, so a long book never
 * blocks the page; a new query aborts the previous scan. Offsets are in the same text space as locators.
 */
import type { FlowSource } from "./types";

export interface SearchHit { s: number; start: number; end: number; before: string; match: string; after: string }

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));
const MAX_HITS = 300;

function scan(text: string, query: string, s: number, hits: SearchHit[]) {
    const hay = text.toLowerCase();
    const needle = query.toLowerCase();
    let from = 0;
    while (hits.length < MAX_HITS) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        hits.push({
            s, start: at, end: at + needle.length,
            before: text.slice(Math.max(0, at - 48), at).replace(/\s+/g, " ").trimStart(),
            match: text.slice(at, at + needle.length),
            after: text.slice(at + needle.length, at + needle.length + 64).replace(/\s+/g, " ").trimEnd(),
        });
        from = at + Math.max(1, needle.length);
    }
}

export class BookSearch {
    private texts = new Map<number, string>();
    private chars = 0;

    constructor(private readonly getText: (s: number) => Promise<string>, private readonly count: number) {}

    static forFlow(source: FlowSource) {
        return new BookSearch((s) => source.chapterText(s), source.spine.length);
    }

    private async text(s: number): Promise<string> {
        const cached = this.texts.get(s);
        if (cached !== undefined) return cached;
        const text = await this.getText(s);
        if (this.chars + text.length < 24_000_000) {
            this.texts.set(s, text);
            this.chars += text.length;
        }
        return text;
    }

    async run(query: string, signal: AbortSignal, onUpdate: (hits: SearchHit[], scanned: number, total: number) => void, from = 0) {
        const q = query.trim();
        if (q.length < 2) { onUpdate([], 0, this.count); return; }
        const hits: SearchHit[] = [];
        for (let n = 0; n < this.count; n++) {
            if (signal.aborted) return;
            const s = (from + n) % this.count;
            try { scan(await this.text(s), q, s, hits); } catch { /* unreadable chapter: skipped */ }
            if (signal.aborted) return;
            if (n % 3 === 2 || n === this.count - 1 || hits.length >= MAX_HITS) {
                onUpdate([...hits].sort((a, b) => a.s - b.s || a.start - b.start), n + 1, this.count);
                await yieldToUi();
            }
            if (hits.length >= MAX_HITS) break;
        }
    }
}
