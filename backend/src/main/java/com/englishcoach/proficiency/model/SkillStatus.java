package com.englishcoach.proficiency.model;

/** Skill status, evaluated top-down in exactly this precedence (Proficiency Spec §6). */
public enum SkillStatus {
    UNSUPPORTED,
    STALE,
    UNDETERMINED,
    VERIFIED,
    PROVISIONAL
}
