package com.englishcoach.writing.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.*;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class PracticeAttemptRequest {
    @NotBlank(message = "Answer cannot be blank")
    private String answer;
    private String clientMutationId;
}
