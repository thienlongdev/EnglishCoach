/**
 * Minimal, bounded ZIP reader for My Books (EPUB packages and library backups).
 *
 * Reads only the central directory up front and each entry on demand through `Blob.slice`, so a large book is never
 * copied into one JavaScript buffer. Deflate uses the browser's own `DecompressionStream('deflate-raw')`.
 * Guards: entry count, per-entry size, total declared size, compression ratio (zip bombs), encrypted entries,
 * ZIP64 (refused), and names that would leave the archive root (path traversal; nothing is ever written to disk).
 */

export class BookFormatError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = "BookFormatError";
    }
}

export interface ZipEntry {
    name: string;
    method: number;
    compressedSize: number;
    size: number;
    localOffset: number;
    encrypted: boolean;
}

export interface ZipLimits {
    maxEntries: number;
    maxEntrySize: number;
    maxTotalSize: number;
    maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
    maxEntries: 12000,
    maxEntrySize: 96 * 1024 * 1024,
    maxTotalSize: 1024 * 1024 * 1024,
    maxRatio: 400,
};

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

async function bytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** Normalises an archive path; returns null for anything that leaves the root or is absolute. */
export function normalizeZipPath(path: string): string | null {
    if (!path || path.includes("\0")) return null;
    const parts: string[] = [];
    for (const raw of path.replace(/\\/g, "/").split("/")) {
        if (raw === "" || raw === ".") continue;
        if (raw === "..") {
            if (!parts.length) return null;
            parts.pop();
            continue;
        }
        parts.push(raw);
    }
    return parts.length ? parts.join("/") : null;
}

export class ZipArchive {
    private readonly entryActualSizes = new Map<string, number>();
    private totalActualBytes = 0;

    private constructor(private readonly blob: Blob, readonly entries: Map<string, ZipEntry>, private readonly limits: ZipLimits) {}

    static async open(blob: Blob, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipArchive> {
        if (blob.size < 22) throw new BookFormatError("NOT_ZIP", "Tệp quá nhỏ để là một gói ZIP.");
        const head = await bytes(blob, 0, 4);
        if (!(head[0] === 0x50 && head[1] === 0x4b)) throw new BookFormatError("NOT_ZIP", "Tệp không phải gói ZIP hợp lệ.");

        const tailStart = Math.max(0, blob.size - 65557);
        const tail = await bytes(blob, tailStart, blob.size);
        const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
        let eocd = -1;
        for (let i = tail.length - 22; i >= 0; i--) {
            if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
        }
        if (eocd < 0) throw new BookFormatError("NOT_ZIP", "Không tìm thấy mục lục của gói ZIP.");
        const count = view.getUint16(eocd + 10, true);
        const cdSize = view.getUint32(eocd + 12, true);
        const cdOffset = view.getUint32(eocd + 16, true);
        if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
            throw new BookFormatError("ZIP64", "Gói ZIP64 chưa được hỗ trợ.");
        }
        if (count > limits.maxEntries) throw new BookFormatError("TOO_MANY_ENTRIES", "Gói có quá nhiều tệp con.");
        if (cdOffset + cdSize > blob.size) throw new BookFormatError("CORRUPT", "Mục lục ZIP bị hỏng.");

        const cd = await bytes(blob, cdOffset, cdOffset + cdSize);
        const cdView = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
        const utf8 = new TextDecoder("utf-8");
        const entries = new Map<string, ZipEntry>();
        let pos = 0;
        let total = 0;
        for (let n = 0; n < count; n++) {
            if (pos + 46 > cd.length || cdView.getUint32(pos, true) !== CEN_SIG) throw new BookFormatError("CORRUPT", "Mục lục ZIP bị hỏng.");
            const flags = cdView.getUint16(pos + 8, true);
            const method = cdView.getUint16(pos + 10, true);
            const compressedSize = cdView.getUint32(pos + 20, true);
            const size = cdView.getUint32(pos + 24, true);
            const nameLen = cdView.getUint16(pos + 28, true);
            const extraLen = cdView.getUint16(pos + 30, true);
            const commentLen = cdView.getUint16(pos + 32, true);
            const localOffset = cdView.getUint32(pos + 42, true);
            const rawName = utf8.decode(cd.subarray(pos + 46, pos + 46 + nameLen));
            pos += 46 + nameLen + extraLen + commentLen;
            if (rawName.endsWith("/")) continue; // directory
            const name = normalizeZipPath(rawName);
            if (!name) continue; // traversal / absolute: ignored, never resolvable
            if (localOffset + 30 > blob.size || compressedSize > blob.size) throw new BookFormatError("CORRUPT", "Dữ liệu ZIP bị hỏng.");
            if (method === 0 && compressedSize !== size) throw new BookFormatError("ZIP_BOMB", "Tệp con không khớp kích thước đã khai báo.");
            if (size > limits.maxEntrySize) continue; // oversized entries are simply unavailable
            if (compressedSize > 0 && size / compressedSize > limits.maxRatio && size > 1024 * 1024) {
                throw new BookFormatError("ZIP_BOMB", "Gói có tỉ lệ nén bất thường và đã bị từ chối.");
            }
            total += size;
            if (total > limits.maxTotalSize) throw new BookFormatError("TOO_LARGE", "Nội dung giải nén vượt giới hạn an toàn.");
            if (!entries.has(name)) {
                entries.set(name, { name, method, compressedSize, size, localOffset, encrypted: (flags & 1) === 1 });
            }
        }
        return new ZipArchive(blob, entries, limits);
    }

