package com.englishcoach.common.contract;

import java.util.List;

/**
 * Module-neutral snapshot of aggregated Learner DNA weaknesses used by Learning Path
 * without introducing a compile-time dependency on {@code com.englishcoach.ai}.
 */
public record LearnerDnaSnapshot(
        String generatedAt,
        List<String> missingPhonemes,
        Boolean pausingIssues,
        List<String> topGrammarErrors,
        Integer section3DistractorTraps,
        Integer formCompletionPluralSpellingErrors,
        Long criticalForgettingCount
) {}
