const TARGET_LEXICON = {
    this: ["ð", "ɪ", "s"], morning: ["m", "ɔ", "r", "n", "ɪ", "ŋ"], a: ["ə"],
    machine: ["m", "ə", "ʃ", "i", "n"], screamed: ["s", "k", "r", "i", "m", "d"],
    at: ["æ", "t"], you: ["j", "u"], until: ["ʌ", "n", "t", "ɪ", "l"], woke: ["w", "oʊ", "k"], up: ["ʌ", "p"],
    so: ["s", "oʊ"], i: ["aɪ"], think: ["θ", "ɪ", "ŋ", "k"], what: ["w", "ʌ", "t"],
    "i'll": ["aɪ", "l"], do: ["d", "u"], is: ["ɪ", "z"], just: ["dʒ", "ʌ", "s", "t"],
    call: ["k", "ɔ", "l"], storyteller: ["s", "t", "ɔ", "r", "i", "t", "ɛ", "l", "ɚ"],
};

const verdict = (status, reason, subchecks) => ({ status, reason, subchecks, timestamp: new Date().toISOString() });

export const validateTargetMembership = (word, phone) => {
    const cleanWord = String(word || "").toLowerCase().replace(/^[^\w']+|[^\w']+$/g, "");
    const validPhones = TARGET_LEXICON[cleanWord];
    return !validPhones || validPhones.includes(phone);
};

export const validateTargetHierarchy = (response) => {
    const words = Array.isArray(response?.assessment?.words) ? response.assessment.words : [];
    if (words.length === 0) return false;
    const wordIds = words.map((word) => word.word_id).filter(Boolean);
    if (wordIds.length !== words.length || new Set(wordIds).size !== wordIds.length) return false;
    const phoneIds = [];
    for (const word of words) {
        const phones = Array.isArray(word.phone_assessments) ? word.phone_assessments : [];
        for (const phone of phones) {
            if (!phone.phone_id || !phone.expected_phone) return false;
            phoneIds.push(phone.phone_id);
        }
        if ((word.issues || []).some((issue) => issue.target_info?.wordId && issue.target_info.wordId !== word.word_id)) return false;
    }
    return phoneIds.length > 0 && new Set(phoneIds).size === phoneIds.length;
};

export const isEcsmCompletedSuccessfully = (response) => {
    const validRuntimeStatus = response?.status === "COMPLETE" || response?.status === "PARTIAL_SUCCESS";
    const validAssessmentStatus = ["NO_ISSUE_DETECTED", "ISSUE_DETECTED", "PARTIAL"].includes(response?.assessmentStatus || "");
    return Boolean(response)
        && validRuntimeStatus
        && response.errorCode !== "INTERNAL_INFERENCE_ERROR"
        && response.errorCode !== "RESPONSE_SERIALIZATION_FAILURE"
        && validAssessmentStatus
        && validateTargetHierarchy(response);
};

const assessmentWords = (metrics) => Array.isArray(metrics.rawEcsmResponse?.assessment?.words)
    ? metrics.rawEcsmResponse.assessment.words
    : [];

const hasTargetPhone = (metrics, targetWord, expectedPhone) => assessmentWords(metrics).some((word) =>
    String(word.word || "").toLowerCase() === targetWord.toLowerCase()
    && (word.phone_assessments || []).some((phone) => phone.expected_phone === expectedPhone)
);

export const evaluateCaseA = (metrics) => {
    const gatePercent = (metrics.rawEcsmResponse?.contentGateMinMatch ?? 0.5) * 100;
    const contentLow = metrics.contentMatchScore < gatePercent;
    const internalError = metrics.ecsmRuntimeStatus === "FAILED"
        || ["INTERNAL_INFERENCE_ERROR", "RESPONSE_SERIALIZATION_FAILURE"].includes(metrics.ecsmErrorCode);
    const authoritativeGate = metrics.ecsmStatus === "INSUFFICIENT_EVIDENCE"
        && metrics.ecsmGatingReasons.includes("CONTENT_DIVERGENCE_GATED")
        && !internalError
        && metrics.phoneIssueCount === 0
        && metrics.trustedObservedPhoneCount === 0
        && metrics.p9PrimaryFocus === "CONTENT_RETRY";
    if (contentLow && authoritativeGate) {
        return verdict("PASS", "WRONG_CONTENT_GATED", { contentLow, authoritativeGate, internalError: false });
    }
    return verdict("FAIL", internalError ? "ECSM_RUNTIME_ERROR_DURING_CONTENT_GATE" : "CONTENT_NOT_AUTHORITATIVELY_GATED", { contentLow, authoritativeGate, internalError });
};

