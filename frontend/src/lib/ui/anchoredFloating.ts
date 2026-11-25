"use client";

/**
 * Anchored floating panels for reader selections (Reading, My Books).
 *
 * A panel follows the LIVE position of its anchor (the selected text), not the position the text had when it was
 * selected: the anchor rect is read every animation frame while the panel is open, so it stays tied to the text
 * through any scroll container (the Reading column, a book's shadow root, a PDF page), resizes and reflows. The
 * panel prefers the space below the anchor, flips above when that side has more room, shifts horizontally inside
 * the bounds and never grows past the space it has (its content scrolls instead).
 *
 * The hook owns `top`, `left`, `max-height` and `max-width` of the floating element and writes them directly (no React
 * state per frame); the element's JSX must not set those properties.
 */
import { useLayoutEffect, useRef, type RefObject } from "react";

export interface Box { top: number; left: number; right: number; bottom: number }

export interface Placement { top: number; left: number; maxHeight: number; maxWidth: number; side: "below" | "above" }

/** The visible viewport (the visual viewport on phones, so an on-screen keyboard is respected). */
export function viewportBox(): Box {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (vv) return { top: vv.offsetTop, left: vv.offsetLeft, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height };
    return { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
}

/**
 * The visible rows of a scroll container (e.g. a reading column below fixed headers): its top / bottom inside the
 * viewport, with the viewport's full width (a panel may extend over side rails, never under a header or past an edge).
 */
export function visibleBox(el: Element | null | undefined): Box {
    const v = viewportBox();
    if (!el) return v;
    const r = el.getBoundingClientRect();
    return { top: Math.max(v.top, r.top), left: v.left, right: v.right, bottom: Math.min(v.bottom, r.bottom) };
}

const MIN_HEIGHT = 140;

/** Pure placement: below when it fits (or when below is the roomier side), else above; clamped to the bounds. */
export function placeFloating(anchor: Box, size: { w: number; h: number }, bounds: Box, gap = 10, margin = 8): Placement {
    const below = bounds.bottom - anchor.bottom - gap - margin;
    const above = anchor.top - bounds.top - gap - margin;
    const side: Placement["side"] = size.h <= below || below >= above ? "below" : "above";
    const room = Math.max(side === "below" ? below : above, 0);
    // A very short side (anchor near both edges of a tiny screen) still gets a usable panel, kept inside the bounds.
    const maxHeight = Math.max(Math.min(room, bounds.bottom - bounds.top - 2 * margin), Math.min(MIN_HEIGHT, bounds.bottom - bounds.top - 2 * margin));
    const h = Math.min(size.h, maxHeight);
    let top = side === "below" ? anchor.bottom + gap : anchor.top - gap - h;
    top = Math.max(bounds.top + margin, Math.min(bounds.bottom - margin - h, top));
    const w = Math.min(size.w, bounds.right - bounds.left - 2 * margin);
    const left = Math.max(bounds.left + margin, Math.min(bounds.right - margin - w, (anchor.left + anchor.right) / 2 - w / 2));
    return { top: Math.round(top), left: Math.round(left), maxHeight: Math.floor(maxHeight), maxWidth: Math.floor(bounds.right - bounds.left - 2 * margin), side };
}

/** True when the anchor rect is gone (detached / hidden: all zero) or entirely outside the bounds. */
export function anchorLost(rect: Box | null, bounds: Box): boolean {
    if (!rect) return true;
    if (rect.top === 0 && rect.bottom === 0 && rect.left === 0 && rect.right === 0) return true;
    return rect.bottom < bounds.top || rect.top > bounds.bottom || rect.right < bounds.left || rect.left > bounds.right;
}

/** The last client rect of a live range (where the selection ends), or null when the range is detached / empty. */
export function rangeRect(range: Range | null | undefined): DOMRect | null {
    if (!range) return null;
    try {
        const rects = range.getClientRects();
        const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
        return r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0 ? null : r;
    } catch {
        return null;
    }
}

export function useAnchoredFloating({ open, floating, anchor, bounds = viewportBox, gap, measure, onLost }: {
    open: boolean;
    floating: RefObject<HTMLElement | null>;
    /** Live anchor rect (read every frame); null = the anchor no longer exists. */
    anchor: () => Box | null;
    bounds?: () => Box;
    gap?: number;
    /** Natural (unclipped) height of the panel; default = its scrollHeight (a panel that scrolls itself). */
    measure?: (el: HTMLElement) => number;
    /** Called once when the anchor disappears or leaves the bounds; the panel then stays where it last was. */
    onLost?: () => void;
}) {
    const live = useRef({ anchor, bounds, measure, onLost });
    live.current = { anchor, bounds, measure, onLost };

    useLayoutEffect(() => {
        if (!open) return;
        let raf = 0, last = "", lost = false;
        const step = () => {
            const el = floating.current;
            if (el) {
                const b = live.current.bounds();
                const a = live.current.anchor();
                if (anchorLost(a, b)) {
                    if (!lost) { lost = true; live.current.onLost?.(); }
                } else {
                    lost = false;
                    // the natural height: the content's full height, whatever max-height currently clips it to
                    const h = live.current.measure ? live.current.measure(el) : el.scrollHeight;
                    const p = placeFloating(a!, { w: el.offsetWidth, h }, b, gap);
                    const key = `${p.top}|${p.left}|${p.maxHeight}|${p.maxWidth}|${p.side}`;
                    if (key !== last) {
                        last = key;
                        el.style.top = `${p.top}px`;
                        el.style.left = `${p.left}px`;
                        el.style.maxHeight = `${p.maxHeight}px`;
                        el.style.maxWidth = `${p.maxWidth}px`;
                        el.dataset.side = p.side;
                    }
                }
            }
            raf = requestAnimationFrame(step);
        };
        step();
        return () => cancelAnimationFrame(raf);
    }, [open, floating, gap]);
}
