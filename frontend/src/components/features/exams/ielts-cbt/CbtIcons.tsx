import React from 'react';

/**
 * Header / navigation glyphs of the IELTS CBT room, drawn to match the reference captures (solid Wi-Fi arcs, thin bell,
 * square-ended bars, pen-in-square, heavy arrows). Original drawings — no third-party icon font is embedded.
 */
type P = React.SVGProps<SVGSVGElement>;

export const IconWifi = (p: P) => (
  <svg viewBox="0 0 26 20" width={26} height={20} aria-hidden {...p}>
    <g fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="butt">
      <path d="M1.6 7.4a16.4 16.4 0 0 1 22.8 0" />
      <path d="M5.4 11.2a11 11 0 0 1 15.2 0" />
      <path d="M9.2 15a5.6 5.6 0 0 1 7.6 0" />
    </g>
    <circle cx="13" cy="18.2" r="1.8" fill="currentColor" />
  </svg>
);

export const IconWifiOff = (p: P) => (
  <svg viewBox="0 0 26 20" width={26} height={20} aria-hidden {...p}>
    <g fill="none" stroke="currentColor" strokeWidth={3.2}>
      <path d="M1.6 7.4a16.4 16.4 0 0 1 22.8 0" opacity=".35" />
      <path d="M5.4 11.2a11 11 0 0 1 15.2 0" opacity=".35" />
      <path d="M9.2 15a5.6 5.6 0 0 1 7.6 0" opacity=".35" />
      <path d="M3 1l20 18" stroke="#d32029" strokeWidth={2.4} />
    </g>
  </svg>
);

export const IconBell = (p: P) => (
  <svg viewBox="0 0 22 26" width={22} height={26} aria-hidden {...p}>
    <path
      d="M11 2.4c-.9 0-1.5.6-1.5 1.4v.7C6.6 5.3 4.8 7.9 4.8 11v5.1c0 1.6-.9 3-2.4 3.9v.9h17.2V20c-1.5-.9-2.4-2.3-2.4-3.9V11c0-3.1-1.8-5.7-4.7-6.5v-.7c0-.8-.6-1.4-1.5-1.4z"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
    />
    <path d="M8.9 22.3a2.1 2.1 0 0 0 4.2 0z" fill="currentColor" />
  </svg>
);

export const IconBars = (p: P) => (
  <svg viewBox="0 0 22 20" width={22} height={20} aria-hidden {...p}>
    <rect x="0.5" y="1.5" width="21" height="3.4" fill="currentColor" />
    <rect x="0.5" y="8.3" width="21" height="3.4" fill="currentColor" />
    <rect x="0.5" y="15.1" width="21" height="3.4" fill="currentColor" />
  </svg>
);

export const IconNotes = (p: P) => (
  <svg viewBox="0 0 26 24" width={26} height={24} aria-hidden {...p}>
    <path d="M14.5 4H5.2C3.4 4 2 5.4 2 7.2v12.6C2 21.6 3.4 23 5.2 23h12.6c1.8 0 3.2-1.4 3.2-3.2V12" fill="none" stroke="currentColor" strokeWidth={2.2} />
    <path d="M21.2 1.6l3.2 3.2-10.6 10.6-4.3 1.1 1.1-4.3z" fill="currentColor" />
    <path d="M11 13.6l1.4 1.4" stroke="#fff" strokeWidth={1.2} />
  </svg>
);

export const IconArrowLeft = (p: P) => (
  <svg viewBox="0 0 28 26" width={28} height={26} aria-hidden {...p}>
    <path d="M13.2 1.6l2.8 2.8-6.8 6.8H26v4H9.2l6.8 6.8-2.8 2.8L1.6 13.2z" fill="currentColor" />
  </svg>
);

export const IconArrowRight = (p: P) => (
  <svg viewBox="0 0 28 26" width={28} height={26} aria-hidden {...p}>
    <path d="M14.8 1.6L12 4.4l6.8 6.8H2v4h16.8L12 22l2.8 2.8 11.6-11.6z" fill="currentColor" />
  </svg>
);

export const IconCheck = (p: P) => (
  <svg viewBox="0 0 20 16" width={20} height={16} aria-hidden {...p}>
    <path d="M7 15.4L.6 9l2.6-2.6L7 10.2 16.8.4l2.6 2.6z" fill="currentColor" />
  </svg>
);

export const IconResize = (p: P) => (
  <svg viewBox="0 0 22 10" width={22} height={10} aria-hidden {...p}>
    <path d="M0 5l5-4.4v3.1h12V.6L22 5l-5 4.4V6.3H5v3.1z" fill="currentColor" />
  </svg>
);
