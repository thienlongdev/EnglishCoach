/**
 * The sign-in sea's first-paint pictures, content-hashed (`docs/journey/cinematic-2026-10-31/capture`). The stylesheet (`authGlass.module.css`) paints them; this list only warms them
 * before a journey. `test-journey.mjs` checks that both name the same files and that they exist.
 */
export const AUTH_STILLS = {
  day: { wide: '/journey/auth-day-wide-e2ad5f30.webp', tall: '/journey/auth-day-tall-2a966796.webp' },
  dawn: { wide: '/journey/auth-dawn-wide-a1baab7c.webp', tall: '/journey/auth-dawn-tall-b4bbdad2.webp' },
  nightDay: { wide: '/journey/auth-night-day-wide-59703646.webp', tall: '/journey/auth-night-day-tall-57050458.webp' },
  nightDawn: { wide: '/journey/auth-night-dawn-wide-974343b1.webp', tall: '/journey/auth-night-dawn-tall-5d195c7a.webp' },
} as const;

/** The engine's own rule: its portrait lens and horizon apply on these screens. */
export const isTallSea = (width: number, height: number) => width / Math.max(1, height) < 0.95 || width < 900;
