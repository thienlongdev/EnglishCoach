package com.englishcoach.exams;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.exams.controller.ExamResultController;
import com.englishcoach.exams.job.ExamJobService;
import com.englishcoach.exams.model.ExamScoringRecords.ExamResultDto;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.service.ExamResultService;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import java.time.Instant;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ExamResultTerminalRecoveryTest {
    @ParameterizedTest
    @EnumSource(ResultStatus.class)
    void persistedOutcomeDoesNotRequireNumericScores(ResultStatus status) {
        var service = mock(ExamResultService.class);
        var jobs = mock(ExamJobService.class);
        var controller = new ExamResultController(service, jobs);
        var user = new UserDetailsImpl(664L, "fixture@example.test", "unused", List.of());
        for (ExamFamily family : ExamFamily.values()) {
            for (String scope : family == ExamFamily.TOEIC
                    ? List.of("LISTENING", "READING")
                    : List.of("LISTENING", "READING", "WRITING", "SPEAKING", "FULL")) {
                UUID id = UUID.randomUUID();
                var result = new ExamResultDto(UUID.randomUUID(), id, family, "FIXTURE", scope,
                        ExamAttemptMode.EXAM_SIMULATION, status, null, Map.of(), List.of(), List.of(), Map.of(), Instant.now());
                when(service.getAttemptResult(id, 664L, false)).thenReturn(Optional.of(result));
                var response = controller.getResult(id, user);
                assertEquals(200, response.getStatusCode().value(), family + ":" + scope + ":" + status);
                assertSame(result, response.getBody());
            }
        }
        verifyNoInteractions(jobs);
    }
}
