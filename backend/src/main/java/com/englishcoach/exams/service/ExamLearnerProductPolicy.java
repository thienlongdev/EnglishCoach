package com.englishcoach.exams.service;

import com.englishcoach.exams.model.ExamTypes.ExamFamily;
import com.englishcoach.exams.model.ExamTypes.SkillType;
import java.util.Collection;

/** New learner entries only. Historical snapshots/results are never rewritten. */
public final class ExamLearnerProductPolicy {
    private ExamLearnerProductPolicy() {}

    public static boolean allows(ExamFamily family, Collection<SkillType> skills) {
        if (family != ExamFamily.TOEIC) return true;
        return skills != null && !skills.isEmpty() && skills.stream().allMatch(
                s -> s == SkillType.LISTENING || s == SkillType.READING);
    }

    public static void require(ExamFamily family, Collection<SkillType> skills) {
        if (!allows(family, skills)) {
            throw new IllegalStateException("TOEIC_LR_ONLY: TOEIC chỉ hỗ trợ Listening và Reading cho bài làm mới.");
        }
    }
}
