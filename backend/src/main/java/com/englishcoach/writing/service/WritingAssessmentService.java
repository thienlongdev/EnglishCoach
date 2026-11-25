package com.englishcoach.writing.service;

import com.englishcoach.writing.dto.SentenceCheckResultDto;
import com.englishcoach.writing.dto.SentenceCheckSubmissionRequest;

public interface WritingAssessmentService {
    SentenceCheckResultDto submitSentenceCheck(Long userId, SentenceCheckSubmissionRequest request);
    SentenceCheckResultDto getAssessment(Long userId, String assessmentId);
    SentenceCheckResultDto retryAssessment(Long userId, String assessmentId);
}
