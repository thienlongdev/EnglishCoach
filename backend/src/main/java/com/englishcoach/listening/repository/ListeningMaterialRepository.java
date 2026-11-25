package com.englishcoach.listening.repository;

import com.englishcoach.listening.entity.ListeningMaterial;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;


public interface ListeningMaterialRepository extends JpaRepository<ListeningMaterial, Long> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT m FROM ListeningMaterial m WHERE m.id = :id")
    Optional<ListeningMaterial> findByIdForShadowingGeneration(@Param("id") Long id);

    @Query("SELECT m FROM ListeningMaterial m WHERE " +
            "(:cefrLevel IS NULL OR m.cefrLevel = :cefrLevel) AND " +
            "(:topic IS NULL OR m.topic = :topic) AND " +
            "(:accent IS NULL OR m.accent = :accent) ORDER BY m.id DESC")
    List<ListeningMaterial> findByFilters(
            @Param("cefrLevel") String cefrLevel,
            @Param("topic") String topic,
            @Param("accent") String accent);

    @Query("SELECT m FROM ListeningMaterial m WHERE " +
            "((m.isSystem = true AND m.ownerUserId IS NULL) OR (:userId IS NOT NULL AND m.ownerUserId = :userId)) AND " +
            "(:cefrLevel IS NULL OR m.cefrLevel = :cefrLevel) AND " +
            "(:topic IS NULL OR m.topic = :topic) AND " +
            "(:accent IS NULL OR m.accent = :accent) ORDER BY m.id DESC")
    List<ListeningMaterial> findVisibleByFilters(
            @Param("userId") Long userId,
            @Param("cefrLevel") String cefrLevel,
            @Param("topic") String topic,
            @Param("accent") String accent);

    @Query("SELECT m FROM ListeningMaterial m WHERE " +
            "m.isSystem = false AND m.ownerUserId = :userId AND " +
            "(:cefrLevel IS NULL OR m.cefrLevel = :cefrLevel) AND " +
            "(:topic IS NULL OR m.topic = :topic) AND " +
            "(:accent IS NULL OR m.accent = :accent) ORDER BY m.id DESC")
    List<ListeningMaterial> findUserMaterialsByFilters(
            @Param("userId") Long userId,
            @Param("cefrLevel") String cefrLevel,
            @Param("topic") String topic,
            @Param("accent") String accent);

    @Query("SELECT m FROM ListeningMaterial m WHERE m.id = :id AND ((m.isSystem = true AND m.ownerUserId IS NULL) OR (:userId IS NOT NULL AND m.ownerUserId = :userId))")
    Optional<ListeningMaterial> findByIdAndVisibleToUser(@Param("id") Long id, @Param("userId") Long userId);

    @Query("SELECT m FROM ListeningMaterial m WHERE m.isSystem = true AND m.ownerUserId IS NULL ORDER BY m.id ASC")
    List<ListeningMaterial> findByIsSystemTrueOrderByIdAsc();

    @Query("SELECT m FROM ListeningMaterial m WHERE m.isSystem = true AND m.ownerUserId IS NULL AND (m.youtubeVideoId = :videoId OR m.audioUrl LIKE CONCAT('%', :videoId, '%')) ORDER BY m.id ASC")
    List<ListeningMaterial> findSystemMaterialsByVideoId(@Param("videoId") String videoId);

    public interface LibraryMaterialRow {
        Long getId();
        String getTitle();
        String getChannel();
        String getTopic();
        String getCefrLevel();
        String getAccent();
        Integer getDurationSeconds();
        String getThumbnail();
        String getAudioUrl();
        String getYoutubeVideoId();
        Long getSegmentCount();
        Long getExerciseCount();
    }

    @Query(value = "SELECT " +
            "m.id AS id, " +
            "m.title AS title, " +
            "m.channel AS channel, " +
            "m.topic AS topic, " +
            "m.cefr_level AS cefrLevel, " +
            "m.accent AS accent, " +
            "m.duration_seconds AS durationSeconds, " +
            "m.thumbnail AS thumbnail, " +
            "m.audio_url AS audioUrl, " +
            "m.youtube_video_id AS youtubeVideoId, " +
            "COALESCE(s.segment_count, 0) AS segmentCount, " +
            "COALESCE(e.exercise_count, 0) AS exerciseCount " +
            "FROM listening_materials m " +
            "LEFT JOIN (SELECT listening_material_id, COUNT(*) AS segment_count " +
            "FROM transcript_segments GROUP BY listening_material_id) s ON s.listening_material_id = m.id " +
            "LEFT JOIN (SELECT listening_material_id, COUNT(*) AS exercise_count " +
            "FROM listening_exercises GROUP BY listening_material_id) e ON e.listening_material_id = m.id " +
            "WHERE m.is_system = true AND m.owner_user_id IS NULL " +
            "ORDER BY m.id ASC", nativeQuery = true)
    List<LibraryMaterialRow> findSharedLibraryRows();

    @Query("SELECT m FROM ListeningMaterial m " +
            "WHERE m.isSystem = true AND m.ownerUserId IS NULL " +
            "AND EXISTS (SELECT 1 FROM TranscriptSegment s WHERE s.listeningMaterial = m) " +
            "AND EXISTS (SELECT 1 FROM ListeningExercise e WHERE e.listeningMaterial = m) " +
            "ORDER BY m.id ASC")
    List<ListeningMaterial> findSystemMaterialsWithSegmentsAndExercises();

    @org.springframework.data.jpa.repository.Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = "DELETE FROM listening_materials WHERE id = :id", nativeQuery = true)
    void deleteByIdNative(@Param("id") Long id);
}
