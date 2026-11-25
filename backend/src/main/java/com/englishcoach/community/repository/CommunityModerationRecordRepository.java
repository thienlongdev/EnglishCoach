package com.englishcoach.community.repository;

import com.englishcoach.community.entity.CommunityModerationRecord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface CommunityModerationRecordRepository extends JpaRepository<CommunityModerationRecord, Long> {
    List<CommunityModerationRecord> findByPostIdOrderByCreatedAtDesc(Long postId);
    List<CommunityModerationRecord> findByPostIdInOrderByCreatedAtDesc(List<Long> postIds);
}
