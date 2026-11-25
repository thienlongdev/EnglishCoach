package com.englishcoach.listening.repository;

import com.englishcoach.listening.entity.ListeningExercise;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface ListeningExerciseRepository extends JpaRepository<ListeningExercise, Long> {

    /** [materialId, dictation exercise count] for the given materials (one statement for the start-up reconciliation). */
    @Query("SELECT e.listeningMaterial.id, COUNT(e) FROM ListeningExercise e WHERE e.listeningMaterial.id IN :ids AND e.exerciseType = com.englishcoach.listening.entity.enums.ExerciseType.DICTATION GROUP BY e.listeningMaterial.id")
    List<Object[]> countDictationExercisesByMaterialIds(@Param("ids") java.util.Collection<Long> ids);

    /** [materialId, exercise count of any type] for the given materials. */
    @Query("SELECT e.listeningMaterial.id, COUNT(e) FROM ListeningExercise e WHERE e.listeningMaterial.id IN :ids GROUP BY e.listeningMaterial.id")
    List<Object[]> countExercisesByMaterialIds(@Param("ids") java.util.Collection<Long> ids);
    List<ListeningExercise> findByListeningMaterialId(Long listeningMaterialId);

    @Query("SELECT COUNT(e) FROM ListeningExercise e WHERE e.listeningMaterial.id = :materialId AND e.exerciseType = com.englishcoach.listening.entity.enums.ExerciseType.DICTATION")
    long countDictationExercisesByMaterialId(@Param("materialId") Long materialId);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = "DELETE FROM listening_exercises WHERE listening_material_id = :materialId", nativeQuery = true)
    void deleteByListeningMaterialId(@Param("materialId") Long materialId);
}
