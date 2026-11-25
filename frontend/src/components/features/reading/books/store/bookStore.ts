/**
 * Local library of My Books (IndexedDB). Books stay on this device: the original file, a small cover, reading
 * positions, bookmarks, highlights and notes. Nothing here is sent to English Coach's servers.
 *
 * Ownership policy: one database per signed-in account (`ec-mybooks-v1-u<id>`). Another account on the same browser
 * sees its own (separate) library; signing out leaves the files on this device for when the same account returns.
 * Records are small objects; the book file and the cover are separate Blobs so listing the shelf never reads a book.
 */
import type { Annotation, BookMeta, Locator, ReaderPrefs } from "../engine/types";

const VERSION = 1;

export interface StoredPosition { bookId: string; loc: Locator; progress: number; updatedAt: number }

function req<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new DOMException("Transaction aborted", "AbortError"));
        tx.onerror = () => reject(tx.error);
    });
}

export class QuotaError extends Error {
    constructor() {
        super("Bộ nhớ trình duyệt đã đầy. Hãy xóa bớt sách hoặc giải phóng dung lượng thiết bị rồi thử lại.");
        this.name = "QuotaError";
    }
}

function isQuota(error: unknown): boolean {
    const name = (error as { name?: string })?.name;
    return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

export class BookStore {
    private constructor(private readonly db: IDBDatabase) {}

    static dbName(userId: number | string) {
        return `ec-mybooks-v1-u${String(userId).replace(/[^\w-]/g, "")}`;
    }

    /** Key of a book's stored page indexes in the `prefs` store (store/pageCache.ts). */
    static pageCacheKey(bookId: string) {
        return `pages:${bookId}`;
    }

    static async open(userId: number | string): Promise<BookStore> {
        if (typeof indexedDB === "undefined") throw new Error("Trình duyệt này không hỗ trợ lưu sách trên thiết bị.");
        const request = indexedDB.open(BookStore.dbName(userId), VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
            if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
            if (!db.objectStoreNames.contains("covers")) db.createObjectStore("covers");
            if (!db.objectStoreNames.contains("positions")) db.createObjectStore("positions", { keyPath: "bookId" });
            if (!db.objectStoreNames.contains("annotations")) {
                const ann = db.createObjectStore("annotations", { keyPath: "id" });
                ann.createIndex("bookId", "bookId");
            }
            if (!db.objectStoreNames.contains("prefs")) db.createObjectStore("prefs");
        };
        const db = await req(request);
        db.onversionchange = () => db.close();
        return new BookStore(db);
    }

    close() {
        this.db.close();
    }

    async listBooks(): Promise<BookMeta[]> {
        const tx = this.db.transaction("books", "readonly");
        const all = await req(tx.objectStore("books").getAll() as IDBRequest<BookMeta[]>);
        return all;
    }

    async getBook(id: string): Promise<BookMeta | undefined> {
        return req(this.db.transaction("books", "readonly").objectStore("books").get(id) as IDBRequest<BookMeta | undefined>);
    }

    async findByFingerprint(fingerprint: string): Promise<BookMeta | undefined> {
        return (await this.listBooks()).find((b) => b.fingerprint === fingerprint);
    }

    async addBook(meta: BookMeta, file: Blob, cover: Blob | null): Promise<void> {
        const tx = this.db.transaction(["books", "files", "covers"], "readwrite");
        tx.objectStore("files").put(file, meta.id);
        if (cover) tx.objectStore("covers").put(cover, meta.id);
        tx.objectStore("books").put(meta);
        try {
            await done(tx);
        } catch (error) {
            if (isQuota(error)) throw new QuotaError();
            throw error;
        }
    }

    async updateBook(id: string, patch: Partial<BookMeta>): Promise<BookMeta | undefined> {
        const tx = this.db.transaction("books", "readwrite");
        const store = tx.objectStore("books");
        const current = await req(store.get(id) as IDBRequest<BookMeta | undefined>);
        if (!current) return undefined;
        const next = { ...current, ...patch, id };
        store.put(next);
        await done(tx);
        return next;
    }

    async getFile(id: string): Promise<Blob | undefined> {
        return req(this.db.transaction("files", "readonly").objectStore("files").get(id) as IDBRequest<Blob | undefined>);
    }

    async getCover(id: string): Promise<Blob | undefined> {
        return req(this.db.transaction("covers", "readonly").objectStore("covers").get(id) as IDBRequest<Blob | undefined>);
    }

    async deleteBook(id: string): Promise<void> {
        const tx = this.db.transaction(["books", "files", "covers", "positions", "annotations", "prefs"], "readwrite");
        tx.objectStore("prefs").delete(BookStore.pageCacheKey(id));
        tx.objectStore("books").delete(id);
        tx.objectStore("files").delete(id);
        tx.objectStore("covers").delete(id);
        tx.objectStore("positions").delete(id);
        const index = tx.objectStore("annotations").index("bookId");
        const keys = await req(index.getAllKeys(id));
        for (const key of keys) tx.objectStore("annotations").delete(key);
        await done(tx);
    }

    async getPosition(bookId: string): Promise<StoredPosition | undefined> {
        return req(this.db.transaction("positions", "readonly").objectStore("positions").get(bookId) as IDBRequest<StoredPosition | undefined>);
    }

    async savePosition(position: StoredPosition): Promise<void> {
        const tx = this.db.transaction(["positions", "books"], "readwrite");
        tx.objectStore("positions").put(position);
        const books = tx.objectStore("books");
        const meta = await req(books.get(position.bookId) as IDBRequest<BookMeta | undefined>);
        if (meta) {
            const finished = position.progress >= 0.995;
            books.put({ ...meta, progress: position.progress, lastOpenedAt: position.updatedAt, status: finished ? "finished" : meta.status === "finished" && position.progress > 0.98 ? "finished" : "reading" });
        }
        await done(tx).catch(() => undefined);
    }

    async annotations(bookId: string): Promise<Annotation[]> {
        const index = this.db.transaction("annotations", "readonly").objectStore("annotations").index("bookId");
        const list = await req(index.getAll(bookId) as IDBRequest<Annotation[]>);
        return list.sort((a, b) => a.createdAt - b.createdAt);
    }

    async allAnnotations(): Promise<Annotation[]> {
        return req(this.db.transaction("annotations", "readonly").objectStore("annotations").getAll() as IDBRequest<Annotation[]>);
    }

    async putAnnotation(a: Annotation): Promise<void> {
        const tx = this.db.transaction("annotations", "readwrite");
        tx.objectStore("annotations").put(a);
        try { await done(tx); } catch (error) { if (isQuota(error)) throw new QuotaError(); throw error; }
    }

    async deleteAnnotation(id: string): Promise<void> {
        const tx = this.db.transaction("annotations", "readwrite");
        tx.objectStore("annotations").delete(id);
        await done(tx);
    }

    async getPrefs(): Promise<Partial<ReaderPrefs> | undefined> {
        return req(this.db.transaction("prefs", "readonly").objectStore("prefs").get("reader") as IDBRequest<Partial<ReaderPrefs> | undefined>);
    }

    async savePrefs(prefs: ReaderPrefs): Promise<void> {
        const tx = this.db.transaction("prefs", "readwrite");
        tx.objectStore("prefs").put(prefs, "reader");
        await done(tx).catch(() => undefined);
    }

    async getValue<T>(key: string): Promise<T | undefined> {
        return req(this.db.transaction("prefs", "readonly").objectStore("prefs").get(key) as IDBRequest<T | undefined>);
    }

    async setValue(key: string, value: unknown): Promise<void> {
        const tx = this.db.transaction("prefs", "readwrite");
        tx.objectStore("prefs").put(value, key);
        await done(tx).catch(() => undefined);
    }
}

export function newId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Cheap duplicate fingerprint: size + SHA-256 of the first and last 64 KiB (never reads the whole book). */
export async function fingerprint(file: Blob): Promise<string> {
    const chunk = 65536;
    const head = await file.slice(0, Math.min(chunk, file.size)).arrayBuffer();
    const tail = file.size > chunk ? await file.slice(Math.max(chunk, file.size - chunk)).arrayBuffer() : new ArrayBuffer(0);
    const data = new Uint8Array(head.byteLength + tail.byteLength);
    data.set(new Uint8Array(head), 0);
    data.set(new Uint8Array(tail), head.byteLength);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    return `${file.size}:${hex.slice(0, 40)}`;
}

/** Asks the browser to keep this site's storage (never guaranteed). */
export async function requestPersistence(): Promise<boolean | null> {
    try {
        if (!navigator.storage?.persist) return null;
        if (await navigator.storage.persisted?.()) return true;
        return await navigator.storage.persist();
    } catch {
        return null;
    }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
    try {
        const e = await navigator.storage?.estimate?.();
        return e && typeof e.usage === "number" && typeof e.quota === "number" ? { usage: e.usage, quota: e.quota } : null;
    } catch {
        return null;
    }
}
