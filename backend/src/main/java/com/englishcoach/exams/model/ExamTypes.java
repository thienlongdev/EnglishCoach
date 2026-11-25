package com.englishcoach.exams.model;

public final class ExamTypes {

    private ExamTypes() {}

    public enum ExamFamily {
        IELTS,
        TOEIC;

        public static ExamFamily fromString(String val) {
            if (val == null || val.isBlank()) return null;
            String normalized = val.trim().toUpperCase().replace("-", "_");
            if (normalized.startsWith("IELTS")) return IELTS;
            if (normalized.startsWith("TOEIC")) return TOEIC;
            try {
                return valueOf(normalized);
            } catch (IllegalArgumentException e) {
                return null;
            }
        }
    }

    public enum ExamVariant {
        ACADEMIC,
        GENERAL_TRAINING,
        LR,
        SPEAKING,
        WRITING,
        SUITE;

        public static ExamVariant fromString(String val) {
            if (val == null || val.isBlank() || "ALL".equalsIgnoreCase(val.trim())) return null;
            String normalized = val.trim().toUpperCase().replace("-", "_");
            try {
                return valueOf(normalized);
            } catch (IllegalArgumentException e) {
                return null;
            }
        }
    }

    public enum ExamScope {
        FULL,
        LISTENING,
        READING,
        WRITING,
        SPEAKING,
        OSR,
        PARTS_1_7;

        public static ExamScope fromString(String val) {
            if (val == null) return null;
            return valueOf(val.trim().toUpperCase().replace("-", "_"));
        }
    }

    public enum ExamAttemptMode {
        EXAM_SIMULATION,
        PRACTICE;

        public static ExamAttemptMode fromString(String val) {
            if (val == null) return null;
            return valueOf(val.trim().toUpperCase());
        }
    }

    public enum ExamAttemptStatus {
        CREATED,
        READY,
        IN_PROGRESS,
        SUBMITTED,
        EXPIRED,
        INVALIDATED
    }

    public enum ExamSectionState {
        PENDING,
        ACTIVE,
        COMPLETED,
        SKIPPED
    }

    public enum SubmissionReason {
        MANUAL,
        TIME_LIMIT,
        ABANDONED,
        OPERATOR;

        @com.fasterxml.jackson.annotation.JsonCreator
        public static SubmissionReason fromString(String val) {
            if (val == null || val.isBlank()) return MANUAL;
            String normalized = val.trim().toUpperCase();
            if (normalized.equals("USER_COMPLETED") || normalized.equals("COMPLETED")) {
                return MANUAL;
            }
            try {
                return valueOf(normalized);
            } catch (IllegalArgumentException e) {
                return MANUAL;
            }
        }
    }

    public enum LifecycleState {
        DRAFT,
        CONTENT_QA,
        ANSWER_QA,
        LEGAL_QA,
        PILOT,
        CALIBRATED,
        PUBLISHED,
        RETIRED
    }

    public enum ReviewGate {
        CONTENT_QA,
        ANSWER_QA,
        LEGAL_QA
    }

    public enum ReviewDecision {
        APPROVED,
        REJECTED
    }

    public enum ProvenanceCategory {
        ORIGINAL,
        LICENSED,
        FAIR_USE_REVIEWED,
        BENCHMARK_ONLY,
        UNKNOWN
    }

    public enum JobStatus {
        PENDING,
        RUNNING,
        COMPLETED,
        PARTIAL,
        RETRY_WAIT,
        REVIEW_REQUIRED,
        FAILED
    }

    public enum JobStageStatus {
        SUCCESS,
        FAILURE,
        ABSTAINED,
        REPAIR_ATTEMPTED
    }

    public enum ResultStatus {
        COMPLETED,
        PARTIAL,
        REVIEW_REQUIRED,
        FAILED
    }

    public enum ScoreMetric {
        LISTENING,
        READING,
        WRITING,
        SPEAKING,
        FULL_OVERALL,
        LR_TOTAL;

        public static ScoreMetric fromString(String val) {
            if (val == null) return null;
            return valueOf(val.trim().toUpperCase().replace("-", "_"));
        }
    }

    public enum RecordingState {
        RECORDING,
        UPLOADING,
        SEALED,
        FAILED,
        VERIFIED
    }

    public enum MediaPurpose {
        SIMULATION_LISTENING,
        PRACTICE_AUDIO,
        REVIEW_AUDIO
    }

    public enum TrainingModule {
        READING,
        LISTENING,
        WRITING,
        SPEAKING
    }

    public enum ExposureType {
        SIMULATION,
        PRACTICE,
        REVIEW
    }

    public enum SkillType {
        LISTENING,
        READING,
        WRITING,
        SPEAKING
    }

    public enum ExamSnapshotState {
        LEGACY_UNSNAPSHOTTED,
        SNAPSHOTTED,
        INVALID;

        public static ExamSnapshotState fromString(String val) {
            if (val == null || val.isBlank()) return LEGACY_UNSNAPSHOTTED;
            try {
                return valueOf(val.trim().toUpperCase());
            } catch (IllegalArgumentException e) {
                return INVALID;
            }
        }
    }
}
