package com.englishcoach.vocabulary.repository;

import com.englishcoach.vocabulary.entity.VocabularyCourse;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface VocabularyCourseRepository extends JpaRepository<VocabularyCourse, Long> {

    @Query("SELECT c FROM VocabularyCourse c LEFT JOIN FETCH c.words WHERE c.id = :id")
    Optional<VocabularyCourse> findByIdWithWords(@Param("id") Long id);
}
