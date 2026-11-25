/**
 * Physical page turn for My Books — a 2D paper-fold model.
 *
 * The turning leaf is hinged at the spine. When its free corner C is pulled to P, the paper folds along the
 * perpendicular bisector of C–P: the part beyond the fold is reflected over it (the "flap", showing the back of the
 * leaf), the part before it stays flat, and the area the flap left shows the page underneath. Everything is done with
 * clip-path polygons and one rigid transform on page-sized elements, plus three gradient layers for the shadows of the
 * curl — no WebGL, no canvas, no copy of the book. Coordinates: the "leaf frame" has its origin at the top of the hinge
 * and x growing towards the leaf's free edge; `mirror` flips that frame for a leaf that lies left of the hinge.
 */

export interface Pt { x: number; y: number }

export interface FlipScene {
    overlay: HTMLElement;
    /** Hinge x in overlay pixels. */
    hingeX: number;
    mirror: boolean;
    leafW: number;
    height: number;
    /** Leaf-sized element showing the front of the turning leaf (positioned by the caller at the leaf rect). */
    front: HTMLElement;
    /** Leaf-sized element showing the back of the leaf (positioned by the caller where it lands when fully turned). */
    back: HTMLElement;
    /** Reverse = the leaf starts fully turned and is laid down (a backward turn in one-page view). */
    reverse: boolean;
    corner: "top" | "bottom";
    dark: boolean;
}

type Poly = Pt[];

