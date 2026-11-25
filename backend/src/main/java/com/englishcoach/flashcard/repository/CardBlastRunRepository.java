package com.englishcoach.flashcard.repository;

import com.englishcoach.flashcard.entity.CardBlastRun;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface CardBlastRunRepository extends JpaRepository<CardBlastRun, Long> {
    List<CardBlastRun> findByUserIdOrderByCreatedAtDesc(Long userId);
    List<CardBlastRun> findByUserIdAndDeckIdOrderByCreatedAtDesc(Long userId, Long deckId);
}
