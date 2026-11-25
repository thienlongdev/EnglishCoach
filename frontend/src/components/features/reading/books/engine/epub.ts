/**
 * EPUB 2 / 3 package support for My Books: container → OPF (metadata, manifest, spine, rendition) → navigation
 * (EPUB 3 nav document or EPUB 2 NCX) → chapters loaded on demand and rebuilt by the sanitizer.
 */
import { BookFormatError, ZipArchive, normalizeZipPath } from "./zip";
import { collectImageHrefs, sanitizeBody, sanitizeBodyInSlices, sanitizeCss, type SanitizeContext } from "./sanitize";
import type { FlowSource, LoadedChapter, SpineEntry, TocItem } from "./types";
import { textOfRoot } from "./text";

const OPF_NS = "http://www.idpf.org/2007/opf";
const OPS_NS = "http://www.idpf.org/2007/ops";

interface ManifestItem { id: string; href: string; type: string; properties: string }

export interface EpubPackage {
    zip: ZipArchive;
    opfPath: string;
    title: string;
    author: string;
    language: string | null;
    manifest: Map<string, ManifestItem>;
    byPath: Map<string, ManifestItem>;
    spine: SpineEntry[];
    spineIds: string[];
    coverPath: string | null;
    fixedLayout: boolean;
    navPath: string | null;
    ncxPath: string | null;
}

function parseXml(text: string): Document {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) {
        throw new BookFormatError("CORRUPT", "Tệp mô tả sách bị hỏng.");
    }
    return doc;
}

function byLocal(root: ParentNode, name: string): Element[] {
    const all = (root as Element | Document).getElementsByTagName("*");
    const out: Element[] = [];
    for (let i = 0; i < all.length; i++) if (all[i].localName === name) out.push(all[i]);
    return out;
}

function dirname(path: string) {
    const i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i + 1);
}

/** Resolves an href relative to a file inside the archive; null if it leaves the root or is not a local path. */
export function resolveHref(base: string, href: string): { path: string; frag: string | null } | null {
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
    const hash = href.indexOf("#");
    const frag = hash >= 0 ? href.slice(hash + 1) : null;
    let rel = hash >= 0 ? href.slice(0, hash) : href;
    rel = rel.split("?")[0];
    let decoded = rel;
    try { decoded = decodeURIComponent(rel); } catch { /* keep raw */ }
    if (!decoded) return { path: base, frag };
    const path = normalizeZipPath(decoded.startsWith("/") ? decoded : dirname(base) + decoded);
    return path ? { path, frag } : null;
}

const DRM_SAFE_ALGORITHMS = ["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"];

