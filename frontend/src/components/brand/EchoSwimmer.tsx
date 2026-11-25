"use client";

import React, { useEffect, useRef } from "react";
import { ECHO_STILL } from "@/components/landing/ocean/echoAssets";
import { ECHO_SWIM } from "@/components/dashboard/echoSwimArt";
import { vfxPreference } from "@/lib/vfx/quality";
import styles from "./echoSwimmer.module.css";

/**
 * Where the rendered swim loop may play: VP9 with alpha (Chromium, Firefox). WebKit would draw its alpha as black, so it
 * keeps the still; so do reduced motion, Save-Data and the device's "Nhẹ" effects choice. Same rule as the Dashboard hero.
 */
export function echoSwimAllowed(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return false;
  if (vfxPreference() === "low") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/AppleWebKit/.test(ua) && !/(Chrome|Chromium|Edg|OPR|Firefox)\//.test(ua))) return false;
  return document.createElement("video").canPlayType('video/webm; codecs="vp9"') !== "";
}

/**
 * Echo swimming: the REAL model (the landing's whale) — its rendered still first, then the pre-rendered 2.5 s VP9-alpha swim
 * loop (`ECHO_SWIM`, 82 KB) once the element is on screen and the page is idle. Muted, shown only after its clock really
 * advances, paused off screen and in a hidden tab, decoder released on unmount. No 3D context and no render loop (10 §Y, §BV).
 * Decorative only: `aria-hidden`, never catches the pointer. `facing="left"` mirrors the whale toward the content.
 */
export function EchoSwimmer({ className, facing = "right", drift = true }: { className?: string; facing?: "left" | "right"; drift?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    const video = videoRef.current;
    if (!root || !video || !echoSwimAllowed() || typeof IntersectionObserver === "undefined") return;
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
      if (last >= 0 && video.currentTime !== last) {
        root.setAttribute("data-live", "");
        video.removeEventListener("timeupdate", onTime);
      }
      last = video.currentTime;
    };
    const onError = () => root.removeAttribute("data-live");
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("error", onError);
    const observer = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
      if (visible && !started) {
        const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
        idle = ric ? ric(start, { timeout: 2500 }) : window.setTimeout(start, 600);
      } else resume();
    });
    observer.observe(root);
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
      root.removeAttribute("data-live");
    };
  }, []);

  return (
    <div ref={rootRef} className={`${styles.swimmer} ${className ?? ""}`} data-facing={facing} data-drift={drift ? "" : undefined} aria-hidden="true">
      <div className={styles.body}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={styles.still} src={ECHO_STILL.src} width={ECHO_STILL.width} height={ECHO_STILL.height} alt="" decoding="async" draggable={false} />
        <video ref={videoRef} className={styles.video} width={ECHO_SWIM.width} height={ECHO_SWIM.height} muted loop playsInline preload="none"
          disablePictureInPicture disableRemotePlayback tabIndex={-1} aria-hidden="true" />
      </div>
    </div>
  );
}
