package com.englishcoach.community.repository;

import com.englishcoach.community.entity.CommunityCommentReaction;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface CommunityCommentReactionRepository extends JpaRepository<CommunityCommentReaction, Long> {
    Optional<CommunityCommentReaction> findByCommentIdAndUserId(Long commentId, Long userId);
    List<CommunityCommentReaction> findByCommentIdInAndUserId(List<Long> commentIds, Long userId);
    long countByCommentId(Long commentId);

    @Query("SELECT r.reactionType, COUNT(r) FROM CommunityCommentReaction r WHERE r.comment.id = :commentId GROUP BY r.reactionType")
    List<Object[]> countGroupedByReactionType(@Param("commentId") Long commentId);

    @Query("SELECT r FROM CommunityCommentReaction r JOIN FETCH r.user WHERE r.comment.id = :commentId ORDER BY r.createdAt DESC")
    List<CommunityCommentReaction> findTopReactorsByCommentId(@Param("commentId") Long commentId, Pageable pageable);

    @Query("SELECT r FROM CommunityCommentReaction r JOIN FETCH r.user WHERE r.comment.id IN :commentIds ORDER BY r.createdAt DESC")
    List<CommunityCommentReaction> findByCommentIdInWithUser(@Param("commentIds") List<Long> commentIds);
}
