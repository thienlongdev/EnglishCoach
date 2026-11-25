-- V40__vocab_full_corpus_indexes.sql
-- High-Performance Composite Indexes for Full Corpus Vocabulary & Zero-Lag Retrieval

-- 1. Composite index for deck dictionary entries association & sort
CREATE INDEX IF NOT EXISTS idx_deck_dict_deck_entry 
    ON public.deck_dictionary_entries (deck_id, dictionary_entry_id);

CREATE INDEX IF NOT EXISTS idx_deck_dict_deck_sort_order 
    ON public.deck_dictionary_entries (deck_id, sort_order);

-- 2. Composite indexes for high-speed user flashcard queries & spaced repetition
CREATE INDEX IF NOT EXISTS idx_flashcards_user_deck_status 
    ON public.flashcards (user_id, deck_id, status);

CREATE INDEX IF NOT EXISTS idx_flashcards_user_deck_entry 
    ON public.flashcards (user_id, deck_id, dictionary_entry_id);

CREATE INDEX IF NOT EXISTS idx_flashcards_user_deck_due 
    ON public.flashcards (user_id, deck_id, next_review_date);

-- 3. Expression index for case-insensitive dictionary lookup & upsert
CREATE INDEX IF NOT EXISTS idx_dict_entries_word_lower 
    ON public.dictionary_entries (LOWER(word));
