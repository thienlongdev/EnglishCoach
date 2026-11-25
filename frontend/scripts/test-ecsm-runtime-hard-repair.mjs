import assert from "node:assert/strict";
import fs from "node:fs";
import {
    evaluateCaseA,
    evaluateCaseB,
    evaluateCaseC,
    isEcsmCompletedSuccessfully,
    validateTargetHierarchy,
} from "../src/app/speaking/shadowing/dev/legacy-real-mic-acceptance/acceptancePolicy.mjs";

const hierarchy = {
    words: [{
        word_id: "W_REQ_001_002",
        word: "think",
        phone_assessments: [
            { phone_id: "PH_REQ_001_000", expected_phone: "θ", observed_phone: null },
            { phone_id: "PH_REQ_001_001", expected_phone: "ɪ", observed_phone: null },
        ],
        issues: [],
    }],
};

const completeResponse = {
    status: "COMPLETE",
    assessmentStatus: "NO_ISSUE_DETECTED",
    errorCode: "NONE",
    assessment: hierarchy,
    contentGateMinMatch: 0.5,
};

const baseMetrics = {
    caseId: "C",
    attemptId: "ATT_C_1",
    durationSec: 2,
    contentMatchScore: 100,
    ecsmStatus: "NO_ISSUE_DETECTED",
    ecsmRuntimeStatus: "COMPLETE",
    ecsmErrorCode: "NONE",
    ecsmGatingReasons: [],
    ecsmCompletedSuccessfully: true,
    targetHierarchyValid: true,
    phoneIssueCount: 0,
    trustedObservedPhoneCount: 0,
    p9PrimaryFocus: null,
    detectedWord: null,
    detectedExpectedPhone: null,
    detectedObservedPhone: null,
    observedPhoneTrusted: false,
    sameAudioVerified: true,
    rawEcsmResponse: completeResponse,
};

assert.equal(validateTargetHierarchy(completeResponse), true);
assert.equal(isEcsmCompletedSuccessfully(completeResponse), true);
assert.equal(isEcsmCompletedSuccessfully({ ...completeResponse, status: "FAILED", errorCode: "INTERNAL_INFERENCE_ERROR" }), false);

const caseAInternal = {
    ...baseMetrics,
    caseId: "A",
    contentMatchScore: 18,
    ecsmStatus: "ASSESSMENT_UNAVAILABLE",
    ecsmRuntimeStatus: "FAILED",
    ecsmErrorCode: "INTERNAL_INFERENCE_ERROR",
    ecsmGatingReasons: ["INTERNAL_EXCEPTION"],
    ecsmCompletedSuccessfully: false,
    sameAudioVerified: true,
};
assert.equal(evaluateCaseA(caseAInternal).status, "FAIL");
assert.equal(evaluateCaseA(caseAInternal).reason, "ECSM_RUNTIME_ERROR_DURING_CONTENT_GATE");

const caseASafeGate = {
    ...baseMetrics,
    caseId: "A",
    contentMatchScore: 18,
    ecsmStatus: "INSUFFICIENT_EVIDENCE",
    ecsmGatingReasons: ["CONTENT_DIVERGENCE_GATED"],
    p9PrimaryFocus: "CONTENT_RETRY",
    ecsmCompletedSuccessfully: false,
};
assert.equal(evaluateCaseA(caseASafeGate).status, "PASS");

assert.equal(evaluateCaseB({ ...baseMetrics, ecsmRuntimeStatus: "FAILED", ecsmErrorCode: "INTERNAL_INFERENCE_ERROR", ecsmCompletedSuccessfully: false }).status, "FAIL");
assert.equal(evaluateCaseB({ ...baseMetrics }).status, "PASS");

const instructionC = { requestedTargetWord: "think", requestedTargetPhone: "θ" };
assert.equal(evaluateCaseC({ ...baseMetrics, ecsmRuntimeStatus: "FAILED", ecsmErrorCode: "INTERNAL_INFERENCE_ERROR", ecsmCompletedSuccessfully: false }, instructionC).status, "ECSM_RUNTIME_INFERENCE_REQUIRES_REPAIR");
assert.equal(evaluateCaseC(baseMetrics, instructionC).status, "MODEL_DETECTION_QUALITY_REQUIRES_REVIEW");

// Per-case ownership/race/reset contract mirrors the page's latest-attempt map.
let latest = { A: "ATT_A_1", B: null, C: null, D: null, E: null };
let metricsByCase = { A: { caseId: "A", attemptId: "ATT_A_1", whisperTranscript: "Hello excuse me sir" } };
const activeMetrics = (caseId) => {
    const metrics = metricsByCase[caseId] || null;
    return metrics?.caseId === caseId && metrics.attemptId === latest[caseId] ? metrics : null;
};
assert.equal(activeMetrics("B"), null);
latest.B = "ATT_B_1";
metricsByCase.B = { caseId: "B", attemptId: "ATT_B_1", whisperTranscript: "This morning" };
assert.equal(activeMetrics("B").whisperTranscript, "This morning");
assert.equal(activeMetrics("A").whisperTranscript, "Hello excuse me sir");
latest.A = "ATT_A_2";
assert.equal(activeMetrics("A"), null, "late ATT_A_1 must not remain active after a newer attempt starts");
latest = { A: null, B: null, C: null, D: null, E: null };
metricsByCase = {};
assert.equal(activeMetrics("A"), null);
assert.equal(activeMetrics("B"), null);

// The A-E UI was retired. Keep its classifier regression coverage, and verify
// that the archived route directs users to the current 16-clip runner.
const pageSource = fs.readFileSync(new URL("../src/app/speaking/shadowing/dev/legacy-real-mic-acceptance/page.tsx", import.meta.url), "utf8");
assert.match(pageSource, /This legacy route is archived/);
assert.match(pageSource, /href="\/speaking\/shadowing\/dev\/real-mic-acceptance"/);
const currentPageSource = fs.readFileSync(new URL("../src/app/speaking/shadowing/dev/real-mic-acceptance/page.tsx", import.meta.url), "utf8");
assert.match(currentPageSource, /export const FALLBACK_16_CLIPS/);

console.log("legacyEcsmRuntimeClassifierCases: 8 PASS");
console.log("legacyOwnershipAndRaceModel: PASS");
console.log("archivedRouteAndCurrentRunnerContract: PASS");