function clipHalf(poly: Poly, keep: (p: Pt) => number): Poly {
    const out: Poly = [];
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const da = keep(a), db = keep(b);
        if (da >= 0) out.push(a);
        if ((da >= 0) !== (db >= 0)) {
            const t = da / (da - db);
            out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
    }
    return out;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class PageFlip {
    private readonly W: number;
    private readonly H: number;
    private readonly C: Pt;
    private P: Pt;
    private shadeUnder: HTMLElement;
    private shadeFlap: HTMLElement;
    private shadeFront: HTMLElement;
    private frameId = 0;
    private dragStart: { pointer: Pt; P: Pt } | null = null;
    private lastMoves: Array<{ x: number; t: number }> = [];
    private destroyed = false;
    private rushed = false;

    constructor(private readonly scene: FlipScene) {
        this.W = scene.leafW;
        this.H = scene.height;
        this.C = { x: this.W, y: scene.corner === "top" ? 0 : this.H };
        this.P = scene.reverse ? this.turnedPoint() : { ...this.C };
        const shade = () => {
            const el = document.createElement("div");
            el.className = "ec-flip-shade";
            el.style.cssText = "position:absolute;inset:0;pointer-events:none;will-change:clip-path,background";
            return el;
        };
        this.shadeUnder = shade();
        this.shadeFront = shade();
        this.shadeFlap = shade();
        // order: (statics) < under-shadow < front < front-shade < back (flap) < flap-shade
        scene.overlay.insertBefore(this.shadeUnder, scene.front);
        scene.overlay.insertBefore(this.shadeFront, scene.back);
        scene.overlay.appendChild(this.shadeFlap);
        scene.front.style.transformOrigin = "0 0";
        scene.back.style.transformOrigin = "0 0";
        // No compositor layer of its own for either side: a promoted layer rasterizes text differently (lighter), and the
        // landing leaf would visibly change weight when the real page takes over at the end of the turn.
        scene.front.style.willChange = "clip-path";
        scene.back.style.willChange = "clip-path";
        this.render();
    }

    private turnedPoint(): Pt {
        return { x: -this.W, y: this.C.y };
    }

    /** Overlay (real) coordinates of a leaf-frame point. */
    private real(p: Pt): Pt {
        return { x: this.scene.mirror ? this.scene.hingeX - p.x : this.scene.hingeX + p.x, y: p.y };
    }
    private frame(p: Pt): Pt {
        return { x: this.scene.mirror ? this.scene.hingeX - p.x : p.x - this.scene.hingeX, y: p.y };
    }

    private constrain(p: Pt): Pt {
        let q = { x: p.x, y: Math.max(-this.H * 0.25, Math.min(this.H * 1.25, p.y)) };
        const same = { x: 0, y: this.C.y };
        const opposite = { x: 0, y: this.H - this.C.y };
        const diag = Math.hypot(this.W, this.H);
        for (let i = 0; i < 2; i++) {
            const d1 = Math.hypot(q.x - same.x, q.y - same.y);
            if (d1 > this.W) q = { x: same.x + (q.x - same.x) * (this.W / d1), y: same.y + (q.y - same.y) * (this.W / d1) };
            const d2 = Math.hypot(q.x - opposite.x, q.y - opposite.y);
            if (d2 > diag) q = { x: opposite.x + (q.x - opposite.x) * (diag / d2), y: opposite.y + (q.y - opposite.y) * (diag / d2) };
        }
        return q;
    }

    setPoint(p: Pt) {
        this.P = this.constrain(p);
        if (!this.frameId) this.frameId = requestAnimationFrame(() => { this.frameId = 0; this.render(); });
    }

    /** Forward progress of the turn, 0 (flat) … 1 (fully turned). */
    get progress(): number {
        return Math.max(0, Math.min(1, (this.W - this.P.x) / (2 * this.W)));
    }

    private polyCss(poly: Poly, offsetX: number): string {
        if (poly.length < 3) return "polygon(0 0, 0 0, 0 0)";
        return `polygon(${poly.map((p) => `${(p.x - offsetX).toFixed(2)}px ${p.y.toFixed(2)}px`).join(", ")})`;
    }

    private gradient(origin: Pt, dir: Pt, stops: Array<[number, string]>): string {
        const Wo = this.scene.overlay.clientWidth || 1, Ho = this.scene.overlay.clientHeight || 1;
        const angle = (Math.atan2(dir.x, -dir.y) * 180) / Math.PI;
        const rad = (angle * Math.PI) / 180;
        const L = Math.abs(Wo * Math.sin(rad)) + Math.abs(Ho * Math.cos(rad));
        const s0 = (origin.x - Wo / 2) * dir.x + (origin.y - Ho / 2) * dir.y + L / 2;
        return `linear-gradient(${angle.toFixed(2)}deg, ${stops.map(([d, c]) => `${c} ${(s0 + d).toFixed(1)}px`).join(", ")})`;
    }

    private render() {
        if (this.destroyed) return;
        const { front, back } = this.scene;
        const W = this.W, H = this.H, C = this.C, P = this.P;
        const leaf: Poly = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
        const dist = Math.hypot(C.x - P.x, C.y - P.y);
        const frontLeft = this.scene.mirror ? this.scene.hingeX - W : this.scene.hingeX;
        const backLeft = this.scene.mirror ? this.scene.hingeX : this.scene.hingeX - W;
        if (dist < 0.5) {
            front.style.clipPath = "none";
            back.style.clipPath = "polygon(0 0, 0 0, 0 0)";
            for (const s of [this.shadeUnder, this.shadeFlap, this.shadeFront]) s.style.background = "none";
            return;
        }
        const n = { x: (C.x - P.x) / dist, y: (C.y - P.y) / dist };
        const M = { x: (C.x + P.x) / 2, y: (C.y + P.y) / 2 };
        const side = (q: Pt) => (q.x - M.x) * n.x + (q.y - M.y) * n.y;
        const refl = (q: Pt): Pt => { const s = side(q); return { x: q.x - 2 * s * n.x, y: q.y - 2 * s * n.y }; };
        const frontPoly = clipHalf(leaf, (q) => -side(q));
        const folded = clipHalf(leaf, side);
        const flap = folded.map(refl);

        front.style.clipPath = this.polyCss(frontPoly.map((q) => this.real(q)), frontLeft);

        // Back: a landing-frame point b shows at refl(refl0(b)), refl0 = mirror over the hinge line.
        const mapBack = (u: Pt): Pt => {
            const f = this.frame({ x: backLeft + u.x, y: u.y });
            return this.real(refl({ x: -f.x, y: f.y }));
        };
        const q0 = mapBack({ x: 0, y: 0 }), q1 = mapBack({ x: 1, y: 0 }), q2 = mapBack({ x: 0, y: 1 });
        back.style.transform = `matrix(${(q1.x - q0.x).toFixed(5)}, ${(q1.y - q0.y).toFixed(5)}, ${(q2.x - q0.x).toFixed(5)}, ${(q2.y - q0.y).toFixed(5)}, ${(q0.x - backLeft).toFixed(2)}, ${q0.y.toFixed(2)})`;
        back.style.clipPath = this.polyCss(folded.map((q) => this.real({ x: -q.x, y: q.y })), backLeft);

        // Shadows. Directions in overlay space (a mirrored frame flips x).
        const toReal = (v: Pt): Pt => ({ x: this.scene.mirror ? -v.x : v.x, y: v.y });
        const foldPoint = this.real(M);
        const intoUnder = toReal(n);
        const intoFlap = toReal({ x: -n.x, y: -n.y });
        const depth = Math.min(1, dist / (W * 0.9));
        const k = this.scene.dark ? 1.6 : 1;
        this.shadeUnder.style.clipPath = this.polyCss(folded.map((q) => this.real(q)), 0);
        this.shadeUnder.style.background = this.gradient(foldPoint, intoUnder, [
            [0, `rgba(0,0,0,${(0.34 * depth * k).toFixed(3)})`],
            [Math.max(8, dist * 0.12), `rgba(0,0,0,${(0.12 * depth * k).toFixed(3)})`],
            [Math.max(24, dist * 0.35), "rgba(0,0,0,0)"],
        ]);
        this.shadeFront.style.clipPath = this.polyCss(frontPoly.map((q) => this.real(q)), 0);
        this.shadeFront.style.background = this.gradient(foldPoint, intoFlap, [
            [0, `rgba(0,0,0,${(0.16 * depth * k).toFixed(3)})`],
            [Math.max(6, dist * 0.06), `rgba(0,0,0,${(0.05 * depth * k).toFixed(3)})`],
            [Math.max(18, dist * 0.18), "rgba(0,0,0,0)"],
        ]);
        this.shadeFlap.style.clipPath = this.polyCss(flap.map((q) => this.real(q)), 0);
        this.shadeFlap.style.background = this.gradient(foldPoint, intoFlap, [
            [0, `rgba(0,0,0,${(0.22 * k).toFixed(3)})`],
            [Math.max(4, dist * 0.04), `rgba(255,255,255,${this.scene.dark ? 0.03 : 0.16})`],
            [Math.max(14, dist * 0.16), "rgba(255,255,255,0)"],
            [Math.max(40, dist * 0.5), `rgba(0,0,0,${(0.07 * k).toFixed(3)})`],
        ]);
    }

    private animate(from: Pt, to: Pt, duration: number, lift: number): Promise<void> {
        return new Promise((resolve) => {
            const start = performance.now();
            const step = (now: number) => {
                if (this.destroyed) return resolve();
                const t = this.rushed ? 1 : Math.min(1, (now - start) / duration);
                const e = ease(t);
                const liftY = Math.sin(Math.PI * e) * lift * (this.C.y === 0 ? 1 : -1);
                this.P = this.constrain({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e + liftY });
                this.render();
                if (t < 1) this.frameId = requestAnimationFrame(step);
                else { this.frameId = 0; resolve(); }
            };
            cancelAnimationFrame(this.frameId);
            this.frameId = requestAnimationFrame(step);
        });
    }

    /** A complete turn (click / key). */
    play(duration = 560): Promise<void> {
        const turned = this.turnedPoint();
        return this.scene.reverse
            ? this.animate(this.P, { ...this.C }, duration, this.H * 0.09)
            : this.animate(this.P, turned, duration, this.H * 0.09);
    }

    beginDrag(pointer: Pt) {
        const f = this.frame(pointer);
        this.dragStart = { pointer: f, P: { ...this.P } };
        this.lastMoves = [{ x: f.x, t: performance.now() }];
        if (!this.scene.reverse) this.setPoint({ x: Math.min(f.x, this.W), y: f.y });
    }

    drag(pointer: Pt) {
        if (!this.dragStart) return;
        const f = this.frame(pointer);
        this.lastMoves.push({ x: f.x, t: performance.now() });
        if (this.lastMoves.length > 6) this.lastMoves.shift();
        if (this.scene.reverse) {
            const dx = f.x - this.dragStart.pointer.x;
            this.setPoint({ x: this.dragStart.P.x + dx * 2, y: f.y });
        } else {
            this.setPoint({ x: Math.min(f.x, this.W), y: f.y });
        }
    }

    /** Ends a drag; resolves true when the turn completed, false when the leaf fell back. */
    async release(): Promise<boolean> {
        const moves = this.lastMoves;
        const first = moves[0], last = moves[moves.length - 1];
        const velocity = first && last && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0; // px/ms in frame x
        this.dragStart = null;
        const p = this.progress;
        const complete = this.scene.reverse
            ? (p < 0.62 || velocity > 0.45) && velocity > -0.45
            : (p > 0.32 || velocity < -0.45) && velocity < 0.45;
        const target = this.scene.reverse ? (complete ? { ...this.C } : this.turnedPoint()) : (complete ? this.turnedPoint() : { ...this.C });
        const remaining = Math.hypot(target.x - this.P.x, target.y - this.P.y) / (2 * this.W);
        await this.animate({ ...this.P }, target, 160 + 380 * Math.min(1, remaining), 0);
        return complete;
    }

    /** Finishes the running animation on the next frame (another turn was requested). */
    rush() {
        this.rushed = true;
    }

    destroy() {
        this.destroyed = true;
        cancelAnimationFrame(this.frameId);
        this.shadeUnder.remove();
        this.shadeFlap.remove();
        this.shadeFront.remove();
    }
}
