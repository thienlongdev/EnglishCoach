package com.englishcoach.auth.repository;

import com.englishcoach.auth.entity.AuthRateLimitBucket;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Optional;

@Repository
public interface AuthRateLimitBucketRepository extends JpaRepository<AuthRateLimitBucket, AuthRateLimitBucket.RateLimitId> {
    Optional<AuthRateLimitBucket> findByKindAndBucketKeyAndWindowStart(String kind, String bucketKey, Instant windowStart);

    @Modifying
    @Query("DELETE FROM AuthRateLimitBucket b WHERE b.expiresAt < :now")
    int deleteExpiredBuckets(@Param("now") Instant now);
}
