package com.englishcoach.speaking.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonIgnoreProperties(ignoreUnknown = true)
public class QuickCheckResponseDto {
    private Long id;
    private String clientAttemptId;
    private Long sessionId;
    private String audioRef;
    private String audioUrl;
    private String whisperTranscript;
    private String intendedTranscript;
    private Double overallScore;
    private Double phonemeScore;
    private Double stressScore;
    private Double pitchScore;
    private Double rhythmScore;
    private Double fluencyScore;
    private PronunciationV2ResponseDto pronunciation;
    private QuickCheckLanguageFeedbackDto languageFeedback;
    private String sttStatus; // SUCCESS | FAILED
    private String pronunciationStatus; // SUCCESS | FAILED | UNAVAILABLE
    private String languageStatus; // SUCCESS | FAILED | UNAVAILABLE
    private String sttError;
    private String pronunciationError;
    private String languageError;
    private LocalDateTime createdAt;
}
