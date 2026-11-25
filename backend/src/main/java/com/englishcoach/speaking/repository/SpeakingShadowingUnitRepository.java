package com.englishcoach.speaking.repository;

import com.englishcoach.speaking.entity.SpeakingShadowingUnit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface SpeakingShadowingUnitRepository extends JpaRepository<SpeakingShadowingUnit, Long> {

    List<SpeakingShadowingUnit> findByMaterialIdOrderBySequenceNumberAsc(Long materialId);

    List<SpeakingShadowingUnit> findByMaterialIdAndGenerationVersionOrderBySequenceNumberAsc(
            Long materialId,
            Integer generationVersion
    );

    Optional<SpeakingShadowingUnit> findByMaterialIdAndSequenceNumber(Long materialId, Integer sequenceNumber);

    long countByMaterialId(Long materialId);

    @org.springframework.data.jpa.repository.Modifying(clearAutomatically = true, flushAutomatically = true)
    @org.springframework.data.jpa.repository.Query(value = "DELETE FROM speaking_shadowing_units WHERE material_id = :materialId", nativeQuery = true)
    void deleteByMaterialId(@org.springframework.data.repository.query.Param("materialId") Long materialId);
}
