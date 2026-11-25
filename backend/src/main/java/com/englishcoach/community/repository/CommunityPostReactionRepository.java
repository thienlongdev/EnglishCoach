package com.englishcoach.community.repository;

import com.englishcoach.community.entity.CommunityPostReaction;
import com.englishcoach.community.entity.ReactionType;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface CommunityPostReactionRepository extends JpaRepository<CommunityPostReaction, Long> {
    Optional<CommunityPostReaction> findByPostIdAndUserId(Long postId, Long userId);
    List<CommunityPostReaction> findByPostIdInAndUserId(List<Long> postIds, Long userId);
    long countByPostId(Long postId);

    @Query("SELECT r FROM CommunityPostReaction r JOIN FETCH r.user WHERE r.post.id = :postId ORDER BY r.createdAt DESC")
    Page<CommunityPostReaction> findByPostIdWithUser(@Param("postId") Long postId, Pageable pageable);

    @Query("SELECT r FROM CommunityPostReaction r JOIN FETCH r.user WHERE r.post.id = :postId AND (r.reactionType = :type OR (r.reactionType = com.englishcoach.community.entity.ReactionType.LIKE AND :type = com.englishcoach.community.entity.ReactionType.LOVE) OR (r.reactionType = com.englishcoach.community.entity.ReactionType.IDEA AND :type = com.englishcoach.community.entity.ReactionType.USEFUL) OR (r.reactionType = com.englishcoach.community.entity.ReactionType.STRONG AND :type = com.englishcoach.community.entity.ReactionType.SUPPORT)) ORDER BY r.createdAt DESC")
    Page<CommunityPostReaction> findByPostIdAndReactionTypeWithUser(@Param("postId") Long postId, @Param("type") ReactionType type, Pageable pageable);

    @Query("SELECT r.reactionType, COUNT(r) FROM CommunityPostReaction r WHERE r.post.id = :postId GROUP BY r.reactionType")
    List<Object[]> countGroupedByReactionType(@Param("postId") Long postId);

    @Query("SELECT r.post.id, r.reactionType, COUNT(r) FROM CommunityPostReaction r WHERE r.post.id IN :postIds GROUP BY r.post.id, r.reactionType ORDER BY COUNT(r) DESC")
    List<Object[]> findTopReactionsByPostIds(@Param("postIds") List<Long> postIds);

    @Query("SELECT r.reactionType, COUNT(r) FROM CommunityPostReaction r WHERE r.post.id = :postId GROUP BY r.reactionType ORDER BY COUNT(r) DESC")
    List<Object[]> findTopReactionsByPostId(@Param("postId") Long postId);
}