export async function openEpubPackage(blob: Blob): Promise<EpubPackage> {
    const zip = await ZipArchive.open(blob);
    const mimetype = zip.has("mimetype") ? (await zip.readText("mimetype", 1024)).trim() : null;
    if (mimetype && mimetype !== "application/epub+zip") throw new BookFormatError("NOT_EPUB", "Gói ZIP này không phải sách EPUB.");
    if (!zip.has("META-INF/container.xml")) throw new BookFormatError("NOT_EPUB", "Thiếu META-INF/container.xml — không phải EPUB hợp lệ.");

    if (zip.has("META-INF/encryption.xml")) {
        const enc = parseXml(await zip.readText("META-INF/encryption.xml", 2 * 1024 * 1024));
        const methods = byLocal(enc, "EncryptionMethod").map((m) => m.getAttribute("Algorithm") || "");
        if (methods.some((m) => !DRM_SAFE_ALGORITHMS.includes(m))) {
            throw new BookFormatError("DRM", "Sách này được bảo vệ bằng DRM nên không thể mở. My Books không vượt qua DRM.");
        }
    }
    if (zip.has("META-INF/rights.xml")) {
        throw new BookFormatError("DRM", "Sách này được bảo vệ bằng DRM nên không thể mở. My Books không vượt qua DRM.");
    }

    const container = parseXml(await zip.readText("META-INF/container.xml", 1024 * 1024));
    const rootfile = byLocal(container, "rootfile").find((r) => (r.getAttribute("media-type") || "application/oebps-package+xml") === "application/oebps-package+xml");
    const opfPath = rootfile ? normalizeZipPath(rootfile.getAttribute("full-path") || "") : null;
    if (!opfPath || !zip.find(opfPath)) throw new BookFormatError("NOT_EPUB", "Không tìm thấy tệp gói (OPF) của sách.");
    const opf = parseXml(await zip.readText(opfPath, 8 * 1024 * 1024));

    const metadata = byLocal(opf, "metadata")[0];
    const text = (name: string) => (metadata ? byLocal(metadata, name)[0]?.textContent?.trim() : undefined) || "";
    const title = text("title");
    const author = metadata ? byLocal(metadata, "creator").map((c) => c.textContent?.trim()).filter(Boolean).slice(0, 3).join(", ") : "";
    const language = text("language") || null;
    const metas = metadata ? byLocal(metadata, "meta") : [];
    const layoutMeta = metas.find((m) => m.getAttribute("property") === "rendition:layout")?.textContent?.trim();
    const fixedLayout = layoutMeta === "pre-paginated";

    const manifest = new Map<string, ManifestItem>();
    const byPath = new Map<string, ManifestItem>();
    for (const item of byLocal(opf, "item")) {
        const id = item.getAttribute("id") || "";
        const resolved = resolveHref(opfPath, item.getAttribute("href") || "");
        if (!id || !resolved) continue;
        const entry = { id, href: resolved.path, type: (item.getAttribute("media-type") || "").toLowerCase(), properties: item.getAttribute("properties") || "" };
        manifest.set(id, entry);
        byPath.set(entry.href, entry);
    }

    const spineEl = byLocal(opf, "spine")[0];
    const spine: SpineEntry[] = [];
    const spineIds: string[] = [];
    for (const ref of spineEl ? byLocal(spineEl, "itemref") : []) {
        const item = manifest.get(ref.getAttribute("idref") || "");
        if (!item || !/x?html|xml/.test(item.type) || !zip.find(item.href)) continue;
        const props = ref.getAttribute("properties") || "";
        const fixed = props.includes("rendition:layout-pre-paginated") || (fixedLayout && !props.includes("rendition:layout-reflowable"));
        spine.push({
            href: item.href,
            weight: Math.max(1, zip.find(item.href)?.size ?? 1),
            linear: ref.getAttribute("linear") !== "no",
            fixed: fixed ? { width: 0, height: 0 } : null,
            spread: props.includes("page-spread-left") ? "left" : props.includes("page-spread-right") ? "right" : null,
        });
        spineIds.push(item.id);
    }
    if (!spine.length) throw new BookFormatError("EMPTY", "Sách không có chương nào để đọc.");

    let coverPath: string | null = null;
    for (const item of manifest.values()) if (item.properties.split(/\s+/).includes("cover-image")) coverPath = item.href;
    if (!coverPath) {
        const coverId = metas.find((m) => m.getAttribute("name") === "cover")?.getAttribute("content");
        const item = coverId ? manifest.get(coverId) : undefined;
        if (item && item.type.startsWith("image/")) coverPath = item.href;
    }
    if (!coverPath) {
        for (const item of manifest.values()) if (item.type.startsWith("image/") && /cover/i.test(item.id + item.href)) { coverPath = item.href; break; }
    }

    const navItem = [...manifest.values()].find((i) => i.properties.split(/\s+/).includes("nav"));
    const ncxId = spineEl?.getAttribute("toc");
    const ncxItem = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((i) => i.type === "application/x-dtbncx+xml");

    return {
        zip, opfPath, title, author, language, manifest, byPath, spine, spineIds,
        coverPath: coverPath && zip.find(coverPath) ? coverPath : null,
        fixedLayout, navPath: navItem?.href ?? null, ncxPath: ncxItem?.href ?? null,
    };
}

function mimeFor(pkg: EpubPackage, path: string): string {
    const declared = pkg.byPath.get(path)?.type;
    if (declared && declared.startsWith("image/")) return declared;
    const ext = path.split(".").pop()?.toLowerCase();
    return ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "svg" ? "image/svg+xml" : ext === "webp" ? "image/webp" : "image/jpeg";
}

export async function readEpubCover(pkg: EpubPackage): Promise<Blob | null> {
    if (!pkg.coverPath) return null;
    try {
        return await pkg.zip.readBlob(pkg.coverPath, mimeFor(pkg, pkg.coverPath), 20 * 1024 * 1024);
    } catch {
        return null;
    }
}

function parseMarkup(text: string): Document {
    const parser = new DOMParser();
    let doc = parser.parseFromString(text, "application/xhtml+xml");
    if (doc.getElementsByTagName("parsererror").length || !doc.body && !byLocal(doc, "body")[0]) {
        doc = parser.parseFromString(text, "text/html");
    }
    return doc;
}

const IMAGE_BUDGET = 160 * 1024 * 1024;

