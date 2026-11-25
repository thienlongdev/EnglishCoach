package com.englishcoach.auth.repository;

import com.englishcoach.auth.entity.AuthMailJob;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

@Repository
public interface AuthMailJobRepository extends JpaRepository<AuthMailJob, UUID> {

    @Query("SELECT j FROM AuthMailJob j WHERE j.status = 'PENDING' AND j.nextAttemptAt <= :now ORDER BY j.nextAttemptAt ASC")
    List<AuthMailJob> findPendingJobsDue(@Param("now") Instant now, Pageable pageable);
}
