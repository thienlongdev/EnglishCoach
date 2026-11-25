package com.englishcoach.echocoach.repository;

import com.englishcoach.echocoach.entity.EchoCoachSession;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface EchoCoachSessionRepository extends JpaRepository<EchoCoachSession, Long> {

    List<EchoCoachSession> findByUserIdOrderByUpdatedAtDesc(Long userId);

    Optional<EchoCoachSession> findByIdAndUserId(Long id, Long userId);

    long countByUserId(Long userId);

    void deleteByIdAndUserId(Long id, Long userId);
}
