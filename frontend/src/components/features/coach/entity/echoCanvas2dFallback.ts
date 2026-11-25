import type { EchoAcousticFrame } from './echoAcousticBridge';
import type { EchoUniformSnapshot } from './echoSprings';

/**
 * Zero-WebGL Radiant Pearlescent Abyss Canvas2D renderer used automatically when:
 * - The route evicts Echo's WebGL2 context to protect heavy 3D worlds (/study-space,
 *   /learning-path?view=odyssey, low-tier /knowledge-universe), OR
 * - WebGL2 is unavailable, software-emulated, context-lost, or failed GLSL link.
 *
 * Guarantees 0 WebGL contexts, strict radial falloff to alpha = 0 inside 0.47 * minDim
 * (zero square canvas edge!), luminous mother-of-pearl + opaline cyan + translucent sapphire
 * + lavender + rose-pink nacreous depth on Light and Dark themes, and genuine FFT audio reactivity.
 */

export interface EchoCanvas2dFrameArgs {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  timeSec: number;
  snap: EchoUniformSnapshot;
  acoustic: EchoAcousticFrame;
}

function rgbCss(rgb: Float32Array, alpha: number): string {
  const r = Math.round(Math.min(255, Math.max(0, rgb[0] * 255)));
  const g = Math.round(Math.min(255, Math.max(0, rgb[1] * 255)));
  const b = Math.round(Math.min(255, Math.max(0, rgb[2] * 255)));
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha)).toFixed(3)})`;
}

export function renderEchoPearlescentCanvas2d({
  ctx,
  width,
  height,
  timeSec,
  snap,
  acoustic,
}: EchoCanvas2dFrameArgs): void {
  if (width <= 0 || height <= 0) return;

  const cx = width * 0.5;
  const cy = height * 0.5;
  const minDim = Math.min(width, height);
  // Keep sphereR <= 0.33 * minDim and outer halo strictly <= 0.475 * minDim -> 0 square canvas edge!
  const sphereR = minDim * 0.305 * Math.max(0.68, Math.min(1.08, snap.uCoreScale));
  const maxSafeR = minDim * 0.475;
  const isDark = snap.uDark > 0.5;

  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, snap.canvasOpacity || 1));

  // 1) Translucent refractive sapphire-lavender cushion (Light) or opaline aurora bloom (Dark)
  if (!isDark) {
    const cushionOuter = Math.min(maxSafeR - sphereR * 0.08, sphereR * 1.36);
    const shGrad = ctx.createRadialGradient(
      cx,
      cy + sphereR * 0.08,
      sphereR * 0.52,
      cx,
      cy + sphereR * 0.08,
      cushionOuter,
    );
    shGrad.addColorStop(0, 'rgba(79, 104, 232, 0.22)');
    shGrad.addColorStop(0.58, 'rgba(139, 92, 246, 0.09)');
    shGrad.addColorStop(1, 'rgba(139, 92, 246, 0)');
    ctx.fillStyle = shGrad;
    ctx.beginPath();
    ctx.arc(cx, cy + sphereR * 0.08, cushionOuter, 0, Math.PI * 2);
    ctx.fill();
  }

  const haloOuter = Math.min(maxSafeR, sphereR * (1.38 + 0.08 * snap.uListenWaveMix + 0.08 * acoustic.voiceRms));
  const haloGrad = ctx.createRadialGradient(cx, cy, sphereR * 0.84, cx, cy, haloOuter);
  if (isDark) {
    haloGrad.addColorStop(0, rgbCss(snap.uCoreColorA, 0.36 + 0.18 * acoustic.voiceRms));
    haloGrad.addColorStop(0.50, rgbCss(snap.uCoreColorB, 0.18));
    haloGrad.addColorStop(0.78, 'rgba(244, 114, 182, 0.07)');
    haloGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  } else {
    haloGrad.addColorStop(0, 'rgba(56, 189, 248, 0.26)');
    haloGrad.addColorStop(0.52, 'rgba(139, 92, 246, 0.12)');
    haloGrad.addColorStop(0.82, 'rgba(244, 114, 182, 0.04)');
    haloGrad.addColorStop(1, 'rgba(244, 114, 182, 0)');
  }
  ctx.fillStyle = haloGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, haloOuter, 0, Math.PI * 2);
  ctx.fill();

  // 2) Translucent Sapphire-Pearl-Nacre Vessel (spatially rich cyan + pearl + violet + rose + sapphire)
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, sphereR, 0, Math.PI * 2);
  ctx.clip();

  const cavityGrad = ctx.createRadialGradient(
    cx - sphereR * 0.22,
    cy - sphereR * 0.24,
    sphereR * 0.04,
    cx + sphereR * 0.08,
    cy + sphereR * 0.10,
    sphereR * 1.08,
  );
  if (isDark) {
    cavityGrad.addColorStop(0, 'rgba(224, 248, 255, 0.90)');
    cavityGrad.addColorStop(0.28, 'rgba(56, 189, 248, 0.84)');
    cavityGrad.addColorStop(0.64, 'rgba(99, 76, 228, 0.86)');
    cavityGrad.addColorStop(1, 'rgba(30, 58, 152, 0.92)');
  } else {
    cavityGrad.addColorStop(0, 'rgba(250, 253, 255, 0.95)');
    cavityGrad.addColorStop(0.30, 'rgba(142, 232, 252, 0.90)');
    cavityGrad.addColorStop(0.66, 'rgba(138, 116, 248, 0.88)');
    cavityGrad.addColorStop(1, 'rgba(63, 98, 223, 0.92)');
  }
  ctx.fillStyle = cavityGrad;
  ctx.fillRect(cx - sphereR, cy - sphereR, sphereR * 2, sphereR * 2);

  // Spatially separated aurora spectral lobes (opaline cyan upper-left, rose-pink lower-right, violet diagonal)
  const lobeAlpha = Math.min(1, Math.max(0.50, snap.uSheetMix) * (0.72 + 0.28 * acoustic.voiceRms));
  const lobes: readonly [number, number, number, string][] = [
    [-0.24, -0.18, 0.72, 'rgba(34, 211, 238, 0.56)'],
    [0.26, 0.22, 0.70, 'rgba(244, 114, 182, 0.54)'],
    [0.18, -0.22, 0.64, 'rgba(168, 85, 247, 0.48)'],
    [-0.18, 0.24, 0.62, 'rgba(45, 212, 191, 0.44)'],
  ];
  for (let k = 0; k < lobes.length; k++) {
    const [ox, oy, radMul, col] = lobes[k];
    const driftX = ox + 0.12 * Math.sin(timeSec * (0.7 + k * 0.18) + k);
    const driftY = oy + 0.12 * Math.cos(timeSec * (0.65 + k * 0.15) - k);
    const lx = cx + driftX * sphereR;
    const ly = cy + driftY * sphereR;
    const lr = sphereR * radMul;
    const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
    lg.addColorStop(0, col);
    lg.addColorStop(0.55, col.replace(/0\.\d+\)$/, '0.22)'));
    lg.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.save();
    ctx.globalAlpha = lobeAlpha;
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.arc(lx, ly, lr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Focused Pearl-White luminous heart
  const coreGrad = ctx.createRadialGradient(
    cx - sphereR * 0.08,
    cy - sphereR * 0.08,
    0,
    cx - sphereR * 0.08,
    cy - sphereR * 0.08,
    sphereR * 0.40,
  );
  coreGrad.addColorStop(0, 'rgba(250, 253, 255, 0.76)');
  coreGrad.addColorStop(0.52, 'rgba(186, 238, 255, 0.28)');
  coreGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, sphereR * 0.46, 0, Math.PI * 2);
  ctx.fill();

  // 4) Listening 5-Strand Opaline Aurora Harmonic Ribbons
  if (snap.uListenWaveMix > 0.05) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const strandColors = [
      'rgba(240, 249, 255, 0.78)',
      'rgba(34, 211, 238, 0.74)',
      'rgba(168, 85, 247, 0.68)',
      'rgba(244, 114, 182, 0.64)',
    ];
    const span = sphereR * 1.56;
    const x0 = cx - span * 0.5;
    for (let s = 0; s < 4; s++) {
      ctx.beginPath();
      ctx.strokeStyle = strandColors[s];
      ctx.lineWidth = Math.max(1.3, minDim * 0.013);
      const amp = sphereR * (0.09 + 0.28 * acoustic.voiceRms + 0.14 * (s === 0 ? acoustic.bass : s === 1 ? acoustic.mid : acoustic.treble));
      const freq = (2.6 + s * 1.1) * (1 + 0.35 * acoustic.spectralCentroid);
      const arch = (s - 1.5) * sphereR * 0.055;
      for (let i = 0; i <= 44; i++) {
        const u = i / 44;
        const xn = u * 2 - 1;
        const gauss = Math.exp(-4.0 * xn * xn);
        const y = cy + arch * gauss + Math.sin(xn * freq * Math.PI - timeSec * (2.8 + s * 0.7) + s * 1.15) * amp * gauss;
        const x = x0 + u * span;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.globalAlpha = snap.uListenWaveMix * 0.80;
      ctx.stroke();
    }
    ctx.restore();
  }

  // 5) Speaking Silky Liquid-Light Caustic Veils (smooth translucent filled ellipses + delicate crest, zero scribbly wireframe)
  if (snap.uSpeakFieldMix > 0.05) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const veilColors = [
      'rgba(45, 212, 191, 0.30)',
      'rgba(168, 85, 247, 0.28)',
      'rgba(244, 114, 182, 0.26)',
    ];
    for (let k = 0; k < 3; k++) {
      const bin = acoustic.spectrum[(k * 9 + 4) & 31] || 0;
      const rx = sphereR * (0.76 + 0.14 * acoustic.voiceRms + 0.08 * bin);
      const ry = sphereR * (0.48 + 0.18 * acoustic.voiceRms + 0.10 * bin);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(timeSec * (0.55 + k * 0.22) * (k % 2 === 0 ? 1 : -1) + k * 1.05);
      ctx.fillStyle = veilColors[k];
      ctx.strokeStyle = k === 0 ? 'rgba(165, 243, 252, 0.56)' : k === 1 ? 'rgba(216, 180, 254, 0.50)' : 'rgba(251, 207, 232, 0.48)';
      ctx.lineWidth = Math.max(1.1, minDim * 0.010);
      ctx.globalAlpha = snap.uSpeakFieldMix * 0.78;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // 6) Pearlescent Nacre Fresnel Sheen & Studio Specular Crescent
  const specGrad = ctx.createRadialGradient(
    cx - sphereR * 0.32,
    cy - sphereR * 0.34,
    sphereR * 0.02,
    cx - sphereR * 0.32,
    cy - sphereR * 0.34,
    sphereR * 0.44,
  );
  specGrad.addColorStop(0, 'rgba(255, 255, 255, 0.80)');
  specGrad.addColorStop(0.46, 'rgba(224, 242, 254, 0.24)');
  specGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = specGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, sphereR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Outer nacreous crystal rim
  ctx.beginPath();
  ctx.arc(cx, cy, sphereR, 0, Math.PI * 2);
  ctx.strokeStyle = isDark ? 'rgba(186, 230, 253, 0.74)' : 'rgba(99, 102, 241, 0.52)';
  ctx.lineWidth = Math.max(1.2, minDim * 0.012);
  ctx.stroke();

  // 7) Gossamer Iridescent Orbital Light Filament Arcs
  const ringR1 = Math.min(maxSafeR * 0.86, sphereR * 1.15);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(timeSec * 0.54 * Math.max(0.25, Math.abs(snap.uRingSpeed)) + snap.uRingPhaseClick);
  ctx.strokeStyle = isDark ? 'rgba(125, 211, 252, 0.48)' : 'rgba(99, 102, 241, 0.38)';
  ctx.lineWidth = Math.max(1.0, minDim * 0.009);
  ctx.beginPath();
  ctx.arc(0, 0, ringR1, 0.22, Math.PI * 1.48);
  ctx.stroke();
  ctx.strokeStyle = isDark ? 'rgba(232, 121, 249, 0.40)' : 'rgba(236, 72, 153, 0.32)';
  ctx.beginPath();
  ctx.arc(0, 0, ringR1 * 1.07, Math.PI * 1.1, Math.PI * 1.95);
  ctx.stroke();
  ctx.restore();

  // 8) Thinking Aurora Neural Lumina Nodes (strictly inside maxSafeR)
  if (snap.uConstellation > 0.12) {
    const count = 10;
    ctx.save();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + timeSec * (0.42 + (i % 3) * 0.14);
      const dist = Math.min(maxSafeR * 0.92, sphereR * (1.18 + 0.16 * Math.sin(timeSec * 1.6 + i * 1.7)));
      const nx = cx + Math.cos(a) * dist;
      const ny = cy + Math.sin(a) * dist;
      ctx.strokeStyle = isDark ? 'rgba(196, 181, 253, 0.30)' : 'rgba(99, 102, 241, 0.26)';
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * sphereR, cy + Math.sin(a) * sphereR);
      ctx.lineTo(nx, ny);
      ctx.stroke();

      ctx.fillStyle = i % 2 === 0
        ? (isDark ? 'rgba(186, 230, 253, 0.90)' : 'rgba(56, 189, 248, 0.86)')
        : (isDark ? 'rgba(245, 208, 254, 0.88)' : 'rgba(168, 85, 247, 0.84)');
      ctx.beginPath();
      ctx.arc(nx, ny, Math.max(1.4, minDim * 0.014), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.restore();
}

export const renderEchoObsidianCanvas2d = renderEchoPearlescentCanvas2d;
