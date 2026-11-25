package com.englishcoach.proficiency.board;

import com.englishcoach.proficiency.model.ProficiencySkill;

/**
 * Năng lực boards (Phase 3). VOCABULARY has no board while it is UNSUPPORTED (no server-computed
 * evidence source), so it is deliberately absent here and rejected by the API.
 */
public enum ProficiencyBoardType {
    OVERALL(null),
    LISTENING(ProficiencySkill.LISTENING),
    READING(ProficiencySkill.READING),
    WRITING(ProficiencySkill.WRITING),
    SPEAKING(ProficiencySkill.SPEAKING);

    private final ProficiencySkill skill;

    ProficiencyBoardType(ProficiencySkill skill) {
        this.skill = skill;
    }

    /** Skill of a skill board; null for OVERALL. */
    public ProficiencySkill skill() {
        return skill;
    }
}