    has(name: string): boolean {
        return this.entries.has(name);
    }

    /** Case-insensitive fallback lookup (some packages reference files with the wrong case). */
    find(name: string): ZipEntry | undefined {
        const exact = this.entries.get(name);
        if (exact) return exact;
        const lower = name.toLowerCase();
        for (const [key, entry] of this.entries) if (key.toLowerCase() === lower) return entry;
        return undefined;
    }

    async read(name: string, maxSize = this.limits.maxEntrySize): Promise<Uint8Array> {
        const entry = this.find(name);
        if (!entry) throw new BookFormatError("MISSING", `Thiếu tệp ${name} trong gói.`);
        if (entry.encrypted) throw new BookFormatError("ENCRYPTED", "Tệp trong gói đã bị mã hóa.");
        const effectiveMaxEntry = Math.min(maxSize, this.limits.maxEntrySize);
        if (entry.size > effectiveMaxEntry) throw new BookFormatError("TOO_LARGE", "Tệp con vượt giới hạn an toàn.");
        const local = await bytes(this.blob, entry.localOffset, entry.localOffset + 30);
        const lv = new DataView(local.buffer, local.byteOffset, local.byteLength);
        if (local.length < 30 || lv.getUint32(0, true) !== LOC_SIG) throw new BookFormatError("CORRUPT", "Dữ liệu ZIP bị hỏng.");
        const dataStart = entry.localOffset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
        if (dataStart + entry.compressedSize > this.blob.size) throw new BookFormatError("CORRUPT", "Dữ liệu ZIP bị hỏng.");
        const raw = this.blob.slice(dataStart, dataStart + entry.compressedSize);
        const previousActual = this.entryActualSizes.get(entry.name) ?? 0;
        const baseTotal = this.totalActualBytes - previousActual;

        if (entry.method === 0) {
            if (entry.compressedSize !== entry.size) throw new BookFormatError("ZIP_BOMB", "Tệp con lớn hơn kích thước đã khai báo.");
            if (entry.compressedSize > effectiveMaxEntry) throw new BookFormatError("TOO_LARGE", "Tệp con vượt giới hạn an toàn.");
            if (baseTotal + entry.compressedSize > this.limits.maxTotalSize) {
                throw new BookFormatError("TOO_LARGE", "Nội dung giải nén vượt giới hạn an toàn.");
            }
            const out = new Uint8Array(await raw.arrayBuffer());
            if (out.byteLength > effectiveMaxEntry || out.byteLength > entry.size) {
                throw new BookFormatError("ZIP_BOMB", "Tệp con lớn hơn kích thước đã khai báo.");
            }
            if (baseTotal + out.byteLength > this.limits.maxTotalSize) {
                throw new BookFormatError("TOO_LARGE", "Nội dung giải nén vượt giới hạn an toàn.");
            }
            this.entryActualSizes.set(entry.name, out.byteLength);
            this.totalActualBytes = baseTotal + out.byteLength;
            return out;
        }
        if (entry.method !== 8) throw new BookFormatError("UNSUPPORTED", "Kiểu nén không được hỗ trợ.");
        if (typeof DecompressionStream === "undefined") throw new BookFormatError("UNSUPPORTED", "Trình duyệt chưa hỗ trợ giải nén.");

        // Enforce declared entry size (including 0), effective entry limit, cumulative archive inflated bytes, and live ratio.
        const entryLimit = Math.min(effectiveMaxEntry, entry.size);
        const reader = raw.stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > entryLimit) {
                await reader.cancel().catch(() => undefined);
                throw new BookFormatError("ZIP_BOMB", "Tệp con lớn hơn kích thước đã khai báo.");
            }
            if (baseTotal + length > this.limits.maxTotalSize) {
                await reader.cancel().catch(() => undefined);
                throw new BookFormatError("TOO_LARGE", "Nội dung giải nén vượt giới hạn an toàn.");
            }
            if (entry.compressedSize > 0 && length > 1024 * 1024 && length / entry.compressedSize > this.limits.maxRatio) {
                await reader.cancel().catch(() => undefined);
                throw new BookFormatError("ZIP_BOMB", "Gói có tỉ lệ nén bất thường và đã bị từ chối.");
            }
            chunks.push(value);
        }
        this.entryActualSizes.set(entry.name, length);
        this.totalActualBytes = baseTotal + length;
        const out = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }

    async readText(name: string, maxSize?: number): Promise<string> {
        return decodeMarkup(await this.read(name, maxSize));
    }

    async readBlob(name: string, type: string, maxSize?: number): Promise<Blob> {
        const entry = this.find(name);
        const effectiveMaxEntry = Math.min(maxSize ?? this.limits.maxEntrySize, this.limits.maxEntrySize);
        if (entry && entry.method === 0 && !entry.encrypted && entry.compressedSize === entry.size && entry.size <= effectiveMaxEntry) {
            const previousActual = this.entryActualSizes.get(entry.name) ?? 0;
            const baseTotal = this.totalActualBytes - previousActual;
            if (baseTotal + entry.size > this.limits.maxTotalSize) {
                throw new BookFormatError("TOO_LARGE", "Nội dung giải nén vượt giới hạn an toàn.");
            }
            // stored entry: a slice of the archive, never copied into memory
            const local = await bytes(this.blob, entry.localOffset, entry.localOffset + 30);
            const lv = new DataView(local.buffer, local.byteOffset, local.byteLength);
            if (local.length === 30 && lv.getUint32(0, true) === LOC_SIG) {
                const dataStart = entry.localOffset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
                if (dataStart + entry.size > this.blob.size) throw new BookFormatError("CORRUPT", "Dữ liệu ZIP bị hỏng.");
                this.entryActualSizes.set(entry.name, entry.size);
                this.totalActualBytes = baseTotal + entry.size;
                return this.blob.slice(dataStart, dataStart + entry.size, type);
            }
        }
        const data = await this.read(name, maxSize);
        return new Blob([data as BlobPart], { type });
    }
}

/** Decodes an XML / HTML document, honouring a BOM and the XML declaration's encoding. */
export function decodeMarkup(data: Uint8Array): string {
    if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
    if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
    const head = new TextDecoder("latin1").decode(data.subarray(0, 200));
    const declared = /encoding\s*=\s*["']([\w.-]+)["']/i.exec(head)?.[1];
    if (declared && !/^utf-?8$/i.test(declared)) {
        try { return new TextDecoder(declared).decode(data); } catch { /* fall through to UTF-8 */ }
    }
    return new TextDecoder("utf-8").decode(data);
}
