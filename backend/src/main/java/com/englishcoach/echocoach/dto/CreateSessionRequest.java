package com.englishcoach.echocoach.dto;

import jakarta.validation.constraints.Size;

public record CreateSessionRequest(
        @Size(max = 255, message = "Tiêu đề không được vượt quá 255 ký tự")
        String title
) {
}
