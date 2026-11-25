package com.englishcoach.writing.translation.repository;

import com.englishcoach.writing.translation.entity.TranslationSessionEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationSessionRepository extends JpaRepository<TranslationSessionEntity, UUID> {
    Optional<TranslationSessionEntity> findByIdAndUserId(UUID id, Long userId);

    /** The owner's session, row-locked until the transaction ends (attempts of one session are written one at a time). */
    @org.springframework.data.jpa.repository.Lock(jakarta.persistence.LockModeType.PESSIMISTIC_WRITE)
    @org.springframework.data.jpa.repository.Query("SELECT s FROM TranslationSessionEntity s WHERE s.id = :id AND s.userId = :userId")
    Optional<TranslationSessionEntity> findOwnedForUpdate(@org.springframework.data.repository.query.Param("id") UUID id,
                                                          @org.springframework.data.repository.query.Param("userId") Long userId);
    Optional<TranslationSessionEntity> findByUserIdAndExerciseIdAndStatus(Long userId, UUID exerciseId, String status);
    Optional<TranslationSessionEntity> findFirstByUserIdAndStatusOrderByUpdatedAtDesc(Long userId, String status);
    Optional<TranslationSessionEntity> findByUserIdAndClientMutationId(Long userId, String clientMutationId);

    @org.springframework.data.jpa.repository.Query("SELECT DISTINCT s.exerciseId FROM TranslationSessionEntity s WHERE s.userId = :userId AND s.status = 'COMPLETED'")
    java.util.List<UUID> findCompletedExerciseIdsByUserId(@org.springframework.data.repository.query.Param("userId") Long userId);
}
