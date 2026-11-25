/**
 * Library backup / restore for My Books. A backup is an ordinary ZIP (stored, not compressed) holding
 * `manifest.json` (shelf records, positions, bookmarks, highlights, notes, reader settings) plus every book file and
 * cover. It is assembled as a Blob from the stored Blobs, so books are not copied into one memory buffer; CRC-32 is
 * computed by streaming. Restore reads it back through the same bounded ZIP reader used for EPUB.
 */
import { ZipArchive } from "../engine/zip";
import type { Annotation, BookMeta, ReaderPrefs } from "../engine/types";
import { BookStore, type StoredPosition } from "./bookStore";

const MANIFEST_VERSION = 1;

interface Manifest {
    app: "english-coach-my-books";
    version: number;
    exportedAt: string;
    books: Array<BookMeta & { file: string; cover: string | null }>;
    positions: StoredPosition[];
    annotations: Annotation[];
    prefs: Partial<ReaderPrefs> | null;
}

let crcTable: Uint32Array | null = null;
function table() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
    }
    return crcTable;
}

async function crc32(blob: Blob): Promise<number> {
    const t = table();
    let crc = 0xffffffff;
    const reader = blob.stream().getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let i = 0; i < value.length; i++) crc = t[(crc ^ value[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
}

async function buildZip(entries: Array<{ name: string; data: Blob }>): Promise<Blob> {
    const parts: BlobPart[] = [];
    const central: Uint8Array[] = [];
    const enc = new TextEncoder();
    const { time, date } = dosTime(new Date());
    let offset = 0;
    for (const entry of entries) {
        if (entry.data.size >= 0xffffffff || offset >= 0xffffffff) throw new Error("Bản sao lưu vượt quá 4 GB — hãy sao lưu ít sách hơn.");
        const name = enc.encode(entry.name);
        const crc = await crc32(entry.data);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true);
        local.setUint16(8, 0, true);
        local.setUint16(10, time, true);
        local.setUint16(12, date, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, entry.data.size, true);
        local.setUint32(22, entry.data.size, true);
        local.setUint16(26, name.length, true);
        local.setUint16(28, 0, true);
        parts.push(local.buffer, name, entry.data);
        const cen = new DataView(new ArrayBuffer(46));
        cen.setUint32(0, 0x02014b50, true);
        cen.setUint16(4, 20, true);
        cen.setUint16(6, 20, true);
        cen.setUint16(8, 0x0800, true);
        cen.setUint16(10, 0, true);
        cen.setUint16(12, time, true);
        cen.setUint16(14, date, true);
        cen.setUint32(16, crc, true);
        cen.setUint32(20, entry.data.size, true);
        cen.setUint32(24, entry.data.size, true);
        cen.setUint16(28, name.length, true);
        cen.setUint32(42, offset, true);
        const record = new Uint8Array(46 + name.length);
        record.set(new Uint8Array(cen.buffer), 0);
        record.set(name, 46);
        central.push(record);
        offset += 30 + name.length + entry.data.size;
    }
    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central as BlobPart[], end.buffer], { type: "application/zip" });
}

export async function exportLibrary(store: BookStore, onProgress?: (done: number, total: number) => void): Promise<Blob> {
    const books = await store.listBooks();
    const entries: Array<{ name: string; data: Blob }> = [];
    const manifest: Manifest = {
        app: "english-coach-my-books", version: MANIFEST_VERSION, exportedAt: new Date().toISOString(),
        books: [], positions: [], annotations: await store.allAnnotations(), prefs: (await store.getPrefs()) ?? null,
    };
    let n = 0;
    for (const book of books) {
        const file = await store.getFile(book.id);
        if (!file) continue;
        const cover = await store.getCover(book.id);
        const fileName = `books/${book.id}.${book.format}`;
        const coverName = cover ? `covers/${book.id}.jpg` : null;
        entries.push({ name: fileName, data: file });
        if (cover && coverName) entries.push({ name: coverName, data: cover });
        manifest.books.push({ ...book, file: fileName, cover: coverName });
        const position = await store.getPosition(book.id);
        if (position) manifest.positions.push(position);
        onProgress?.(++n, books.length);
    }
    entries.unshift({ name: "manifest.json", data: new Blob([JSON.stringify(manifest)], { type: "application/json" }) });
    return buildZip(entries);
}

