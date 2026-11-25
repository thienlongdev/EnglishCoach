package com.englishcoach.grammar;

import com.englishcoach.reading.service.ContextTranslationService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class GrammarProfessorServiceTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final ContextTranslationService transport = mock(ContextTranslationService.class);
    private final GrammarProfessorService professor = new GrammarProfessorService(new GrammarContent(mapper), transport, mapper);

    @Test
    void explicitQuestionCarriesEditorialStatusAndNoExerciseKeys() throws Exception {
        when(transport.completeJson(anyString(), anyString(), eq(900)))
                .thenReturn("{\"answer\":\"Hai cách dùng cần ngữ cảnh.\",\"examples\":[],\"confidence\":\"LOW\"}");
        var result = professor.ask(new GrammarDtos.ProfessorRequest("present-perfect-vs-past-simple", "Vì sao?", "I lived here."));
        var body = ArgumentCaptor.forClass(String.class);
        verify(transport).completeJson(anyString(), body.capture(), eq(900));
        var request = mapper.readTree(body.getValue());
        assertEquals("drafted", request.path("editorialStatus").asText());
        assertEquals("Vì sao?", request.path("question").asText());
        assertEquals("I lived here.", request.path("sentence").asText());
        assertFalse(request.path("lesson").asText().contains("ppps-"));
        assertFalse(request.has("exercises"));
        assertTrue(result.ai());
        assertEquals("LOW", result.confidence());
    }

    @Test
    void unavailableOrMalformedOptionalInferenceHasAControlledFailure() {
        when(transport.completeJson(anyString(), anyString(), anyInt())).thenReturn("not JSON");
        var error = assertThrows(GrammarException.class, () -> professor.ask(
                new GrammarDtos.ProfessorRequest("present-perfect-vs-past-simple", "Giải thích", null)));
        assertEquals(503, error.status);
        assertEquals("PROFESSOR_UNAVAILABLE", error.code);
    }
}
