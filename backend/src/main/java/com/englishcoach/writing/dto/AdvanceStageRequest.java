package com.englishcoach.writing.dto;

import com.englishcoach.writing.enums.WritingSessionStage;
import jakarta.validation.constraints.NotNull;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AdvanceStageRequest {
    @NotNull(message = "targetStage is required")
    private WritingSessionStage targetStage;

    @NotNull(message = "expectedRevision is required")
    private Long expectedRevision;
}
