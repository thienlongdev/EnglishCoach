package com.englishcoach.writing.translation.paragraph.repository;

import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphPassageEntity;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationParagraphPassageRepository extends JpaRepository<TranslationParagraphPassageEntity, UUID> {

    /**
     * Canonical Central Eligibility Predicate constants.
     * Guaranteed single source of truth for both catalog availability and session selection.
     */
    String ELIGIBILITY_WHERE = """
            WHERE d.provenanceComplete = true
              AND d.originalOrderProven = true
              AND d.publicationState NOT IN ('WITHDRAWN', 'BLOCKED')
              AND s.publicationState NOT IN ('WITHDRAWN', 'BLOCKED')
              AND p.alignmentDecision IN ('ACCEPT', 'ACCEPTED')
              AND p.coherenceDecision IN ('ACCEPT', 'ACCEPTED')
              AND p.qualityDecision IN ('ACCEPT', 'ACCEPTED')
              AND p.rightsEligible = true
              AND p.rightsDecision IN ('ELIGIBLE', 'ACCEPT', 'ACCEPTED')
              AND p.canonicalContent = true
              AND p.publicationState IN ('APPROVED', 'STAGED', 'ELIGIBLE')
              AND p.publicationState NOT IN ('WITHDRAWN', 'BLOCKED')
              AND p.contentVersion > 0
            """;

    @Query("SELECT COUNT(p) FROM TranslationParagraphPassageEntity p JOIN p.document d JOIN d.source s " + ELIGIBILITY_WHERE)
    long countEligiblePassages();

    @Query("SELECT COUNT(p) FROM TranslationParagraphPassageEntity p JOIN p.document d JOIN d.source s "
            + ELIGIBILITY_WHERE
            + " AND (:genre IS NULL OR p.genre = :genre) "
            + " AND (:topic IS NULL OR p.topic = :topic)")
    long countEligiblePassagesByFilter(
            @Param("genre") String genre,
            @Param("topic") String topic
    );

    @Query("SELECT p.genre, COUNT(p) FROM TranslationParagraphPassageEntity p JOIN p.document d JOIN d.source s "
            + ELIGIBILITY_WHERE + " GROUP BY p.genre ORDER BY COUNT(p) DESC")
    List<Object[]> findEligibleGenreCounts();

    @Query("SELECT p.topic, COUNT(p) FROM TranslationParagraphPassageEntity p JOIN p.document d JOIN d.source s "
            + ELIGIBILITY_WHERE + " GROUP BY p.topic ORDER BY COUNT(p) DESC")
    List<Object[]> findEligibleTopicCounts();

    @Query("SELECT p.difficultyStatus, COUNT(p) FROM TranslationParagraphPassageEntity p JOIN p.document d JOIN d.source s "
            + ELIGIBILITY_WHERE + " GROUP BY p.difficultyStatus")
    List<Object[]> findEligibleDifficultyCounts();

    @Query("SELECT p FROM TranslationParagraphPassageEntity p JOIN p.document d JOIN d.source s "
            + ELIGIBILITY_WHERE
            + " AND (:genre IS NULL OR p.genre = :genre) "
            + " AND (:topic IS NULL OR p.topic = :topic) "
            + " ORDER BY p.document.id ASC, p.passageOrdinal ASC, p.id ASC")
    List<TranslationParagraphPassageEntity> findEligiblePassages(
            @Param("genre") String genre,
            @Param("topic") String topic,
            Pageable pageable
    );

    @Query("SELECT p FROM TranslationParagraphPassageEntity p JOIN p.document d JOIN d.source s "
            + ELIGIBILITY_WHERE
            + " AND p.id = :passageId")
    Optional<TranslationParagraphPassageEntity> findEligibleById(@Param("passageId") UUID passageId);

    @Query("SELECT p FROM TranslationParagraphPassageEntity p JOIN p.document d JOIN d.source s "
            + ELIGIBILITY_WHERE
            + " AND (:genre IS NULL OR p.genre = :genre) "
            + " AND (:topic IS NULL OR p.topic = :topic) ")
    Page<TranslationParagraphPassageEntity> findEligiblePaged(
            @Param("genre") String genre,
            @Param("topic") String topic,
            Pageable pageable
    );

    public interface PassageSummaryProjection {
        UUID getId();
        String getGenre();
        String getTopic();
        String getDifficultyStatus();
        String getSourceVi();
        String getReferenceEn();
        String getSourceTitle();
        String getAttributionText();
        String getLicenseCode();
    }

    @Query(value = "SELECT p.id AS id, p.genre AS genre, p.topic AS topic, p.difficultyStatus AS difficultyStatus, "
            + "SUBSTRING(p.sourceVi, 1, 125) AS sourceVi, SUBSTRING(p.referenceEn, 1, 125) AS referenceEn, "
            + "d.sourceTitle AS sourceTitle, p.attributionText AS attributionText, p.licenseCode AS licenseCode "
            + "FROM TranslationParagraphPassageEntity p JOIN p.document d JOIN d.source s "
            + ELIGIBILITY_WHERE
            + " AND (:genre IS NULL OR p.genre = :genre) "
            + " AND (:topic IS NULL OR p.topic = :topic) ",
            countQuery = "SELECT COUNT(p) FROM TranslationParagraphPassageEntity p JOIN p.document d JOIN d.source s "
            + ELIGIBILITY_WHERE
            + " AND (:genre IS NULL OR p.genre = :genre) "
            + " AND (:topic IS NULL OR p.topic = :topic) ")
    Page<PassageSummaryProjection> findEligibleSummaryPaged(
            @Param("genre") String genre,
            @Param("topic") String topic,
            Pageable pageable
    );
}
