package com.englishcoach.writing.translation.repository;

import com.englishcoach.writing.translation.entity.TranslationSessionUnitEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationSessionUnitRepository extends JpaRepository<TranslationSessionUnitEntity, UUID> {
    List<TranslationSessionUnitEntity> findBySessionIdOrderByUnitOrdinalAsc(UUID sessionId);
    Optional<TranslationSessionUnitEntity> findBySessionIdAndUnitId(UUID sessionId, UUID unitId);
    Optional<TranslationSessionUnitEntity> findBySessionIdAndUnitOrdinal(UUID sessionId, short unitOrdinal);
}
