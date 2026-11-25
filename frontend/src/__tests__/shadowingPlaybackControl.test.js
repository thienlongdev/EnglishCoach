/**
 * SHD-2A Shadowing Playback & Recording Interaction Control Regression Test Suite
 * Validates:
 * - Playback Permission / Intent semantics
 * - Post-recording pause invariant (isRecording=false NEVER auto-resumes media)
 * - Recorder state transitions (RECORDING -> PROCESSING -> REVIEWING -> IDLE -> ERROR)
 * - Repeat limits (1x, 2x, 3x, Infinite)
 * - Boundary race conditions
 * - Manual Replay restoration
 * - Sentence navigation lifecycle
 * - Component cleanup
 */
const assert = require('assert');

class MockYouTubePlayer {
    constructor() {
        this.currentTime = 0;
        this.isPlaying = false;
        this.playCount = 0;
        this.pauseCount = 0;
        this.seekCount = 0;
        this.lastSeek = 0;
    }

    playVideo() {
        this.isPlaying = true;
        this.playCount++;
    }

    pauseVideo() {
        this.isPlaying = false;
        this.pauseCount++;
    }

    seekTo(seconds, allowSeekAhead) {
        this.currentTime = seconds;
        this.seekCount++;
        this.lastSeek = seconds;
    }

    getCurrentTime() {
        return this.currentTime;
    }

    getPlayerState() {
        return this.isPlaying ? 1 : 2;
    }
}

class ShadowingWorkspaceSimulator {
    constructor({ initialUnitIndex = 0, units = [], repeatCount = 1 } = {}) {
        this.units = units.length > 0 ? units : [
            { id: 1, startTimeMs: 1000, endTimeMs: 4000, displayText: "Sentence 1" },
            { id: 2, startTimeMs: 5000, endTimeMs: 9000, displayText: "Sentence 2" },
            { id: 3, startTimeMs: 10000, endTimeMs: 14000, displayText: "Sentence 3" },
        ];
        this.currentIndex = initialUnitIndex;
        this.repeatCount = repeatCount;

        // Recorder State
        this.recorderState = 'IDLE'; // 'IDLE' | 'REQUESTING_PERMISSION' | 'RECORDING' | 'REVIEWING' | 'PROCESSING' | 'ERROR'
        this.isRecording = false;

        // Player Imperative State
        this.ytPlayer = new MockYouTubePlayer();
        this.loopA = null;
        this.loopB = null;
        this.currentCycle = 0;
        this.maxRepeats = repeatCount;
        this.isSeeking = false;
        this.lastSeekTime = 0;

        // Shadowing Page Controller State
        this.playbackPermission = false;
        this.lastUnitIndex = null;
        this.activeTimer = null;
        this.isUnmounted = false;

        // Initialize active sentence
        this.syncUnitOnMountOrChange();
    }

    get currentUnit() {
        return this.units[this.currentIndex] || null;
    }

    syncUnitOnMountOrChange() {
        if (this.isUnmounted) return;
        const isNewUnit = this.lastUnitIndex !== this.currentIndex;
        this.lastUnitIndex = this.currentIndex;

        if (isNewUnit && !this.isRecording) {
            this.playbackPermission = true;
            if (this.activeTimer) clearTimeout(this.activeTimer);
            this.activeTimer = setTimeout(() => {
                if (this.playbackPermission && !this.isRecording && this.currentUnit) {
                    const startSec = this.currentUnit.startTimeMs / 1000;
                    const endSec = this.currentUnit.endTimeMs / 1000;
                    this.setLoop(startSec, endSec, true, this.repeatCount);
                }
            }, 50);
        }
    }

    setLoop(start, end, autoPlay = true, maxRepeats = undefined) {
        if (this.isUnmounted) return;
        this.loopA = start;
        this.loopB = end;
        this.currentCycle = 0;
        this.maxRepeats = maxRepeats !== undefined ? maxRepeats : this.repeatCount;
        this.isSeeking = true;
        this.lastSeekTime = Date.now();
        this.ytPlayer.seekTo(start, true);
        if (autoPlay && !this.isRecording && this.playbackPermission) {
            this.ytPlayer.playVideo();
        }
    }

    clearLoop() {
        this.loopA = null;
        this.loopB = null;
        this.currentCycle = 0;
        this.maxRepeats = Infinity;
        this.isSeeking = false;
    }

    loopCurrentUnit(explicitIntent = false) {
        if (this.isUnmounted || this.isRecording) return;
        if (explicitIntent) {
            this.playbackPermission = true;
        }
        if (!this.playbackPermission) return;
        if (this.currentUnit) {
            const startSec = this.currentUnit.startTimeMs / 1000;
            const endSec = this.currentUnit.endTimeMs / 1000;
            this.setLoop(startSec, endSec, true, this.repeatCount);
        }
    }

