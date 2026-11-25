package com.englishcoach.writing.repository;

import com.englishcoach.writing.entity.WritingSessionEntity;
import com.englishcoach.writing.enums.WritingSessionStage;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface WritingSessionRepository extends JpaRepository<WritingSessionEntity, String> {
    @org.springframework.data.jpa.repository.Lock(jakarta.persistence.LockModeType.PESSIMISTIC_WRITE)
    @org.springframework.data.jpa.repository.Query("select s from WritingSessionEntity s where s.id = :id and s.userId = :userId")
    Optional<WritingSessionEntity> findOwnedForCompletion(@org.springframework.data.repository.query.Param("id") String id,
            @org.springframework.data.repository.query.Param("userId") Long userId);
    Optional<WritingSessionEntity> findByIdAndUserId(String id, Long userId);
    List<WritingSessionEntity> findByUserIdOrderByUpdatedAtDesc(Long userId);
    List<WritingSessionEntity> findByUserIdAndStageOrderByUpdatedAtDesc(Long userId, WritingSessionStage stage);
    List<WritingSessionEntity> findByUserIdAndStageNotOrderByUpdatedAtDesc(Long userId, WritingSessionStage stage);
    List<WritingSessionEntity> findByUserIdAndIsFavoriteTrueOrderByUpdatedAtDesc(Long userId);
    long countByUserIdAndStage(Long userId, WritingSessionStage stage);

    /** Sessions of one stage completed after an instant (weekly report: bounded by the week, not the whole history). */
    List<WritingSessionEntity> findByUserIdAndStageAndCompletedAtAfter(Long userId, WritingSessionStage stage, java.time.Instant after);
}
