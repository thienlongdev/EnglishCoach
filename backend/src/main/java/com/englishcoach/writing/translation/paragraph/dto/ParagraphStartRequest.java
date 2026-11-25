package com.englishcoach.writing.translation.paragraph.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ParagraphStartRequest {

    @NotBlank(message = "clientMutationId is required")
    private String clientMutationId;

    private String genre;

    private String topic;

    @Min(value = 1, message = "limit must be at least 1")
    @Max(value = 50, message = "limit cannot exceed 50")
    @Builder.Default
    private Integer limit = 5;
}
