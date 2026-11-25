package com.englishcoach.listening.repository;

import com.englishcoach.listening.entity.TranscriptSegment;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

public interface TranscriptSegmentRepository extends JpaRepository<TranscriptSegment, Long> {
    List<TranscriptSegment> findByListeningMaterialIdOrderByStartTimeMsAsc(Long materialId);
    boolean existsByListeningMaterialId(Long materialId);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = "DELETE FROM transcript_segments WHERE listening_material_id = :materialId", nativeQuery = true)
    void deleteByListeningMaterialId(@Param("materialId") Long materialId);
}
