package com.englishcoach.content.repository;

import com.englishcoach.content.entity.ContentVocabulary;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface ContentVocabularyRepository extends JpaRepository<ContentVocabulary, Long> {
    List<ContentVocabulary> findTop5ByContentTypeOrderByFrequencyDescIdAsc(String contentType);
    List<ContentVocabulary> findByContentTypeAndContentId(String contentType, Long contentId);

    @org.springframework.data.jpa.repository.Query("SELECT cv FROM ContentVocabulary cv WHERE cv.word IS NOT NULL AND TRIM(cv.word) != '' AND cv.meaning IS NOT NULL AND TRIM(cv.meaning) != '' ORDER BY cv.id ASC")
    List<ContentVocabulary> findAllEligibleDailyVocabulary();
}
