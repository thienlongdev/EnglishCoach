'use client';

import styles from './learningPath.module.css';

// Deterministic star field (same sky on server and client, no randomness at render).
const STARS = (() => {
  let seed = 11;
  const next = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: 90 }, () => ({ x: next() * 1600, y: next() * 330, r: 0.7 + next() * 1.6, o: 0.3 + next() * 0.65, t: next() < 0.2 }));
})();
// The sky west of the viewBox (x −1600…0): only seen when the hero is wider than the art's 8 : 3 box.
const STARS_WEST = (() => {
  let seed = 23;
  const next = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: 80 }, () => ({ x: -1600 + next() * 1600, y: next() * 330, r: 0.7 + next() * 1.5, o: 0.3 + next() * 0.6, t: next() < 0.2 }));
})();

// The trail the learner follows from the cliff to the summit (scene coordinates, viewBox 1600 × 600).
const TRAIL = 'M1298 506 C1336 482 1388 478 1384 446 C1380 416 1340 404 1372 374 C1404 344 1440 338 1428 300 C1418 266 1452 250 1446 216 C1442 194 1448 180 1450 164';

/**
 * Lộ trình học hero scene (decorative, `aria-hidden`, never catches the pointer): the learner standing on a cliff, a lit
 * trail climbing to a far summit, a night sky (dark theme) or a dawn sky (light theme). `destination` is the learner's
 * own goal label, written above the summit. Motion: drifting nebulae, twinkling stars, a breathing summit light and one
 * light pulse climbing the trail — opacity / transform / dash offset only, all of it still under reduced motion.
 */
