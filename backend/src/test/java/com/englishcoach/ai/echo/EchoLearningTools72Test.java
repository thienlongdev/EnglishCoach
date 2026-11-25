package com.englishcoach.ai.echo;

import com.englishcoach.ai.echo.tools.ExamOverviewTool;
import com.englishcoach.ai.echo.tools.WritingFeedbackTool;
import com.englishcoach.exams.model.ExamProfileRecords.AttemptHistoryItemDto;
import com.englishcoach.exams.model.ExamScoringRecords.ExamResultDto;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.repository.ExamAttemptRepository;
import com.englishcoach.exams.service.ExamResultService;
import com.englishcoach.writing.repository.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import java.time.Instant;
import java.util.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class EchoLearningTools72Test {
    private final ObjectMapper json = new ObjectMapper();
    private final EchoTurn turn = new EchoTurn(42L,false,false,"review my latest result",null,null);
    @Test void ordinaryTeachingStreamsWithoutAPlanningRound() {
        String grammar = "Giải thích chi tiết thì hiện tại hoàn thành, có ví dụ A2 và B2.";
        var intent = com.englishcoach.ai.service.EchoPolicy.intent(grammar);
        assertThat(EchoRouter.route(intent, grammar, false, true)).isEqualTo(EchoRouter.Route.FAST);
        assertThat(EchoRouter.directTeaching(intent, grammar)).isTrue();
        assertThat(EchoRouter.directTeaching(com.englishcoach.ai.service.EchoPolicy.Intent.GENERAL_ENGLISH_CONTEXT,
                "hướng dẫn tôi các từ vựng band 6.0")).isTrue();
        assertThat(EchoRouter.direct("Mày là ai?").orElseThrow().type()).isEqualTo(EchoRouter.CommandType.IDENTITY);
        assertThat(EchoRouter.direct("Dịch câu “Mày là ai?”")).isEmpty();
        assertThat(EchoRouter.requestedLessonSearch("Dựa vào tiến bộ của tôi, hãy tìm một bài ngữ pháp cụ thể."))
                .isEqualTo("search_grammar_topics");
        assertThat(EchoRouter.requestedLessonSearch("Giải thích bài ngữ pháp này")).isNull();
        String drill = "Tôi muốn luyện nói tiếng Anh. Hãy hỏi tôi một câu ngắn bằng tiếng Anh về sở thích.";
        assertThat(EchoRouter.directTeaching(com.englishcoach.ai.service.EchoPolicy.intent(drill), drill)).isTrue();
        assertThat(EchoRouter.conversationDrill(com.englishcoach.ai.service.EchoPolicy.Intent.PRACTICE,
                "Tìm bài luyện nói tiếng Anh theo trình độ của tôi")).isFalse();
    }
    @Test void projectsReleasedSkillsOnlyAndSkipsActiveAttempt() throws Exception {
        var attempts = mock(ExamAttemptRepository.class);
        var results = mock(ExamResultService.class);
        var practice = mock(ObjectProvider.class);
        var tool = new ExamOverviewTool(mock(ObjectProvider.class),practice,json,attempts,results);
        var active = mock(AttemptHistoryItemDto.class);
        when(active.status()).thenReturn(ExamAttemptStatus.IN_PROGRESS);
        var submitted = mock(AttemptHistoryItemDto.class);
        var id = UUID.randomUUID();
        when(submitted.attemptId()).thenReturn(id);
        when(submitted.completedAt()).thenReturn(Instant.EPOCH);
        when(submitted.status()).thenReturn(ExamAttemptStatus.SUBMITTED);
        when(submitted.mode()).thenReturn(ExamAttemptMode.PRACTICE);
        when(attempts.findHistoryByUserId(42L,ExamFamily.IELTS,null,null,5,0)).thenReturn(List.of(active,submitted));
        var result = mock(ExamResultDto.class);
        when(results.getAttemptResult(id,42L,false)).thenReturn(Optional.of(result));
        when(result.resultStatus()).thenReturn(ResultStatus.PARTIAL,ResultStatus.COMPLETED);
        when(result.skillScores()).thenReturn(Map.of("LISTENING",6.5));
        var args = json.readTree("{\"family\":\"IELTS\"}");
        assertThat(json.readTree(tool.run(turn,args)).path("recentReleasedAttempts").size()).isZero();
        var released = json.readTree(tool.run(turn,args)).path("recentReleasedAttempts");
        assertThat(released.get(0).path("releasedSkillScores").path("LISTENING").asDouble()).isEqualTo(6.5);
        verify(results,times(2)).getAttemptResult(id,42L,false);
        verifyNoMoreInteractions(results);
        verify(result,never()).criteria();
        verifyNoInteractions(practice);
    }
    @Test void missingOwnedSubmissionDoesNotReadFeedback() {
        var memory = mock(WritingErrorMemoryRepository.class);
        var assessments = mock(WritingAssessmentRepository.class);
        var issues = mock(WritingFeedbackIssueRepository.class);
        var tool = new WritingFeedbackTool(memory,json,assessments,issues);
        assertThat(tool.run(turn,json.createObjectNode())).contains("\"hasReadySubmission\":false");
        verify(assessments).latestReadyForOwner(eq(42L),any());
        verify(memory).findTop3ByUserIdAndIsMutedFalseOrderByLastSeenAtDesc(42L);
        verifyNoInteractions(issues);
    }
}
