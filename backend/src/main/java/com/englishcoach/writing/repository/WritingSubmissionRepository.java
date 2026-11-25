package com.englishcoach.writing.repository;

import com.englishcoach.writing.entity.WritingSubmissionEntity;
import com.englishcoach.writing.enums.SubmissionKind;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface WritingSubmissionRepository extends JpaRepository<WritingSubmissionEntity, String> {
    Optional<WritingSubmissionEntity> findByIdAndUserId(String id, Long userId);
    Optional<WritingSubmissionEntity> findByUserIdAndIdempotencyKey(Long userId, String idempotencyKey);
    Optional<WritingSubmissionEntity> findBySessionIdAndOrdinal(String sessionId, Integer ordinal);
    List<WritingSubmissionEntity> findBySessionIdOrderByOrdinalAsc(String sessionId);
    List<WritingSubmissionEntity> findByUserIdAndKindOrderByCreatedAtDesc(Long userId, SubmissionKind kind);
    List<WritingSubmissionEntity> findTop10ByUserIdOrderByCreatedAtDesc(Long userId);

    List<WritingSubmissionEntity> findByUserIdAndKindAndCreatedAtAfterOrderByCreatedAtDesc(Long userId, SubmissionKind kind, java.time.Instant after);

    /** Every submission of the given sessions, grouped by session and ordered by ordinal (one statement instead of one per session). */
    List<WritingSubmissionEntity> findBySessionIdInOrderBySessionIdAscOrdinalAsc(java.util.Collection<String> sessionIds);

    /** The owner's sessions that received any submission after an instant. */
    @org.springframework.data.jpa.repository.Query("SELECT DISTINCT sub.sessionId FROM WritingSubmissionEntity sub, WritingSessionEntity s "
            + "WHERE s.id = sub.sessionId AND s.userId = :userId AND sub.createdAt > :after")
    List<String> findSessionIdsWithSubmissionsAfter(@org.springframework.data.repository.query.Param("userId") Long userId,
                                                    @org.springframework.data.repository.query.Param("after") java.time.Instant after);
}
