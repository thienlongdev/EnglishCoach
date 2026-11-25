package com.englishcoach.listening.dto;

import com.englishcoach.listening.entity.enums.ErrorCategory;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AiDiagnosticResponse {
    private String source;
    private ErrorCategory errorCategory;
    private String explanation;
}
