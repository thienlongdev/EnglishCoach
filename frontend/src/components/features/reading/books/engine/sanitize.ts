/**
 * Book content sanitizer (My Books).
 *
 * Imported books are untrusted. Their XHTML is parsed by `DOMParser` (no browsing context: nothing loads, nothing
 * runs) and then REBUILT element by element from an allow-list into the reader's own document — there is no
 * `innerHTML` and no markup string anywhere. Scripts, forms, frames, objects, media, event attributes, `javascript:`
 * and every external resource are dropped; images become `blob:` URLs of files inside the book package only; links
 * become inert data attributes the reader resolves on an explicit click.
 *
 * Publisher CSS is filtered property by property (no `url()`, no fonts, no colours / backgrounds outside fixed
 * layout, no fixed or absolute positioning in reflowable books, no absolute font sizes) and every selector is scoped
 * to the book body, so a book can style its own text but never the reader around it.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const MATH_NS = "http://www.w3.org/1998/Math/MathML";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const OPS_NS = "http://www.idpf.org/2007/ops";

const HTML_KEEP = new Set([
    "a", "abbr", "acronym", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br", "caption", "center",
    "cite", "code", "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer",
    "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol",
    "p", "pre", "q", "rb", "rp", "rt", "rtc", "ruby", "s", "samp", "section", "small", "span", "strike", "strong", "sub",
    "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "tt", "u", "ul", "var", "wbr",
]);
const HTML_RENAME: Record<string, string> = { font: "span", basefont: "span", blink: "span", marquee: "div", listing: "pre", xmp: "pre", plaintext: "pre" };
const DROP_WITH_CONTENT = new Set([
    "script", "style", "noscript", "iframe", "object", "embed", "applet", "form", "input", "button", "select", "textarea",
    "option", "optgroup", "datalist", "output", "link", "meta", "base", "frame", "frameset", "template", "canvas", "dialog",
    "portal", "title", "head", "param", "map", "area", "slot", "math-annotation",
]);
const MEDIA = new Set(["audio", "video"]);
const SVG_KEEP = new Set([
    "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath", "defs", "use",
    "image", "title", "desc", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "symbol", "marker",
]);
const MATH_KEEP = new Set([
    "math", "mi", "mn", "mo", "ms", "mrow", "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "mtext", "mspace", "mtable",
    "mtr", "mtd", "munder", "mover", "munderover", "mstyle", "mpadded", "mphantom", "menclose", "mfenced", "semantics",
    "annotation", "mmultiscripts", "mprescripts", "none", "merror", "mlabeledtr",
]);

const HTML_ATTRS = new Set(["id", "title", "colspan", "rowspan", "headers", "scope", "span", "alt", "width", "height", "start",
    "reversed", "type", "value", "datetime", "align", "valign", "role", "aria-label", "abbr", "open"]);
const SVG_ATTRS = new Set(["id", "class", "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy",
    "points", "viewBox", "preserveAspectRatio", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap",
    "stroke-linejoin", "stroke-opacity", "stroke-dasharray", "stroke-miterlimit", "transform", "font-size", "font-weight",
    "font-style", "text-anchor", "dominant-baseline", "opacity", "offset", "stop-color", "stop-opacity", "gradientUnits",
    "gradientTransform", "patternUnits", "patternContentUnits", "patternTransform", "spreadMethod", "clip-path", "clip-rule",
    "mask", "width", "height", "dx", "dy", "rotate", "textLength", "lengthAdjust", "markerWidth", "markerHeight", "refX",
    "refY", "orient", "visibility", "display", "maskUnits", "maskContentUnits", "clipPathUnits", "startOffset"]);
const MATH_ATTRS = new Set(["mathvariant", "display", "mathsize", "fence", "separator", "separators", "stretchy", "accent",
    "accentunder", "lspace", "rspace", "columnalign", "rowalign", "columnspan", "rowspan", "linethickness", "notation",
    "open", "close", "width", "height", "depth", "scriptlevel", "displaystyle", "form", "largeop", "movablelimits",
    "symmetric", "minsize", "maxsize", "encoding", "align"]);

export interface SanitizeContext {
    fixedLayout: boolean;
    /** Returns a blob: URL for a book-internal image, or null. */
    resolveImage(href: string): string | null;
    /** Classifies a link: a book-internal target (archive path + fragment) or an external http(s)/mailto URL. */
    resolveLink(href: string): { internal: string } | { external: string } | null;
    maxNodes?: number;
}

