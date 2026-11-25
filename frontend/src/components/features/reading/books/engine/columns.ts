/**
 * Column geometry of a paged chapter (My Books): which page (CSS column) a character or picture is on, where a page
 * starts in the text-offset space, and how many pages actually hold content. Used by the visible reader and by the
 * page-index measurer, so both count pages the same way.
 */
import type { TextIndex } from "./text";

const WS = /^\s*$/;

export class Columns {
    private left = 0;

    constructor(private readonly viewport: HTMLElement, readonly index: TextIndex, private readonly stride: number) {
        this.refresh();
    }

    /** Re-reads the viewport origin (its scroll position moves the columns). */
    refresh() {
        this.left = this.viewport.getBoundingClientRect().left - this.viewport.scrollLeft;
    }

    /** Client x of the left edge of column `p`. */
    columnLeft(p: number): number {
        return this.left + p * this.stride;
    }

    colOf(rect: DOMRect): number | null {
        if (!rect || (rect.width === 0 && rect.height === 0)) return null;
        return Math.floor((rect.left - this.left + 1) / this.stride);
    }

    charRect(node: Text, i: number): DOMRect | null {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + 1);
        const rects = r.getClientRects();
        return rects.length ? rects[0] : null;
    }

    charCol(node: Text, i: number, dir: 1 | -1 = 1): number | null {
        const data = node.data;
        for (let j = i, n = 0; j >= 0 && j < data.length && n < 48; j += dir, n++) {
            if (/\s/.test(data[j])) continue;
            const rect = this.charRect(node, j);
            if (rect) {
                const c = this.colOf(rect);
                if (c !== null) return c;
            }
        }
        return null;
    }

    itemCol(i: number, end = false): number | null {
        const item = this.index.items[i];
        if (item.atom) return this.colOf((item.node as Element).getBoundingClientRect());
        if (WS.test((item.node as Text).data)) return null;
        return end ? this.charCol(item.node as Text, item.len - 1, -1) : this.charCol(item.node as Text, 0, 1);
    }

    private effectiveStart(i: number): number {
        const items = this.index.items;
        for (let j = i, n = 0; j < items.length && n < 400; j++, n++) {
            const c = this.itemCol(j);
            if (c !== null) return c;
        }
        return Number.POSITIVE_INFINITY;
    }

    /** First text position of page (column) `p`. */
    pageStart(p: number): { o: number; k: number; item: number } {
        const index = this.index;
        if (p <= 0 || !index.items.length) return { o: 0, k: 0, item: 0 };
        let lo = 0, hi = index.items.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (this.effectiveStart(mid) >= p) hi = mid; else lo = mid + 1;
        }
        // the previous text item may run on into this page
        for (let j = lo - 1, n = 0; j >= 0 && n < 400; j--, n++) {
            const item = index.items[j];
            if (item.atom || WS.test((item.node as Text).data)) continue;
            const endCol = this.itemCol(j, true);
            if (endCol === null || endCol < p) break;
            const node = item.node as Text;
            let a = 0, b = item.len - 1;
            while (a < b) {
                const m = (a + b) >> 1;
                const c = this.charCol(node, m, 1);
                if (c !== null && c >= p) b = m; else a = m + 1;
            }
            return { o: item.start + a, k: 0, item: j };
        }
        if (lo >= index.items.length) return { o: index.total, k: 0, item: index.items.length };
        return { o: index.items[lo].start, k: index.tieOf(lo), item: lo };
    }

    /** Page holding text offset `o` (tie `k`); `fallback` when nothing there is laid out. */
    columnOf(o: number, k: number, fallback: number): number {
        const index = this.index;
        if (!index.items.length) return 0;
        let i = index.itemAt(o, k);
        if (i < 0) return 0;
        const item = index.items[i];
        let col: number | null = null;
        if (item.atom) col = this.colOf((item.node as Element).getBoundingClientRect());
        else col = this.charCol(item.node as Text, Math.max(0, Math.min(item.len - 1, o - item.start)), 1);
        while (col === null && ++i < index.items.length) col = this.itemCol(i);
        return col ?? fallback;
    }

    /**
     * Number of pages that hold text or pictures: one past the last occupied column. Trailing columns that only exist
     * because of a bottom margin are not pages. Null when nothing is laid out (the caller keeps its own count).
     */
    contentPages(): number | null {
        const items = this.index.items;
        let last: number | null = null;
        for (let j = items.length - 1, seen = 0; j >= 0 && seen < 60; j--) {
            const c = this.itemCol(j, true);
            if (c === null) continue;
            seen++;
            last = last === null ? c : Math.max(last, c);
        }
        return last === null ? null : last + 1;
    }
}
