package com.englishcoach.community.repository;

import com.englishcoach.community.entity.CommunityPost;
import com.englishcoach.community.entity.PostStatus;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

@Repository
public interface CommunityPostRepository extends JpaRepository<CommunityPost, Long> {

    @Query("SELECT p FROM CommunityPost p JOIN FETCH p.author WHERE p.status = 'PUBLISHED' ORDER BY p.isPinned DESC, COALESCE(p.publishedAt, p.createdAt) DESC, p.id DESC")
    Page<CommunityPost> findPublicFeed(Pageable pageable);

    @Query("SELECT p FROM CommunityPost p JOIN FETCH p.author WHERE p.status = 'PUBLISHED' AND p.postType = :postType ORDER BY p.isPinned DESC, COALESCE(p.publishedAt, p.createdAt) DESC, p.id DESC")
    Page<CommunityPost> findPublicFeedByPostType(@Param("postType") com.englishcoach.community.entity.PostType postType, Pageable pageable);

    @Query("SELECT p FROM CommunityPost p JOIN FETCH p.author WHERE p.status = 'PUBLISHED' AND function('regexp_like', p.content, :pattern, 'i') = true ORDER BY p.isPinned DESC, COALESCE(p.publishedAt, p.createdAt) DESC, p.id DESC")
    Page<CommunityPost> findPublicFeedByHashtag(@Param("pattern") String pattern, Pageable pageable);

    @Query("SELECT p FROM CommunityPost p JOIN FETCH p.author WHERE p.status = 'PUBLISHED' AND p.postType = :postType AND function('regexp_like', p.content, :pattern, 'i') = true ORDER BY p.isPinned DESC, COALESCE(p.publishedAt, p.createdAt) DESC, p.id DESC")
    Page<CommunityPost> findPublicFeedByPostTypeAndHashtag(@Param("postType") com.englishcoach.community.entity.PostType postType, @Param("pattern") String pattern, Pageable pageable);

    @Query("SELECT p FROM CommunityPost p JOIN FETCH p.author WHERE p.status = 'PUBLISHED' AND (p.publishedAt >= :since OR p.createdAt >= :since) ORDER BY p.id DESC")
    List<CommunityPost> findRecentPublishedPostsForTrending(@Param("since") Instant since);

    @Query("SELECT p FROM CommunityPost p JOIN FETCH p.author WHERE p.status = 'PUBLISHED' AND p.author.id IN (SELECT f.following.id FROM CommunityFollow f WHERE f.follower.id = :userId) ORDER BY p.isPinned DESC, COALESCE(p.publishedAt, p.createdAt) DESC, p.id DESC")
    Page<CommunityPost> findFollowingFeed(@Param("userId") Long userId, Pageable pageable);

    @Query("SELECT p FROM CommunityPost p JOIN FETCH p.author WHERE p.author.id = :authorId AND p.status <> 'DELETED' ORDER BY p.createdAt DESC")
    Page<CommunityPost> findAuthorPostsForAuthor(@Param("authorId") Long authorId, Pageable pageable);

    @Query("SELECT p FROM CommunityPost p JOIN FETCH p.author WHERE p.author.id = :authorId AND p.status = 'PUBLISHED' ORDER BY p.publishedAt DESC")
    Page<CommunityPost> findAuthorPostsPublic(@Param("authorId") Long authorId, Pageable pageable);

    @Query("SELECT p FROM CommunityPost p JOIN FETCH p.author WHERE p.id IN (SELECT s.post.id FROM CommunitySavedPost s WHERE s.user.id = :userId) AND p.status = 'PUBLISHED' ORDER BY p.id DESC")
    Page<CommunityPost> findSavedPosts(@Param("userId") Long userId, Pageable pageable);

    @Query("SELECT p FROM CommunityPost p JOIN FETCH p.author WHERE p.status = :status ORDER BY p.createdAt DESC")
    Page<CommunityPost> findByStatusWithAuthor(@Param("status") PostStatus status, Pageable pageable);

    @Query("SELECT p FROM CommunityPost p JOIN FETCH p.author WHERE p.id IN (SELECT r.post.id FROM CommunityReport r WHERE r.status = 'PENDING') ORDER BY p.createdAt DESC")
    Page<CommunityPost> findReportedPosts(Pageable pageable);

    Optional<CommunityPost> findBySeriesTypeAndScheduledDate(String seriesType, LocalDate scheduledDate);

    @Query("SELECT p FROM CommunityPost p WHERE p.status = 'SCHEDULED' AND p.scheduledFor <= :now")
    List<CommunityPost> findScheduledPostsReadyToPublish(@Param("now") Instant now);

    @Modifying
    @Query("UPDATE CommunityPost p SET p.likeCount = (SELECT count(r) FROM CommunityPostReaction r WHERE r.post.id = :postId) WHERE p.id = :postId")
    void refreshLikeCount(@Param("postId") Long postId);

    @Modifying
    @Query("UPDATE CommunityPost p SET p.commentCount = (SELECT count(c) FROM CommunityComment c WHERE c.post.id = :postId AND c.status = 'PUBLISHED') WHERE p.id = :postId")
    void refreshCommentCount(@Param("postId") Long postId);

    @Modifying
    @Query("UPDATE CommunityPost p SET p.saveCount = (SELECT count(s) FROM CommunitySavedPost s WHERE s.post.id = :postId) WHERE p.id = :postId")
    void refreshSaveCount(@Param("postId") Long postId);
}
