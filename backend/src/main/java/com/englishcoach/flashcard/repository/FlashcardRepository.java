package com.englishcoach.flashcard.repository;

import com.englishcoach.flashcard.entity.Flashcard;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

@Repository
public interface FlashcardRepository extends JpaRepository<Flashcard, Long> {

    // Query only current learner rows. Latest is deterministic, even when two log timestamps coincide.
    @Query(value="""
        SELECT DISTINCT f.deck_id, r.quality FROM
          (SELECT DISTINCT ON (l.flashcard_id) l.flashcard_id,l.quality
           FROM public.flashcard_review_log l WHERE l.user_id=:userId
           ORDER BY l.flashcard_id,l.reviewed_at DESC,l.id DESC) r
        JOIN public.flashcards f ON f.id=r.flashcard_id
        WHERE f.user_id=:userId AND f.state=0
        ORDER BY f.deck_id,r.quality
        """,nativeQuery=true)
    List<Object[]> latestRatingsByDeck(@Param("userId") Long userId);

    String LAST_RATING_FROM = """
            FROM public.flashcards f JOIN public.dictionary_entries d ON d.id=f.dictionary_entry_id
            JOIN LATERAL (SELECT l.quality FROM public.flashcard_review_log l
                WHERE l.user_id=:userId AND l.flashcard_id=f.id
                ORDER BY l.reviewed_at DESC, l.id DESC LIMIT 1) last_rating ON last_rating.quality=:rating
            WHERE f.user_id=:userId AND f.state=0
              AND (CAST(:deckId AS bigint) IS NULL OR f.deck_id=:deckId)
              AND lower(d.word) LIKE lower(concat('%', :term, '%'))
            """;
    @Query(value="SELECT f.id " + LAST_RATING_FROM + " ORDER BY f.id DESC",
           countQuery="SELECT COUNT(*) " + LAST_RATING_FROM, nativeQuery=true)
    Page<Long> idsByLatestRating(@Param("userId") Long userId,@Param("deckId") Long deckId,
        @Param("rating") String rating,@Param("term") String term, Pageable pageable);

    @Query("SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry WHERE f.user.id=:userId AND f.id IN :ids ORDER BY f.id DESC")
    List<Flashcard> loadRatedPage(@Param("userId") Long userId,@Param("ids") List<Long> ids);

    // A game needs words and accepted translations, not hydrated DictionaryEntry
    // entities (whose eager meanings/examples cause many database round trips).
    interface PvPWordProjection {
        Long getId();
        String getWord();
        String getIpa();
        String getVietnamese();
        String getMeaning();
    }

    @Query(value = """
        SELECT d.id, d.word, d.ipa, d.general_translation_vi AS vietnamese, m.meaning
        FROM deck_dictionary_entries membership
        JOIN dictionary_entries d ON d.id = membership.dictionary_entry_id
        LEFT JOIN dictionary_meanings m ON m.dictionary_entry_id = d.id
        WHERE membership.deck_id = :deckId
        ORDER BY d.id, m.meaning
        """, nativeQuery = true)
    List<PvPWordProjection> findPvPWordsByDeckId(@Param("deckId") Long deckId);

