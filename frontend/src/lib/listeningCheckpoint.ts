import type { ListeningWorkspaceState } from '@/types/listening';
import type { TranscriptSegment } from '@/types/listening';

/** Latest-start containing segment owns overlaps; the preceding segment owns a gap. Untimed text has no seek target. */
export function listeningSentenceAtTime(segments: TranscriptSegment[], seconds: number) {
    if(!Number.isFinite(seconds))return -1;
    let previous=-1;let earliest=-1;let latestStart=-Infinity;let earliestStart=Infinity;
    segments.forEach((s,index)=>{
        if(typeof s.startTimeMs!=='number'||typeof s.endTimeMs!=='number'||!Number.isFinite(s.startTimeMs)||!Number.isFinite(s.endTimeMs)||s.startTimeMs<0||s.endTimeMs<=s.startTimeMs)return;
        const start=s.startTimeMs/1000;
        if(start<earliestStart){earliest=index;earliestStart=start;}
        if(start<=seconds&&start>=latestStart){latestStart=start;previous=index;}
    });
    return previous>=0?previous:earliest;
}

/** Three-way merge: a stale tab cannot silently replace another tab's draft. */
export function mergeListeningCheckpoint(base: ListeningWorkspaceState, local: ListeningWorkspaceState, remote: ListeningWorkspaceState) {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const result: ListeningWorkspaceState = { ...remote, entries: { ...remote.entries } };
    const conflicts: string[] = [];
    for (const id of Object.keys(local.entries)) {
        const own = local.entries[id], before = base.entries?.[id], other = remote.entries?.[id];
        if (same(own, before)) continue;
        if (!same(other, before) && !same(own, other) && own.draft !== other?.draft) { conflicts.push(id); continue; }
        result.entries[id] = { ...own, status: other?.status === 'completed' ? 'completed' : own.status };
    }
    // Navigation changed in a stale tab never replaces a newer remote checkpoint.
    if (same(base.selectedSegmentId, remote.selectedSegmentId)) {
        result.selectedSegmentId = local.selectedSegmentId;
        result.position = local.position;
    }
    if (!same(base.preferences, local.preferences) && same(base.preferences, remote.preferences)) result.preferences = local.preferences;
    return { state: result, conflicts };
}
