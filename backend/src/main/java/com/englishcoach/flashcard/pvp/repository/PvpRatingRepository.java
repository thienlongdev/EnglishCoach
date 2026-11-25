package com.englishcoach.flashcard.pvp.repository;

import com.englishcoach.flashcard.pvp.entity.PvpRating;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface PvpRatingRepository extends JpaRepository<PvpRating, Long> {
}