    startRecording() {
        if (this.isUnmounted) return;
        this.playbackPermission = false;
        this.clearLoop();
        this.ytPlayer.pauseVideo();
        if (this.activeTimer) {
            clearTimeout(this.activeTimer);
            this.activeTimer = null;
        }
        this.isRecording = true;
        this.recorderState = 'RECORDING';
    }

    stopRecording() {
        if (this.isUnmounted) return;
        this.isRecording = false;
        this.recorderState = 'REVIEWING';
        // Note: isRecording = false does NOT set playbackPermission to true!
    }

    transitionToProcessing() {
        if (this.isUnmounted) return;
        this.recorderState = 'PROCESSING';
    }

    transitionToFeedbackRendered() {
        if (this.isUnmounted) return;
        this.recorderState = 'IDLE'; // analysis received, ready for next attempt or replay
    }

    selectUnit(index) {
        if (this.isUnmounted) return;
        if (this.activeTimer) {
            clearTimeout(this.activeTimer);
            this.activeTimer = null;
        }
        this.isRecording = false;
        this.recorderState = 'IDLE';
        this.playbackPermission = true;
        this.currentIndex = index;
        this.syncUnitOnMountOrChange();
    }

    unmount() {
        this.isUnmounted = true;
        if (this.activeTimer) {
            clearTimeout(this.activeTimer);
            this.activeTimer = null;
        }
        this.clearLoop();
        this.ytPlayer.pauseVideo();
    }

    // Advance player time tick (simulates 50ms polling interval)
    tick(timeSec) {
        if (this.isUnmounted) return { action: 'UNMOUNTED' };

        if (this.isRecording) {
            if (this.ytPlayer.isPlaying) {
                this.ytPlayer.pauseVideo();
            }
            return { action: 'BLOCKED_BY_RECORDING' };
        }

        this.ytPlayer.currentTime = timeSec;

        if (this.ytPlayer.isPlaying && this.loopA !== null && this.loopB !== null) {
            const now = Date.now();

            if (this.isSeeking) {
                if (timeSec >= this.loopA && timeSec < this.loopB && (now - this.lastSeekTime > 300)) {
                    this.isSeeking = false;
                }
            }

            if (!this.isSeeking && timeSec >= this.loopB) {
                if (this.isRecording || !this.playbackPermission) {
                    this.ytPlayer.pauseVideo();
                    return { action: 'BLOCKED_BY_PERMISSION' };
                }

                const nextCycle = this.currentCycle + 1;
                this.currentCycle = nextCycle;

                if (nextCycle < this.maxRepeats) {
                    this.isSeeking = true;
                    this.lastSeekTime = now;
                    this.ytPlayer.seekTo(this.loopA, true);
                    return { action: 'LOOP_SEEK', cycle: nextCycle };
                } else {
                    this.ytPlayer.pauseVideo();
                    return { action: 'REPEAT_LIMIT_REACHED', cycle: nextCycle };
                }
            }
        }

        return { action: 'PLAYING', currentTime: timeSec };
    }
}

// Helper to flush asynchronous setTimeout
function flushTimers() {
    return new Promise((resolve) => setTimeout(resolve, 80));
}

