package com.englishcoach.reading.repository;

import com.englishcoach.reading.entity.ReadingMaterial;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

@Repository
public interface ReadingMaterialRepository extends JpaRepository<ReadingMaterial, Long> {

    @Query("SELECT r FROM ReadingMaterial r WHERE (r.isSystem = true AND r.ownerUserId IS NULL) OR (r.isSystem = false AND :userId IS NOT NULL AND r.ownerUserId = :userId) ORDER BY r.createdAt DESC NULLS LAST, r.id DESC")
    List<ReadingMaterial> findVisibleToUser(@Param("userId") Long userId);

    @Query("SELECT r FROM ReadingMaterial r WHERE r.id = :id AND ((r.isSystem = true AND r.ownerUserId IS NULL) OR (r.isSystem = false AND :userId IS NOT NULL AND r.ownerUserId = :userId))")
    Optional<ReadingMaterial> findByIdAndVisibleToUser(@Param("id") Long id, @Param("userId") Long userId);

    Optional<ReadingMaterial> findByOwnerUserIdAndOriginFeedArticleId(Long ownerUserId, Long originFeedArticleId);

    @org.springframework.data.jpa.repository.Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = "DELETE FROM reading_materials WHERE id = :id", nativeQuery = true)
    void deleteByIdNative(@Param("id") Long id);
}