    @Query(value = """
        SELECT d.id, d.word, d.ipa, d.general_translation_vi AS vietnamese, m.meaning
        FROM (SELECT dictionary_entry_id, id FROM flashcards
              WHERE user_id = :userId AND deck_id IS NULL AND state = 0
              ORDER BY id DESC LIMIT 60) personal
        JOIN dictionary_entries d ON d.id = personal.dictionary_entry_id
        LEFT JOIN dictionary_meanings m ON m.dictionary_entry_id = d.id
        ORDER BY personal.id DESC, m.meaning
        """, nativeQuery = true)
    List<PvPWordProjection> findPvPPersonalWords(@Param("userId") Long userId);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 ORDER BY f.id DESC",
        countQuery = "SELECT COUNT(f) FROM Flashcard f WHERE f.user.id = :userId AND f.state = 0"
    )
    Page<Flashcard> findByUserId(@Param("userId") Long userId, Pageable pageable);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%')) ORDER BY f.id DESC",
        countQuery = "SELECT COUNT(f) FROM Flashcard f JOIN f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%'))"
    )
    Page<Flashcard> findByUserIdAndFrontContainingIgnoreCase(
        @Param("userId") Long userId,
        @Param("search") String search,
        Pageable pageable);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND f.status = :status ORDER BY f.id DESC",
        countQuery = "SELECT COUNT(f) FROM Flashcard f WHERE f.user.id = :userId AND f.state = 0 AND f.status = :status"
    )
    Page<Flashcard> findByUserIdAndStatus(
        @Param("userId") Long userId,
        @Param("status") String status,
        Pageable pageable);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND f.status = :status AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%')) ORDER BY f.id DESC",
        countQuery = "SELECT COUNT(f) FROM Flashcard f JOIN f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND f.status = :status AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%'))"
    )
    Page<Flashcard> findByUserIdAndStatusAndWord(
        @Param("userId") Long userId,
        @Param("status") String status,
        @Param("search") String search,
        Pageable pageable);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND f.status IN :statuses ORDER BY f.id DESC",
        countQuery = "SELECT COUNT(f) FROM Flashcard f WHERE f.user.id = :userId AND f.state = 0 AND f.status IN :statuses"
    )
    Page<Flashcard> findByUserIdAndStatusIn(
        @Param("userId") Long userId,
        @Param("statuses") List<String> statuses,
        Pageable pageable);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND f.status IN :statuses AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%')) ORDER BY f.id DESC",
        countQuery = "SELECT COUNT(f) FROM Flashcard f JOIN f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND f.status IN :statuses AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%'))"
    )
    Page<Flashcard> findByUserIdAndStatusInAndWord(
        @Param("userId") Long userId,
        @Param("statuses") List<String> statuses,
        @Param("search") String search,
        Pageable pageable);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND f.status != 'MASTERED' AND (f.nextReviewDate IS NULL OR f.nextReviewDate <= CURRENT_TIMESTAMP) ORDER BY f.nextReviewDate ASC NULLS FIRST",
        countQuery = "SELECT COUNT(f) FROM Flashcard f WHERE f.user.id = :userId AND f.state = 0 AND f.status != 'MASTERED' AND (f.nextReviewDate IS NULL OR f.nextReviewDate <= CURRENT_TIMESTAMP)"
    )
    Page<Flashcard> findDueFlashcards(
        @Param("userId") Long userId,
        Pageable pageable);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND f.status != 'MASTERED' AND (f.nextReviewDate IS NULL OR f.nextReviewDate <= CURRENT_TIMESTAMP) AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%')) ORDER BY f.nextReviewDate ASC NULLS FIRST",
        countQuery = "SELECT COUNT(f) FROM Flashcard f JOIN f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND f.status != 'MASTERED' AND (f.nextReviewDate IS NULL OR f.nextReviewDate <= CURRENT_TIMESTAMP) AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%'))"
    )
    Page<Flashcard> findDueFlashcardsAndWord(
        @Param("userId") Long userId,
        @Param("search") String search,
        Pageable pageable);

    /**
     * Every card of the learner for one dictionary entry. Enrolling several decks that share a word, plus a personal
     * card, legitimately gives more than one, so this is a list (a single-result finder answered 500 for such words).
     */
    List<Flashcard> findByUserIdAndDictionaryEntryIdOrderByIdAsc(Long userId, Long dictionaryEntryId);

    /** The learner's card, row-locked for the rating transaction (a double submit waits instead of racing). */
    @org.springframework.data.jpa.repository.Lock(jakarta.persistence.LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT f FROM Flashcard f WHERE f.id = :id AND f.user.id = :userId")
    Optional<Flashcard> findOwnedForUpdate(@Param("id") Long id, @Param("userId") Long userId);

    /**
     * Targeted bulk update for Card Blast weak words — avoids loading all of a learner's flashcards into heap.
     * Explicitly updates {@code updatedAt} so {@link #countReviewDueByUserId} stays consistent with JPA entity saves.
     */
    @Modifying(clearAutomatically = false, flushAutomatically = true)
    @Query("""
        UPDATE Flashcard f
        SET f.status = 'LEARNED', f.nextReviewDate = :dueAt, f.updatedAt = :now
        WHERE f.user.id = :userId
          AND f.state = 0
          AND (f.id IN :weakIds OR f.dictionaryEntry.id IN :weakIds)
    """)
    int prioritizeWeakFlashcards(
        @Param("userId") Long userId,
        @Param("weakIds") Collection<Long> weakIds,
        @Param("dueAt") LocalDateTime dueAt,
        @Param("now") LocalDateTime now);

    // ==========================================
    // DECK-SCOPED QUERIES
    // ==========================================

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) ORDER BY f.id DESC",
        countQuery = "SELECT COUNT(f) FROM Flashcard f WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId)"
    )
    Page<Flashcard> findByUserIdAndDeckId(@Param("userId") Long userId, @Param("deckId") Long deckId, Pageable pageable);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%')) ORDER BY f.id DESC",
        countQuery = "SELECT COUNT(f) FROM Flashcard f JOIN f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%'))"
    )
    Page<Flashcard> findByUserIdAndDeckIdAndFrontContainingIgnoreCase(
        @Param("userId") Long userId,
        @Param("deckId") Long deckId,
        @Param("search") String search,
        Pageable pageable);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) AND f.status = :status ORDER BY f.id DESC",
        countQuery = "SELECT COUNT(f) FROM Flashcard f WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) AND f.status = :status"
    )
    Page<Flashcard> findByUserIdAndDeckIdAndStatus(
        @Param("userId") Long userId,
        @Param("deckId") Long deckId,
        @Param("status") String status,
        Pageable pageable);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) AND f.status = :status AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%')) ORDER BY f.id DESC",
        countQuery = "SELECT COUNT(f) FROM Flashcard f JOIN f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) AND f.status = :status AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%'))"
    )
    Page<Flashcard> findByUserIdAndDeckIdAndStatusAndWord(
        @Param("userId") Long userId,
        @Param("deckId") Long deckId,
        @Param("status") String status,
        @Param("search") String search,
        Pageable pageable);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) AND f.status IN :statuses ORDER BY f.id DESC",
        countQuery = "SELECT COUNT(f) FROM Flashcard f WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) AND f.status IN :statuses"
    )
    Page<Flashcard> findByUserIdAndDeckIdAndStatusIn(
        @Param("userId") Long userId,
        @Param("deckId") Long deckId,
        @Param("statuses") List<String> statuses,
        Pageable pageable);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) AND f.status IN :statuses AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%')) ORDER BY f.id DESC",
        countQuery = "SELECT COUNT(f) FROM Flashcard f JOIN f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) AND f.status IN :statuses AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%'))"
    )
    Page<Flashcard> findByUserIdAndDeckIdAndStatusInAndWord(
        @Param("userId") Long userId,
        @Param("deckId") Long deckId,
        @Param("statuses") List<String> statuses,
        @Param("search") String search,
        Pageable pageable);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) AND f.status != 'MASTERED' AND (f.nextReviewDate IS NULL OR f.nextReviewDate <= CURRENT_TIMESTAMP) ORDER BY f.nextReviewDate ASC NULLS FIRST",
        countQuery = "SELECT COUNT(f) FROM Flashcard f WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) AND f.status != 'MASTERED' AND (f.nextReviewDate IS NULL OR f.nextReviewDate <= CURRENT_TIMESTAMP)"
    )
    Page<Flashcard> findDueFlashcardsByDeckId(
        @Param("userId") Long userId,
        @Param("deckId") Long deckId,
        Pageable pageable);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) AND f.status != 'MASTERED' AND (f.nextReviewDate IS NULL OR f.nextReviewDate <= CURRENT_TIMESTAMP) AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%')) ORDER BY f.nextReviewDate ASC NULLS FIRST",
        countQuery = "SELECT COUNT(f) FROM Flashcard f JOIN f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND ((:deckId IS NULL AND f.deck IS NULL) OR f.deck.id = :deckId) AND f.status != 'MASTERED' AND (f.nextReviewDate IS NULL OR f.nextReviewDate <= CURRENT_TIMESTAMP) AND LOWER(d.word) LIKE LOWER(CONCAT('%', :search, '%'))"
    )
    Page<Flashcard> findDueFlashcardsAndWordByDeckId(
        @Param("userId") Long userId,
        @Param("deckId") Long deckId,
        @Param("search") String search,
        Pageable pageable);

    @Query("SELECT f FROM Flashcard f WHERE f.user.id = :userId AND f.deck.id = :deckId")
    List<Flashcard> findByUserIdAndDeckId(@Param("userId") Long userId, @Param("deckId") Long deckId);

    @Query("SELECT f FROM Flashcard f WHERE f.user.id = :userId AND f.deck.id = :deckId AND f.dictionaryEntry.id = :dictionaryEntryId")
    Optional<Flashcard> findByUserIdAndDeckIdAndDictionaryEntryId(
        @Param("userId") Long userId,
        @Param("deckId") Long deckId,
        @Param("dictionaryEntryId") Long dictionaryEntryId);

    @Query(value = "SELECT dictionary_entry_id FROM deck_dictionary_entries WHERE deck_id = :deckId ORDER BY sort_order ASC", nativeQuery = true)
    List<Long> findDictionaryEntryIdsByDeckId(@Param("deckId") Long deckId);

    @Query(value = "SELECT COUNT(*) FROM deck_dictionary_entries WHERE deck_id = :deckId", nativeQuery = true)
    long countDeckDictionaryEntriesByDeckId(@Param("deckId") Long deckId);

    @Query(value = "SELECT deck_id, COUNT(*) FROM deck_dictionary_entries GROUP BY deck_id", nativeQuery = true)
    List<Object[]> countDeckDictionaryEntriesGrouped();

    public interface FlashcardStatsProjection {
        Long getTotalCards();
        Long getDueCards();
        Long getLearningCards();
        Long getMasteredCards();
    }

    @Query("""
        SELECT
            COUNT(f) AS totalCards,
            COALESCE(SUM(CASE WHEN f.status != 'MASTERED' AND (f.nextReviewDate IS NULL OR f.nextReviewDate <= CURRENT_TIMESTAMP) THEN 1L ELSE 0L END), 0L) AS dueCards,
            COALESCE(SUM(CASE WHEN f.status = 'MASTERED' THEN 1L ELSE 0L END), 0L) AS masteredCards,
            COALESCE(SUM(CASE WHEN f.status IN ('LEARNED', 'NEW') THEN 1L ELSE 0L END), 0L) AS learningCards
        FROM Flashcard f
        WHERE f.user.id = :userId AND f.state = 0
    """)
    FlashcardStatsProjection getStatsByUserId(@Param("userId") Long userId);

    @Query("""
        SELECT
            COUNT(f) AS totalCards,
            COALESCE(SUM(CASE WHEN f.status != 'MASTERED' AND (f.nextReviewDate IS NULL OR f.nextReviewDate <= CURRENT_TIMESTAMP) THEN 1L ELSE 0L END), 0L) AS dueCards,
            COALESCE(SUM(CASE WHEN f.status = 'MASTERED' THEN 1L ELSE 0L END), 0L) AS masteredCards,
            COALESCE(SUM(CASE WHEN f.status = 'LEARNED' THEN 1L ELSE 0L END), 0L) AS learningCards
        FROM Flashcard f
        WHERE f.user.id = :userId AND f.state = 0 AND f.deck.id = :deckId
    """)
    FlashcardStatsProjection getStatsByUserIdAndDeckId(@Param("userId") Long userId, @Param("deckId") Long deckId);

    public interface DeckStatsProjection {
        Long getDeckId();
        Long getTotalCards();
        Long getDueCards();
        Long getMasteredCards();
        Long getLearningCards();
        Long getReviewedCards();
    }

    @Query("""
        SELECT
            f.deck.id AS deckId,
            COUNT(f) AS totalCards,
            COALESCE(SUM(CASE WHEN f.status != 'MASTERED' AND (f.nextReviewDate IS NULL OR f.nextReviewDate <= CURRENT_TIMESTAMP) THEN 1L ELSE 0L END), 0L) AS dueCards,
            COALESCE(SUM(CASE WHEN f.status = 'MASTERED' THEN 1L ELSE 0L END), 0L) AS masteredCards,
            COALESCE(SUM(CASE WHEN f.status = 'LEARNED' THEN 1L ELSE 0L END), 0L) AS learningCards,
            COALESCE(SUM(CASE WHEN (f.reviewCount > 0 OR f.status = 'MASTERED') THEN 1L ELSE 0L END), 0L) AS reviewedCards
        FROM Flashcard f
        WHERE f.user.id = :userId AND f.state = 0
        GROUP BY f.deck.id
    """)
    List<DeckStatsProjection> getDeckStatsByUserId(@Param("userId") Long userId);

    @Query("""
        SELECT
            COUNT(f) AS totalCards,
            COALESCE(SUM(CASE WHEN f.status != 'MASTERED' AND (f.nextReviewDate IS NULL OR f.nextReviewDate <= CURRENT_TIMESTAMP) THEN 1L ELSE 0L END), 0L) AS dueCards,
            COALESCE(SUM(CASE WHEN f.status = 'MASTERED' THEN 1L ELSE 0L END), 0L) AS masteredCards,
            COALESCE(SUM(CASE WHEN f.status = 'LEARNED' THEN 1L ELSE 0L END), 0L) AS learningCards,
            COALESCE(SUM(CASE WHEN (f.reviewCount > 0 OR f.status = 'MASTERED') THEN 1L ELSE 0L END), 0L) AS reviewedCards
        FROM Flashcard f
        WHERE f.user.id = :userId AND f.state = 0 AND f.deck.id = :deckId
    """)
    DeckStatsProjection getDeckStatsByUserIdAndDeckId(@Param("userId") Long userId, @Param("deckId") Long deckId);

    @Query("SELECT COUNT(f) FROM Flashcard f WHERE f.user.id = :userId AND f.state = 0 AND f.status != 'MASTERED' AND (f.nextReviewDate IS NULL OR f.nextReviewDate <= CURRENT_TIMESTAMP)")
    long countCriticalForgettingByUserId(@Param("userId") Long userId);

    @Query("SELECT COUNT(f) FROM Flashcard f WHERE f.user.id = :userId AND f.state = 0 AND f.status = :status")
    long countByUserIdAndStatus(@Param("userId") Long userId, @Param("status") String status);

    @Query("SELECT COUNT(f) FROM Flashcard f WHERE f.user.id = :userId AND f.state = 0 AND f.status != 'MASTERED' AND (f.nextReviewDate IS NULL OR f.nextReviewDate <= CURRENT_TIMESTAMP)")
    long countDueByUserId(@Param("userId") Long userId);

    /**
     * Review-due cards: already studied (LEARNED), due now, and not reviewed since {@code dayStart} (the start of the
     * learner's local day). What the daily reminder counts and the reminder's review list shows: cards whose due day has
     * come from earlier learning, never NEW cards and never a card rated Khó in today's session.
     */
    @Query("SELECT COUNT(f) FROM Flashcard f WHERE f.user.id = :userId AND f.state = 0 AND f.status = 'LEARNED' AND f.nextReviewDate <= CURRENT_TIMESTAMP AND (f.updatedAt IS NULL OR f.updatedAt < :dayStart)")
    long countReviewDueByUserId(@Param("userId") Long userId, @Param("dayStart") java.time.LocalDateTime dayStart);

    @Query(
        value = "SELECT f FROM Flashcard f JOIN FETCH f.dictionaryEntry d WHERE f.user.id = :userId AND f.state = 0 AND f.status = 'LEARNED' AND f.nextReviewDate <= CURRENT_TIMESTAMP AND (f.updatedAt IS NULL OR f.updatedAt < :dayStart) ORDER BY f.nextReviewDate ASC",
        countQuery = "SELECT COUNT(f) FROM Flashcard f WHERE f.user.id = :userId AND f.state = 0 AND f.status = 'LEARNED' AND f.nextReviewDate <= CURRENT_TIMESTAMP AND (f.updatedAt IS NULL OR f.updatedAt < :dayStart)"
    )
    Page<Flashcard> findReviewDueFlashcards(@Param("userId") Long userId, @Param("dayStart") java.time.LocalDateTime dayStart, Pageable pageable);
}
