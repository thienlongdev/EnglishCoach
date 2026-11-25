"use client"

import { useEffect, useRef } from "react"
import styles from "./WorkspaceShell.module.css"

/**
 * Echo OceanFlow current (sidebar). One body of luminous "water" under the glass of a sidebar zone: it follows the entry under a
 * fine pointer (or the keyboard-focused entry) on springs. The leading edge pulls ahead and the trailing edge catches up, so
 * moving between entries stretches the light like a current before it settles; a softer wake follows behind and the brightest
 * glint trails the pointer with inertia. Presentation only: aria-hidden, never takes pointer input, no React state per frame,
 * an animation frame only while something still moves, nothing for touch or reduced motion (the entries' own :hover / :active
 * styles stand in). Placed as the FIRST child of a positioned zone, so the entries paint above it.
 */
type Spring = { p: number; v: number; t: number }

const LEAD = { k: 340, c: 31 }
const TRAIL = { k: 140, c: 20 }
const WAKE = { k: 58, c: 13 }
const GLINT = { k: 110, c: 18 }
const FADE = { k: 150, c: 24 }

const spring = (): Spring => ({ p: 0, v: 0, t: 0 })
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function advance(s: Spring, k: number, c: number, dt: number) {
    s.v += (k * (s.t - s.p) - c * s.v) * dt
    s.p += s.v * dt
}

function settled(s: Spring, eps: number) {
    return Math.abs(s.t - s.p) < eps && Math.abs(s.v) < eps * 4
}

function settle(s: Spring) {
    s.p = s.t
    s.v = 0
}

