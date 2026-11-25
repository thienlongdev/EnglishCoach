package com.englishcoach.auth.repository;

import com.englishcoach.auth.entity.AuthSecurityState;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface AuthSecurityStateRepository extends JpaRepository<AuthSecurityState, Long> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT s FROM AuthSecurityState s WHERE s.userId = :userId")
    Optional<AuthSecurityState> findByUserIdForUpdate(@Param("userId") Long userId);

    /** Accounts created after V11 have no row until their first failed sign-in; two racing failures both end up on one row. */
    @Modifying
    @Query(value = "INSERT INTO public.auth_security_state (user_id, failed_login_count, reset_generation, verification_generation, version) VALUES (:userId, 0, 0, 0, 0) ON CONFLICT (user_id) DO NOTHING", nativeQuery = true)
    int ensureRow(@Param("userId") Long userId);
}
