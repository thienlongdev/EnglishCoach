package com.englishcoach.flashcard.repository;

import com.englishcoach.flashcard.entity.VocabDeck;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface VocabDeckRepository extends JpaRepository<VocabDeck, Long> {

    Optional<VocabDeck> findBySlug(String slug);

    boolean existsBySlug(String slug);

    List<VocabDeck> findAllByOrderBySortOrderAsc();

    List<VocabDeck> findByIsSystemTrueOrderBySortOrderAsc();

    List<VocabDeck> findByCategoryOrderBySortOrderAsc(String category);
}