export function AscentScene({ destination, destinationCaption }: { destination: string | null; destinationCaption: string }) {
  return (
    <div className={styles.scene} aria-hidden="true">
      <div className={styles.sky} />
      <div className={styles.nebula}><i /><i /></div>
      <svg className={styles.sceneSvg} viewBox="0 0 1600 600" preserveAspectRatio="xMaxYMax slice">
        <defs>
          <radialGradient id="lp-summit-glow">
            <stop offset="0" className={styles.glowStop0} />
            <stop offset="0.35" className={styles.glowStop1} />
            <stop offset="1" className={styles.glowStop2} />
          </radialGradient>
          <radialGradient id="lp-beam">
            <stop offset="0" className={styles.beamStop0} />
            <stop offset="1" className={styles.beamStop1} />
          </radialGradient>
          <linearGradient id="lp-trail" x1="1298" y1="506" x2="1450" y2="164" gradientUnits="userSpaceOnUse">
            <stop offset="0" className={styles.trailStop0} />
            <stop offset="0.55" className={styles.trailStop1} />
            <stop offset="1" className={styles.trailStop2} />
          </linearGradient>
          <linearGradient id="lp-ridge" x1="1320" y1="0" x2="1600" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" className={styles.ridgeStop0} />
            <stop offset="0.45" className={styles.ridgeStop1} />
            <stop offset="1" className={styles.ridgeStop0} />
          </linearGradient>
        </defs>
        <g className={styles.stars}>
          {[...STARS_WEST, ...STARS].map((s, i) => (
            <circle key={i} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={s.r.toFixed(2)} opacity={s.o.toFixed(2)} className={s.t ? styles.twinkle : undefined} />
          ))}
        </g>
        <ellipse className={styles.beam} cx="1450" cy="40" rx="38" ry="170" fill="url(#lp-beam)" />
        <circle className={styles.summitGlow} cx="1450" cy="168" r="300" fill="url(#lp-summit-glow)" />
        <path className={styles.mFar} d="M-1600 410 L-1508 380 L-1420 404 L-1318 360 L-1226 392 L-1130 352 L-1036 386 L-940 344 L-846 378 L-752 336 L-660 372 L-566 330 L-470 364 L-372 340 L-286 376 L-196 350 L-96 408 L0 452 L92 418 L176 436 L284 382 L384 418 L476 362 L566 398 L664 350 L764 388 L862 340 L952 378 L1032 330 L1102 356 L1182 304 L1252 330 L1342 292 L1424 330 L1504 300 L1600 338 V600 H-1600 Z" />
        <path className={styles.mBack} d="M880 600 L1010 392 L1070 414 L1150 300 L1206 336 L1262 306 L1330 392 V600 Z" />
        <path className={styles.mMain} d="M1060 600 L1190 430 L1250 448 L1324 348 L1366 366 L1450 162 L1500 252 L1530 238 L1572 304 L1600 326 V600 Z" />
        <path className={styles.mShade} d="M1450 162 L1500 252 L1530 238 L1572 304 L1600 326 V600 H1462 L1436 470 L1458 360 Z" />
        <path className={styles.mSnow} d="M1450 162 L1474 206 L1460 201 L1449 218 L1436 200 L1425 210 Z" />
        <path className={styles.ridge} d="M1324 348 L1366 366 L1450 162 L1500 252 L1530 238 L1572 304" stroke="url(#lp-ridge)" />
        <path className={styles.mMid} d="M-1600 516 L-1460 486 L-1330 508 L-1190 470 L-1050 500 L-910 478 L-770 512 L-620 482 L-480 506 L-340 476 L-200 498 L-90 488 L0 522 L136 474 L254 502 L378 452 L516 500 L636 470 L758 520 L874 492 L1000 532 L1170 516 L1320 540 L1460 512 L1600 530 V600 H-1600 Z" />
        <path className={styles.trailHalo} d={TRAIL} />
        <path className={styles.trail} d={TRAIL} stroke="url(#lp-trail)" />
        <path className={styles.trailPulse} d={TRAIL} pathLength="100" />
        <path className={styles.mCliff} d="M1148 600 L1180 528 L1224 508 L1268 516 L1316 500 L1344 522 L1378 600 Z" />
        <g className={styles.climber} transform="translate(1273 466)">
          <circle cx="7" cy="5" r="4.6" />
          <path d="M1.5 12 Q7 9.5 12.5 12 L14 25 L11.5 25.5 L10.6 37 L8 37 L7.2 27 L6.3 37 L3.7 37 L2.8 25.5 L0.2 25 Z" />
          <path d="M11.4 12.5 L16.6 14.2 L17.4 24.6 L12.8 25 Z" />
        </g>
        {destination && (
          <g className={styles.summitTag}>
            <text x="1450" y="96" textAnchor="middle" className={styles.summitTagValue}>{destination}</text>
            <text x="1450" y="124" textAnchor="middle" className={styles.summitTagCaption}>{destinationCaption}</text>
          </g>
        )}
      </svg>
      <div className={styles.sceneMist} />
      <div className={styles.sceneScrim} />
    </div>
  );
}

/** Quiet night ridge behind the journey track (decorative). */
export function JourneyBackdrop() {
  return (
    <div className={styles.journeyBackdrop} aria-hidden="true">
      <svg viewBox="0 0 1600 260" preserveAspectRatio="xMidYMax slice">
        <g className={styles.stars}>
          {STARS.slice(0, 46).map((s, i) => (
            <circle key={i} cx={s.x.toFixed(1)} cy={(s.y * 0.45).toFixed(1)} r={(s.r * 0.8).toFixed(2)} opacity={(s.o * 0.8).toFixed(2)} />
          ))}
        </g>
        <path className={styles.jbFar} d="M0 210 L120 168 L240 192 L360 140 L470 176 L600 120 L720 168 L840 128 L960 170 L1080 112 L1200 160 L1320 104 L1440 150 L1600 118 V260 H0 Z" />
        <path className={styles.jbNear} d="M0 240 L160 206 L300 226 L460 196 L620 230 L780 204 L940 236 L1100 208 L1260 232 L1420 204 L1600 228 V260 H0 Z" />
      </svg>
    </div>
  );
}
