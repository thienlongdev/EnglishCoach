package com.englishcoach.common.web;

import com.englishcoach.dictionary.provider.LocalEnViLexicalProvider;
import com.englishcoach.writing.service.LanguageToolGrammarService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.availability.ApplicationAvailability;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.IOException;

/** Keep the canonical health probe DOWN until runners and synchronous catalog warmups finish. */
public class CoreReadinessFilter extends OncePerRequestFilter {
    private final ApplicationAvailability availability;
    private final LocalEnViLexicalProvider dictionary;
    private final LanguageToolGrammarService grammar;

    public CoreReadinessFilter(ApplicationAvailability availability, LocalEnViLexicalProvider dictionary,
                               LanguageToolGrammarService grammar) {
        this.availability = availability;
        this.dictionary = dictionary;
        this.grammar = grammar;
    }

    @Override protected boolean shouldNotFilter(HttpServletRequest request) {
        return !"/api/v1/exams/capabilities".equals(request.getServletPath());
    }

    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                              FilterChain chain) throws ServletException, IOException {
        if (availability.getReadinessState() != ReadinessState.ACCEPTING_TRAFFIC
                || !dictionary.isAvailable() || grammar.getLanguageTool() == null) {
            response.setStatus(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
            response.setContentType("application/json");
            response.getWriter().write("{\"code\":\"CORE_NOT_READY\"}");
            return;
        }
        chain.doFilter(request, response);
    }
}
