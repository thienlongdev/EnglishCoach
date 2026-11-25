package com.englishcoach.exams;

import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.service.ExamLearnerProductPolicy;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.time.Instant;
import com.englishcoach.exams.model.ExamContentRecords.*;
import com.englishcoach.exams.model.ExamAttemptRecords.CreateAttemptRequest;
import com.englishcoach.exams.repository.*;
import com.englishcoach.exams.service.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ExamLearnerProductPolicyTest {
    @Test void toeicOnlyAllowsObjectiveSkills() {
        assertTrue(ExamLearnerProductPolicy.allows(ExamFamily.TOEIC, List.of(SkillType.READING)));
        assertTrue(ExamLearnerProductPolicy.allows(ExamFamily.TOEIC, List.of(SkillType.LISTENING, SkillType.READING)));
        for (SkillType productive : List.of(SkillType.WRITING, SkillType.SPEAKING)) {
            assertThrows(IllegalStateException.class, () -> ExamLearnerProductPolicy.require(ExamFamily.TOEIC, List.of(productive)));
            assertThrows(IllegalStateException.class, () -> ExamLearnerProductPolicy.require(ExamFamily.TOEIC, List.of(SkillType.READING, productive)));
        }
        assertFalse(ExamLearnerProductPolicy.allows(ExamFamily.TOEIC, List.of()));
    }
    @Test void ieltsRetainsAllFourSkills() {
        assertTrue(ExamLearnerProductPolicy.allows(ExamFamily.IELTS, List.of(SkillType.values())));
    }
    @Test void learnerCreateCannotBypassRetirementWithSelectedSkills() {
        var attempts = mock(ExamAttemptRepository.class);
        var content = mock(ExamContentRepository.class);
        var rights = mock(ExamRightsService.class);
        var manifests = mock(ExamManifestService.class);
        UUID formId = UUID.randomUUID();
        var form = new FormVersionRecord(formId, "retired", 1, "retired", ExamFamily.TOEIC, "SUITE", "FULL",
                null, null, null, LifecycleState.PILOT, null, null, "hash", null, null, Instant.now());
        when(content.findFormById(formId)).thenReturn(Optional.of(form));
        when(rights.verifyFormRights(formId)).thenReturn(true);
        when(content.findSectionsByFormId(formId)).thenReturn(List.of());
        when(content.findSkillsByFormId(formId)).thenReturn(List.of("LISTENING", "READING", "WRITING", "SPEAKING"));
        var service = new ExamAttemptService(attempts, content, rights, mock(ExamTimingService.class), manifests);
        var error = assertThrows(IllegalStateException.class, () -> service.createAttempt(101L,
                new CreateAttemptRequest(formId, ExamAttemptMode.PRACTICE, null, null, null, List.of("READING"))));
        assertTrue(error.getMessage().startsWith("TOEIC_LR_ONLY"));
        verify(attempts, never()).insertAttempt(any());
        verifyNoInteractions(manifests);
    }
}
