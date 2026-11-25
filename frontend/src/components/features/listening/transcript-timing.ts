import type { TranscriptSegment } from '../../../types/listening';

/** Display envelopes only. Stored caption bounds still own replay/dictation/seek. */
export function transcriptDisplayBounds(segments: TranscriptSegment[]) {
  return segments.map(segment => {
    const timedWords = segment.words?.filter(word => Number.isFinite(word.start) && Number.isFinite(word.end)
      && word.start >= 0 && word.end > word.start) ?? [];
    return {
      start: Math.min(segment.startTimeMs / 1000, ...timedWords.map(word => word.start)),
      end: Math.max(segment.endTimeMs / 1000, ...timedWords.map(word => word.end)),
    };
  });
}

export function activeTranscriptSegment(bounds: { start: number; end: number }[], time: number): number {
  if (!bounds.length || !Number.isFinite(time)) return -1;
  let active = -1;
  let preceding = -1;
  for (let index = 0; index < bounds.length; index++) {
    const bound = bounds[index];
    if (time < bound.start) continue;
    if (preceding === -1 || bound.start >= bounds[preceding].start) preceding = index;
    // The later sentence owns its start even when a caption's old end overlaps it.
    if (time < bound.end && (active === -1 || bound.start >= bounds[active].start)) active = index;
  }
  // Preserve the existing stable sentence card during gaps and before the intro.
  return active !== -1 ? active : preceding !== -1 ? preceding : 0;
}
