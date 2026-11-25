package com.englishcoach.ai.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Map;

/**
 * A validated navigation or typed workspace control offered with Echo's answer.
 * <ul>
 *   <li>{@code navigate}: {@code href} comes from the server route registry only; {@code auto} is true only when
 *       the learner's own unquoted words asked to open a page.</li>
 *   <li>{@code workspace_control}: {@code payload} carries an allow-listed typed client control intent validated
 *       by {@code WorkspaceControlTool} and re-validated by the client {@code PermissionEngine}.</li>
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record EchoAction(String type, String href, String label, boolean auto, Map<String, Object> intent) {

    /** Backward-compatible 4-arg constructor preserved for all existing callers and tests. */
    public EchoAction(String type, String href, String label, boolean auto) {
        this(type, href, label, auto, null);
    }

    public static EchoAction navigate(String href, String label, boolean auto) {
        return new EchoAction("navigate", href, label, auto, null);
    }

    public static EchoAction workspaceControl(Map<String, Object> intent, String label, boolean auto) {
        return new EchoAction("client_intent", null, label, auto, intent == null ? Map.of() : Map.copyOf(intent));
    }
}
