package com.englishcoach.feedback.repository;

import com.englishcoach.feedback.entity.FeedbackThread;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface FeedbackThreadRepository extends JpaRepository<FeedbackThread, Long> {

    boolean existsByIdAndUserId(Long id, Long userId);

    List<FeedbackThread> findByUserIdOrderByLastMessageAtDesc(Long userId);

    long countByUserIdAndUserUnreadTrue(Long userId);

    List<FeedbackThread> findAllByOrderByLastMessageAtDesc();

    long countByAdminUnreadTrue();
}
