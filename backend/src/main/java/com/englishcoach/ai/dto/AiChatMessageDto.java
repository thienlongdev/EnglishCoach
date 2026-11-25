package com.englishcoach.ai.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import jakarta.validation.constraints.Pattern;

public record AiChatMessageDto(
    @NotBlank(message = "Role must not be blank")
    @Pattern(regexp = "user|assistant", message = "Unsupported conversation role")
    String role,

    @NotBlank(message = "Content must not be blank")
    @Size(max = 4000, message = "Message content must not exceed 4000 characters")
    String content
) {}
