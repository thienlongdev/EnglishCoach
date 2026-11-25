package com.englishcoach.ai.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * One Echo turn. Identity never travels in the request: the server takes the learner from the authenticated principal.
 * {@code pageContext} names the page the learner is on by typed ids only (resolved and ownership-checked on the server),
 * {@code channel} is TEXT or VOICE, {@code locale} vi / en, {@code turnId} a client id used to drop duplicate actions,
 * and {@code sessionId} optionally associates client-tracked conversation state without trusting cross-user ownership.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record AiChatRequest(
    @NotEmpty(message = "Messages list must not be empty")
    @Size(max = 30, message = "Conversation history cannot exceed 30 messages")
    List<@Valid AiChatMessageDto> messages,
    @Valid EchoPageContextDto pageContext,
    @Pattern(regexp = "(?i)text|voice", message = "Unsupported channel") String channel,
    @Pattern(regexp = "vi|en", message = "Unsupported locale") String locale,
    @Pattern(regexp = "[A-Za-z0-9-]{8,64}", message = "Invalid turn id") String turnId,
    @Positive(message = "Invalid session id") Long sessionId,
    @Size(max = 12, message = "Salient resources cannot exceed 12 items")
    List<@Valid EchoSalientResourceDto> salientResources
) {
    public AiChatRequest(List<AiChatMessageDto> messages) {
        this(messages, null, null, null, null, null, null);
    }

    public AiChatRequest(
            List<AiChatMessageDto> messages,
            EchoPageContextDto pageContext,
            String channel,
            String locale,
            String turnId) {
        this(messages, pageContext, channel, locale, turnId, null, null);
    }

    public AiChatRequest(
            List<AiChatMessageDto> messages,
            EchoPageContextDto pageContext,
            String channel,
            String locale,
            String turnId,
            Long sessionId) {
        this(messages, pageContext, channel, locale, turnId, sessionId, null);
    }

    public boolean voice() { return channel != null && channel.equalsIgnoreCase("voice"); }

    public boolean english() { return "en".equals(locale); }
}
