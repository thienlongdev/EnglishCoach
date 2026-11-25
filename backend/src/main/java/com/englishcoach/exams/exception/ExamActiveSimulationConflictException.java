package com.englishcoach.exams.exception;

import com.englishcoach.exams.model.ExamAttemptRecords.ActiveSimulationAttemptSummary;
import lombok.Getter;

@Getter
public class ExamActiveSimulationConflictException extends IllegalStateException {

    private final String code;
    private final ActiveSimulationAttemptSummary activeAttempt;

    public ExamActiveSimulationConflictException(String message, ActiveSimulationAttemptSummary activeAttempt) {
        super(message);
        this.code = "ACTIVE_SIMULATION_CONFLICT";
        this.activeAttempt = activeAttempt;
    }
}
