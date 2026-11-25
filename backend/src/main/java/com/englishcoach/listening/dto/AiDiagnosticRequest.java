package com.englishcoach.listening.dto;

import java.util.Map;
import lombok.Builder;
import lombok.Data;

@Data
@Builder
public class AiDiagnosticRequest {
    private String transcriptText;
    private String userRawAnswer;
    private String audioContextUrl;
    private Map<String, Double> priorErrorDnaSummary;
}
