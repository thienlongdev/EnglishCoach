/** Shared types of the My Books engines. */

export type BookFormat = "epub" | "pdf" | "txt";

export interface TocItem {
    label: string;
    /** Target in the flow book: spine index + optional fragment id / text offset. PDF: page index in `s`. */
    target: { s: number; frag?: string; o?: number };
    children: TocItem[];
}

/** A stable reading position. Flow books: spine index + character offset in that chapter's text (+ tie index). */
export interface Locator {
    s: number;
    o: number;
    k?: number;
    /** Short text after the position, used to re-anchor if the chapter's text changes. */
    t?: string;
}

export interface SpineEntry {
    href: string;
    weight: number;
    linear: boolean;
    fixed: { width: number; height: number } | null;
    spread?: "left" | "right" | "center" | null;
}

export interface LoadedChapter {
    root: HTMLElement;
    css: string;
    fixed: { width: number; height: number } | null;
}

export interface FlowSource {
    kind: "epub" | "txt";
    title: string;
    author: string;
    language: string | null;
    spine: SpineEntry[];
    toc: TocItem[];
    fixedLayout: boolean;
    /** `pause`: background load — awaited between slices of the work, so it never holds the main thread for long. */
    loadChapter(index: number, pause?: () => Promise<void>): Promise<LoadedChapter>;
    /** Resolves an inert `data-ec-href` value to a spine index + fragment. */
    resolveInternal(value: string): { s: number; frag?: string } | null;
    /** Plain text of a chapter in the same text-offset space as the rendered chapter (for search). */
    chapterText(index: number): Promise<string>;
    /** Lets the source drop cached resources (images) of chapters outside this set. */
    retain(indices: number[]): void;
    dispose(): void;
}

export interface BookMeta {
    id: string;
    title: string;
    author: string;
    format: BookFormat;
    fileName: string;
    size: number;
    fingerprint: string;
    language: string | null;
    addedAt: number;
    lastOpenedAt: number | null;
    progress: number;
    status: "new" | "reading" | "finished";
    collections: string[];
    hasCover: boolean;
    pageCount?: number | null;
}

export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "orange";

export interface FlowRange {
    s: number;
    start: number;
    end: number;
}

export interface PdfRect { x: number; y: number; w: number; h: number }

export interface Annotation {
    id: string;
    bookId: string;
    kind: "highlight" | "bookmark";
    createdAt: number;
    updatedAt: number;
    /** Flow books. */
    range?: FlowRange;
    loc?: Locator;
    /** PDF: page index + rects normalised to the page (0..1). */
    page?: number;
    rects?: PdfRect[];
    text: string;
    color?: HighlightColor;
    note?: string;
    label?: string;
}

export interface ReaderPrefs {
    theme: "paper" | "white" | "dark" | "oled";
    fontSize: number;
    lineHeight: number;
    margin: "narrow" | "normal" | "wide";
    font: "literata" | "publisher-serif" | "sans";
    justify: boolean;
    hyphenate: boolean;
    layout: "auto" | "single" | "spread";
    turn: "curl" | "instant" | "scroll";
    pdfZoom: "page" | "width" | number;
}

export const DEFAULT_PREFS: ReaderPrefs = {
    theme: "paper",
    fontSize: 19,
    lineHeight: 1.55,
    margin: "normal",
    font: "literata",
    justify: true,
    hyphenate: true,
    layout: "auto",
    turn: "curl",
    pdfZoom: "page",
};
