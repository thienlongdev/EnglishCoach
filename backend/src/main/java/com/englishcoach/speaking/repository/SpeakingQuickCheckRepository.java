package com.englishcoach.speaking.repository;

import com.englishcoach.speaking.entity.SpeakingQuickCheck;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

@Repository
public interface SpeakingQuickCheckRepository extends JpaRepository<SpeakingQuickCheck, Long> {

    Optional<SpeakingQuickCheck> findByClientAttemptId(String clientAttemptId);

    Optional<SpeakingQuickCheck> findByUserIdAndClientAttemptId(Long userId, String clientAttemptId);

    Optional<SpeakingQuickCheck> findBySessionId(Long sessionId);

    List<SpeakingQuickCheck> findBySessionIdIn(Collection<Long> sessionIds);

    Page<SpeakingQuickCheck> findByUserIdOrderByCreatedAtDesc(Long userId, Pageable pageable);

    List<SpeakingQuickCheck> findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(Long userId, LocalDateTime after);
}
