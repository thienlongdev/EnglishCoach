"use client";

import React, { useEffect, useRef } from "react";
import { ECHO_STILL } from "@/components/landing/ocean/echoAssets";
import { vfxPreference } from "@/lib/vfx/quality";
import { ECHO_SWIM } from "./echoSwimArt";
import { ATMOSPHERE_ART } from "@/components/atmosphere/atmosphereArt";
import styles from "./dashboard.module.css";

// Deterministic star field (same sky on server and client, no randomness at render).
const STARS = (() => {
  let seed = 7;
  const next = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: 70 }, () => ({ x: next() * 1000, y: next() * 250, r: 0.5 + next() * 1.3, o: 0.35 + next() * 0.6, t: next() < 0.22 }));
})();
const BUBBLES = [
  { l: "58%", s: 10, d: 0 }, { l: "63%", s: 6, d: -3 }, { l: "71%", s: 8, d: -6 }, { l: "52%", s: 5, d: -9 }, { l: "67%", s: 4, d: -12 },
];

/** The workspace atmosphere's caustic tiles, reused on the hero's water (one light language, files already cached). */
const SEA_ART = {
  "--sea-caustic-light": `url("${ATMOSPHERE_ART.caustic_pearl}")`,
  "--sea-caustic-dark": `url("${ATMOSPHERE_ART.caustic_abyss}")`,
} as React.CSSProperties;

/**
 * Where the rendered swim loop may play: VP9 with alpha (Chromium, Firefox). WebKit (Safari, every iOS browser) would draw its
 * alpha as black, so it keeps the still; so do reduced motion, Save-Data and the device's "Nhẹ" effects choice.
 */
function swimLoopAllowed(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return false;
  if (vfxPreference() === "low") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/AppleWebKit/.test(ua) && !/(Chrome|Chromium|Edg|OPR|Firefox)\//.test(ua))) return false;
  return document.createElement("video").canPlayType('video/webm; codecs="vp9"') !== "";
}

/**
 * Echo's real swim (Echo Ocean, 2026-11-14): the landing's own model and clips rendered once into a 2.5 s VP9-alpha loop (82 KB).
 * Fetched only once the hero is on screen and the page is idle, muted (Echo Music ignores muted media), shown only after its
 * frames really advance; it pauses off screen and in a hidden tab and releases its decoder on unmount. No 3D context, no render
 * loop (10 §Y): until it plays — or where it may not — the still below swims with CSS exactly as before.
 */
function useSwimLoop() {
  const echoRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const echo = echoRef.current;
    const video = videoRef.current;
    if (!echo || !video || !swimLoopAllowed()) return;
    let started = false;
    let visible = false;
    let idle = 0;
    let last = -1;
    video.muted = true;
    video.defaultMuted = true;
    const resume = () => {
      if (!started || !visible || document.visibilityState === "hidden") video.pause();
      else void video.play().catch(() => undefined);
    };
    const start = () => {
      if (started) return;
      started = true;
      video.src = ECHO_SWIM.webm;
      resume();
    };
    const onTime = () => {
      // proof of playback: the clock advanced between two reports (a decoded first frame alone is not enough); once proven,
      // stop listening (no attribute write, no style work per report)
      if (last >= 0 && video.currentTime !== last) {
        echo.setAttribute("data-live", "");
        video.removeEventListener("timeupdate", onTime);
      }
      last = video.currentTime;
    };
    const onError = () => echo.removeAttribute("data-live");
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("error", onError);
    const observer = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
      if (visible && !started) {
        const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
        idle = ric ? ric(start, { timeout: 2500 }) : window.setTimeout(start, 600);
      } else resume();
    });
    observer.observe(echo);
    document.addEventListener("visibilitychange", resume);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", resume);
      const cic = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (cic) cic(idle); else window.clearTimeout(idle);
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("error", onError);
      video.pause();
      video.removeAttribute("src");
      video.load();
      echo.removeAttribute("data-live");
    };
  }, []);
  return { echoRef, videoRef };
}

