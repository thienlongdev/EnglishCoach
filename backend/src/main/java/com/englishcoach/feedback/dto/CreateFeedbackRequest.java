package com.englishcoach.feedback.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CreateFeedbackRequest(
        String category,

        @NotBlank(message = "Tiêu đề không được để trống")
        @Size(max = 120, message = "Tiêu đề tối đa 120 ký tự")
        String subject,

        @NotBlank(message = "Nội dung không được để trống")
        @Size(max = 2000, message = "Nội dung tối đa 2000 ký tự")
        String content
) {
}
