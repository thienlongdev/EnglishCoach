package com.englishcoach.community.repository;

import com.englishcoach.community.entity.CommunityCommentMedia;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface CommunityCommentMediaRepository extends JpaRepository<CommunityCommentMedia, Long> {
    List<CommunityCommentMedia> findByCommentIdOrderByDisplayOrderAsc(Long commentId);
    List<CommunityCommentMedia> findByCommentIdInOrderByDisplayOrderAsc(List<Long> commentIds);
}
