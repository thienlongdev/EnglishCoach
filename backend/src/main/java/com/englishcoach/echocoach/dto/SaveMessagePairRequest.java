package com.englishcoach.echocoach.dto;

public record SaveMessagePairRequest(
        String userMessage,
        String assistantMessage,
        String role,
        String content
) {
}
