package com.englishcoach.exams.job;

import com.englishcoach.exams.model.ExamTypes.ExamAttemptMode;
import com.englishcoach.exams.model.ExamTypes.LifecycleState;
import com.englishcoach.exams.model.ExamTypes.ResultStatus;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ExamJobWorkerEligibilityTest {

    @Test
    void onlyCompletedSimulationOfPublishedFormWithApprovedCalibrationEntersTrustedProfile() {
        // INTERNAL_QA is represented by the current DRAFT lifecycle state;
        // this remains excluded even when the attempt is a simulation.
        assertTrue(ExamJobWorker.isProductionEligibleForProfileEvidence(
                ExamAttemptMode.EXAM_SIMULATION, LifecycleState.PUBLISHED, ResultStatus.COMPLETED, true));

        assertFalse(ExamJobWorker.isProductionEligibleForProfileEvidence(
                ExamAttemptMode.EXAM_SIMULATION, LifecycleState.PUBLISHED, ResultStatus.COMPLETED, false));

        assertFalse(ExamJobWorker.isProductionEligibleForProfileEvidence(
                ExamAttemptMode.EXAM_SIMULATION, LifecycleState.PILOT, ResultStatus.COMPLETED, true));
        assertFalse(ExamJobWorker.isProductionEligibleForProfileEvidence(
                ExamAttemptMode.EXAM_SIMULATION, LifecycleState.CALIBRATED, ResultStatus.COMPLETED, true));
        assertFalse(ExamJobWorker.isProductionEligibleForProfileEvidence(
                ExamAttemptMode.EXAM_SIMULATION, LifecycleState.DRAFT, ResultStatus.COMPLETED, true));
        assertFalse(ExamJobWorker.isProductionEligibleForProfileEvidence(
                ExamAttemptMode.PRACTICE, LifecycleState.PUBLISHED, ResultStatus.COMPLETED, true));
        // Phase 0 containment: a REVIEW_REQUIRED artifact (incl. AI fallback) never enters the trusted profile.
        assertFalse(ExamJobWorker.isProductionEligibleForProfileEvidence(
                ExamAttemptMode.EXAM_SIMULATION, LifecycleState.PUBLISHED, ResultStatus.REVIEW_REQUIRED, true));
    }
}