export class EpubSource implements FlowSource {
    readonly kind = "epub" as const;
    readonly title: string;
    readonly author: string;
    readonly language: string | null;
    readonly spine: SpineEntry[];
    readonly fixedLayout: boolean;
    toc: TocItem[] = [];
    private readonly images = new Map<string, { url: string; bytes: number; chapters: Set<number> }>();
    private imageBytes = 0;
    private readonly cssCache = new Map<string, string>();
    private readonly spineIndex = new Map<string, number>();
    private disposed = false;

    constructor(private readonly pkg: EpubPackage) {
        this.title = pkg.title;
        this.author = pkg.author;
        this.language = pkg.language;
        this.spine = pkg.spine;
        this.fixedLayout = pkg.fixedLayout;
        pkg.spine.forEach((s, i) => this.spineIndex.set(s.href, i));
    }

    static async open(blob: Blob): Promise<EpubSource> {
        const source = new EpubSource(await openEpubPackage(blob));
        source.toc = await source.loadToc().catch(() => []);
        if (!source.toc.length) {
            source.toc = source.spine.map((_, i) => ({ label: `Phần ${i + 1}`, target: { s: i }, children: [] }));
        }
        return source;
    }

    private target(path: string, frag: string | null): { s: number; frag?: string } | null {
        const s = this.spineIndex.get(path);
        if (s === undefined) return null;
        return frag ? { s, frag } : { s };
    }

    private async loadToc(): Promise<TocItem[]> {
        const { zip, navPath, ncxPath } = this.pkg;
        if (navPath && zip.find(navPath)) {
            const doc = parseMarkup(await zip.readText(navPath, 4 * 1024 * 1024));
            const navs = byLocal(doc, "nav");
            const nav = navs.find((n) => /\btoc\b/.test(n.getAttributeNS(OPS_NS, "type") || n.getAttribute("epub:type") || "")) || navs[0];
            const list = nav ? byLocal(nav, "ol")[0] : undefined;
            const items = list ? this.navList(list, navPath, 0) : [];
            if (items.length) return items;
        }
        if (ncxPath && zip.find(ncxPath)) {
            const doc = parseXml(await zip.readText(ncxPath, 4 * 1024 * 1024));
            const map = byLocal(doc, "navMap")[0];
            if (map) return this.ncxPoints(map, ncxPath, 0);
        }
        return [];
    }

