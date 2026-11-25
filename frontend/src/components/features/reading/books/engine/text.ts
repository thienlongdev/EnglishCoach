/**
 * Text-offset space of a rendered chapter. A position is the number of characters of countable text before it, in
 * document order. Highlights (<mark>) and search marks never change this space, so locators stay valid however the
 * chapter is paginated, restyled or annotated. Placeholders (`data-ec-nt`) and SVG pictures are not text; pictures
 * (img, svg, hr) are "atoms" so a page that holds only a picture still has a position.
 */

export interface TextItem {
    node: Node;
    start: number;
    len: number;
    atom: boolean;
}

const ATOMS = new Set(["img", "svg", "hr"]);

function isSkipped(el: Element): boolean {
    return el.hasAttribute("data-ec-nt");
}

export function buildItems(root: Element): TextItem[] {
    const items: TextItem[] = [];
    let offset = 0;
    const stack: Node[] = [];
    for (let c = root.lastChild; c; c = c.previousSibling) stack.push(c);
    while (stack.length) {
        const node = stack.pop()!;
        if (node.nodeType === 3) {
            const len = (node as Text).data.length;
            if (len) { items.push({ node, start: offset, len, atom: false }); offset += len; }
            continue;
        }
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        if (isSkipped(el)) continue;
        if (ATOMS.has(el.localName)) { items.push({ node, start: offset, len: 0, atom: true }); continue; }
        for (let c = el.lastChild; c; c = c.previousSibling) stack.push(c);
    }
    return items;
}

export function textOfRoot(root: Element): string {
    let text = "";
    for (const item of buildItems(root)) if (!item.atom) text += (item.node as Text).data;
    return text;
}

export class TextIndex {
    items: TextItem[] = [];
    private byNode = new Map<Node, number>();
    total = 0;

    constructor(private readonly root: Element) {
        this.rebuild();
    }

    /**
     * Index of the items [from, to) of `full`, with the same offsets: the part of a chapter that is laid out while it
     * is measured piece by piece (pageIndex.ts). Only for column geometry: it has no DOM lookups of its own.
     */
    static slice(full: TextIndex, from: number, to: number): TextIndex {
        const items = full.items.slice(from, to);
        const last = items[items.length - 1];
        return Object.assign(Object.create(TextIndex.prototype) as TextIndex, { root: full.root, byNode: new Map(), items, total: last ? last.start + last.len : 0 });
    }

    rebuild() {
        this.items = buildItems(this.root);
        this.byNode.clear();
        this.items.forEach((item, i) => this.byNode.set(item.node, i));
        const last = this.items[this.items.length - 1];
        this.total = last ? last.start + last.len : 0;
    }

    text(start: number, end: number): string {
        let out = "";
        for (const item of this.items) {
            if (item.atom || item.start + item.len <= start) continue;
            if (item.start >= end) break;
            const data = (item.node as Text).data;
            out += data.slice(Math.max(0, start - item.start), Math.min(item.len, end - item.start));
        }
        return out;
    }

    /** Index of the item of a text node or picture element (-1 when it is not one). */
    itemOf(node: Node): number {
        return this.byNode.get(node) ?? -1;
    }

    /** Text offset of a DOM boundary point inside the chapter (or null when it is outside). */
    offsetOf(container: Node, offset: number): number | null {
        if (!this.root.contains(container)) return null;
        if (container.nodeType === 3) {
            const i = this.byNode.get(container);
            if (i !== undefined) return this.items[i].start + Math.min(offset, this.items[i].len);
        }
        const range = document.createRange();
        try { range.setStart(container, offset); } catch { return null; }
        let lo = 0, hi = this.items.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            let cmp: number;
            try { cmp = range.comparePoint(this.items[mid].node, 0); } catch { cmp = 1; }
            if (cmp < 0) lo = mid + 1; else hi = mid;
        }
        return lo < this.items.length ? this.items[lo].start : this.total;
    }

    /** Index of the item at text offset `o`: the k-th item starting exactly there, else the text item containing it. */
    itemAt(o: number, k = 0): number {
        const n = this.items.length;
        if (!n) return -1;
        let lo = 0, hi = n - 1, j = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (this.items[mid].start <= o) { j = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (j < 0) return 0;
        const s = this.items[j].start;
        let first = j;
        while (first > 0 && this.items[first - 1].start === s) first--;
        if (s === o) return Math.min(first + k, j);
        for (let i = j; i >= first; i--) if (!this.items[i].atom) return i;
        return j;
    }

    /** Tie index of an item among the items that start at the same offset. */
    tieOf(index: number): number {
        let k = 0;
        while (index - k - 1 >= 0 && this.items[index - k - 1].start === this.items[index].start) k++;
        return k;
    }

    /** DOM boundary point for a text offset. */
    point(o: number): { node: Node; offset: number } | null {
        if (!this.items.length) return null;
        const clamped = Math.max(0, Math.min(o, this.total));
        let i = this.itemAt(clamped);
        while (i < this.items.length && this.items[i].atom) i++;
        if (i >= this.items.length) {
            const last = [...this.items].reverse().find((it) => !it.atom);
            return last ? { node: last.node, offset: last.len } : null;
        }
        const item = this.items[i];
        return { node: item.node, offset: Math.max(0, Math.min(item.len, clamped - item.start)) };
    }

    range(start: number, end: number): Range | null {
        const a = this.point(start), b = this.point(end);
        if (!a || !b) return null;
        const r = document.createRange();
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, b.offset);
        return r;
    }

    /** Text nodes (or parts) covering [start, end): used to wrap highlights. */
    segments(start: number, end: number): Array<{ node: Text; from: number; to: number }> {
        const out: Array<{ node: Text; from: number; to: number }> = [];
        if (end <= start) return out;
        let i = this.itemAt(start);
        if (i < 0) return out;
        for (; i < this.items.length; i++) {
            const item = this.items[i];
            if (item.start >= end) break;
            if (item.atom || item.start + item.len <= start) continue;
            out.push({ node: item.node as Text, from: Math.max(0, start - item.start), to: Math.min(item.len, end - item.start) });
        }
        return out;
    }
}
