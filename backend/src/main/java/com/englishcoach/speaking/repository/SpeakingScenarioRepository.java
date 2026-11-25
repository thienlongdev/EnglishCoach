package com.englishcoach.speaking.repository;

import com.englishcoach.speaking.entity.SpeakingScenario;
import com.englishcoach.speaking.entity.enums.CefrLevel;
import com.englishcoach.speaking.entity.enums.ScenarioCategory;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface SpeakingScenarioRepository extends JpaRepository<SpeakingScenario, Long> {

    @Query("SELECT s FROM SpeakingScenario s WHERE " +
           "((s.isSystem = true AND s.ownerUserId IS NULL) OR (:userId IS NOT NULL AND s.ownerUserId = :userId)) AND " +
           "(:cefrLevel IS NULL OR s.cefrLevel = :cefrLevel) AND " +
           "(:category IS NULL OR s.category = :category) " +
           "ORDER BY s.id ASC")
    List<SpeakingScenario> findByFilters(
            @Param("userId") Long userId,
            @Param("cefrLevel") CefrLevel cefrLevel,
            @Param("category") ScenarioCategory category
    );

    default List<SpeakingScenario> findByFilters(CefrLevel cefrLevel, ScenarioCategory category) {
        return findByFilters(null, cefrLevel, category);
    }

    @Query("SELECT s.cefrLevel, COUNT(s) FROM SpeakingScenario s WHERE " +
           "((s.isSystem = true AND s.ownerUserId IS NULL) OR (:userId IS NOT NULL AND s.ownerUserId = :userId)) " +
           "GROUP BY s.cefrLevel")
    List<Object[]> countByCefrLevel(@Param("userId") Long userId);

    @Query("SELECT s.category, COUNT(s) FROM SpeakingScenario s WHERE " +
           "((s.isSystem = true AND s.ownerUserId IS NULL) OR (:userId IS NOT NULL AND s.ownerUserId = :userId)) " +
           "GROUP BY s.category")
    List<Object[]> countByCategory(@Param("userId") Long userId);

    @Query("SELECT COUNT(s) FROM SpeakingScenario s WHERE " +
           "((s.isSystem = true AND s.ownerUserId IS NULL) OR (:userId IS NOT NULL AND s.ownerUserId = :userId))")
    long countVisibleScenarios(@Param("userId") Long userId);

    @Query("SELECT s FROM SpeakingScenario s WHERE s.id = :id AND " +
           "((s.isSystem = true AND s.ownerUserId IS NULL) OR (:userId IS NOT NULL AND s.ownerUserId = :userId))")
    java.util.Optional<SpeakingScenario> findByIdAndAccessible(@Param("id") Long id, @Param("userId") Long userId);
}
