import { Literata } from "next/font/google";

/**
 * Book body typeface of My Books (the reader's own Aa choice; 10 §AA). Self-hosted by next/font, declared only in this
 * lazily loaded module and never preloaded: the files download only when a book is opened in Literata.
 * Optical sizing (opsz) keeps body text sturdy and headings refined, like a printed book.
 */
export const literata = Literata({
    subsets: ["latin", "latin-ext", "vietnamese"],
    style: ["normal", "italic"],
    axes: ["opsz"],
    display: "swap",
    preload: false,
    fallback: ["Georgia", "Cambria", "Times New Roman", "serif"],
});
