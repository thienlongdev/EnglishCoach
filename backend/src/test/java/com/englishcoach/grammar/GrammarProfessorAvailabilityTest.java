package com.englishcoach.grammar;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.grammar.GrammarDtos.ProfessorRequest;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.method.annotation.AuthenticationPrincipalArgumentResolver;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import java.util.List;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class GrammarProfessorAvailabilityTest {
    @AfterEach void clear() { SecurityContextHolder.clearContext(); }

    @Test void explicitOptInAndConfiguredCredentialAreBothRequiredWithoutAnyNetworkProbe() {
        assertThat(new GrammarProfessorAvailability(false, "configured-test-only").available()).isFalse();
        assertThat(new GrammarProfessorAvailability(true, "").available()).isFalse();
        assertThat(new GrammarProfessorAvailability(true, "your_api_key").available()).isFalse();
        assertThat(new GrammarProfessorAvailability(true, "configured-test-only").available()).isTrue();
    }

    @Test void disabledRequestsNeverReachContentReceiptsQuotaOrProviderEvenWhenReplayed() throws Exception {
        var content = mock(GrammarContent.class); var provider = mock(GrammarProfessorService.class);
        var receipts = mock(GrammarProfessorReceipts.class);
        var facade = new GrammarProfessorFacade(content, provider, receipts, new ObjectMapper(), new GrammarProfessorAvailability(false, "configured-test-only"));
        var mvc = MockMvcBuilders.standaloneSetup(new GrammarController(content, mock(GrammarService.class), facade))
                .setCustomArgumentResolvers(new AuthenticationPrincipalArgumentResolver())
                .setControllerAdvice(new GrammarExceptionHandler()).build();
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(
                new UserDetailsImpl(7L,"synthetic@example.test","unused",List.of()),null,List.of()));
        mvc.perform(get("/api/v1/grammar/capabilities")).andExpect(status().isOk())
                .andExpect(jsonPath("$.professorAvailable").value(false)).andExpect(header().string("Cache-Control","no-store"));
        for (int i=0;i<2;i++) mvc.perform(post("/api/v1/grammar/professor/ask").header("X-Request-Id","same")
                .contentType("application/json").content(new ObjectMapper().writeValueAsString(new ProfessorRequest("verb-be","A grammar question",null))))
                .andExpect(status().isServiceUnavailable()).andExpect(jsonPath("$.code").value("PROFESSOR_DISABLED"));
        verifyNoInteractions(content,provider,receipts);
    }
}
