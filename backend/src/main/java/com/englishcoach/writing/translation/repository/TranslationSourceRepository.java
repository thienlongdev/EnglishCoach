package com.englishcoach.writing.translation.repository;

import com.englishcoach.writing.translation.entity.TranslationSourceEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface TranslationSourceRepository extends JpaRepository<TranslationSourceEntity, UUID> {
    Optional<TranslationSourceEntity> findBySourceCodeAndReleaseVersionAndChecksumSha256(
            String sourceCode, String releaseVersion, String checksumSha256
    );
}
