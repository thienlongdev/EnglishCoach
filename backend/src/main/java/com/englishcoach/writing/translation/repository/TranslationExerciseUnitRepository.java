package com.englishcoach.writing.translation.repository;

import com.englishcoach.writing.translation.entity.TranslationExerciseUnitEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationExerciseUnitRepository extends JpaRepository<TranslationExerciseUnitEntity, UUID> {
    List<TranslationExerciseUnitEntity> findByExerciseIdOrderByOrdinalAsc(UUID exerciseId);
    List<TranslationExerciseUnitEntity> findByExerciseIdAndActiveTrueOrderByOrdinalAsc(UUID exerciseId);
    Optional<TranslationExerciseUnitEntity> findByExerciseIdAndOrdinal(UUID exerciseId, short ordinal);
}
