package com.englishcoach.speaking.repository;

import com.englishcoach.speaking.dto.ShadowingSegmentProgressDto;
import com.englishcoach.speaking.entity.SpeakingShadowingAttempt;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface SpeakingShadowingAttemptRepository extends JpaRepository<SpeakingShadowingAttempt, Long> {

    Optional<SpeakingShadowingAttempt> findBySessionIdAndClientAttemptId(Long sessionId, String clientAttemptId);

    Optional<SpeakingShadowingAttempt> findByClientAttemptId(String clientAttemptId);

    int countBySessionIdAndShadowingUnitId(Long sessionId, Long shadowingUnitId);

    List<SpeakingShadowingAttempt> findBySessionIdOrderByCreatedAtAsc(Long sessionId);

    @Query("SELECT new com.englishcoach.speaking.dto.ShadowingSegmentProgressDto(a.shadowingUnit.id, COUNT(a.id), MAX(a.accuracyScore)) " +
           "FROM SpeakingShadowingAttempt a " +
           "WHERE a.user.id = :userId AND a.shadowingUnit.material.id = :materialId " +
           "AND a.shadowingUnit.generationVersion = :generationVersion " +
           "AND (a.isMocked = false OR a.isMocked IS NULL) " +
           "GROUP BY a.shadowingUnit.id")
    List<ShadowingSegmentProgressDto> getUnitProgressByMaterial(
            @Param("userId") Long userId,
            @Param("materialId") Long materialId,
            @Param("generationVersion") Integer generationVersion
    );

    @Query("SELECT new com.englishcoach.speaking.dto.ShadowingSegmentProgressDto(a.shadowingUnit.id, COUNT(a.id), MAX(a.accuracyScore)) " +
           "FROM SpeakingShadowingAttempt a " +
           "WHERE a.session.id = :sessionId AND a.shadowingUnit IS NOT NULL " +
           "AND a.shadowingUnit.generationVersion = :generationVersion " +
           "AND (a.isMocked = false OR a.isMocked IS NULL) " +
           "GROUP BY a.shadowingUnit.id")
    List<ShadowingSegmentProgressDto> getUnitProgressBySession(
            @Param("sessionId") Long sessionId,
            @Param("generationVersion") Integer generationVersion
    );

    List<SpeakingShadowingAttempt> findByUserIdOrderByCreatedAtAsc(Long userId);

    List<SpeakingShadowingAttempt> findByUserIdAndCreatedAtAfterOrderByCreatedAtAsc(Long userId, java.time.LocalDateTime since);

    @Query("SELECT a FROM SpeakingShadowingAttempt a WHERE a.user.id = :userId AND (a.isMocked IS NULL OR a.isMocked = false) AND a.createdAt >= :since ORDER BY a.createdAt DESC")
    List<SpeakingShadowingAttempt> findRecentAttemptsByUserId(@Param("userId") Long userId, @Param("since") java.time.LocalDateTime since, org.springframework.data.domain.Pageable pageable);

    List<SpeakingShadowingAttempt> findBySessionIdIn(List<Long> sessionIds);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("UPDATE SpeakingShadowingAttempt a SET a.shadowingUnit = :newUnit WHERE a.shadowingUnit = :oldUnit")
    int remapUnitAttempts(
            @Param("oldUnit") com.englishcoach.speaking.entity.SpeakingShadowingUnit oldUnit,
            @Param("newUnit") com.englishcoach.speaking.entity.SpeakingShadowingUnit newUnit
    );

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = "DELETE FROM speaking_shadowing_attempts a WHERE " +
           "a.shadowing_unit_id IN (SELECT u.id FROM speaking_shadowing_units u WHERE u.material_id = :materialId) " +
           "OR a.segment_id IN (SELECT s.id FROM transcript_segments s WHERE s.listening_material_id = :materialId)", nativeQuery = true)
    int deleteByMaterialId(@Param("materialId") Long materialId);
}
