"use client";

import React from "react";
import { EchoSwimmer } from "@/components/brand/EchoSwimmer";
import type { RecallQuality } from "../RecallControls";
import s from "./theater.module.css";

// Deterministic motes (same on server and client): subtle ambient lights drifting along the outer margins, never over the card.
const MOTES = [
  { x: 6, y: 74, d: 0, z: 3 },
  { x: 13, y: 48, d: -4, z: 2 },
  { x: 20, y: 82, d: -9, z: 4 },
  { x: 26, y: 30, d: -2, z: 2 },
  { x: 76, y: 78, d: -6, z: 3 },
  { x: 83, y: 38, d: -11, z: 2 },
  { x: 89, y: 68, d: -3, z: 4 },
  { x: 94, y: 24, d: -8, z: 2 },
  { x: 9, y: 20, d: -12, z: 2 },
  { x: 68, y: 88, d: -5, z: 3 },
];

/**
 * The Memory Theater's living celestial environment (reforged 2026-11-20):
 * - Light mode: a distinctive luminous Pearl Solar Astrolabe in the open upper-left dawn sky with subtle orbital rings,
 *   drifting layered clouds, dawn light beams and a pearlescent ocean reflection.
 * - Dark mode: a deep cosmic Echo Ocean horizon with twin-depth parallax stars, a progress-responsive aurora ribbon,
 *   an unobstructed ringed amethyst planet with an orbiting moonlet, and a distant upper-left crescent satellite.
 *
 * Pure CSS / SVG (zero extra WebGL canvas, zero render loop, zero network requests beyond Echo's cached swim loop).
 * Decorative (`aria-hidden`, `pointer-events: none`), hidden under a wallpaper / Living World / 3D preset (10 §BI),
 * and completely still under `prefers-reduced-motion: reduce`.
 */
export function TheaterScene({
  progressRatio = 0,
  tide = null,
}: {
  /** Verified session progress ratio in [0, 1] — subtly lifts atmospheric luminosity without faking progress. */
  progressRatio?: number;
  /** Most recently stored rating tide — gives a gentle, transient horizon resonance. */
  tide?: RecallQuality | null;
}) {
  const safeProgress = Math.max(0, Math.min(1, Number.isFinite(progressRatio) ? progressRatio : 0));

  return (
    <div
      className={s.scene}
      aria-hidden="true"
      data-tide={tide ?? undefined}
      style={{ ["--th-progress" as string]: safeProgress.toFixed(3) }}
    >
      <div className={s.sky} />
      <div className={s.aurora} />
      <div className={s.nebula} />
      <div className={s.starsFar} />
      <div className={s.stars} />

      {/* Light-mode celestial centerpiece: Luminous Pearl Solar Astrolabe */}
      <div className={s.celestialDay}>
        <span className={s.dayCorona} />
        <span className={s.dayRingOuter}>
          <i className={s.daySatellite} />
        </span>
        <span className={s.dayRingInner} />
        <span className={s.dayOrb} />
      </div>
      <div className={s.dayBeams} />

      {/* Dark-mode celestial system: unobstructed Ringed Planet + orbiting moonlet + balancing distant crescent */}
      <div className={s.crescent} />
      <div className={s.planet}>
        <span className={s.planetGlow} />
        <span className={s.planetRingBack} />
        <span className={s.planetBody} />
        <span className={s.planetRingFront}>
          <i className={s.planetMoon} />
        </span>
      </div>

      <div className={s.clouds}>
        <i />
        <i />
        <i />
        <i />
      </div>

      <div className={s.sea}>
        <i className={s.seaHorizon} />
        <i className={s.seaGlint} />
        <i className={s.seaPath} />
      </div>

      <svg className={`${s.reef} ${s.reefLeft}`} viewBox="0 0 220 160" preserveAspectRatio="xMinYMax meet">
        <defs>
          <linearGradient id="thCrystalA" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: "var(--th-crystal-a)" }} />
            <stop offset="1" style={{ stopColor: "var(--th-crystal-b)" }} />
          </linearGradient>
          <linearGradient id="thCrystalB" x1="1" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--th-crystal-c)" }} />
            <stop offset="1" style={{ stopColor: "var(--th-crystal-a)" }} />
          </linearGradient>
        </defs>
        <path d="M18 160 L34 70 L52 160Z" fill="url(#thCrystalA)" />
        <path d="M34 70 L44 160 L52 160Z" style={{ fill: "var(--th-crystal-edge)" }} />
        <path d="M44 160 L66 40 L92 160Z" fill="url(#thCrystalB)" />
        <path d="M66 40 L78 160 L92 160Z" style={{ fill: "var(--th-crystal-edge)" }} />
        <path d="M84 160 L104 96 L122 160Z" fill="url(#thCrystalA)" />
        <path d="M0 160 L10 112 L24 160Z" fill="url(#thCrystalB)" />
        <path d="M118 160 L132 122 L150 160Z" fill="url(#thCrystalB)" />
      </svg>

      <svg className={`${s.reef} ${s.reefRight}`} viewBox="0 0 220 160" preserveAspectRatio="xMaxYMax meet">
        <path d="M200 160 L184 64 L166 160Z" fill="url(#thCrystalA)" />
        <path d="M184 64 L174 160 L166 160Z" style={{ fill: "var(--th-crystal-edge)" }} />
        <path d="M172 160 L150 36 L126 160Z" fill="url(#thCrystalB)" />
        <path d="M150 36 L140 160 L126 160Z" style={{ fill: "var(--th-crystal-edge)" }} />
        <path d="M130 160 L112 100 L96 160Z" fill="url(#thCrystalA)" />
        <path d="M220 160 L212 110 L198 160Z" fill="url(#thCrystalB)" />
      </svg>

      <div className={s.whale}>
        <EchoSwimmer facing="left" />
      </div>

      <div className={s.motes}>
        {MOTES.map((m, i) => (
          <i
            key={i}
            style={{
              left: `${m.x}%`,
              top: `${m.y}%`,
              width: m.z,
              height: m.z,
              animationDelay: `${m.d}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
