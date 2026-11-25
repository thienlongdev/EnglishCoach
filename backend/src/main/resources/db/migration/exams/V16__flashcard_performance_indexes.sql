-- V16__flashcard_performance_indexes.sql
-- Performance: Add indexes for Flashcards user scoping, due review scheduling, and dictionary lookup

CREATE INDEX IF NOT EXISTS idx_flashcards_user_state
    ON public.flashcards(user_id, state);

CREATE INDEX IF NOT EXISTS idx_flashcards_user_due
    ON public.flashcards(user_id, state, status, next_review_date);

CREATE INDEX IF NOT EXISTS idx_flashcards_user_dict
    ON public.flashcards(user_id, dictionary_entry_id);