/**
 * Restores a backup. {@code allow} (from the UI, which asks the server) decides which new books may be added today — a
 * restore is an import like any other; books it refuses are skipped and counted in {@code refused}.
 */
export async function importLibrary(store: BookStore, backup: Blob,
        allow?: (fingerprints: string[]) => Promise<Set<string>>): Promise<{ added: number; skipped: number; refused: number; addedFingerprints: string[] }> {
    const zip = await ZipArchive.open(backup, { maxEntries: 20000, maxEntrySize: 700 * 1024 * 1024, maxTotalSize: 8 * 1024 * 1024 * 1024, maxRatio: 400 });
    if (!zip.has("manifest.json")) throw new Error("Tệp này không phải bản sao lưu My Books.");
    const manifest = JSON.parse(await zip.readText("manifest.json", 64 * 1024 * 1024)) as Manifest;
    if (manifest.app !== "english-coach-my-books" || !Array.isArray(manifest.books)) throw new Error("Tệp này không phải bản sao lưu My Books.");
    const existing = await store.listBooks();
    const known = new Set(existing.map((b) => b.fingerprint));
    const knownIds = new Set(existing.map((b) => b.id));
    let added = 0, skipped = 0, refused = 0;
    const restored = new Set<string>(), addedFingerprints: string[] = [];
    const candidates = manifest.books.slice(0, 5000).filter((raw) => raw && typeof raw.fingerprint === "string" && !known.has(raw.fingerprint));
    const allowed = allow ? await allow(candidates.map((raw) => raw.fingerprint).slice(0, 50)) : null;
    for (const raw of manifest.books.slice(0, 5000)) {
        if (!raw || typeof raw.id !== "string" || !/^[\w-]{6,64}$/.test(raw.id) || !["epub", "pdf", "txt"].includes(raw.format)) { skipped++; continue; }
        if (known.has(raw.fingerprint) || knownIds.has(raw.id) || !zip.has(raw.file)) { skipped++; continue; }
        if (allowed && !allowed.has(raw.fingerprint)) { refused++; continue; }
        const type = raw.format === "pdf" ? "application/pdf" : raw.format === "epub" ? "application/epub+zip" : "text/plain";
        const file = await zip.readBlob(raw.file, type, 700 * 1024 * 1024);
        const cover = raw.cover && zip.has(raw.cover) ? await zip.readBlob(raw.cover, "image/jpeg", 8 * 1024 * 1024) : null;
        const meta: BookMeta = {
            id: raw.id, title: String(raw.title || "Sách").slice(0, 300), author: String(raw.author || "").slice(0, 200), format: raw.format,
            fileName: String(raw.fileName || "").slice(0, 260), size: file.size, fingerprint: String(raw.fingerprint || ""), language: raw.language ?? null,
            addedAt: Number(raw.addedAt) || Date.now(), lastOpenedAt: Number(raw.lastOpenedAt) || null, progress: Math.max(0, Math.min(1, Number(raw.progress) || 0)),
            status: raw.status === "finished" || raw.status === "reading" ? raw.status : "new",
            collections: Array.isArray(raw.collections) ? raw.collections.filter((c) => typeof c === "string").slice(0, 20).map((c) => c.slice(0, 60)) : [],
            hasCover: Boolean(cover), pageCount: typeof raw.pageCount === "number" ? raw.pageCount : null,
        };
        await store.addBook(meta, file, cover);
        restored.add(meta.id);
        addedFingerprints.push(meta.fingerprint);
        added++;
    }
    for (const p of manifest.positions ?? []) if (p && restored.has(p.bookId) && p.loc) await store.savePosition({ ...p, updatedAt: Number(p.updatedAt) || Date.now() });
    for (const a of manifest.annotations ?? []) {
        if (!a || !restored.has(a.bookId) || typeof a.id !== "string") continue;
        await store.putAnnotation({ ...a, text: String(a.text || "").slice(0, 4000), note: a.note ? String(a.note).slice(0, 8000) : undefined });
    }
    if (manifest.prefs && !(await store.getPrefs())) await store.savePrefs(manifest.prefs as ReaderPrefs);
    return { added, skipped, refused, addedFingerprints };
}