/**
 * The Dashboard hero's scene (decorative, `aria-hidden`, never catches the pointer): a night ocean in the dark theme and a
 * dawn ocean in the light one — sky, stars, aurora, moon / sun, far islands, a glinting sea and Echo (the landing's own
 * rendered whale still) swimming at the waterline — fluke beats, a slow drifting swim, a spout now and then. Transform /
 * opacity motion only (CSS, no render loop), all of it still under reduced motion; the hero's pointer light leans the
 * layers a few pixels for depth and turns Echo toward the pointer.
 */
export function DashboardHeroScene() {
  const sceneRef = useRef<HTMLDivElement>(null);
  const { echoRef, videoRef } = useSwimLoop();
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    let intersecting = true;
    const sync = () => {
      if (!intersecting || document.visibilityState === "hidden") {
        scene.setAttribute("data-paused", "true");
      } else {
        scene.removeAttribute("data-paused");
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = !!entry?.isIntersecting;
      sync();
    });
    observer.observe(scene);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      scene.removeAttribute("data-paused");
    };
  }, []);
  return (
    <div ref={sceneRef} className={styles.scene} aria-hidden="true" style={SEA_ART}>
      <div className={styles.sky} />
      <svg className={styles.stars} viewBox="0 0 1000 250" preserveAspectRatio="xMidYMid slice">
        {STARS.map((s, i) => (
          <circle key={i} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={s.r.toFixed(2)} fill="#ffffff" opacity={s.o.toFixed(2)} className={s.t ? styles.twinkle : undefined} />
        ))}
      </svg>
      <div className={styles.aurora}><i /><i /></div>
      <div className={styles.moon}><i /></div>
      <svg className={styles.isles} viewBox="0 0 1000 90" preserveAspectRatio="none">
        <path className={styles.isleFar} d="M0 90V70c40-6 70-18 110-16s60 12 96 10 50-22 92-20 58 18 100 16 46-14 84-12 70 16 118 14 52-20 96-18 64 14 108 12 70-10 112-8 54 10 84 8V90z" />
        <path className={styles.isleNear} d="M520 90c10-22 30-44 58-50s44 6 64 4 30-26 58-28 46 22 70 30 40 6 58 14 22 18 28 30z" />
        <path className={styles.isleNear} d="M0 90c18-14 40-26 72-28s48 10 70 8 26-12 46-10 30 16 40 30z" />
      </svg>
      <div className={styles.sea}><i className={styles.seaCaustic} /><i className={styles.seaPath} /><i className={styles.seaGlint} /></div>
      <div className={styles.echo} ref={echoRef}>
        <i className={styles.echoGlow} />
        <i className={styles.echoWake}><b /><b /></i>
        {/* Echo swims: one still drawn twice — the flukes (left of the peduncle) beat around the peduncle while the body,
            feathered over the joint, drifts and pitches above them; a spout now and then from the blowhole. */}
        <div className={styles.echoSwim}>
          <div className={styles.echoBody}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={styles.echoTail} src={ECHO_STILL.src} width={ECHO_STILL.width} height={ECHO_STILL.height} alt="" decoding="async" draggable={false} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={styles.echoTrunk} src={ECHO_STILL.src} width={ECHO_STILL.width} height={ECHO_STILL.height} alt="" decoding="async" draggable={false} />
            {/* the real rig swimming: same origin and size as the still (see .echoVideo), shown once it really plays */}
            <video ref={videoRef} className={styles.echoVideo} width={ECHO_SWIM.width} height={ECHO_SWIM.height} muted loop playsInline preload="none" disablePictureInPicture disableRemotePlayback tabIndex={-1} aria-hidden="true" />
          </div>
          <i className={styles.echoSpout}><b /><b /><b /><b /><b /></i>
        </div>
      </div>
      <div className={styles.bubbles}>
        {BUBBLES.map((b, i) => <i key={i} style={{ left: b.l, width: b.s, height: b.s, animationDelay: `${b.d}s` }} />)}
      </div>
      <div className={styles.rays} />
    </div>
  );
}
