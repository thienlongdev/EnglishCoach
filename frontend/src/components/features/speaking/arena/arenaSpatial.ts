/** Metres and linear gain on the Arena height field. The panner supplies direction only. */
export const proximity = [[0,1],[1.25,1],[3,.5],[5,.12],[6,0]] as const;
export function spatialGain(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  if (distance <= 0) return 1;
  for (let i=1; i<proximity.length; i++) {
    const [end,to]=proximity[i], [start,from]=proximity[i-1];
    if (distance <= end) {
      const t=(distance-start)/(end-start);
      return from+(to-from)*t*t*(3-2*t);
    }
  }
  return 0;
}
