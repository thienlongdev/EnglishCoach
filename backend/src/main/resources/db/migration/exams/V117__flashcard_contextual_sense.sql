-- Echo Memory Tides 2.0 — the contextual sense of a card made by Echo AI Card Studio (owner release brief 2026-11-12).
-- Additive only: three NULLABLE columns on public.flashcards, no default, no backfill, no existing row or rule changed.
--
-- custom_definition      : the short English definition of the sense used in the learner's text (Studio draft, learner-approved)
-- custom_part_of_speech  : that sense's part of speech (allow-listed by FlashcardService)
-- custom_example_vi      : the Vietnamese translation of custom_example (the source sentence), only when both exist
--
-- A card with a contextual sense shows ONLY that sense (meaning, definition, its example and translation): the shared dictionary row
-- may describe other senses of the word ("struggle" noun next to the learner's verb sense). Cards without these fields (every card
-- before this migration) keep exactly their current display. Review state, history and scheduling are untouched.

ALTER TABLE public.flashcards
    ADD COLUMN IF NOT EXISTS custom_definition text,
    ADD COLUMN IF NOT EXISTS custom_part_of_speech varchar(32),
    ADD COLUMN IF NOT EXISTS custom_example_vi text,
    ADD CONSTRAINT chk_flashcards_custom_definition_len CHECK (custom_definition IS NULL OR char_length(custom_definition) <= 500),
    ADD CONSTRAINT chk_flashcards_custom_example_vi_len CHECK (custom_example_vi IS NULL OR char_length(custom_example_vi) <= 1000);
