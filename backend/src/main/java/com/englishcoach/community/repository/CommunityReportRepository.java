package com.englishcoach.community.repository;

import com.englishcoach.community.entity.CommunityReport;
import com.englishcoach.community.entity.ReportStatus;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface CommunityReportRepository extends JpaRepository<CommunityReport, Long> {
    Page<CommunityReport> findByStatusOrderByCreatedAtDesc(ReportStatus status, Pageable pageable);
    List<CommunityReport> findByPostIdOrderByCreatedAtDesc(Long postId);
    long countByPostId(Long postId);

    @Query("SELECT r.post.id, count(r) FROM CommunityReport r WHERE r.status = 'PENDING' GROUP BY r.post.id")
    List<Object[]> countPendingReportsPerPost();
}