    private navList(ol: Element, base: string, depth: number): TocItem[] {
        const out: TocItem[] = [];
        if (depth > 8) return out;
        for (const li of Array.from(ol.children).filter((c) => c.localName === "li")) {
            const link = Array.from(li.children).find((c) => c.localName === "a" || c.localName === "span");
            const label = (link?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
            const href = link?.getAttribute("href");
            const resolved = href ? resolveHref(base, href) : null;
            const target = resolved ? this.target(resolved.path, resolved.frag) : null;
            const sub = Array.from(li.children).find((c) => c.localName === "ol");
            const children = sub ? this.navList(sub, base, depth + 1) : [];
            if (label && (target || children.length)) out.push({ label, target: target ?? children[0].target, children });
        }
        return out;
    }

    private ncxPoints(parent: Element, base: string, depth: number): TocItem[] {
        const out: TocItem[] = [];
        if (depth > 8) return out;
        for (const point of Array.from(parent.children).filter((c) => c.localName === "navPoint")) {
            const label = (byLocal(point, "text")[0]?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
            const content = Array.from(point.children).find((c) => c.localName === "content");
            const resolved = resolveHref(base, content?.getAttribute("src") || "");
            const target = resolved ? this.target(resolved.path, resolved.frag) : null;
            const children = this.ncxPoints(point, base, depth + 1);
            if (label && (target || children.length)) out.push({ label, target: target ?? children[0].target, children });
        }
        return out;
    }

    resolveInternal(value: string): { s: number; frag?: string } | null {
        const hash = value.indexOf("#");
        const path = hash >= 0 ? value.slice(0, hash) : value;
        const frag = hash >= 0 ? value.slice(hash + 1) : null;
        return this.target(path, frag);
    }

    private async loadImages(chapter: number, hrefs: string[], base: string) {
        for (const href of hrefs) {
            const resolved = resolveHref(base, href);
            if (!resolved || this.disposed) continue;
            const existing = this.images.get(resolved.path);
            if (existing) { existing.chapters.add(chapter); continue; }
            const entry = this.pkg.zip.find(resolved.path);
            if (!entry || entry.size > 30 * 1024 * 1024) continue;
            try {
                const blob = await this.pkg.zip.readBlob(resolved.path, mimeFor(this.pkg, resolved.path), 30 * 1024 * 1024);
                if (this.disposed) return;
                const url = URL.createObjectURL(blob);
                this.images.set(resolved.path, { url, bytes: blob.size, chapters: new Set([chapter]) });
                this.imageBytes += blob.size;
            } catch { /* a broken image is skipped (its alt text is shown) */ }
        }
    }

    private async stylesFor(doc: Document, path: string, fixed: boolean): Promise<string> {
        const parts: string[] = [];
        const head = doc.head || byLocal(doc, "head")[0];
        if (head) {
            for (const node of Array.from(head.children)) {
                if (node.localName === "link" && /stylesheet/i.test(node.getAttribute("rel") || "")) {
                    const resolved = resolveHref(path, node.getAttribute("href") || "");
                    if (!resolved || !this.pkg.zip.find(resolved.path)) continue;
                    const key = `${resolved.path}|${fixed ? 1 : 0}`;
                    let css = this.cssCache.get(key);
                    if (css === undefined) {
                        try { css = sanitizeCss(await this.pkg.zip.readText(resolved.path, 2 * 1024 * 1024), fixed); } catch { css = ""; }
                        this.cssCache.set(key, css);
                    }
                    parts.push(css);
                } else if (node.localName === "style") {
                    parts.push(sanitizeCss(node.textContent || "", fixed));
                }
            }
        }
        return parts.join("\n");
    }

    private async parseChapter(index: number): Promise<{ doc: Document; body: Element; path: string }> {
        const entry = this.spine[index];
        if (!entry) throw new BookFormatError("MISSING", "Không tìm thấy chương.");
        const text = await this.pkg.zip.readText(entry.href, 24 * 1024 * 1024);
        const doc = parseMarkup(text);
        const body = doc.body || byLocal(doc, "body")[0];
        if (!body) throw new BookFormatError("CORRUPT", "Chương sách bị hỏng.");
        return { doc, body, path: entry.href };
    }

    async loadChapter(index: number, pause?: () => Promise<void>): Promise<LoadedChapter> {
        const { doc, body, path } = await this.parseChapter(index);
        const entry = this.spine[index];
        let fixed: { width: number; height: number } | null = null;
        if (entry.fixed) {
            const viewport = byLocal(doc, "meta").find((m) => (m.getAttribute("name") || "").toLowerCase() === "viewport")?.getAttribute("content") || "";
            const w = Number(/width\s*=\s*(\d+)/i.exec(viewport)?.[1]);
            const h = Number(/height\s*=\s*(\d+)/i.exec(viewport)?.[1]);
            fixed = w > 0 && h > 0 ? { width: Math.min(w, 6000), height: Math.min(h, 8000) } : { width: 1200, height: 1600 };
        }
        await this.loadImages(index, collectImageHrefs(body), path);
        const css = await this.stylesFor(doc, path, Boolean(fixed));
        const ctx: SanitizeContext = {
            fixedLayout: Boolean(fixed),
            resolveImage: (href) => {
                const r = resolveHref(path, href);
                return r ? this.images.get(r.path)?.url ?? null : null;
            },
            resolveLink: (href) => {
                if (/^(https?:|mailto:)/i.test(href.trim())) return { external: href.trim().slice(0, 2000) };
                const r = resolveHref(path, href);
                if (!r) return null;
                return this.spineIndex.has(r.path) ? { internal: r.frag ? `${r.path}#${r.frag}` : r.path } : null;
            },
        };
        // a background load (page counting, the next chapter) is rebuilt in slices with pauses between them
        const { root } = pause ? await sanitizeBodyInSlices(body, ctx, pause) : sanitizeBody(body, ctx);
        return { root, css, fixed };
    }

    async chapterText(index: number): Promise<string> {
        const { body, path } = await this.parseChapter(index);
        const { root } = sanitizeBody(body, {
            fixedLayout: Boolean(this.spine[index].fixed),
            resolveImage: (href) => {
                const r = resolveHref(path, href);
                return r ? this.images.get(r.path)?.url ?? "data:," : "data:,";
            },
            resolveLink: () => null,
        });
        return textOfRoot(root);
    }

    retain(indices: number[]) {
        const keep = new Set(indices);
        if (this.imageBytes <= IMAGE_BUDGET / 2) return;
        for (const [path, image] of this.images) {
            for (const c of image.chapters) if (!keep.has(c)) image.chapters.delete(c);
            if (!image.chapters.size) {
                URL.revokeObjectURL(image.url);
                this.imageBytes -= image.bytes;
                this.images.delete(path);
            }
        }
    }

    dispose() {
        this.disposed = true;
        for (const image of this.images.values()) URL.revokeObjectURL(image.url);
        this.images.clear();
        this.cssCache.clear();
    }
}
