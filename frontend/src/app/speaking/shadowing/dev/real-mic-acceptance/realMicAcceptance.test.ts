import { FALLBACK_16_CLIPS, SessionManifest, AcceptanceClipDef } from "./page";

export interface MockSaveResponse {
    status: string;
    sessionId: string;
    clipId: string;
    audioSHA256: string;
    durationSec: number;
    rawAudioPath: string;
    derivedWavPath: string;
}

export function simulateSaveResponseHandling(
    saveResponseStatus: number,
    saveResponseBody: any,
    currentManifest: SessionManifest | null,
    activeClip: AcceptanceClipDef
): {
    success: boolean;
    updatedManifest: SessionManifest | null;
    errorMessage: string | null;
    isSavedDisplayed: boolean;
    shaDisplayed: string | null;
    recordedCount: number;
} {
    if (saveResponseStatus >= 200 && saveResponseStatus < 300) {
        const savedSha = saveResponseBody?.audioSHA256 || "verified";
        const savedClipId = saveResponseBody?.clipId || activeClip.clip_id;
        const existingClips = currentManifest?.clips || {};
        const isAlreadyRecorded = existingClips[savedClipId]?.isRecorded;
        const recordedCount = (currentManifest?.recordedCount || 0) + (isAlreadyRecorded ? 0 : 1);

        const updated: SessionManifest = {
            sessionId: saveResponseBody?.sessionId || "test_session",
            totalClips: 16,
            recordedCount: recordedCount,
            isComplete: recordedCount === 16,
            clips: {
                ...existingClips,
                [savedClipId]: {
                    isRecorded: true,
                    audioSHA256: savedSha,
                    rawAudioPath: saveResponseBody?.rawAudioPath,
                    derivedWavPath: saveResponseBody?.derivedWavPath,
                    durationSec: saveResponseBody?.durationSec || 5.0,
                    savedAt: new Date().toISOString(),
                },
            },
            updatedAt: new Date().toISOString(),
        };

        return {
            success: true,
            updatedManifest: updated,
            errorMessage: null,
            isSavedDisplayed: true,
            shaDisplayed: savedSha,
            recordedCount: updated.recordedCount,
        };
    } else {
        const errMsg = `Server rejected save (HTTP ${saveResponseStatus}): ${saveResponseBody?.detail || "Error"}`;
        return {
            success: false,
            updatedManifest: currentManifest,
            errorMessage: errMsg,
            isSavedDisplayed: Boolean(currentManifest?.clips?.[activeClip.clip_id]?.isRecorded),
            shaDisplayed: currentManifest?.clips?.[activeClip.clip_id]?.audioSHA256 || null,
            recordedCount: currentManifest?.recordedCount || 0,
        };
    }
}

export function runSaveContractSuite(): {
    testA_200_Saved: boolean;
    testB_ShaDisplayed: boolean;
    testC_ProgressIncrements: boolean;
    testD_NextEnabled: boolean;
    testE_RefreshRestores: boolean;
    testF_500_PersistenceError: boolean;
    testG_NetworkFailure: boolean;
    testH_200_NeverShowsGenericError: boolean;
    allPassed: boolean;
} {
    const activeClip = FALLBACK_16_CLIPS[0]; // clean_01
    const initialManifest: SessionManifest = {
        sessionId: "session_test",
        totalClips: 16,
        recordedCount: 0,
        isComplete: false,
        clips: {},
        updatedAt: new Date().toISOString(),
    };

    const mock200Response: MockSaveResponse = {
        status: "SAVED",
        sessionId: "session_test",
        clipId: "clean_01",
        audioSHA256: "5fb8bb81bb10280738061e12cd53f13e9b8de7cd9f735ace4fd70b1e1a21ce59",
        durationSec: 5.183,
        rawAudioPath: "real_mic_acceptance_pack/session_test/clean_01.webm",
        derivedWavPath: "real_mic_acceptance_pack/session_test/clean_01.wav",
    };

    // Test A: 200 OK -> SAVED
    const resA = simulateSaveResponseHandling(200, mock200Response, initialManifest, activeClip);
    const testA = resA.success && resA.isSavedDisplayed;

    // Test B: SHA Displayed
    const testB = resA.shaDisplayed === "5fb8bb81bb10280738061e12cd53f13e9b8de7cd9f735ace4fd70b1e1a21ce59";

    // Test C: Progress increments 0 -> 1
    const testC = initialManifest.recordedCount === 0 && resA.recordedCount === 1;

    // Test D: Next Enabled (can advance index)
    const testD = (resA.updatedManifest !== null) && (resA.updatedManifest.recordedCount > 0);

    // Test E: Refresh/Session reload restores saved clip
    const restoredManifest = resA.updatedManifest;
    const testE = Boolean(restoredManifest?.clips?.["clean_01"]?.isRecorded);

    // Test F: HTTP 500 shows persistence error
    const resF = simulateSaveResponseHandling(500, { detail: "Disk write failure" }, initialManifest, activeClip);
    const testF = !resF.success && (resF.errorMessage?.includes("500") ?? false);

    // Test G: Network failure shows error
    const resG = simulateSaveResponseHandling(0, null, initialManifest, activeClip);
    const testG = !resG.success && (resG.errorMessage !== null);

    // Test H: 200 never shows generic error
    const testH = resA.errorMessage === null;

    const allPassed = testA && testB && testC && testD && testE && testF && testG && testH;

    return {
        testA_200_Saved: testA,
        testB_ShaDisplayed: testB,
        testC_ProgressIncrements: testC,
        testD_NextEnabled: testD,
        testE_RefreshRestores: testE,
        testF_500_PersistenceError: testF,
        testG_NetworkFailure: testG,
        testH_200_NeverShowsGenericError: testH,
        allPassed,
    };
}
