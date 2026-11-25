// duetsub (MIT), semantic-craft, revision 01f870c8. See LICENSE.txt.
export function synchronizeCues(topCues, bottomCues, timeMs, previous) {
    const canAdvance = previous !== undefined && timeMs >= previous.timeMs;
    const top = canAdvance ? advanceCursor(topCues, timeMs, previous.top) : locateCursor(topCues, timeMs);
    const bottom = canAdvance ? advanceCursor(bottomCues, timeMs, previous.bottom) : locateCursor(bottomCues, timeMs);
    return {
        topActive: top.activeIndices.map((index)=>topCues[index]),
        bottomActive: bottom.activeIndices.map((index)=>bottomCues[index]),
        state: {
            timeMs,
            top,
            bottom
        }
    };
}
function locateCursor(cues, timeMs) {
    const nextIndex = upperBoundStart(cues, timeMs);
    const activeIndices = [];
    for(let index = 0; index < nextIndex; index += 1){
        if (timeMs < cues[index].end) activeIndices.push(index);
    }
    return {
        nextIndex,
        activeIndices
    };
}
function advanceCursor(cues, timeMs, cursor) {
    const activeIndices = cursor.activeIndices.filter((index)=>timeMs < cues[index].end);
    let nextIndex = cursor.nextIndex;
    while(nextIndex < cues.length && cues[nextIndex].start <= timeMs){
        if (timeMs < cues[nextIndex].end) activeIndices.push(nextIndex);
        nextIndex += 1;
    }
    return {
        nextIndex,
        activeIndices
    };
}
function upperBoundStart(cues, timeMs) {
    let low = 0;
    let high = cues.length;
    while(low < high){
        const middle = Math.floor((low + high) / 2);
        if (cues[middle].start <= timeMs) low = middle + 1;
        else high = middle;
    }
    return low;
}
