/**
 * Book import for My Books: validates the file (extension + signature + structure + size), reads only the
 * metadata and cover it needs, and returns a shelf record. The original file is kept as-is (no conversion, no
 * Base64, no full-text extraction); nothing leaves the device.
 */
import { BookFormatError } from "../engine/zip";
import { openEpubPackage, readEpubCover } from "../engine/epub";
import type { BookFormat, BookMeta } from "../engine/types";
import { fingerprint, newId } from "./bookStore";

export const LIMITS: Record<BookFormat, number> = { epub: 300 * 1024 * 1024, pdf: 600 * 1024 * 1024, txt: 32 * 1024 * 1024 };
export const ACCEPT = ".epub,.pdf,.txt,application/epub+zip,application/pdf,text/plain";

export function formatOf(file: File): BookFormat | null {
    const name = file.name.toLowerCase();
    if (name.endsWith(".epub")) return "epub";
    if (name.endsWith(".pdf")) return "pdf";
    if (name.endsWith(".txt") || name.endsWith(".text")) return "txt";
    if (file.type === "application/epub+zip") return "epub";
    if (file.type === "application/pdf") return "pdf";
    if (file.type === "text/plain") return "txt";
    return null;
}

function titleFromName(name: string) {
    return name.replace(/\.(epub|pdf|txt|text)$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim() || "Sách không tên";
}

async function thumbnail(image: Blob): Promise<Blob | null> {
    try {
        if (image.size > 25 * 1024 * 1024) return null;
        const bitmap = await createImageBitmap(image);
        const scale = Math.min(1, 360 / bitmap.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        const out = await new Promise<Blob | null>((r) => canvas.toBlob((b) => r(b), "image/jpeg", 0.84));
        canvas.width = 0;
        return out;
    } catch {
        return null;
    }
}

export interface PreparedBook {
    meta: BookMeta;
    file: Blob;
    cover: Blob | null;
}

/** Validates and inspects a file. Throws BookFormatError with a learner-facing Vietnamese message. */
export async function prepareBook(file: File): Promise<PreparedBook> {
    const format = formatOf(file);
    if (!format) throw new BookFormatError("UNSUPPORTED", "Định dạng chưa được hỗ trợ. My Books mở EPUB, PDF và TXT.");
    if (file.size === 0) throw new BookFormatError("EMPTY", "Tệp trống.");
    if (file.size > LIMITS[format]) {
        throw new BookFormatError("TOO_LARGE", `Tệp quá lớn (giới hạn ${Math.round(LIMITS[format] / 1024 / 1024)} MB cho ${format.toUpperCase()}).`);
    }
    const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    let title = titleFromName(file.name), author = "", language: string | null = null, cover: Blob | null = null, pageCount: number | null = null;

    if (format === "epub") {
        if (!(head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)) {
            throw new BookFormatError("NOT_EPUB", "Tệp không phải EPUB hợp lệ (thiếu chữ ký ZIP).");
        }
        const pkg = await openEpubPackage(file);
        title = pkg.title || title;
        author = pkg.author;
        language = pkg.language;
        const image = await readEpubCover(pkg);
        cover = image ? await thumbnail(image) : null;
    } else if (format === "pdf") {
        const signature = new TextDecoder("latin1").decode(head);
        if (!signature.includes("%PDF-")) throw new BookFormatError("NOT_PDF", "Tệp không phải PDF hợp lệ.");
        const { pdfImportInfo } = await import("../engine/pdf");
        try {
            const info = await pdfImportInfo(file);
            title = info.title && info.title.length > 2 && !/^untitled|^microsoft word/i.test(info.title) ? info.title : title;
            author = info.author;
            cover = info.cover;
            pageCount = info.pages;
        } catch (error) {
            const name = (error as { name?: string })?.name;
            if (name === "PasswordException") throw new BookFormatError("ENCRYPTED", "PDF được đặt mật khẩu nên không thể mở.");
            throw new BookFormatError("CORRUPT", "PDF bị hỏng hoặc không đọc được.");
        }
    } else {
        const sample = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
        const utf16 = (sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff);
        if (!utf16 && sample.some((b) => b === 0)) throw new BookFormatError("NOT_TEXT", "Tệp này không phải văn bản thuần (TXT).");
    }

    const meta: BookMeta = {
        id: newId(),
        title: title.slice(0, 300),
        author: author.slice(0, 200),
        format,
        fileName: file.name.slice(0, 260),
        size: file.size,
        fingerprint: await fingerprint(file),
        language,
        addedAt: Date.now(),
        lastOpenedAt: null,
        progress: 0,
        status: "new",
        collections: [],
        hasCover: Boolean(cover),
        pageCount,
    };
    return { meta, file, cover };
}