export interface SanitizedChapter {
    root: HTMLElement;
    nodeCount: number;
}

const FORBIDDEN_VALUE = /url\s*\(|expression\s*\(|javascript:|vbscript:|@import|behavior\s*:|-moz-binding|\\/i;
const SAFE_LOCAL_URL = /^\s*url\(\s*["']?#[\w.-]+["']?\s*\)\s*$/i;

const REFLOW_PROPS = new Set([
    "font-style", "font-weight", "font-variant", "font-variant-caps", "font-variant-ligatures", "font-variant-numeric",
    "font-variant-east-asian", "font-feature-settings", "font-size", "font-stretch", "text-align", "text-align-last",
    "text-indent", "text-transform", "text-decoration-line", "text-decoration-style", "text-decoration-thickness",
    "text-underline-offset", "text-underline-position", "letter-spacing", "word-spacing", "white-space",
    "white-space-collapse", "text-wrap-mode", "text-wrap-style", "vertical-align", "hyphens", "-webkit-hyphens",
    "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom",
    "padding-left", "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
    "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-top-left-radius",
    "border-top-right-radius", "border-bottom-left-radius", "border-bottom-right-radius", "list-style-type",
    "list-style-position", "display", "float", "clear", "width", "max-width", "min-width", "height", "max-height",
    "min-height", "page-break-before", "page-break-after", "page-break-inside", "break-before", "break-after",
    "break-inside", "orphans", "widows", "caption-side", "empty-cells", "border-collapse", "border-spacing",
    "table-layout", "direction", "unicode-bidi", "visibility", "content", "quotes", "counter-reset", "counter-increment",
    "ruby-position", "ruby-align", "text-emphasis-style", "text-emphasis-position", "font-kerning", "text-rendering",
    "box-sizing", "text-combine-upright",
    // SVG presentation
    "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-opacity",
    "stroke-dasharray", "text-anchor", "dominant-baseline", "stop-color", "stop-opacity", "clip-path", "clip-rule", "mask",
]);
const FIXED_EXTRA = new Set([
    "position", "top", "right", "bottom", "left", "z-index", "transform", "transform-origin", "opacity", "overflow-x",
    "overflow-y", "color", "background-color", "line-height", "border-top-color", "border-right-color", "border-bottom-color",
    "border-left-color", "letter-spacing", "column-count", "column-gap",
]);
const DISPLAY_OK = /^(none|block|inline|inline-block|list-item|table|inline-table|table-row|table-cell|table-caption|table-header-group|table-row-group|table-footer-group|table-column|table-column-group|flex|inline-flex|grid|inline-grid|ruby|ruby-base|ruby-text|flow-root|contents)$/;
const ABSOLUTE_SIZE = /(-?[\d.]+)(px|pt|pc|cm|mm|in|q|vw|vh|vmin|vmax)\b/i;

function allowedValue(prop: string, value: string, fixed: boolean): string | null {
    const v = value.trim();
    if (!v || v.length > 300) return null;
    if (FORBIDDEN_VALUE.test(v)) {
        if ((prop === "clip-path" || prop === "mask" || prop === "fill" || prop === "stroke") && SAFE_LOCAL_URL.test(v)) return v;
        return null;
    }
    if (prop === "display") return DISPLAY_OK.test(v) ? v : null;
    if (prop === "position") return fixed && /^(relative|absolute|static)$/.test(v) ? v : (/^(relative|static)$/.test(v) ? v : null);
    if (prop === "font-size") {
        if (fixed) return v;
        if (ABSOLUTE_SIZE.test(v)) return null; // the reader's size wins over absolute publisher sizes
        const em = /^([\d.]+)(em|rem)$/.exec(v);
        if (em && Number(em[1]) > 4) return null;
        const pct = /^([\d.]+)%$/.exec(v);
        if (pct && Number(pct[1]) > 400) return null;
        return v;
    }
    if (prop === "content") return /^(normal|none|"[^"]{0,40}"|'[^']{0,40}'|open-quote|close-quote|no-open-quote|no-close-quote|counter\([\w-]+\)|counters\([\w-]+,\s*"[^"]{0,4}"\))(\s+("[^"]{0,40}"|counter\([\w-]+\)))*$/.test(v) ? v : null;
    if (!fixed && (prop === "height" || prop === "min-height")) {
        const px = /^([\d.]+)px$/.exec(v);
        if (px && Number(px[1]) > 1200) return null;
    }
    if (!fixed && /^margin-|^padding-|^text-indent$/.test(prop)) {
        const m = /^(-?[\d.]+)(px|em|rem|%)$/.exec(v);
        if (m) {
            const n = Math.abs(Number(m[1]));
            if ((m[2] === "px" && n > 400) || ((m[2] === "em" || m[2] === "rem") && n > 25) || (m[2] === "%" && n > 60)) return null;
        }
    }
    return v;
}

/** Filters a declaration block (rule.style or an element's inline style) into safe `prop: value` text. */
export function filterDeclarations(style: CSSStyleDeclaration, fixed: boolean): string {
    const out: string[] = [];
    for (let i = 0; i < style.length; i++) {
        const prop = style.item(i);
        if (!(REFLOW_PROPS.has(prop) || (fixed && FIXED_EXTRA.has(prop)))) continue;
        const value = allowedValue(prop, style.getPropertyValue(prop), fixed);
        if (value !== null) out.push(`${prop}: ${value}`);
    }
    return out.join("; ");
}

let probe: HTMLElement | null = null;
export function sanitizeInlineStyle(value: string, fixed: boolean): string {
    if (!value || value.length > 4000) return "";
    probe ??= document.createElement("div");
    probe.style.cssText = value;
    const result = filterDeclarations(probe.style, fixed);
    probe.removeAttribute("style");
    return result;
}

const BODY_SELECTOR = /(^|[\s>+~,(])(html|body|:root)(?=$|[\s.#:[>+~,)])/gi;
function scopeSelector(selector: string): string | null {
    const parts: string[] = [];
    for (const raw of splitSelectorList(selector)) {
        let s = raw.trim();
        if (!s || s.length > 400 || /\bec-|:host|::slotted|::part/.test(s)) continue;
        s = s.replace(BODY_SELECTOR, "$1.ec-body").replace(/(\.ec-body)(\s*>?\s*\.ec-body)+/g, "$1");
        parts.push(s.startsWith(".ec-body") ? s : `.ec-body ${s}`);
    }
    return parts.length ? parts.join(", ") : null;
}
function splitSelectorList(selector: string): string[] {
    const out: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < selector.length; i++) {
        const c = selector[i];
        if (c === "(" || c === "[") depth++;
        else if (c === ")" || c === "]") depth--;
        else if (c === "," && depth === 0) { out.push(selector.slice(start, i)); start = i + 1; }
    }
    out.push(selector.slice(start));
    return out;
}

function walkRules(rules: CSSRuleList, fixed: boolean, out: string[], budget: { n: number }) {
    for (let i = 0; i < rules.length && budget.n > 0; i++) {
        const rule = rules[i];
        if (rule instanceof CSSStyleRule) {
            const selector = scopeSelector(rule.selectorText);
            if (!selector) continue;
            const body = filterDeclarations(rule.style, fixed);
            if (body) { out.push(`${selector} { ${body} }`); budget.n--; }
        } else if (typeof CSSMediaRule !== "undefined" && rule instanceof CSSMediaRule) {
            const inner: string[] = [];
            walkRules(rule.cssRules, fixed, inner, budget);
            const condition = rule.conditionText || rule.media.mediaText;
            if (inner.length && !/\bprint\b/i.test(condition) && !FORBIDDEN_VALUE.test(condition)) out.push(`@media ${condition} { ${inner.join("\n")} }`);
        } else if (typeof CSSSupportsRule !== "undefined" && rule instanceof CSSSupportsRule) {
            const inner: string[] = [];
            walkRules(rule.cssRules, fixed, inner, budget);
            if (inner.length && !FORBIDDEN_VALUE.test(rule.conditionText)) out.push(`@supports ${rule.conditionText} { ${inner.join("\n")} }`);
        }
        // @font-face, @import, @page, @keyframes, @namespace: dropped
    }
}

/** Sanitizes a publisher stylesheet; the result is scoped to `.ec-body` and safe to place in the reader's shadow root. */
export function sanitizeCss(css: string, fixed: boolean): string {
    if (!css || typeof CSSStyleSheet === "undefined") return "";
    const sheet = new CSSStyleSheet();
    try {
        sheet.replaceSync(css.slice(0, 600_000).replace(/@import[^;]*;/gi, ""));
    } catch {
        return "";
    }
    const out: string[] = [];
    walkRules(sheet.cssRules, fixed, out, { n: 6000 });
    return out.join("\n");
}

function epubType(el: Element): string | null {
    return el.getAttributeNS(OPS_NS, "type") || el.getAttribute("epub:type");
}

/** Image references (raw href strings) of a source body, so the caller can load them before the synchronous rebuild. */
export function collectImageHrefs(body: Element): string[] {
    const refs: string[] = [];
    for (const img of Array.from(body.getElementsByTagName("img"))) {
        const src = img.getAttribute("src");
        if (src) refs.push(src);
    }
    for (const image of Array.from(body.getElementsByTagNameNS(SVG_NS, "image"))) {
        const href = image.getAttributeNS(XLINK_NS, "href") || image.getAttribute("href");
        if (href) refs.push(href);
    }
    return refs;
}

/** Rebuilds a source `<body>` (from DOMParser) as a safe element tree in the reader's document. */
export function sanitizeBody(body: Element, ctx: SanitizeContext): SanitizedChapter {
    const run = rebuild(body, ctx);
    let step = run.next();
    while (!step.done) step = run.next();
    return step.value;
}

/**
 * The same rebuild in slices of about `sliceMs`: `pause` is awaited between them, so a large chapter loaded in the
 * background (page counting, the next chapter) never holds the main thread while the reader turns a page.
 */
export async function sanitizeBodyInSlices(body: Element, ctx: SanitizeContext, pause: () => Promise<void>, sliceMs = 6): Promise<SanitizedChapter> {
    const run = rebuild(body, ctx);
    let since = performance.now();
    for (let step = run.next(); ; step = run.next()) {
        if (step.done) return step.value;
        if (performance.now() - since >= sliceMs) {
            await pause();
            since = performance.now();
        }
    }
}

/** The rebuild itself; yields every 128 source nodes (a point where it may pause). */
function* rebuild(body: Element, ctx: SanitizeContext): Generator<void, SanitizedChapter, void> {
    const doc = document;
    const maxNodes = ctx.maxNodes ?? 250_000;
    let nodes = 0;
    const root = doc.createElement("div");
    root.className = "ec-body";
    copyCommon(body, root, ctx, false);
    const bodyClass = (body.getAttribute("class") || "").split(/\s+/).filter((c) => c && !c.startsWith("ec-") && c.length < 64);
    root.className = ["ec-body", ...bodyClass].join(" ");

    const visit = function* (src: Node, dst: Element | DocumentFragment, depth: number, inSvg: boolean, inMath: boolean): Generator<void, void, void> {
        for (let child = src.firstChild; child; child = child.nextSibling) {
            if (++nodes > maxNodes) return;
            if ((nodes & 127) === 0) yield;
            if (child.nodeType === 3 || child.nodeType === 4) {
                dst.appendChild(doc.createTextNode((child as CharacterData).data));
                continue;
            }
            if (child.nodeType !== 1) continue;
            const el = child as Element;
            const ns = el.namespaceURI;
            const name = el.localName;
            const lower = name.toLowerCase();
            if (depth > 180) { yield* visit(el, dst, depth, inSvg, inMath); continue; }

            if (ns === OPS_NS) {
                if (lower === "switch") {
                    const fallback = Array.from(el.children).find((c) => c.localName === "default");
                    if (fallback) yield* visit(fallback, dst, depth + 1, inSvg, inMath);
                }
                continue;
            }
            if (inSvg || ns === SVG_NS || lower === "svg") {
                if (lower === "foreignobject" || lower === "script" || lower === "style" || !SVG_KEEP.has(name) && !SVG_KEEP.has(lower)) continue;
                const out = doc.createElementNS(SVG_NS, SVG_KEEP.has(name) ? name : lower);
                copySvg(el, out, ctx);
                dst.appendChild(out);
                yield* visit(el, out, depth + 1, true, false);
                continue;
            }
            if (inMath || ns === MATH_NS || lower === "math") {
                if (!MATH_KEEP.has(lower)) continue;
                if (lower === "annotation" && !/^(text\/plain|application\/x-tex)$/i.test(el.getAttribute("encoding") || "")) continue;
                const out = doc.createElementNS(MATH_NS, lower);
                for (const attr of Array.from(el.attributes)) {
                    if (MATH_ATTRS.has(attr.localName) && !FORBIDDEN_VALUE.test(attr.value)) out.setAttribute(attr.localName, attr.value.slice(0, 200));
                }
                dst.appendChild(out);
                yield* visit(el, out, depth + 1, false, true);
                continue;
            }
            if (DROP_WITH_CONTENT.has(lower)) continue;
            if (MEDIA.has(lower)) {
                const note = doc.createElement("span");
                note.className = "ec-media";
                note.setAttribute("data-ec-nt", "");
                note.textContent = lower === "audio" ? "[Âm thanh trong sách — không phát trong trình đọc]" : "[Video trong sách — không phát trong trình đọc]";
                dst.appendChild(note);
                continue;
            }
            const tag = HTML_KEEP.has(lower) ? lower : HTML_RENAME[lower];
            if (!tag) { yield* visit(el, dst, depth + 1, false, false); continue; } // unknown: keep the text, drop the wrapper

            if (tag === "img") {
                const src = el.getAttribute("src");
                const url = src ? ctx.resolveImage(src) : null;
                if (!url) {
                    const alt = el.getAttribute("alt");
                    if (alt) {
                        const span = doc.createElement("span");
                        span.className = "ec-missing-img";
                        span.setAttribute("data-ec-nt", "");
                        span.textContent = alt.slice(0, 300);
                        dst.appendChild(span);
                    }
                    continue;
                }
                const img = doc.createElement("img");
                img.src = url;
                img.decoding = "async";
                img.draggable = false;
                copyCommon(el, img, ctx, true);
                dst.appendChild(img);
                continue;
            }
            const out = doc.createElement(tag);
            copyCommon(el, out, ctx, true);
            if (tag === "a") {
                const href = el.getAttribute("href") || el.getAttributeNS(XLINK_NS, "href");
                const target = href ? ctx.resolveLink(href) : null;
                if (target && "internal" in target) out.setAttribute("data-ec-href", target.internal);
                else if (target && "external" in target) out.setAttribute("data-ec-ext", target.external);
            }
            if (tag === "details") out.setAttribute("open", "");
            dst.appendChild(out);
            yield* visit(el, out, depth + 1, false, false);
        }
    };
    yield* visit(body, root, 0, false, false);
    return { root, nodeCount: nodes };
}

function copyCommon(src: Element, dst: Element, ctx: SanitizeContext, withClass: boolean) {
    for (const attr of Array.from(src.attributes)) {
        const name = attr.name.toLowerCase();
        const local = attr.localName.toLowerCase();
        const value = attr.value;
        if (name.startsWith("on") || FORBIDDEN_VALUE.test(value) && name !== "style") continue;
        if (name === "class") {
            if (!withClass) continue;
            const cls = value.split(/\s+/).filter((c) => c && !c.startsWith("ec-") && c.length < 64).slice(0, 12).join(" ");
            if (cls) dst.setAttribute("class", cls);
        } else if (name === "style") {
            const style = sanitizeInlineStyle(value, ctx.fixedLayout);
            if (style) dst.setAttribute("style", style);
        } else if (name === "lang" || name === "xml:lang") {
            if (/^[a-z]{2,3}(-[\w]{1,8})*$/i.test(value)) dst.setAttribute("lang", value);
        } else if (name === "dir") {
            if (/^(ltr|rtl|auto)$/i.test(value)) dst.setAttribute("dir", value.toLowerCase());
        } else if (local === "type" && (attr.namespaceURI === OPS_NS || name === "epub:type")) {
            dst.setAttribute("data-epub-type", value.slice(0, 100));
        } else if (HTML_ATTRS.has(name)) {
            if ((name === "width" || name === "height") && !/^\d{1,5}(%|px)?$/.test(value.trim())) continue;
            dst.setAttribute(name, value.slice(0, 500));
        }
    }
    const type = epubType(src);
    if (type && !dst.hasAttribute("data-epub-type")) dst.setAttribute("data-epub-type", type.slice(0, 100));
}

function copySvg(src: Element, dst: Element, ctx: SanitizeContext) {
    for (const attr of Array.from(src.attributes)) {
        const name = attr.localName;
        const value = attr.value;
        if (name.toLowerCase().startsWith("on")) continue;
        if (name === "href" && (attr.namespaceURI === XLINK_NS || attr.namespaceURI === null)) {
            if (src.localName === "image") {
                const url = ctx.resolveImage(value);
                if (url) dst.setAttributeNS(null, "href", url);
            } else if (/^#[\w.-]+$/.test(value) && src.localName === "use") {
                dst.setAttributeNS(null, "href", value);
            }
            continue;
        }
        if (name === "style") {
            const style = sanitizeInlineStyle(value, true);
            if (style) dst.setAttribute("style", style);
            continue;
        }
        if (!SVG_ATTRS.has(name)) continue;
        if (FORBIDDEN_VALUE.test(value) && !SAFE_LOCAL_URL.test(value)) continue;
        dst.setAttributeNS(null, name, value.slice(0, 20000));
    }
}
