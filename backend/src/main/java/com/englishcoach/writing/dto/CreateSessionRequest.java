package com.englishcoach.writing.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CreateSessionRequest {
    @NotBlank(message = "taskId is required")
    private String taskId;

    private String clientMutationId;
}
