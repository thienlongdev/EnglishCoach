package com.englishcoach.flashcard.pvp.repository;

import com.englishcoach.flashcard.pvp.entity.PvpPlayerStats;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface PvpPlayerStatsRepository extends JpaRepository<PvpPlayerStats, Long> {

    List<PvpPlayerStats> findByMatchId(Long matchId);

    List<PvpPlayerStats> findByUserId(Long userId);
}
