package com.englishcoach.community.repository;

import com.englishcoach.community.entity.CommunitySavedPost;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface CommunitySavedPostRepository extends JpaRepository<CommunitySavedPost, Long> {
    boolean existsByUserIdAndPostId(Long userId, Long postId);
    Optional<CommunitySavedPost> findByUserIdAndPostId(Long userId, Long postId);
    Page<CommunitySavedPost> findByUserIdOrderByCreatedAtDesc(Long userId, Pageable pageable);
    List<CommunitySavedPost> findByUserIdAndPostIdIn(Long userId, List<Long> postIds);
}
