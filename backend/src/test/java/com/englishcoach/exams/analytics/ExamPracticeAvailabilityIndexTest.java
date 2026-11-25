package com.englishcoach.exams.analytics;

import com.englishcoach.exams.model.ExamContentRecords.CatalogFormDto;
import com.englishcoach.exams.model.ExamTypes.*;
import com.englishcoach.exams.practice.ExamPracticeRecords.*;
import com.englishcoach.exams.practice.ExamPracticeService;
import com.englishcoach.exams.service.ExamContentService;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ExamPracticeAvailabilityIndexTest {
    @Test
    void exactScopesOnLaterPagesSurviveLegacyBudgetAndStillRequireReadiness() {
        ExamContentService content = mock(ExamContentService.class);
        ExamPracticeService practice = mock(ExamPracticeService.class);
        List<CatalogFormDto> forms = new ArrayList<>();
        for (int i = 0; i < 137; i++) forms.add(form(List.of()));
        CatalogFormDto writing = form(List.of("IELTS_WRITING_TASK_1"));
        CatalogFormDto speaking = form(List.of("IELTS_SPEAKING_PART_1"));
        forms.set(87, writing);
        forms.set(118, speaking);
        for (int page = 0; page < 3; page++) {
            when(content.getCatalog(ExamFamily.IELTS, null, null, 50, page * 50))
                    .thenReturn(forms.subList(page * 50, Math.min(137, (page + 1) * 50)));
        }
        when(practice.getCatalog(writing.id())).thenReturn(new PracticeCatalogDto(writing.id(), ExamFamily.IELTS,
                writing.title(), List.of(scope("AVAILABLE"))));
        when(practice.getCatalog(speaking.id())).thenReturn(new PracticeCatalogDto(speaking.id(), ExamFamily.IELTS,
                speaking.title(), List.of(scope("UNAVAILABLE"))));

        var result = new ExamPracticeAvailabilityIndex(content, practice).availableScopes(ExamFamily.IELTS);
        assertEquals(1, result.size());
        assertEquals(writing.id(), result.get(0).formId());
        verify(practice).getCatalog(speaking.id());
        verify(practice, times(40)).getCatalog(any());
        verify(content, never()).getCatalog(ExamFamily.IELTS, null, null, 50, 150);
    }

    private static CatalogFormDto form(List<String> codes) {
        return new CatalogFormDto(UUID.randomUUID(), "fixture", 1, "Fixture", ExamFamily.IELTS, "ACADEMIC",
                "FULL", "Fixture", 0, 0, List.of("WRITING"), LifecycleState.PILOT, null)
                .withValidation(List.of("WRITING"), List.of(), false, true, List.of("PRACTICE"), "NEEDS_REVIEW")
                .withPracticeScopes(codes);
    }

    private static PracticeScopeDto scope(String state) {
        return new PracticeScopeDto("IELTS_WRITING_TASK_1", "IELTS_WRITING_TASK", SkillType.WRITING, 1,
                1, false, "RESPONSE_ONLY", "UNTIMED", state, true, false, true);
    }
}
