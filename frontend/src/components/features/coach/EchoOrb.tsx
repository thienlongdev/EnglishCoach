'use client';

import React from 'react';
import {
  EchoLivingEntity,
  deactivateEchoEntityStage,
  type EchoEntityVisualMode,
} from './entity/EchoLivingEntity';
import type { EchoEntitySlot, EchoEntityState, EchoEntityStateInput } from './entity/echoSprings';

export type { EchoEntitySlot, EchoEntityState, EchoEntityStateInput, EchoEntityVisualMode };
export { deactivateEchoEntityStage };
export {
  bindEchoVoiceAnalyser,
  triggerEchoSpeechBoundary,
  clearEchoSpeechBoundary,
} from './entity/echoAcousticBridge';

export interface EchoOrbProps {
  /** Supports canonical 12-state choreography plus 'idle' and legacy CoachWidget/EchoVoice string states. */
  state?: EchoEntityState | 'idle' | (string & {});
  /** Active UI slot for singleton WebGL2 priority arbitration (immersive > voice > rail > welcome > ambient > compact > launcher). */
  slot?: EchoEntitySlot;
  /** Pixel dimension or legacy preset ('sm' | 'md' | 'lg'). */
  size?: number | 'sm' | 'md' | 'lg';
  /** Directional gaze angle in radians (0 = straight toward learner). */
  attentionAngle?: number;
  /** True during backchannel soft-duck so Speaking shell dims cleanly without shockwave recoil. */
  softDucked?: boolean;
  /** Whether the CSS/VP9 resting essence shows EchoSwimmer when parked in Dormant or fallback mode. */
  swim?: boolean;
  /** Explicit activation gate; when false, cleanly detaches GPU/Canvas2D and reports onVisualReady(false). */
  active?: boolean;
  /** Deterministic readiness callback for atomic visual ownership transfer with the Echo Whale mascot. */
  onVisualReady?: (ready: boolean) => void;
  className?: string;
}

/**
 * Echo's multidimensional 5-layer Radiant Pearlescent Abyss Living Entity (Pearl x Abyss)
 * with compositor-only Pearlescent CSS/SVG resting essence when Dormant, reduced-motion, or evicted.
 */
export function EchoOrb({
  size = 'md',
  state = 'idle',
  slot,
  attentionAngle,
  softDucked = false,
  swim = true,
  active = true,
  onVisualReady,
  className,
}: EchoOrbProps) {
  return (
    <EchoLivingEntity
      size={size}
      state={state}
      slot={slot}
      attentionAngle={attentionAngle}
      softDucked={softDucked}
      swim={swim}
      active={active}
      onVisualReady={onVisualReady}
      className={className}
    />
  );
}
