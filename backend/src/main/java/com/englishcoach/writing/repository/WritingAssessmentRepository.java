package com.englishcoach.writing.repository;

import com.englishcoach.writing.entity.WritingAssessmentEntity;
import com.englishcoach.writing.enums.AssessmentStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public interface WritingAssessmentRepository extends JpaRepository<WritingAssessmentEntity, String> {
    @Query("""
        select a.id from WritingAssessmentEntity a, WritingSubmissionEntity s
        where s.id = a.submissionId and s.userId = :owner and a.status = 'READY'
        order by s.createdAt desc, a.createdAt desc, a.id desc
        """)
    List<String> latestReadyForOwner(@Param("owner") Long owner, org.springframework.data.domain.Pageable limit);

    Optional<WritingAssessmentEntity> findBySubmissionId(String submissionId);

    List<WritingAssessmentEntity> findBySubmissionIdIn(java.util.Collection<String> submissionIds);

    @Query("SELECT a FROM WritingAssessmentEntity a WHERE a.status = 'QUEUED' OR (a.status = 'RUNNING' AND a.leaseExpiresAt < :now) ORDER BY a.createdAt ASC")
    List<WritingAssessmentEntity> findEligibleJobsForWorker(@Param("now") Instant now);
}
