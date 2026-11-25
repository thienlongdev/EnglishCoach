package com.englishcoach.community.repository;

import com.englishcoach.community.entity.CommunityComment;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface CommunityCommentRepository extends JpaRepository<CommunityComment, Long> {

    @Query("SELECT c FROM CommunityComment c JOIN FETCH c.user WHERE c.post.id = :postId AND c.parentComment IS NULL AND c.status = :status ORDER BY c.createdAt ASC")
    Page<CommunityComment> findRootComments(
            @Param("postId") Long postId,
            @Param("status") String status,
            Pageable pageable
    );

    @Query("SELECT c FROM CommunityComment c JOIN FETCH c.user WHERE c.parentComment.id IN :parentIds AND c.status = :status ORDER BY c.createdAt ASC")
    List<CommunityComment> findRepliesForParents(
            @Param("parentIds") List<Long> parentIds,
            @Param("status") String status
    );

    @Query("SELECT c FROM CommunityComment c JOIN FETCH c.user WHERE c.post.id = :postId AND c.status = 'PUBLISHED' ORDER BY c.createdAt ASC")
    List<CommunityComment> findAllPublishedForPost(@Param("postId") Long postId);
}
