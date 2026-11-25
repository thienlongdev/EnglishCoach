package com.englishcoach.feedback.repository;

import com.englishcoach.feedback.entity.FeedbackMessage;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

@Repository
public interface FeedbackMessageRepository extends JpaRepository<FeedbackMessage, Long> {

    interface LatestSnippetProjection {
        Long getThreadId();
        String getContent();
    }

    List<FeedbackMessage> findByThreadIdOrderByCreatedAtAsc(Long threadId);

    long countBySenderUserIdAndCreatedAtAfter(Long senderUserId, Instant since);

    Optional<FeedbackMessage> findFirstByThreadIdOrderByCreatedAtDesc(Long threadId);

    /**
     * Batch-loads the latest message snippet for each feedback thread in one PostgreSQL DISTINCT ON query.
     */
    @org.springframework.data.jpa.repository.Query(value = """
        SELECT DISTINCT ON (m.thread_id)
               m.thread_id AS threadId,
               m.content AS content
        FROM public.feedback_messages m
        WHERE m.thread_id IN (:threadIds)
        ORDER BY m.thread_id, m.created_at DESC, m.id DESC
    """, nativeQuery = true)
    List<LatestSnippetProjection> findLatestSnippetsByThreadIds(
            @org.springframework.data.repository.query.Param("threadIds") Collection<Long> threadIds);
}
