package com.englishcoach.writing.dto;

import jakarta.validation.constraints.NotNull;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class UpdateWorkingCopyRequest {
    private String workingText;
    private String workingPlan;

    @NotNull(message = "expectedRevision is required")
    private Long expectedRevision;

    private String clientMutationId;
}
