package com.englishcoach.writing.translation.repository;

import com.englishcoach.writing.translation.entity.TranslationMutationReceiptEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationMutationReceiptRepository extends JpaRepository<TranslationMutationReceiptEntity, UUID> {
    Optional<TranslationMutationReceiptEntity> findByUserIdAndClientMutationId(Long userId, String clientMutationId);
}
