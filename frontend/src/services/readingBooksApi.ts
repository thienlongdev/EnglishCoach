import { apiClient } from "./api-client";
import type { BookSelectionExplainRequest, ContextTranslation } from "@/types/readingBooks";

/**
 * Explicit "Giải nghĩa" on a My Books selection. Sends only the selected text, its sentence and a bounded context —
 * never the book. Called on a button click only (AGENTS §17: selection itself makes no request).
 */
export async function explainBookSelection(body: BookSelectionExplainRequest, signal?: AbortSignal): Promise<ContextTranslation> {
    const payload: BookSelectionExplainRequest = {
        text: body.text.slice(0, 300),
        sentence: body.sentence.slice(0, 1200),
        context: body.context?.slice(0, 2000),
        bookTitle: body.bookTitle?.slice(0, 200),
        bookAuthor: body.bookAuthor?.slice(0, 200),
    };
    const { data } = await apiClient.post<ContextTranslation>("/reading/books/explain-selection", payload, { signal, timeout: 45000 });
    return data;
}

/** The existing Reading flow's Google translation (explicit click only; same endpoint as InteractiveReader). */
export async function googleTranslate(text: string, signal?: AbortSignal): Promise<string> {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=${encodeURIComponent(text.slice(0, 4500))}`;
    const res = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error("translate failed");
    const data = await res.json();
    return (data[0] as Array<[string]>).map((item) => item[0]).join("");
}

/** Server answer to a My Books import request: only fingerprints travel, never a book. */
export interface BookImportGrant {
    granted: string[];
    refused: string[];
    unlimited: boolean;
    limit: number;
    used: number;
    remaining: number;
    resetsAt: string;
}

/**
 * Asks for the daily import allowance BEFORE books are stored on the device (free: one new book a day; a book already
 * granted to this account — also after deleting it — is granted again). Only the content fingerprints are sent.
 */
export async function requestBookImports(fingerprints: string[]): Promise<BookImportGrant> {
    const { data } = await apiClient.post<BookImportGrant>("/reading/books/import-grants", { fingerprints: fingerprints.slice(0, 50) });
    return data;
}

/** Tells the server which granted books were stored (completed) or could not be stored (the day's import comes back). */
export async function settleBookImports(fingerprints: string[], stored: boolean): Promise<void> {
    if (!fingerprints.length) return;
    await apiClient.post(`/reading/books/import-grants/${stored ? "complete" : "release"}`, { fingerprints: fingerprints.slice(0, 50) });
}

export async function createFlashcard(front: string, back: string, example: string): Promise<void> {
    await apiClient.post("/flashcards", { front: front.slice(0, 500), back: back.slice(0, 2000), example: example.slice(0, 1000) });
}
