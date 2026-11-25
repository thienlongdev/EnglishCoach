package com.englishcoach.writing.translation.paragraph.repository;

import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphSessionEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationParagraphSessionRepository extends JpaRepository<TranslationParagraphSessionEntity, UUID> {

    Optional<TranslationParagraphSessionEntity> findByUserIdAndClientMutationId(Long userId, String clientMutationId);

    Optional<TranslationParagraphSessionEntity> findFirstByUserIdAndStatusOrderByUpdatedAtDesc(Long userId, String status);

    Optional<TranslationParagraphSessionEntity> findFirstByUserIdAndStatusInOrderByUpdatedAtDesc(Long userId, java.util.Collection<String> statuses);

    Optional<TranslationParagraphSessionEntity> findByIdAndUserId(UUID id, Long userId);
}
