package com.englishcoach.writing.translation.paragraph.repository;

import com.englishcoach.writing.translation.paragraph.entity.TranslationParagraphSourceEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationParagraphSourceRepository extends JpaRepository<TranslationParagraphSourceEntity, UUID> {
    Optional<TranslationParagraphSourceEntity> findBySourceCodeAndSourceRelease(String sourceCode, String sourceRelease);
}