export const evaluateCaseB = (metrics) => {
    const contentOk = metrics.contentMatchScore >= 75;
    const ecsmCompletedSuccessfully = metrics.ecsmCompletedSuccessfully;
    const targetMembershipOk = !metrics.detectedWord || !metrics.detectedExpectedPhone
        || validateTargetMembership(metrics.detectedWord, metrics.detectedExpectedPhone);
    if (contentOk && ecsmCompletedSuccessfully && targetMembershipOk) {
        return verdict("PASS", "CORRECT_CONTENT_EVALUATED", { contentOk, ecsmCompletedSuccessfully, targetMembershipOk });
    }
    return verdict("FAIL", !contentOk ? "CONTENT_ALIGNMENT_LOW" : "ECSM_EXECUTION_FAILED_OR_INVARIANT_INVALID", { contentOk, ecsmCompletedSuccessfully, targetMembershipOk });
};

export const evaluateCaseC = (metrics, instruction) => {
    const runtimeCompleted = metrics.ecsmCompletedSuccessfully;
    const hierarchyValid = metrics.targetHierarchyValid;
    const targetBuilt = hasTargetPhone(metrics, instruction.requestedTargetWord || "think", instruction.requestedTargetPhone || "θ");
    const subchecks = { runtimeCompleted, hierarchyValid, targetBuilt };
    if (metrics.ecsmErrorCode.startsWith("AUDIO_") || !metrics.sameAudioVerified) {
        return verdict("AUDIO_PIPELINE_REQUIRES_REPAIR", "AUDIO_PIPELINE_OR_IDENTITY_NOT_VALID", subchecks);
    }
    if (metrics.ecsmRuntimeStatus === "FAILED" || ["INTERNAL_INFERENCE_ERROR", "RESPONSE_SERIALIZATION_FAILURE"].includes(metrics.ecsmErrorCode)) {
        return verdict("ECSM_RUNTIME_INFERENCE_REQUIRES_REPAIR", `ECSM_RUNTIME_FAILED_AT_${metrics.rawEcsmResponse?.failureStage || "UNKNOWN_STAGE"}`, subchecks);
    }
    if (!hierarchyValid || !targetBuilt) {
        return verdict("ECSM_TARGET_ALIGNMENT_REQUIRES_REPAIR", "TARGET_THINK_THETA_HIERARCHY_INVALID", subchecks);
    }
    if (metrics.ecsmRuntimeStatus === "PARTIAL_SUCCESS") {
        return verdict("ECSM_COMPONENT_PARTIAL", "OPTIONAL_ECSM_COMPONENT_UNAVAILABLE", subchecks);
    }
    const detectorPassed = metrics.durationSec > 0.5
        && metrics.contentMatchScore >= 70
        && metrics.ecsmStatus === "ISSUE_DETECTED"
        && metrics.detectedWord?.toLowerCase() === "think"
        && metrics.detectedExpectedPhone === "θ"
        && (!metrics.detectedObservedPhone || metrics.observedPhoneTrusted)
        && runtimeCompleted;
    if (detectorPassed) return verdict("PASS", "REAL_TARGET_ISSUE_DETECTED", subchecks);
    if (metrics.durationSec > 0.5 && metrics.contentMatchScore >= 70 && runtimeCompleted) {
        return verdict("MODEL_DETECTION_QUALITY_REQUIRES_REVIEW", "TARGET_ISSUE_NOT_DETECTED_AFTER_SUCCESSFUL_RUNTIME", subchecks);
    }
    return verdict("FAIL", metrics.durationSec <= 0.5 ? "NO_AUDIO_RECORDED" : "CONTENT_NOT_PRESERVED", subchecks);
};
