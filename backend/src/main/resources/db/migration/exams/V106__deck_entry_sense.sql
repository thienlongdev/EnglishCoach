-- SYSTEM vocabulary library (owner brief 2026-10-30): a curated topic deck teaches ONE sense of each word. The sense lives
-- on the deck link, not on the shared dictionary row: the Vietnamese meaning of that sense, an example that shows it and the
-- example's Vietnamese translation (human translations with recorded provenance, written only by the opt-in deck seeder).
-- The shared dictionary_entries row is not changed by this (dictionary lookups rewrite it), and the same word may teach
-- a different sense in another deck. Additive: four nullable columns; existing links keep NULL and render as before.
ALTER TABLE public.deck_dictionary_entries
    ADD COLUMN IF NOT EXISTS part_of_speech VARCHAR(20),
    ADD COLUMN IF NOT EXISTS meaning_vi TEXT,
    ADD COLUMN IF NOT EXISTS example TEXT,
    ADD COLUMN IF NOT EXISTS example_vi TEXT;

ALTER TABLE public.deck_dictionary_entries
    ADD CONSTRAINT ck_deck_dictionary_entries_sense_lengths CHECK (
        (meaning_vi IS NULL OR length(meaning_vi) BETWEEN 1 AND 500)
        AND (example IS NULL OR length(example) BETWEEN 1 AND 1000)
        AND (example_vi IS NULL OR length(example_vi) BETWEEN 1 AND 1000)
        AND (example_vi IS NULL OR example IS NOT NULL));
