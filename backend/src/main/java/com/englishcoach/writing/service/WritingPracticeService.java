package com.englishcoach.writing.service;

import com.englishcoach.writing.dto.PracticeAttemptRequest;
import com.englishcoach.writing.dto.PracticeAttemptResultDto;
import com.englishcoach.writing.dto.PracticeEpisodeDto;
import com.englishcoach.writing.dto.PracticeStartRequest;

public interface WritingPracticeService {
    PracticeEpisodeDto startPractice(Long userId, PracticeStartRequest request);
    PracticeEpisodeDto getPractice(Long userId, String practiceId);
    PracticeEpisodeDto requestNextHint(Long userId, String practiceId);
    PracticeAttemptResultDto submitAttempt(Long userId, String practiceId, PracticeAttemptRequest request);
}
