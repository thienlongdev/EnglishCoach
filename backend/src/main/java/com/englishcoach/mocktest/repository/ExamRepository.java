package com.englishcoach.mocktest.repository;

import com.englishcoach.mocktest.entity.Exam;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface ExamRepository extends JpaRepository<Exam, Long> {
}
