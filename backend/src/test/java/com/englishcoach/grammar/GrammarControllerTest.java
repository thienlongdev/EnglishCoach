package com.englishcoach.grammar;

import com.englishcoach.common.security.UserDetailsImpl;
import com.englishcoach.grammar.GrammarDtos.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.method.annotation.AuthenticationPrincipalArgumentResolver;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** Module MVC contract only; the shared production cookie/JWT/CSRF filters are not replaced or exercised here. */
class GrammarControllerTest {
    private final GrammarContent content = mock(GrammarContent.class);
    private final GrammarService service = mock(GrammarService.class);
    private final GrammarProfessorFacade professor = mock(GrammarProfessorFacade.class);
    private MockMvc mvc;

    @BeforeEach
    void start() {
        SecurityContextHolder.clearContext();
        mvc = MockMvcBuilders.standaloneSetup(new GrammarController(content, service, professor))
                .setCustomArgumentResolvers(new AuthenticationPrincipalArgumentResolver())
                .setControllerAdvice(new GrammarExceptionHandler()).build();
    }

    @AfterEach
    void clear() { SecurityContextHolder.clearContext(); }

    private void signIn() {
        UserDetailsImpl user = mock(UserDetailsImpl.class);
        when(user.getId()).thenReturn(7L);
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(user, null, List.of()));
    }

    @Test
    void learnerHandlersRefuseAMissingPrincipalBeforeTouchingState() throws Exception {
        mvc.perform(get("/api/v1/grammar/me")).andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("AUTH_REQUIRED")).andExpect(header().string("Cache-Control", "no-store"));
        verifyNoInteractions(service, professor);
    }

    @Test
    void ownerComesFromThePrincipalAndLearnerResponsesAreNotCached() throws Exception {
        signIn();
        when(service.attempt(eq(7L), any())).thenReturn(new VerdictView("exercise", "CORRECT", 1.0, "why", null, List.of()));
        mvc.perform(post("/api/v1/grammar/attempts").contentType("application/json").content("""
                {"requestId":"11111111-1111-1111-1111-111111111111","exerciseId":"exercise","answer":{"choice":0},"userId":999}
                """)).andExpect(status().isOk()).andExpect(header().string("Cache-Control", "no-store"));
        verify(service).attempt(eq(7L), any());
        verifyNoInteractions(professor);
    }

    @Test
    void invalidPayloadsAndOversizedAnswerMapsAreRejectedBeforeScoring() throws Exception {
        signIn();
        String base = "/api/v1/grammar/checks/" + UUID.randomUUID() + "/submit";
        mvc.perform(post(base).contentType("application/json").content("{\"answers\":null}"))
                .andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
        var body = new ObjectMapper().createObjectNode();
        var answers = body.putObject("answers");
        for (int i = 0; i < 65; i++) answers.putObject("item-" + i);
        mvc.perform(post(base).contentType("application/json").content(body.toString())).andExpect(status().isBadRequest());
        mvc.perform(get("/api/v1/grammar/checks/not-a-uuid")).andExpect(status().isBadRequest());
        verifyNoInteractions(service, professor);
    }

    @Test
    void privateContentRevalidatesWithoutWritingLearnerProgress() throws Exception {
        when(content.catalogJson()).thenReturn("{\"revision\":\"test\"}");
        when(content.revision()).thenReturn("test");
        mvc.perform(get("/api/v1/grammar/catalog")).andExpect(status().isOk())
                .andExpect(header().string("ETag", "\"gtest\""))
                .andExpect(header().string("Cache-Control", org.hamcrest.Matchers.containsString("private")));
        mvc.perform(get("/api/v1/grammar/catalog").header("If-None-Match", "\"gtest\""))
                .andExpect(status().isNotModified()).andExpect(content().string(""));
        verifyNoInteractions(service, professor);
    }
}
