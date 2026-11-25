package com.englishcoach.reading.repository;

import com.englishcoach.reading.entity.DocumentHighlight;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface DocumentHighlightRepository extends JpaRepository<DocumentHighlight, Long> {

    List<DocumentHighlight> findByReadingMaterialId(Long readingMaterialId);

    List<DocumentHighlight> findByReadingMaterialIdAndUserId(Long readingMaterialId, Long userId);
}
