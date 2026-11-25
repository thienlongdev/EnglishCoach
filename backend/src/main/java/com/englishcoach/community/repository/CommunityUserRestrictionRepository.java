package com.englishcoach.community.repository;

import com.englishcoach.community.entity.CommunityUserRestriction;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public interface CommunityUserRestrictionRepository extends JpaRepository<CommunityUserRestriction, Long> {

    @Query("SELECT r FROM CommunityUserRestriction r JOIN FETCH r.targetUser JOIN FETCH r.createdByAdmin " +
           "WHERE r.targetUser.id = :userId AND r.revokedAt IS NULL AND (r.expiresAt IS NULL OR r.expiresAt > :now) " +
           "ORDER BY r.createdAt DESC")
    List<CommunityUserRestriction> findActiveRestrictions(
            @Param("userId") Long userId,
            @Param("now") Instant now
    );

    @Query("SELECT r FROM CommunityUserRestriction r JOIN FETCH r.targetUser JOIN FETCH r.createdByAdmin " +
           "WHERE r.targetUser.id = :userId AND r.revokedAt IS NULL AND (r.expiresAt IS NULL OR r.expiresAt > :now) " +
           "ORDER BY r.createdAt DESC LIMIT 1")
    Optional<CommunityUserRestriction> findLatestActiveRestriction(
            @Param("userId") Long userId,
            @Param("now") Instant now
    );

    @Query("SELECT r FROM CommunityUserRestriction r JOIN FETCH r.targetUser JOIN FETCH r.createdByAdmin " +
           "WHERE r.targetUser.id = :userId ORDER BY r.createdAt DESC")
    List<CommunityUserRestriction> findHistoryByUserId(@Param("userId") Long userId);
}