export default function OceanCurrent({ itemClass }: { itemClass: string }) {
    const wakeRef = useRef<HTMLSpanElement>(null)
    const layerRef = useRef<HTMLSpanElement>(null)

    useEffect(() => {
        const layer = layerRef.current
        const wake = wakeRef.current
        const host = layer?.parentElement
        const glint = layer?.querySelector<HTMLElement>("[data-glint]")
        const ripple = layer?.querySelector<HTMLElement>("[data-ripple]")
        if (!layer || !wake || !host || !glint || !ripple) return

        const selector = `.${CSS.escape(itemClass)}`
        const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)")
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")

        const top = spring(), bottom = spring(), wakeTop = spring(), wakeBottom = spring(), glintX = spring(), glow = spring()
        let left = 0
        let width = 0
        let item: HTMLElement | null = null
        let frame = 0
        let last = 0
        let inside = false

        const enabled = () => finePointer.matches && !reducedMotion.matches
        const syncEnabled = () => {
            if (enabled()) host.dataset.ocean = ""
            else {
                delete host.dataset.ocean
                glow.t = 0
                settle(glow)
                render()
            }
        }

        const render = () => {
            const height = Math.max(6, bottom.p - top.p)
            const opacity = clamp(glow.p, 0, 1)
            layer.style.transform = `translate3d(${left}px, ${top.p}px, 0)`
            layer.style.width = `${width}px`
            layer.style.height = `${height}px`
            layer.style.opacity = opacity.toFixed(3)
            glint.style.transform = `translate3d(${glintX.p.toFixed(1)}px, 0, 0)`
            // The wake only shows while it lags behind the current (the light "flowing" between entries).
            const lag = Math.abs(wakeTop.p - top.p) + Math.abs(wakeBottom.p - bottom.p)
            wake.style.transform = `translate3d(${left}px, ${Math.min(wakeTop.p, top.p)}px, 0)`
            wake.style.width = `${width}px`
            wake.style.height = `${Math.max(6, Math.max(wakeBottom.p, bottom.p) - Math.min(wakeTop.p, top.p))}px`
            wake.style.opacity = (opacity * clamp(lag / 46, 0, 0.7)).toFixed(3)
        }

        const tick = (now: number) => {
            const dt = Math.min(0.034, (now - last) / 1000)
            last = now
            // Moving down: the bottom edge leads and the top trails; moving up: the reverse.
            const down = top.t >= top.p
            const a = down ? TRAIL : LEAD
            const b = down ? LEAD : TRAIL
            wakeTop.t = top.t
            wakeBottom.t = bottom.t
            for (let i = 0; i < 2; i++) {
                const h = dt / 2
                advance(top, a.k, a.c, h)
                advance(bottom, b.k, b.c, h)
                advance(wakeTop, WAKE.k, WAKE.c, h)
                advance(wakeBottom, WAKE.k, WAKE.c, h)
                advance(glintX, GLINT.k, GLINT.c, h)
                advance(glow, FADE.k, FADE.c, h)
            }
            const still = settled(top, 0.3) && settled(bottom, 0.3) && settled(wakeTop, 0.4) && settled(wakeBottom, 0.4)
                && settled(glintX, 0.4) && settled(glow, 0.004)
            if (still) {
                for (const s of [top, bottom, wakeTop, wakeBottom, glintX, glow]) settle(s)
                render()
                frame = 0
                if (glow.t === 0) delete host.dataset.oceanLive
                return
            }
            render()
            frame = requestAnimationFrame(tick)
        }

        const kick = () => {
            if (frame) return
            last = performance.now()
            frame = requestAnimationFrame(tick)
        }

        const measure = (el: HTMLElement) => {
            const zone = host.getBoundingClientRect()
            const box = el.getBoundingClientRect()
            return {
                top: box.top - zone.top + host.scrollTop,
                bottom: box.bottom - zone.top + host.scrollTop,
                left: box.left - zone.left + host.scrollLeft,
                width: box.width,
                screenLeft: box.left,
            }
        }

        const aim = (el: HTMLElement, clientX: number | null, strength: number) => {
            const box = measure(el)
            const fromRest = glow.p < 0.04 && glow.t < 0.04
            top.t = box.top
            bottom.t = box.bottom
            left = box.left
            width = box.width
            glintX.t = clientX === null ? box.width / 2 : clamp(clientX - box.screenLeft, 0, box.width)
            glow.t = strength
            item = el
            if (fromRest) {
                // A fresh current rises where the pointer is; it never sweeps in from a stale place.
                for (const s of [top, bottom, wakeTop, wakeBottom, glintX]) settle(s)
                wakeTop.p = wakeTop.t = top.t
                wakeBottom.p = wakeBottom.t = bottom.t
            }
            host.dataset.oceanLive = ""
            kick()
        }

        const fadeOut = () => {
            glow.t = 0
            kick()
        }

        const onPointerMove = (event: PointerEvent) => {
            if (event.pointerType !== "mouse" && event.pointerType !== "pen") return
            if (!enabled()) return
            inside = true
            const el = (event.target as Element | null)?.closest<HTMLElement>(selector)
            // Between two entries the current stays where it is: one continuous body of light, not a row of switches.
            if (el && host.contains(el)) aim(el, event.clientX, 1)
            else if (item && glow.t > 0) {
                const box = item.getBoundingClientRect()
                glintX.t = clamp(event.clientX - box.left, 0, box.width)
                kick()
            }
        }

        const onPointerLeave = () => {
            inside = false
            fadeOut()
        }

        const onPointerDown = (event: PointerEvent) => {
            if (!enabled() || glow.p < 0.2) return
            const box = item?.getBoundingClientRect()
            if (!box) return
            const x = clamp(event.clientX - box.left, 0, box.width)
            ripple.animate(
                [
                    { transform: `translate3d(${x}px, 0, 0) scale(0.2)`, opacity: 0.85 },
                    { transform: `translate3d(${x}px, 0, 0) scale(3.2)`, opacity: 0 },
                ],
                { duration: 620, easing: "cubic-bezier(.2,.8,.2,1)" },
            )
        }

        // The collapsed rail scrolls, so its tooltips are fixed-positioned: tell each entry where its tooltip sits on screen.
        // Runs for every pointer and under reduced motion too (it is placement, not motion).
        const placeTip = (event: Event) => {
            const el = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null
            if (!el || !host.contains(el)) return
            const box = el.getBoundingClientRect()
            el.style.setProperty("--tip-x", `${Math.round(box.right + 18)}px`)
            el.style.setProperty("--tip-y", `${Math.round(box.top + box.height / 2)}px`)
        }

        const onFocusIn = (event: FocusEvent) => {
            placeTip(event)
            if (!enabled()) return
            const el = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(selector) : null
            if (el && el.matches(":focus-visible")) aim(el, null, 0.8)
        }

        const onFocusOut = () => {
            if (!inside) fadeOut()
        }

        // The rail changes width (collapse / expand) and the entries move with it: keep the current on its entry.
        const resize = new ResizeObserver(() => {
            if (!item || glow.t === 0 || !item.isConnected) return
            const box = measure(item)
            top.t = box.top
            bottom.t = box.bottom
            left = box.left
            width = box.width
            for (const s of [top, bottom, wakeTop, wakeBottom]) settle(s)
            wakeTop.p = wakeTop.t = top.t
            wakeBottom.p = wakeBottom.t = bottom.t
            render()
        })

        syncEnabled()
        render()
        host.addEventListener("pointerover", placeTip, { passive: true })
        host.addEventListener("pointermove", onPointerMove, { passive: true })
        host.addEventListener("pointerleave", onPointerLeave)
        host.addEventListener("pointerdown", onPointerDown, { passive: true })
        host.addEventListener("focusin", onFocusIn)
        host.addEventListener("focusout", onFocusOut)
        finePointer.addEventListener("change", syncEnabled)
        reducedMotion.addEventListener("change", syncEnabled)
        resize.observe(host)

        return () => {
            if (frame) cancelAnimationFrame(frame)
            resize.disconnect()
            host.removeEventListener("pointerover", placeTip)
            host.removeEventListener("pointermove", onPointerMove)
            host.removeEventListener("pointerleave", onPointerLeave)
            host.removeEventListener("pointerdown", onPointerDown)
            host.removeEventListener("focusin", onFocusIn)
            host.removeEventListener("focusout", onFocusOut)
            finePointer.removeEventListener("change", syncEnabled)
            reducedMotion.removeEventListener("change", syncEnabled)
            delete host.dataset.ocean
            delete host.dataset.oceanLive
        }
    }, [itemClass])

    return (
        <>
            <span ref={wakeRef} className={styles.wake} aria-hidden="true" />
            <span ref={layerRef} className={styles.current} aria-hidden="true">
                <span className={styles.water} />
                <span className={styles.waterBack} />
                <span className={styles.glint} data-glint="" />
                <span className={styles.ripple} data-ripple="" />
            </span>
        </>
    )
}

/** Paint servers for the sculpted icon glyphs: one gradient per module tone (colours come from the theme tokens). */
const GLYPH_TONES = [
    "home", "path", "cosmos", "cards", "grammar", "games", "reading", "listening", "speaking", "writing", "exams",
    "rank", "community", "bell", "admin", "security", "music", "wallpaper", "space",
] as const

export type GlyphTone = (typeof GLYPH_TONES)[number]

export function OceanGlyphDefs() {
    return (
        <svg className={styles.glyphDefs} width="0" height="0" aria-hidden="true" focusable="false">
            <defs>
                {GLYPH_TONES.map(tone => (
                    // userSpaceOnUse: a straight stroke has a zero-height box, which would leave an objectBoundingBox gradient unpainted.
                    <linearGradient key={tone} id={`ec-og-${tone}`} gradientUnits="userSpaceOnUse" x1="5" y1="2" x2="19" y2="22">
                        <stop offset="0" style={{ stopColor: `var(--og-${tone}-1)` }} />
                        <stop offset="1" style={{ stopColor: `var(--og-${tone}-2)` }} />
                    </linearGradient>
                ))}
            </defs>
        </svg>
    )
}
