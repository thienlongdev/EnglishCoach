package com.englishcoach.writing.service;

import com.englishcoach.writing.dto.ErrorMemoryDto;

import java.util.List;
import java.util.Optional;

public interface WritingErrorMemoryService {
    void recordMistakeObservation(Long userId, String sourceAssessmentId, String sourceIssueId, String patternCode, String contextId);
    void recordPracticeOutcome(Long userId, String practiceId, String patternCode, boolean isSuccess, boolean assisted, String contextId);
    List<ErrorMemoryDto> getMyMistakes(Long userId);
    ErrorMemoryDto getMistakeByPattern(Long userId, String patternCode);
    Optional<ErrorMemoryDto> findMistakeByPattern(Long userId, String patternCode);
    void setMuted(Long userId, String patternCode, boolean isMuted);
    void disputeIssue(Long userId, String issueId, String reason);
}
