package com.englishcoach.writing.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.Map;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class WritingErrorResponse {
    private String code;
    private String message;
    private String requestId;
    private boolean retryable;
    private Instant timestamp;
    private Map<String, String> fieldErrors;
}
