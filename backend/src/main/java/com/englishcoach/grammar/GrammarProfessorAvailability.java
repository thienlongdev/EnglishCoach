package com.englishcoach.grammar;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Explicit opt-in only. A configured string is not a provider health check; this class makes no network request. */
@Component
public class GrammarProfessorAvailability {
    private final boolean available;

    public GrammarProfessorAvailability(@Value("${GRAMMAR_PROFESSOR_ENABLED:false}") boolean enabled,
                                        @Value("${openrouter.api-key:}") String credential) {
        available = enabled && credential != null && !credential.isBlank() && !credential.trim().startsWith("your_");
    }

    public boolean available() { return available; }
}
