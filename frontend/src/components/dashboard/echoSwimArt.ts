/**
 * Echo's swim loop for the Dashboard hero: the REAL model (whale-e0569b41.glb, its own `swimming` + `idle` clips, 2.5 s) rendered
 * with the landing engine's lights by docs/echo-ocean/2026-11-14/art/render-echo-swim.cjs, encoded as VP9 with alpha (ffmpeg line
 * in that record's README). Generated: never edit by hand; a changed loop ships under a new name.
 * `origin` = where the whale's own origin sits in the frame (fractions), as ECHO_STILL's centre does.
 */
export const ECHO_SWIM = {
  webm: '/assets/echo-swim-4e5224c6.webm',
  width: 560,
  height: 226,
  seconds: 2.5,
  origin: [0.596, 0.522],
} as const;
