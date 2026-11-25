package com.englishcoach.community.repository;

import com.englishcoach.community.entity.CommunityPostMedia;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface CommunityPostMediaRepository extends JpaRepository<CommunityPostMedia, Long> {
    List<CommunityPostMedia> findByPostIdOrderByDisplayOrderAsc(Long postId);
    List<CommunityPostMedia> findByPostIdInOrderByDisplayOrderAsc(List<Long> postIds);
    java.util.Optional<CommunityPostMedia> findByStorageKey(String storageKey);
    List<CommunityPostMedia> findByStorageKeyIn(List<String> storageKeys);
}
