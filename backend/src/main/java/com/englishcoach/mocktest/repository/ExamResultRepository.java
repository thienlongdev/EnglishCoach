package com.englishcoach.mocktest.repository;

import com.englishcoach.mocktest.entity.ExamResult;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface ExamResultRepository extends JpaRepository<ExamResult, Long> {
    List<ExamResult> findByUserIdOrderByCompletedAtDesc(Long userId);
}
