package com.englishcoach.writing.translation.paragraph.repository;

import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphInFlightEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationParagraphInFlightRepository extends JpaRepository<TranslationParagraphInFlightEntity, UUID> {

    Optional<TranslationParagraphInFlightEntity> findByFlightKey(String flightKey);

    void deleteByFlightKey(String flightKey);

    @Modifying
    @Query("DELETE FROM TranslationParagraphInFlightEntity f WHERE f.expiresAt < :now")
    int deleteExpired(@Param("now") Instant now);
}
