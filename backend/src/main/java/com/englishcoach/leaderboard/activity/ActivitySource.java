package com.englishcoach.leaderboard.activity;

/**
 * Point sources of Activity Spec §4. Stored in {@code score_events.source_module}; the
 * V52 CHECK constraint lists exactly these values.
 */
public enum ActivitySource {
    FLASHCARD_REVIEW(SkillGroup.VOCAB),
    FLASHCARD_NEW(SkillGroup.VOCAB),
    FLASHCARD_MASTERED(SkillGroup.VOCAB),
    CARD_BLAST_SOLO(SkillGroup.VOCAB),
    CARD_BLAST_PVP(SkillGroup.VOCAB),
    DICTATION(SkillGroup.LISTENING),
    /** NOT RUN in Phase 1: no watch-progress data exists (11-known-issues). */
    LISTENING_WATCH(SkillGroup.LISTENING),
    SHADOWING(SkillGroup.SPEAKING),
    ROLEPLAY(SkillGroup.SPEAKING),
    /** NOT RUN in Phase 1: no "finished article" signal exists (11-known-issues). */
    READING(SkillGroup.READING),
    WRITING(SkillGroup.WRITING),
    EXAM_SIMULATION(SkillGroup.EXAMS),
    EXAM_PRACTICE(SkillGroup.EXAMS);

    private final SkillGroup skillGroup;

    ActivitySource(SkillGroup skillGroup) {
        this.skillGroup = skillGroup;
    }

    public SkillGroup skillGroup() {
        return skillGroup;
    }
}
