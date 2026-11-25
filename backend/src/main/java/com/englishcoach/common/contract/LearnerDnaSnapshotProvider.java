package com.englishcoach.common.contract;

/**
 * Port for reading a learner's aggregated 7-day weakness snapshot (Learner DNA) without
 * coupling callers to the {@code ai} module implementation.
 */
public interface LearnerDnaSnapshotProvider {
    LearnerDnaSnapshot getSnapshot(Long userId, boolean forceRefresh);
}