async function runTests() {
    console.log('====================================================');
    console.log('SHD-2A POST-RECORDING PAUSE REGRESSION TEST SUITE');
    console.log('====================================================');
    let passed = 0;
    let failed = 0;

    function runCase(name, fn) {
        try {
            fn();
            console.log(`[PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`[FAIL] ${name}: ${err.message}`);
            failed++;
        }
    }

    async function runCaseAsync(name, fn) {
        try {
            await fn();
            console.log(`[PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`[FAIL] ${name}: ${err.message}`);
            failed++;
        }
    }

    // TEST A — INFINITE REPEAT INTERRUPTION
    await runCaseAsync('TEST A — Infinite repeat interruption remains paused permanently after recording', async () => {
        const workspace = new ShadowingWorkspaceSimulator({ repeatCount: Infinity });
        await flushTimers();
        assert.strictEqual(workspace.ytPlayer.isPlaying, true, 'Should be playing infinite loop initially');

        // Play 2 cycles
        workspace.isSeeking = false;
        workspace.tick(4.0); // cycle 1
        workspace.isSeeking = false;
        workspace.tick(4.0); // cycle 2
        assert.strictEqual(workspace.ytPlayer.isPlaying, true);

        // Start recording
        workspace.startRecording();
        assert.strictEqual(workspace.ytPlayer.isPlaying, false, 'Media must pause immediately on record');
        assert.strictEqual(workspace.playbackPermission, false, 'Playback permission must be revoked');

        // Stop recording -> REVIEWING
        workspace.stopRecording();
        assert.strictEqual(workspace.ytPlayer.isPlaying, false, 'Media must REMAIN PAUSED on stop recording');

        // Transition to PROCESSING
        workspace.transitionToProcessing();
        assert.strictEqual(workspace.ytPlayer.isPlaying, false, 'Media must REMAIN PAUSED during PROCESSING');

        // Transition to FEEDBACK RENDERED (YOU SAID card)
        workspace.transitionToFeedbackRendered();
        assert.strictEqual(workspace.ytPlayer.isPlaying, false, 'Media must REMAIN PAUSED during YOU SAID rendering');

        // Simulate multiple polling ticks over 10 seconds of idle wait
        for (let t = 0; t <= 15; t += 0.5) {
            const tickRes = workspace.tick(t);
            assert.notStrictEqual(tickRes.action, 'LOOP_SEEK', 'Infinite loop must not auto-resume ticks');
            assert.strictEqual(workspace.ytPlayer.isPlaying, false, 'Media must not restart during idle wait');
        }
    });

    // TEST B — 2X BOUNDARY RACE
    await runCaseAsync('TEST B — 2x boundary race does not start cycle 2 when recording triggers at boundary', async () => {
        const workspace = new ShadowingWorkspaceSimulator({ repeatCount: 2 });
        await flushTimers();
        workspace.isSeeking = false;

        // Play near end boundary (3.99s)
        workspace.tick(3.99);
        assert.strictEqual(workspace.ytPlayer.isPlaying, true);

        // Learner starts recording exactly at boundary (4.0s)
        workspace.startRecording();
        const boundaryTick = workspace.tick(4.0);
        assert.strictEqual(boundaryTick.action, 'BLOCKED_BY_RECORDING');
        assert.strictEqual(workspace.ytPlayer.isPlaying, false, 'Playback must be blocked at boundary');

        // Stop recording
        workspace.stopRecording();
        assert.strictEqual(workspace.ytPlayer.isPlaying, false);

        // Simulate any stale boundary tick or ended event
        const postStopTick = workspace.tick(4.0);
        assert.notStrictEqual(postStopTick.action, 'LOOP_SEEK', 'Cycle 2 must not trigger after recording');
        assert.strictEqual(workspace.ytPlayer.isPlaying, false);
    });

    // TEST C — RECORDER STATE TRANSITIONS
    await runCaseAsync('TEST C — Reference remains paused across all recorder state transitions', async () => {
        const workspace = new ShadowingWorkspaceSimulator({ repeatCount: 1 });
        await flushTimers();
        assert.strictEqual(workspace.ytPlayer.isPlaying, true);

        const initialPlayCount = workspace.ytPlayer.playCount;

        // 1. RECORDING
        workspace.startRecording();
        assert.strictEqual(workspace.ytPlayer.isPlaying, false);

        // 2. REVIEWING
        workspace.stopRecording();
        assert.strictEqual(workspace.ytPlayer.isPlaying, false);

        // 3. PROCESSING
        workspace.transitionToProcessing();
        assert.strictEqual(workspace.ytPlayer.isPlaying, false);

        // 4. YOU SAID Feedback Rendered (IDLE)
        workspace.transitionToFeedbackRendered();
        assert.strictEqual(workspace.ytPlayer.isPlaying, false);

        // Total playVideo calls must not have increased since recording started
        assert.strictEqual(workspace.ytPlayer.playCount, initialPlayCount, 'Zero play calls permitted during transitions');
    });

    // TEST D — MANUAL REPLAY RESTORATION
    await runCaseAsync('TEST D — Manual replay restoration resets cycles and respects selected repeat count', async () => {
        const workspace = new ShadowingWorkspaceSimulator({ repeatCount: 2 });
        await flushTimers();

        // Record and finish
        workspace.startRecording();
        workspace.stopRecording();
        workspace.transitionToFeedbackRendered();
        assert.strictEqual(workspace.ytPlayer.isPlaying, false);

        // Learner explicitly clicks "Lặp lại câu mẫu" (Replay)
        workspace.loopCurrentUnit(true);
        assert.strictEqual(workspace.ytPlayer.isPlaying, true, 'Replay must start playback on demand');
        assert.strictEqual(workspace.currentCycle, 0, 'Cycle counter must reset to 0');
        assert.strictEqual(workspace.ytPlayer.lastSeek, 1.0, 'Must seek to start timestamp');

        // First repeat
        workspace.isSeeking = false;
        const res1 = workspace.tick(4.0);
        assert.strictEqual(res1.action, 'LOOP_SEEK');
        assert.strictEqual(workspace.currentCycle, 1);
        assert.strictEqual(workspace.ytPlayer.isPlaying, true);

        // Second repeat (limit 2x reached -> pauses)
        workspace.isSeeking = false;
        const res2 = workspace.tick(4.0);
        assert.strictEqual(res2.action, 'REPEAT_LIMIT_REACHED');
        assert.strictEqual(workspace.currentCycle, 2);
        assert.strictEqual(workspace.ytPlayer.isPlaying, false, 'Must stop after exact 2x plays');
    });

    // TEST E — DEFAULT 1X REGRESSION
    await runCaseAsync('TEST E — Default repeat = 1x plays exactly once and stops at boundary', async () => {
        const workspace = new ShadowingWorkspaceSimulator({ repeatCount: 1 });
        await flushTimers();
        assert.strictEqual(workspace.ytPlayer.isPlaying, true);

        workspace.isSeeking = false;
        const res = workspace.tick(4.0);
        assert.strictEqual(res.action, 'REPEAT_LIMIT_REACHED');
        assert.strictEqual(workspace.currentCycle, 1);
        assert.strictEqual(workspace.ytPlayer.isPlaying, false, 'Must pause at boundary on 1x');
    });

    // TEST F — 2X / 3X REGRESSION
    await runCaseAsync('TEST F — 2x and 3x repeat counts execute exact iterations and stop', async () => {
        // Test 2x
        const ws2 = new ShadowingWorkspaceSimulator({ repeatCount: 2 });
        await flushTimers();
        ws2.isSeeking = false;
        ws2.tick(4.0); // cycle 1
        ws2.isSeeking = false;
        const res2 = ws2.tick(4.0); // cycle 2 limit
        assert.strictEqual(res2.action, 'REPEAT_LIMIT_REACHED');
        assert.strictEqual(ws2.currentCycle, 2);
        assert.strictEqual(ws2.ytPlayer.isPlaying, false);

        // Test 3x
        const ws3 = new ShadowingWorkspaceSimulator({ repeatCount: 3 });
        await flushTimers();
        ws3.isSeeking = false;
        ws3.tick(4.0); // cycle 1
        ws3.isSeeking = false;
        ws3.tick(4.0); // cycle 2
        ws3.isSeeking = false;
        const res3 = ws3.tick(4.0); // cycle 3 limit
        assert.strictEqual(res3.action, 'REPEAT_LIMIT_REACHED');
        assert.strictEqual(ws3.currentCycle, 3);
        assert.strictEqual(ws3.ytPlayer.isPlaying, false);
    });

    // TEST G — INFINITE REGRESSION
    await runCaseAsync('TEST G — Uninterrupted infinite repeat loops indefinitely', async () => {
        const workspace = new ShadowingWorkspaceSimulator({ repeatCount: Infinity });
        await flushTimers();
        workspace.isSeeking = false;

        for (let c = 1; c <= 8; c++) {
            const res = workspace.tick(4.0);
            assert.strictEqual(res.action, 'LOOP_SEEK');
            assert.strictEqual(workspace.currentCycle, c);
            assert.strictEqual(workspace.ytPlayer.isPlaying, true);
            workspace.isSeeking = false;
        }
        assert.strictEqual(workspace.ytPlayer.isPlaying, true);
    });

    // TEST H — SENTENCE CHANGE CLEANUP
    await runCaseAsync('TEST H — Sentence navigation cleanly resets cycle counter and coordinates', async () => {
        const workspace = new ShadowingWorkspaceSimulator({ repeatCount: 3 });
        await flushTimers();
        workspace.isSeeking = false;
        workspace.tick(4.0); // cycle 1 on unit 1
        assert.strictEqual(workspace.currentCycle, 1);

        // Navigate to unit 2 (index 1)
        workspace.selectUnit(1);
        await flushTimers();

        assert.strictEqual(workspace.currentIndex, 1);
        assert.strictEqual(workspace.currentCycle, 0, 'Cycle counter must reset on unit navigation');
        assert.strictEqual(workspace.loopA, 5.0, 'Start timestamp must update to unit 2');
        assert.strictEqual(workspace.loopB, 9.0, 'End timestamp must update to unit 2');
        assert.strictEqual(workspace.ytPlayer.isPlaying, true, 'New unit should start playback');
    });

    // TEST I — COMPONENT CLEANUP
    await runCaseAsync('TEST I — Component unmount cancels timers and cleans up playback state', async () => {
        const workspace = new ShadowingWorkspaceSimulator({ repeatCount: 1 });
        workspace.unmount();
        await flushTimers();

        assert.strictEqual(workspace.ytPlayer.isPlaying, false);
        assert.strictEqual(workspace.loopA, null);
        assert.strictEqual(workspace.loopB, null);

        const tickRes = workspace.tick(2.0);
        assert.strictEqual(tickRes.action, 'UNMOUNTED');
    });

    console.log('====================================================');
    console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
    console.log('====================================================');
    if (failed > 0) {
        process.exit(1);
    }
}

runTests();
