package com.englishcoach.writing.translation.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.*;

import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class TranslationStartRequest {
    private String mode;
    private String topicCode;
    private String difficultyBucket;
    private UUID exerciseId;

    @NotBlank(message = "clientMutationId is required")
    private String clientMutationId;
}
