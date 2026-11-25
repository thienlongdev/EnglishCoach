package com.englishcoach.avatarframe.evaluator;

import com.englishcoach.avatarframe.entity.AvatarFrameRequirement;
import com.englishcoach.exams.model.ExamProfileRecords.IeltsProfileDto;
import com.englishcoach.exams.model.ExamProfileRecords.MetricSummaryDto;
import com.englishcoach.exams.service.ExamProfileService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class CefrExamEvaluatorTest {

    @Mock
    private ExamProfileService examProfileService;

    @InjectMocks
    private CefrExamEvaluator cefrExamEvaluator;

    @Test
    @DisplayName("CefrExamEvaluator supports CEFR_LEVEL")
    void testSupports() {
        assertThat(cefrExamEvaluator.supports("CEFR_LEVEL")).isTrue();
        assertThat(cefrExamEvaluator.supports("cefr_level")).isTrue();
        assertThat(cefrExamEvaluator.supports("STREAK_DAYS")).isFalse();
    }

    @Test
    @DisplayName("evaluate: IELTS 7.5 qualifies for C1 and B2, but not C2 (8.5)")
    void testEvaluate_c1Qualification() {
        MetricSummaryDto overallSummary = new MetricSummaryDto(7.5, 7.5, Instant.now(), Instant.now(), null, "IMPROVING");
        IeltsProfileDto profile = new IeltsProfileDto(overallSummary, null, null, null, null, List.of(), "IELTS", "CONFIRMED", List.of());
        when(examProfileService.getIeltsProfile(1L)).thenReturn(profile);

        AvatarFrameRequirement b2Req = AvatarFrameRequirement.builder()
                .metricType("CEFR_LEVEL")
                .operator("EQUALS")
                .targetValue("B2")
                .build();
        AvatarFrameRequirement c1Req = AvatarFrameRequirement.builder()
                .metricType("CEFR_LEVEL")
                .operator("EQUALS")
                .targetValue("C1")
                .build();
        AvatarFrameRequirement c2Req = AvatarFrameRequirement.builder()
                .metricType("CEFR_LEVEL")
                .operator("EQUALS")
                .targetValue("C2")
                .build();

        MetricEvaluationResult b2Result = cefrExamEvaluator.evaluate(1L, b2Req);
        MetricEvaluationResult c1Result = cefrExamEvaluator.evaluate(1L, c1Req);
        MetricEvaluationResult c2Result = cefrExamEvaluator.evaluate(1L, c2Req);

        assertThat(b2Result.eligible()).isTrue();
        assertThat(c1Result.eligible()).isTrue();
        assertThat(c2Result.eligible()).isFalse();
    }
}
