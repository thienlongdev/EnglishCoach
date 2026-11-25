package com.englishcoach.writing.repository;

import com.englishcoach.writing.entity.WritingLearningEvidenceEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;

@Repository
public interface WritingLearningEvidenceRepository extends JpaRepository<WritingLearningEvidenceEntity, String> {
    List<WritingLearningEvidenceEntity> findByUserIdOrderByRecordedAtDesc(Long userId);
    List<WritingLearningEvidenceEntity> findByUserIdAndPatternCodeOrderByRecordedAtDesc(Long userId, String patternCode);
    List<WritingLearningEvidenceEntity> findByUserIdAndSkillCodeOrderByRecordedAtDesc(Long userId, String skillCode);
    long countByUserIdAndRecordedAtAfter(Long userId, Instant after);

    List<WritingLearningEvidenceEntity> findByUserIdAndRecordedAtAfter(Long userId, Instant after);
    java.util.Optional<WritingLearningEvidenceEntity> findFirstBySourceIssueId(String sourceIssueId);
    boolean existsBySourceAssessmentIdAndPatternCode(String sourceAssessmentId, String patternCode);
}
