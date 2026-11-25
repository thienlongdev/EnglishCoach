package com.englishcoach.proficiency.model;

/**
 * Proficiency skills. VOCABULARY exists in schema/enums but is disabled by config
 * ({@code app.proficiency.disabled-skills}) until a server-computed vocabulary source exists.
 */
public enum ProficiencySkill {
    LISTENING,
    READING,
    WRITING,
    SPEAKING,
    VOCABULARY
}
