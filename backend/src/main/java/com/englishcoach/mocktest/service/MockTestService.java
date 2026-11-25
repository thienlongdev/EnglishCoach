package com.englishcoach.mocktest.service;

import com.englishcoach.mocktest.dto.MockExamDto;
import com.englishcoach.mocktest.dto.MockExamResultDto;
import com.englishcoach.mocktest.repository.ExamRepository;
import com.englishcoach.mocktest.repository.ExamResultRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
public class MockTestService {

    private final ExamRepository examRepository;
    private final ExamResultRepository examResultRepository;

    @Transactional(readOnly = true)
    public List<MockExamDto> getAllExams() {
        return examRepository.findAll().stream()
                .map(MockExamDto::fromEntity)
                .toList();
    }

    @Transactional(readOnly = true)
    public List<MockExamResultDto> getUserResults(Long userId) {
        return examResultRepository.findByUserIdOrderByCompletedAtDesc(userId).stream()
                .map(MockExamResultDto::fromEntity)
                .toList();
    }
}
