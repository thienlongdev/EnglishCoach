/**
 * Echo's static files. Both names carry the first 8 hex digits of the file's SHA-256: a changed file ships under a new
 * name, so the year-long browser cache and the Cloudflare edge cache (rule on `/models/*.glb`) can never serve a
 * stale model. Never replace a file in place. `/models/whale.glb` stays on disk, byte-identical, for pages loaded
 * before the rename.
 */
export const ECHO_MODEL_URL = '/models/whale-e0569b41.glb';

/**
 * The standby still: the real model rendered with the engine's lights, material and still pose
 * (`scripts/render-echo-still.cjs`, 6.8 KB). The whale's origin is the image centre and one model unit — Echo's
 * length — spans `unit` × the image width, so the engine can take over at exactly the still's place and size.
 */
export const ECHO_STILL = { src: '/assets/echo-still-805552e9.webp', width: 640, height: 400, unit: 0.74 } as const;

/** The heading the still was rendered with (the engine holds it while it takes over). */
export const ECHO_STILL_HEADING = [1, 0.05, 0.55] as const;
