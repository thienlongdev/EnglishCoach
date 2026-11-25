package com.englishcoach.writing.translation.repository;

import com.englishcoach.writing.translation.entity.TranslationAttemptEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationAttemptRepository extends JpaRepository<TranslationAttemptEntity, UUID> {
    Optional<TranslationAttemptEntity> findByUserIdAndClientMutationId(Long userId, String clientMutationId);
    List<TranslationAttemptEntity> findBySessionIdOrderByCreatedAtDesc(UUID sessionId);
    Optional<TranslationAttemptEntity> findFirstBySessionIdAndUnitOrdinalOrderByAttemptOrdinalDesc(UUID sessionId, short unitOrdinal);
    long countBySessionIdAndUnitOrdinal(UUID sessionId, short unitOrdinal);
}
