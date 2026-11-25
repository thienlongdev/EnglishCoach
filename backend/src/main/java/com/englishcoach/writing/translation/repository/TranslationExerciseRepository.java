package com.englishcoach.writing.translation.repository;

import com.englishcoach.writing.translation.entity.TranslationExerciseEntity;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationExerciseRepository extends JpaRepository<TranslationExerciseEntity, UUID>, JpaSpecificationExecutor<TranslationExerciseEntity> {

    Optional<TranslationExerciseEntity> findByIdAndActiveTrue(UUID id);

    long countByActiveTrue();

    long countByModeAndActiveTrue(String mode);

    @Query("SELECT DISTINCT e.topicCode FROM TranslationExerciseEntity e WHERE e.active = true AND (:mode IS NULL OR e.mode = :mode)")
    List<String> findDistinctActiveTopics(@Param("mode") String mode);

    @Query("SELECT DISTINCT e.difficultyBucket FROM TranslationExerciseEntity e WHERE e.active = true AND (:mode IS NULL OR e.mode = :mode)")
    List<String> findDistinctActiveDifficulties(@Param("mode") String mode);

    @Query("SELECT e.topicCode, COUNT(e) FROM TranslationExerciseEntity e WHERE e.active = true AND (:mode IS NULL OR e.mode = :mode) GROUP BY e.topicCode")
    List<Object[]> countByTopicGrouped(@Param("mode") String mode);

    @Query("SELECT e.difficultyBucket, COUNT(e) FROM TranslationExerciseEntity e WHERE e.active = true AND (:mode IS NULL OR e.mode = :mode) GROUP BY e.difficultyBucket")
    List<Object[]> countByDifficultyGrouped(@Param("mode") String mode);

    @Query("SELECT e.mode, e.topicCode, e.difficultyBucket, COUNT(e) FROM TranslationExerciseEntity e WHERE e.active = true GROUP BY e.mode, e.topicCode, e.difficultyBucket")
    List<Object[]> countCollectionsGrouped();

    @Query("SELECT e.id, e.mode, e.topicCode, e.difficultyBucket, e.cefrBand, COUNT(u.id) " +
           "FROM TranslationExerciseEntity e " +
           "JOIN TranslationExerciseUnitEntity u ON u.exerciseId = e.id " +
           "WHERE e.active = true AND u.active = true " +
           "GROUP BY e.id, e.mode, e.topicCode, e.difficultyBucket, e.cefrBand " +
           "HAVING COUNT(u.id) >= 3 " +
           "ORDER BY e.topicCode ASC, e.difficultyBucket ASC")
    List<Object[]> findEligibleSetsWithSentenceCount();

    @Query("SELECT MIN(e.id), e.topicCode, e.difficultyBucket, COUNT(DISTINCT e.id), COUNT(u.id) " +
           "FROM TranslationExerciseEntity e " +
           "JOIN TranslationExerciseUnitEntity u ON u.exerciseId = e.id " +
           "WHERE e.active = true AND u.active = true AND e.mode = 'SENTENCE' " +
           "GROUP BY e.topicCode, e.difficultyBucket " +
           "HAVING COUNT(u.id) >= 3 " +
           "ORDER BY COUNT(u.id) DESC, e.topicCode ASC")
    List<Object[]> findEligibleTopicPools();

    @Query("SELECT e FROM TranslationExerciseEntity e WHERE e.active = true " +
           "AND (:mode IS NULL OR e.mode = :mode) " +
           "AND (:topicCode IS NULL OR e.topicCode = :topicCode) " +
           "AND (:difficultyBucket IS NULL OR e.difficultyBucket = :difficultyBucket) " +
           "ORDER BY e.randomBucket ASC, e.id ASC")
    List<TranslationExerciseEntity> findAllActiveCandidates(
            @Param("mode") String mode,
            @Param("topicCode") String topicCode,
            @Param("difficultyBucket") String difficultyBucket
    );

    @Query("SELECT e FROM TranslationExerciseEntity e WHERE e.active = true " +
           "AND (:mode IS NULL OR e.mode = :mode) " +
           "AND (:topicCode IS NULL OR e.topicCode = :topicCode) " +
           "AND (:difficultyBucket IS NULL OR e.difficultyBucket = :difficultyBucket) " +
           "AND e.randomBucket >= :startBucket " +
           "ORDER BY e.randomBucket ASC, e.id ASC")
    List<TranslationExerciseEntity> findCandidatesGteBucket(
            @Param("mode") String mode,
            @Param("topicCode") String topicCode,
            @Param("difficultyBucket") String difficultyBucket,
            @Param("startBucket") short startBucket,
            Pageable pageable
    );

    @Query("SELECT e FROM TranslationExerciseEntity e WHERE e.active = true " +
           "AND (:mode IS NULL OR e.mode = :mode) " +
           "AND (:topicCode IS NULL OR e.topicCode = :topicCode) " +
           "AND (:difficultyBucket IS NULL OR e.difficultyBucket = :difficultyBucket) " +
           "AND e.randomBucket < :startBucket " +
           "ORDER BY e.randomBucket ASC, e.id ASC")
    List<TranslationExerciseEntity> findCandidatesLtBucket(
            @Param("mode") String mode,
            @Param("topicCode") String topicCode,
            @Param("difficultyBucket") String difficultyBucket,
            @Param("startBucket") short startBucket,
            Pageable pageable
    );
}
