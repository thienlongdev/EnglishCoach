/**
 * Stance speed of the retargeted shoe surface, metres/second at scale 1.
 * Source capture root speed overstates the shorter cast's stride. Measured
 * from the shipped Walk/Run clips (gait-bn-raw-{Walk,Run}.json); sole locking
 * handles the remaining heel/toe variation.
 */
export const GAIT_SPEED = { Walk: .91354, Run: 2.04482 } as const;

/** Clip rate for a travel speed: the only thing that keeps the feet from skating. */
export function gaitTimeScale(clip: keyof typeof GAIT_SPEED, speed: number, scale = 1, drawn: Partial<Record<keyof typeof GAIT_SPEED, number>> = {}) {
  return Math.max(.2, Math.min(2.2, speed / ((drawn[clip] ?? GAIT_SPEED[clip]) * scale)));
}

/** Turning on the spot: a slow shuffle of real steps, faster the faster the body turns. */
export function stepWhileTurning(radiansPerSecond: number) {
  return Math.max(.45, Math.min(1.1, Math.abs(radiansPerSecond) * .42)) * Math.sign(radiansPerSecond || 1);
}
