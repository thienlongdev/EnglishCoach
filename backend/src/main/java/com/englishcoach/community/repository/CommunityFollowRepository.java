package com.englishcoach.community.repository;

import com.englishcoach.community.entity.CommunityFollow;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface CommunityFollowRepository extends JpaRepository<CommunityFollow, Long> {

    boolean existsByFollowerIdAndFollowingId(Long followerId, Long followingId);

    Optional<CommunityFollow> findByFollowerIdAndFollowingId(Long followerId, Long followingId);

    long countByFollowingId(Long followingId); // number of followers

    long countByFollowerId(Long followerId); // number of following

    @Query("SELECT f.following.id FROM CommunityFollow f WHERE f.follower.id = :followerId")
    List<Long> findFollowingUserIds(@Param("followerId") Long followerId);

    @Query("SELECT f FROM CommunityFollow f JOIN FETCH f.follower WHERE f.following.id = :userId ORDER BY f.createdAt DESC")
    Page<CommunityFollow> findFollowers(@Param("userId") Long userId, Pageable pageable);

    @Query("SELECT f FROM CommunityFollow f JOIN FETCH f.following WHERE f.follower.id = :userId ORDER BY f.createdAt DESC")
    Page<CommunityFollow> findFollowing(@Param("userId") Long userId, Pageable pageable);
}
