package com.englishcoach.ai.dto;

import java.util.List;

/**
 * Echo's answer. {@code cards} are structured results built by server tools (never by the model's text), {@code actions}
 * navigation targets taken only from the server route registry; {@code route} is DIRECT / FAST / STRONG / GUARD.
 */
public record AiChatResponse(
    String reply,
    String model,
    String route,
    List<EchoCard> cards,
    List<EchoAction> actions
) {
    public AiChatResponse(String reply, String model) { this(reply, model, null, List.of(), List.of()); }
}
