import assert from "node:assert/strict";
import { finiteDurationOrNull, formatAudioTime } from "../src/lib/audioDuration.mjs";

assert.equal(finiteDurationOrNull(Infinity), null);
assert.equal(finiteDurationOrNull(Number.NaN), null);
assert.equal(finiteDurationOrNull(0), null);
assert.equal(finiteDurationOrNull(65.8), 65.8);
assert.equal(formatAudioTime(Infinity), "--:--");
assert.equal(formatAudioTime(Number.NaN), "--:--");
assert.equal(formatAudioTime(null), "--:--");
assert.equal(formatAudioTime(65.8), "1:05");

console.log("shadowing audio duration contract: 8 passed, 0 failed, 0 skipped");
