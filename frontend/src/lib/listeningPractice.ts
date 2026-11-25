import { ListeningExercise, TranscriptSegment } from '@/types/listening';

/**
 * Resolves the initial exercise index based on URL search query parameters (?segment=, ?start=).
 * Used when deep-linking into listening/dictation practice.
 */
export function resolveInitialExerciseIndex(
    exercises: ListeningExercise[],
    segmentParam?: string | null,
    startParam?: string | null,
    segments?: TranscriptSegment[]
): number {
    if (!exercises || exercises.length === 0) return 0;

    if (segmentParam) {
        const segId = parseInt(segmentParam, 10);
        if (!isNaN(segId)) {
            const matchIdx = exercises.findIndex(ex => ex.transcriptSegmentId === segId);
            if (matchIdx !== -1) {
                return matchIdx;
            }
        }
    }

    if (startParam && segments && segments.length > 0) {
        const startSec = parseFloat(startParam);
        if (!isNaN(startSec)) {
            let bestIndex = 0;
            let minDiff = Infinity;
            exercises.forEach((ex, idx) => {
                const seg = segments.find(s => s.id === ex.transcriptSegmentId) || segments[idx];
                if (seg) {
                    const segStart = (seg.startTimeMs || 0) / 1000;
                    const diff = Math.abs(segStart - startSec);
                    if (diff < minDiff) {
                        minDiff = diff;
                        bestIndex = idx;
                    }
                }
            });
            return bestIndex;
        }
    }

    return 0;
}
