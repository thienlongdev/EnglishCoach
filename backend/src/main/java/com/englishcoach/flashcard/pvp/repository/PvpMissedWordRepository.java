package com.englishcoach.flashcard.pvp.repository;

import com.englishcoach.flashcard.pvp.entity.PvpMissedWord;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface PvpMissedWordRepository extends JpaRepository<PvpMissedWord, Long> {

    List<PvpMissedWord> findByMatchId(Long matchId);

    List<PvpMissedWord> findByUserIdAndMatchId(Long userId, Long matchId);

    List<PvpMissedWord> findByUserIdOrderByMissedAtDesc(Long userId);
}
