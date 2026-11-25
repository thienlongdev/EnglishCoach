-- V39__massive_vocab_decks_and_vietnamese_meanings.sql
-- High-Performance Composite Indexes & Vietnamese L1 Support for Massive Vocabulary Scaling

-- 1. Ensure general_translation_vi column exists on dictionary_entries
ALTER TABLE public.dictionary_entries ADD COLUMN IF NOT EXISTS general_translation_vi text;

-- 2. Ensure composite indexes for high-speed deck word ordering and user card querying
CREATE INDEX IF NOT EXISTS idx_deck_dict_deck_sort ON public.deck_dictionary_entries (deck_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_flashcards_user_deck_status ON public.flashcards (user_id, deck_id, status);

CREATE INDEX IF NOT EXISTS idx_flashcards_user_deck_state ON public.flashcards (user_id, deck_id, state);

CREATE INDEX IF NOT EXISTS idx_dict_entries_word_lower ON public.dictionary_entries (LOWER(word));
