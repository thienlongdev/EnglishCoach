/**
 * Plain-text books: encoding-aware decoding, paragraphs from blank lines (or single lines when the file has none),
 * chapter headings detected conservatively, and the text split into sections of bounded size so pagination stays
 * fast on very long files. Rendered by the same flow engine as EPUB.
 */
import { BookFormatError } from "./zip";
import type { FlowSource, LoadedChapter, SpineEntry, TocItem } from "./types";

const HEADING = /^(chapter|chương|chuong|part|phần|phan|book|quyển|quyen|hồi|hoi|prologue|epilogue|lời mở đầu|lời kết|vol\.?|volume)\b[\s.:\-–—]*([\divxlcdm]+|[a-zà-ỹ]+)?\b.{0,70}$/i;
const SECTION_TARGET = 60_000;

export function decodeText(data: Uint8Array): string {
    if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return new TextDecoder("utf-8").decode(data.subarray(3));
    if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data.subarray(2));
    if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data.subarray(2));
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
        // Legacy single-byte files: Vietnamese Windows-1258 when it yields Vietnamese letters, else Windows-1252.
        const vn = new TextDecoder("windows-1258").decode(data);
        const latin = new TextDecoder("windows-1252").decode(data);
        const score = (s: string) => (s.match(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi) || []).length;
        return score(vn) > score(latin) ? vn : latin;
    }
}

export function looksBinary(data: Uint8Array): boolean {
    const n = Math.min(data.length, 65536);
    let nul = 0;
    for (let i = 0; i < n; i++) if (data[i] === 0) nul++;
    const utf16 = (data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff);
    return !utf16 && nul > 0;
}

interface Block { heading: boolean; text: string }

function toBlocks(text: string): Block[] {
    const normalized = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
    const hasBlankLines = /\n[ \t]*\n/.test(normalized);
    const raw = hasBlankLines ? normalized.split(/\n[ \t]*\n+/) : normalized.split("\n");
    const blocks: Block[] = [];
    for (const chunk of raw) {
        const t = hasBlankLines ? chunk.replace(/[ \t]*\n[ \t]*/g, " ").trim() : chunk.trim();
        if (!t) continue;
        blocks.push({ heading: t.length <= 90 && HEADING.test(t), text: t });
    }
    return blocks;
}

export class TxtSource implements FlowSource {
    readonly kind = "txt" as const;
    /** Guessed for hyphenation only: Vietnamese when its letters are common, English for other Latin text, else unknown. */
    readonly language: string | null;
    readonly fixedLayout = false;
    spine: SpineEntry[] = [];
    toc: TocItem[] = [];
    private sections: Block[][] = [];

    constructor(readonly title: string, readonly author: string, text: string) {
        const sample = text.slice(0, 40_000);
        const letters = (sample.match(/\p{L}/gu) || []).length || 1;
        const vietnamese = (sample.match(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi) || []).length;
        const ascii = (sample.match(/[a-z]/gi) || []).length;
        this.language = vietnamese / letters > 0.02 ? "vi" : ascii / letters > 0.9 ? "en" : null;
        const blocks = toBlocks(text);
        if (!blocks.length) throw new BookFormatError("EMPTY", "Tệp văn bản không có nội dung.");
        let current: Block[] = [];
        let size = 0;
        for (const block of blocks) {
            if (current.length && (size >= SECTION_TARGET || (block.heading && size >= 4_000))) {
                this.sections.push(current);
                current = [];
                size = 0;
            }
            current.push(block);
            size += block.text.length;
        }
        if (current.length) this.sections.push(current);
        this.spine = this.sections.map((s, i) => ({ href: `section-${i}`, weight: Math.max(1, s.reduce((n, b) => n + b.text.length, 0)), linear: true, fixed: null }));
        this.sections.forEach((section, s) => {
            let o = 0;
            for (const block of section) {
                if (block.heading) this.toc.push({ label: block.text.slice(0, 120), target: { s, o }, children: [] });
                o += block.text.length;
            }
        });
        if (!this.toc.length) this.toc = this.sections.map((_, s) => ({ label: `Phần ${s + 1}`, target: { s }, children: [] }));
    }

    static async open(blob: Blob, title: string): Promise<TxtSource> {
        const data = new Uint8Array(await blob.arrayBuffer());
        if (looksBinary(data)) throw new BookFormatError("NOT_TEXT", "Tệp này không phải văn bản thuần (TXT).");
        return new TxtSource(title, "", decodeText(data));
    }

    async loadChapter(index: number): Promise<LoadedChapter> {
        const root = document.createElement("div");
        root.className = "ec-body ec-txt";
        for (const block of this.sections[index] ?? []) {
            const el = document.createElement(block.heading ? "h2" : "p");
            el.textContent = block.text;
            root.appendChild(el);
        }
        return { root, css: "", fixed: null };
    }

    async chapterText(index: number): Promise<string> {
        return (this.sections[index] ?? []).map((b) => b.text).join("");
    }

    resolveInternal(): null {
        return null;
    }

    retain() {}

    dispose() {
        this.sections = [];
    }
}
