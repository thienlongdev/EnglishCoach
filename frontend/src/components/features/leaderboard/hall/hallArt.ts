/**
 * Echo Hall of Champions artwork (rendered in Blender from code: `docs/leaderboard/hall-of-champions-2026-10-30/art/`,
 * published by its `compose.py`). Content-hashed names: a changed picture ships under a new name (immutable caching).
 */
export const HALL_ART = {
  royalWide: '/leaderboard/hall/hall-royal-wide-0956507db1.webp',
  royalTall: '/leaderboard/hall/hall-royal-tall-6866c10de6.webp',
  midnightWide: '/leaderboard/hall/hall-midnight-wide-22900e8549.webp',
  midnightTall: '/leaderboard/hall/hall-midnight-tall-73e7c951d4.webp',
  trophy: '/leaderboard/hall/trophy-d71220a94a.webp',
  pedestal: {
    1: '/leaderboard/hall/pedestal-1-1d115d5b6d.webp',
    2: '/leaderboard/hall/pedestal-2-b01bf7c537.webp',
    3: '/leaderboard/hall/pedestal-3-4ddba45142.webp',
  },
} as const;

/** CSS custom properties of the hall backdrop: only the one the theme and width select is ever downloaded. */
export const HALL_BACKDROP_VARS = {
  '--hall-wide-royal': `url(${HALL_ART.royalWide})`,
  '--hall-tall-royal': `url(${HALL_ART.royalTall})`,
  '--hall-wide-midnight': `url(${HALL_ART.midnightWide})`,
  '--hall-tall-midnight': `url(${HALL_ART.midnightTall})`,
} as Record<string, string>;
