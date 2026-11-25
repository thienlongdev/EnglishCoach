package com.englishcoach.auth.repository;

import com.englishcoach.auth.entity.AuthActionToken;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface AuthActionTokenRepository extends JpaRepository<AuthActionToken, UUID> {
    Optional<AuthActionToken> findByTokenDigest(String tokenDigest);

    @Modifying
    @Query("UPDATE AuthActionToken t SET t.usedAt = :now WHERE t.id = :id AND t.usedAt IS NULL AND t.revokedAt IS NULL")
    int markUsedIfUnused(@Param("id") UUID id, @Param("now") Instant now);

    @Modifying
    @Query("UPDATE AuthActionToken t SET t.revokedAt = :now WHERE t.user.id = :userId AND t.purpose = :purpose AND t.usedAt IS NULL AND t.revokedAt IS NULL")
    int revokeActiveTokensForUserAndPurpose(@Param("userId") Long userId, @Param("purpose") String purpose, @Param("now") Instant now);
}
