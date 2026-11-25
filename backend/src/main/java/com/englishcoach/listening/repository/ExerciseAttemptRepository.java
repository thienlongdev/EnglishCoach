package com.englishcoach.listening.repository;

import com.englishcoach.listening.dto.SegmentHeatmapDto;
import com.englishcoach.listening.entity.ExerciseAttempt;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface ExerciseAttemptRepository extends JpaRepository<ExerciseAttempt, Long> {

    /** [sessionId, distinct exercises attempted] for the given sessions (one statement for the start-up reconciliation). */
    @Query("SELECT a.listeningSession.id, COUNT(DISTINCT a.listeningExercise.id) FROM ExerciseAttempt a WHERE a.listeningSession.id IN :ids AND (a.listeningExercise.exerciseType = com.englishcoach.listening.entity.enums.ExerciseType.DICTATION OR NOT EXISTS (SELECT e.id FROM ListeningExercise e WHERE e.listeningMaterial = a.listeningSession.listeningMaterial AND e.exerciseType = com.englishcoach.listening.entity.enums.ExerciseType.DICTATION)) GROUP BY a.listeningSession.id")
    List<Object[]> countDistinctExercisesAttemptedBySessionIds(@Param("ids") java.util.Collection<Long> ids);

    @Query("SELECT new com.englishcoach.listening.dto.SegmentHeatmapDto(e.transcriptSegment.id, AVG(a.accuracyPercentage)) "
            +
            "FROM ExerciseAttempt a " +
            "JOIN a.listeningExercise e " +
            "JOIN a.listeningSession s " +
            "WHERE s.user.id = :userId AND e.listeningMaterial.id = :materialId AND e.transcriptSegment IS NOT NULL " +
            "GROUP BY e.transcriptSegment.id")
    List<SegmentHeatmapDto> getSegmentAccuracyHeatmap(@Param("userId") Long userId,
            @Param("materialId") Long materialId);

    List<ExerciseAttempt> findByListeningExerciseId(Long exerciseId);

    List<ExerciseAttempt> findByListeningSessionId(Long sessionId);

    @Query("SELECT COUNT(a) FROM ExerciseAttempt a JOIN a.listeningSession s WHERE s.user.id = :userId")
    long countByUserId(@Param("userId") Long userId);

    @Query("SELECT COUNT(a) FROM ExerciseAttempt a JOIN a.listeningSession s WHERE s.user.id = :userId AND s.endedAt IS NOT NULL")
    long countAttemptsInCompletedSessionsByUserId(@Param("userId") Long userId);

    @Query("SELECT COUNT(a) FROM ExerciseAttempt a JOIN a.listeningSession s JOIN a.listeningExercise e WHERE s.user.id = :userId AND e.exerciseType = com.englishcoach.listening.entity.enums.ExerciseType.DICTATION AND (a.isCorrect = true OR a.accuracyPercentage >= 80.0)")
    long countCompletedDictationsByUserId(@Param("userId") Long userId);

    @Query("SELECT COUNT(DISTINCT a.listeningExercise.id) FROM ExerciseAttempt a WHERE a.listeningSession.id = :sessionId AND (a.listeningExercise.exerciseType = com.englishcoach.listening.entity.enums.ExerciseType.DICTATION OR NOT EXISTS (SELECT e.id FROM ListeningExercise e WHERE e.listeningMaterial = a.listeningSession.listeningMaterial AND e.exerciseType = com.englishcoach.listening.entity.enums.ExerciseType.DICTATION))")
    long countDistinctExercisesAttemptedBySessionId(@Param("sessionId") Long sessionId);

    @Query("SELECT a FROM ExerciseAttempt a JOIN FETCH a.listeningExercise e WHERE a.listeningSession.user.id = :userId ORDER BY a.id DESC")
    List<ExerciseAttempt> findRecentAttemptsWithExerciseByUserId(@Param("userId") Long userId, org.springframework.data.domain.Pageable pageable);

    @Query("SELECT a FROM ExerciseAttempt a JOIN FETCH a.listeningExercise e JOIN a.listeningSession s WHERE s.user.id = :userId AND s.endedAt IS NOT NULL ORDER BY a.id DESC")
    List<ExerciseAttempt> findAttemptsInCompletedSessionsWithExerciseByUserId(@Param("userId") Long userId);

    @org.springframework.data.jpa.repository.Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = "DELETE FROM exercise_attempts WHERE listening_exercise_id IN (SELECT id FROM listening_exercises WHERE listening_material_id = :materialId) OR listening_session_id IN (SELECT id FROM listening_sessions WHERE listening_material_id = :materialId)", nativeQuery = true)
    void deleteByListeningMaterialId(@Param("materialId") Long materialId);
}
