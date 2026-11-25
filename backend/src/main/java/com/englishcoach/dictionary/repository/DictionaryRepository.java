package com.englishcoach.dictionary.repository;

import com.englishcoach.dictionary.entity.DictionaryEntry;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
/**
 * Every word finder here reads SHARED rows only ({@code owner_user_id IS NULL}). A learner's private entry (V102) is
 * reachable only through {@link #findPrivateEntry} with that learner's id, or through the learner's own card.
 */
public interface DictionaryRepository extends JpaRepository<DictionaryEntry, Long> {
    /** Every shared entry whose word equals {@code word} ignoring case ("Scarf" and "scarf" are separate rows). */
    @org.springframework.data.jpa.repository.Query(
            "SELECT d FROM DictionaryEntry d WHERE d.ownerUserId IS NULL AND lower(d.word) = lower(:word) ORDER BY d.id ASC")
    List<DictionaryEntry> findAllByWordIgnoreCaseAndOwnerUserIdIsNullOrderByIdAsc(
            @org.springframework.data.repository.query.Param("word") String word);

    /**
     * The shared entry for a word ignoring case: the exact spelling first, else the oldest. Words stored in two
     * spellings made the old single-result finder throw (HTTP 500 for every caller of that word).
     */
    default Optional<DictionaryEntry> findByWordIgnoreCase(String word) {
        if (word == null) return Optional.empty();
        List<DictionaryEntry> all = findAllByWordIgnoreCaseAndOwnerUserIdIsNullOrderByIdAsc(word);
        if (all == null || all.isEmpty()) return Optional.empty();
        return all.stream().filter(e -> word.equals(e.getWord())).findFirst().or(() -> Optional.of(all.get(0)));
    }

    /** Which of {@code words} (lower case) have a shared entry: one read for many words. */
    @org.springframework.data.jpa.repository.Query(value = "SELECT DISTINCT lower(word) FROM public.dictionary_entries "
            + "WHERE owner_user_id IS NULL AND lower(word) IN (:words)", nativeQuery = true)
    List<String> findSharedWordsAmong(@org.springframework.data.repository.query.Param("words") java.util.Collection<String> words);

    /** The stored payload of a word's shared entry (exact spelling first, else the oldest), one column, one read. */
    @org.springframework.data.jpa.repository.Query(value = "SELECT data_json FROM public.dictionary_entries "
            + "WHERE owner_user_id IS NULL AND lower(word) = lower(:word) ORDER BY (word = :word) DESC, id LIMIT 1",
            nativeQuery = true)
    String findSharedPayload(@org.springframework.data.repository.query.Param("word") String word);

    /**
     * Whether a shared entry belongs to a SYSTEM deck (seeded content). The engine upgrades a stored row that has no
     * payload yet only then: a payload-less row outside the SYSTEM decks may hold a learner's text from before V102
     * and is left for the owner's provenance review.
     */
    @org.springframework.data.jpa.repository.Query(value = "SELECT EXISTS (SELECT 1 FROM public.deck_dictionary_entries l "
            + "JOIN public.vocab_decks d ON d.id = l.deck_id WHERE l.dictionary_entry_id = :id AND d.is_system = true)",
            nativeQuery = true)
    boolean isInSystemDeck(@org.springframework.data.repository.query.Param("id") Long id);

    /** The learner's own private entry of a word (ignoring case), never another learner's. */
    @org.springframework.data.jpa.repository.Query(
            "SELECT d FROM DictionaryEntry d WHERE d.ownerUserId = :ownerUserId AND lower(d.word) = lower(:word) ORDER BY d.id ASC")
    List<DictionaryEntry> findAllPrivateByOwnerAndWordLower(
            @org.springframework.data.repository.query.Param("ownerUserId") Long ownerUserId,
            @org.springframework.data.repository.query.Param("word") String word);

    default Optional<DictionaryEntry> findFirstByOwnerUserIdAndWordIgnoreCaseOrderByIdAsc(Long ownerUserId, String word) {
        if (ownerUserId == null || word == null) return Optional.empty();
        List<DictionaryEntry> rows = findAllPrivateByOwnerAndWordLower(ownerUserId, word);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    default Optional<DictionaryEntry> findPrivateEntry(Long ownerUserId, String word) {
        if (ownerUserId == null || word == null) return Optional.empty();
        return findFirstByOwnerUserIdAndWordIgnoreCaseOrderByIdAsc(ownerUserId, word);
    }

    @org.springframework.data.jpa.repository.Query(
            "SELECT d FROM DictionaryEntry d WHERE d.ownerUserId IS NULL AND lower(d.word) LIKE CONCAT(lower(:prefix), '%')")
    List<DictionaryEntry> findByWordStartingWithIgnoreCaseAndOwnerUserIdIsNull(
            @org.springframework.data.repository.query.Param("prefix") String prefix);
    List<DictionaryEntry> findByWordEndingWithIgnoreCaseAndOwnerUserIdIsNull(String suffix);
    List<DictionaryEntry> findByWordContainingIgnoreCaseAndOwnerUserIdIsNull(String infix);
    long countByGeneralTranslationViIsNotNullAndOwnerUserIdIsNull();
    org.springframework.data.domain.Page<DictionaryEntry> findByGeneralTranslationViIsNotNullAndOwnerUserIdIsNull(org.springframework.data.domain.Pageable pageable);

    default List<DictionaryEntry> findByWordStartingWithIgnoreCase(String prefix) {
        return findByWordStartingWithIgnoreCaseAndOwnerUserIdIsNull(prefix);
    }
    default List<DictionaryEntry> findByWordEndingWithIgnoreCase(String suffix) {
        return findByWordEndingWithIgnoreCaseAndOwnerUserIdIsNull(suffix);
    }
    default List<DictionaryEntry> findByWordContainingIgnoreCase(String infix) {
        return findByWordContainingIgnoreCaseAndOwnerUserIdIsNull(infix);
    }
    default long countByGeneralTranslationViIsNotNull() {
        return countByGeneralTranslationViIsNotNullAndOwnerUserIdIsNull();
    }
    default org.springframework.data.domain.Page<DictionaryEntry> findByGeneralTranslationViIsNotNull(org.springframework.data.domain.Pageable pageable) {
        return findByGeneralTranslationViIsNotNullAndOwnerUserIdIsNull(pageable);
    }
}
