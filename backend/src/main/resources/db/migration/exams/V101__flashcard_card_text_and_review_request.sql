-- Flashcards repair (2026-10-18). Additive only: three nullable columns, no rewrite of existing rows.
--
-- custom_meaning / custom_example: what the learner typed when saving a card (Reading, My Books, dictionary popups,
-- translation, manual add). Until now the card only pointed at a shared dictionary entry, so a learner's own
-- meaning and example were dropped whenever that word already existed in the dictionary. Shown before the
-- dictionary's text on the card; NULL keeps the old behaviour.
--
-- last_review_request_id: the client's id of the last rating applied to the card. A retried rating (timeout,
-- uncertain network answer) carries the same id and is answered with the stored state instead of moving the
-- schedule twice or writing a second review event.

ALTER TABLE public.flashcards
    ADD COLUMN IF NOT EXISTS custom_meaning text,
    ADD COLUMN IF NOT EXISTS custom_example text,
    ADD COLUMN IF NOT EXISTS last_review_request_id varchar(64);

ALTER TABLE public.flashcards
    ADD CONSTRAINT chk_flashcards_custom_meaning_len CHECK (custom_meaning IS NULL OR char_length(custom_meaning) <= 2000),
    ADD CONSTRAINT chk_flashcards_custom_example_len CHECK (custom_example IS NULL OR char_length(custom_example) <= 1000);
