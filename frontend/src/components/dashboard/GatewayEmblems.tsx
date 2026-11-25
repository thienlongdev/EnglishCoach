"use client";

import { useId } from "react";

export type GatewayKind = "flashcards" | "reading" | "listening" | "speaking" | "writing" | "exams";

/**
 * Dimensional glass emblems of the six learning gateways (decorative, `aria-hidden`). Pure SVG: the colours come from the
 * card's tone variables (`--e-hi`, `--e-mid`, `--e-lo`), so one drawing serves both themes. No text, no raster, no animation
 * inside: the card moves the emblem as a whole (transform only).
 */
export function GatewayEmblem({ kind, className }: { kind: GatewayKind; className?: string }) {
  const raw = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const id = (name: string) => `${raw}-${name}`;
  const url = (name: string) => `url(#${id(name)})`;
  return (
    <svg viewBox="0 0 120 100" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id("face")} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--e-hi)" }} />
          <stop offset="1" style={{ stopColor: "var(--e-mid)" }} />
        </linearGradient>
        <linearGradient id={id("deep")} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" style={{ stopColor: "var(--e-mid)" }} />
          <stop offset="1" style={{ stopColor: "var(--e-lo)" }} />
        </linearGradient>
        <linearGradient id={id("sheen")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={id("floor")} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" style={{ stopColor: "var(--e-mid)" }} stopOpacity="0.55" />
          <stop offset="1" style={{ stopColor: "var(--e-mid)" }} stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="60" cy="91" rx="42" ry="7" fill={url("floor")} />
      {kind === "flashcards" && (
        <g>
          <rect x="27" y="24" width="50" height="62" rx="9" transform="rotate(-15 52 55)" fill={url("deep")} opacity="0.75" />
          <rect x="33" y="19" width="50" height="62" rx="9" transform="rotate(-5 58 50)" fill={url("deep")} />
          <g transform="rotate(9 66 48)">
            <rect x="41" y="15" width="50" height="62" rx="9" fill={url("face")} stroke="#ffffff" strokeOpacity="0.55" />
            <rect x="45" y="19" width="42" height="22" rx="6" fill={url("sheen")} opacity="0.55" />
            <path d="M54 50h24M54 58h17M54 66h21" stroke="#ffffff" strokeOpacity="0.8" strokeWidth="3.4" strokeLinecap="round" />
            <circle cx="80" cy="27" r="4.5" fill="#ffffff" fillOpacity="0.9" />
          </g>
        </g>
      )}
      {kind === "reading" && (
        <g>
          <path d="M60 36C47 27 29 26 15 30v52c14-4 32-3 45 6 13-9 31-10 45-6V30c-14-4-32-3-45 6z" fill={url("deep")} transform="translate(0 4)" />
          <path d="M60 34C48 25 31 24 18 28v50c13-4 30-3 42 6V34z" fill={url("face")} stroke="#ffffff" strokeOpacity="0.5" />
          <path d="M60 34c12-9 29-10 42-6v50c-13-4-30-3-42 6V34z" fill={url("face")} opacity="0.86" stroke="#ffffff" strokeOpacity="0.5" />
          <path d="M26 40c9-2 18-1 26 3M26 50c9-2 18-1 26 3M26 60c9-2 18-1 26 3M68 43c8-4 17-5 26-3M68 53c8-4 17-5 26-3M68 63c8-4 17-5 26-3"
            stroke="#ffffff" strokeOpacity="0.75" strokeWidth="2.6" strokeLinecap="round" fill="none" />
          <path d="M18 28c13-4 30-3 42 6" stroke={url("sheen")} strokeWidth="3" fill="none" />
          <path d="M60 34v50" stroke="var(--e-lo)" strokeOpacity="0.6" strokeWidth="2" />
        </g>
      )}
      {kind === "listening" && (
        <g>
          <path d="M25 63C25 30 95 30 95 63" stroke={url("deep")} strokeWidth="10" strokeLinecap="round" fill="none" />
          <path d="M28 58C30 34 90 34 92 58" stroke={url("sheen")} strokeWidth="2.5" strokeLinecap="round" fill="none" opacity="0.7" />
          <rect x="15" y="54" width="23" height="33" rx="10" fill={url("deep")} />
          <rect x="20" y="57" width="15" height="26" rx="7" fill={url("face")} stroke="#ffffff" strokeOpacity="0.6" />
          <rect x="82" y="54" width="23" height="33" rx="10" fill={url("deep")} />
          <rect x="85" y="57" width="15" height="26" rx="7" fill={url("face")} stroke="#ffffff" strokeOpacity="0.6" />
          <path d="M50 64c3-4 3-8 0-12M58 68c6-7 6-17 0-24M66 72c9-10 9-26 0-36" stroke={url("face")} strokeWidth="3" strokeLinecap="round" fill="none" opacity="0.9" />
        </g>
      )}
      {kind === "speaking" && (
        <g>
          <path d="M36 50c0 16 11 24 24 24s24-8 24-24" stroke={url("deep")} strokeWidth="6" strokeLinecap="round" fill="none" />
          <rect x="56" y="73" width="8" height="10" fill={url("deep")} />
          <rect x="42" y="82" width="36" height="7" rx="3.5" fill={url("deep")} />
          <rect x="44" y="12" width="32" height="52" rx="16" fill={url("face")} stroke="#ffffff" strokeOpacity="0.6" />
          <path d="M50 26h20M50 33h20M50 40h20M50 47h20" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="2.4" strokeLinecap="round" />
          <rect x="48" y="15" width="10" height="30" rx="5" fill={url("sheen")} opacity="0.7" />
          <path d="M90 34c4 5 4 13 0 18M98 28c7 9 7 21 0 30" stroke={url("face")} strokeWidth="3" strokeLinecap="round" fill="none" />
        </g>
      )}
      {kind === "writing" && (
        <g>
          <path d="M14 84c12-9 22 4 34-3s20-11 30-4" stroke={url("face")} strokeWidth="3.5" strokeLinecap="round" fill="none" opacity="0.9" />
          <g transform="rotate(38 70 46)">
            <rect x="62" y="2" width="17" height="60" rx="8.5" fill={url("face")} stroke="#ffffff" strokeOpacity="0.6" />
            <rect x="62" y="17" width="17" height="7" fill="var(--e-lo)" opacity="0.75" />
            <path d="M62 62h17l-8.5 24z" fill={url("deep")} />
            <path d="M70.5 66v13" stroke="#ffffff" strokeOpacity="0.8" strokeWidth="1.6" />
            <rect x="65" y="5" width="5" height="50" rx="2.5" fill={url("sheen")} opacity="0.75" />
          </g>
        </g>
      )}
      {kind === "exams" && (
        <g>
          {[32, 18, 4].map((dy, i) => (
            <g key={dy} transform={`translate(0 ${dy})`} opacity={i === 2 ? 1 : 0.92}>
              <path d="M24 34 60 50v10L24 44z" fill={url("deep")} />
              <path d="M96 34 60 50v10l36-16z" fill="var(--e-lo)" />
              <path d="M60 18l36 16-36 16-36-16z" fill={url("face")} stroke="#ffffff" strokeOpacity={i === 2 ? 0.7 : 0.35} />
            </g>
          ))}
          <path d="M50 37l7 6 14-12" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </g>
      )}
    </svg>
  );
}
