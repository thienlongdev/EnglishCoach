package com.englishcoach.writing.translation.paragraph.repository;

import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphAttemptEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationParagraphAttemptRepository extends JpaRepository<TranslationParagraphAttemptEntity, UUID> {

    Optional<TranslationParagraphAttemptEntity> findByUserIdAndClientMutationId(Long userId, String clientMutationId);

    List<TranslationParagraphAttemptEntity> findBySessionItemIdOrderByAttemptOrdinalDesc(UUID sessionItemId);

    Optional<TranslationParagraphAttemptEntity> findFirstBySessionItemIdOrderByAttemptOrdinalDesc(UUID sessionItemId);

    @Query("SELECT COALESCE(MAX(a.attemptOrdinal), 0) FROM TranslationParagraphAttemptEntity a WHERE a.sessionItemId = :sessionItemId")
    Integer findMaxAttemptOrdinalBySessionItemId(@Param("sessionItemId") UUID sessionItemId);
}
