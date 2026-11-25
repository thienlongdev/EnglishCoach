package com.englishcoach.flashcard.pvp.repository;

import com.englishcoach.flashcard.pvp.entity.PvpMatch;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;

@Repository
public interface PvpMatchRepository extends JpaRepository<PvpMatch, Long> {

    List<PvpMatch> findByRoomCode(String roomCode);

    @Query("SELECT COUNT(m) FROM PvpMatch m WHERE m.isRanked = true " +
           "AND ((m.hostUserId = :u1 AND m.guestUserId = :u2) OR (m.hostUserId = :u2 AND m.guestUserId = :u1)) " +
           "AND m.endedAt >= :since")
    long countRankedMatchesBetweenPairSince(@Param("u1") Long u1, @Param("u2") Long u2, @Param("since") Instant since);
}
