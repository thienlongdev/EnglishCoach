package com.englishcoach.writing.repository;

import com.englishcoach.writing.entity.WritingProfileEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface WritingProfileRepository extends JpaRepository<WritingProfileEntity, Long> {
    Optional<WritingProfileEntity> findByUserId(Long userId);
}
