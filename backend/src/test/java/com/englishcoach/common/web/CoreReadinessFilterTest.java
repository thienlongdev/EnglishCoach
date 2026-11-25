package com.englishcoach.common.web;

import com.englishcoach.dictionary.provider.LocalEnViLexicalProvider;
import com.englishcoach.writing.service.LanguageToolGrammarService;
import org.junit.jupiter.api.Test;
import org.languagetool.JLanguageTool;
import org.springframework.boot.availability.ApplicationAvailability;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.mock.web.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class CoreReadinessFilterTest {
    @Test void healthRequiresCompletedStartupAndBothCriticalProviders() throws Exception {
        var availability = mock(ApplicationAvailability.class);
        var dictionary = mock(LocalEnViLexicalProvider.class);
        var grammar = mock(LanguageToolGrammarService.class);
        var filter = new CoreReadinessFilter(availability, dictionary, grammar);
        when(availability.getReadinessState()).thenReturn(ReadinessState.REFUSING_TRAFFIC);
        when(dictionary.isAvailable()).thenReturn(true);
        when(grammar.getLanguageTool()).thenReturn(mock(JLanguageTool.class));
        assertThat(probe(filter)).isEqualTo(503);
        when(availability.getReadinessState()).thenReturn(ReadinessState.ACCEPTING_TRAFFIC);
        assertThat(probe(filter)).isEqualTo(200);
        when(dictionary.isAvailable()).thenReturn(false);
        assertThat(probe(filter)).isEqualTo(503);
        when(dictionary.isAvailable()).thenReturn(true);
        when(grammar.getLanguageTool()).thenReturn(null);
        assertThat(probe(filter)).isEqualTo(503);
    }

    @Test void featureRoutesKeepTheirExistingSecurityAndResponseChain() throws Exception {
        var filter = new CoreReadinessFilter(mock(ApplicationAvailability.class),
                mock(LocalEnViLexicalProvider.class), mock(LanguageToolGrammarService.class));
        var request = new MockHttpServletRequest("GET", "/api/v1/dictionary/v2/lookup");
        request.setServletPath("/api/v1/dictionary/v2/lookup");
        var response = new MockHttpServletResponse();
        filter.doFilter(request, response, (req, res) -> res.getWriter().write("existing"));
        assertThat(response.getContentAsString()).isEqualTo("existing");
    }

    private int probe(CoreReadinessFilter filter) throws Exception {
        var request = new MockHttpServletRequest("GET", "/api/v1/exams/capabilities");
        request.setServletPath("/api/v1/exams/capabilities");
        var response = new MockHttpServletResponse();
        filter.doFilter(request, response, (req, res) -> {});
        return response.getStatus();
    }
}
