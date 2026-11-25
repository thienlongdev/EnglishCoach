package com.englishcoach.writing.repository;

import com.englishcoach.writing.entity.WritingFeedbackIssueEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface WritingFeedbackIssueRepository extends JpaRepository<WritingFeedbackIssueEntity, String> {
    List<WritingFeedbackIssueEntity> findByAssessmentId(String assessmentId);
    List<WritingFeedbackIssueEntity> findTop2ByAssessmentIdAndDispositionOrderByPriorityRankAsc(
            String assessmentId, com.englishcoach.writing.enums.IssueDisposition disposition);
    List<WritingFeedbackIssueEntity> findByAssessmentIdOrderByPriorityRankAsc(String assessmentId);

    List<WritingFeedbackIssueEntity> findByAssessmentIdInOrderByPriorityRankAsc(java.util.Collection<String> assessmentIds);
    List<WritingFeedbackIssueEntity> findByPatternCodeOrderByCreatedAtDesc(String patternCode);

    /**
     * Counts ERROR issues per assessment in a single GROUP BY query (used by portfolio summary to avoid N+1).
     */
    @org.springframework.data.jpa.repository.Query("""
        SELECT i.assessmentId, COUNT(i)
        FROM WritingFeedbackIssueEntity i
        WHERE i.assessmentId IN :assessmentIds
          AND i.kind = com.englishcoach.writing.enums.IssueKind.ERROR
        GROUP BY i.assessmentId
    """)
    List<Object[]> countErrorIssuesByAssessmentIdIn(
            @org.springframework.data.repository.query.Param("assessmentIds") java.util.Collection<String> assessmentIds);
}
