package com.englishcoach.ai.echo;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.Map;

/**
 * One typed, allow-listed capability Echo may use. A tool:
 * - acts only for {@link EchoTurn#userId()} (the authenticated principal); no schema may contain a user, owner or account id;
 * - goes through the owning module's service and its rules (ownership, SYSTEM visibility, quarantine, readiness);
 * - never changes scores, evidence, achievements, payments, Premium rights, leaderboard or anti-cheat records;
 * - returns compact JSON for the model (no e-mail, no ids of other learners, no free text of other learners).
 * Mutations are never executed by a tool: PREPARE tools only issue a single-use confirmation the learner must press.
 */
public interface EchoTool {
    enum Kind { READ, NAVIGATE, PREPARE, MEMORY }

    String name();

    /** One or two sentences: what it returns and when to use it. Part of the cached static prefix. */
    String description();

    /** JSON-schema object: only string / integer / boolean properties, enums and maxLength; additionalProperties false. */
    Map<String, Object> parameters();

    Kind kind();

    /** Short line shown to the learner while the tool runs (Vietnamese / English). */
    String status(boolean vi);

    /** Whether the registry wraps the call in a read-only transaction (false when the service manages its own). */
    default boolean readOnlyTransaction() { return kind() == Kind.READ || kind() == Kind.NAVIGATE || kind() == Kind.PREPARE; }

    /** Whether multiple calls to this tool in the same round may run concurrently on {@code toolPool}. */
    default boolean parallelizableRead() { return kind() == Kind.READ && readOnlyTransaction(); }

    /** Returns JSON text for the model; may add cards / actions to the turn. Throwing yields a neutral "unavailable". */
    String run(EchoTurn turn, JsonNode args) throws Exception;
}
