package com.englishcoach.learningpath;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * What the Learning Path needs from Exams, nothing more: the practice scopes the Exams module itself declares ready
 * (its authoritative catalog: validation, rights, readiness), and the server-scored raw outcome of one of the learner's
 * own submitted practice attempts. The Learning Path never decides readiness and never scores an answer.
 */
public interface LearningExamPractice {

    /** One practice-ready part of one published form, as the learner catalog shows it. */
    record Scope(UUID formId, String family, String scopeCode, String title) {}

    /** Raw objective outcome of a submitted practice attempt (no scale, no band). */
    record Outcome(int answered, int total, Integer accuracyPct) {}

    record Focus(String code, String skill, int attempts, int questions, String signal) {}

    record Signals(List<Focus> focus, String latestSimulationStatus, java.util.Map<String, Double> estimates) {}

    default Signals signals(long userId, String family) { return new Signals(List.of(), null, java.util.Map.of()); }

    default List<Focus> recommendedFocus(long userId, String family) { return List.of(); }

    List<Scope> practiceScopes(String family);

    /** Empty when the attempt is not the learner's, not a submitted objective practice attempt, or cannot be scored. */
    Optional<Outcome> outcome(long userId, UUID attemptId);
}
