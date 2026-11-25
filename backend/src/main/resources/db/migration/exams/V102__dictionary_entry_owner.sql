-- Flashcard / dictionary data isolation hotfix (2026-10-18).
--
-- Saving a Flashcard for a word the shared dictionary did not know inserted a public.dictionary_entries row carrying the
-- learner's own meaning, example, IPA and CEFR. Every lookup path of every learner reads that table, so another learner
-- could be shown that text as dictionary data. From now on such a word gets a PRIVATE entry: owner_user_id = the learner.
-- The learner's meaning / example stay on the card (flashcards.custom_meaning / custom_example, V101). Shared finders read
-- only rows with owner_user_id IS NULL.
--
-- Additive: one nullable column, the word uniqueness split into "shared" and "per owner" (a private "zorb" of one learner
-- and of another, and later a shared "zorb", may coexist). No row is deleted; the only rows given an owner are those whose
-- learner origin is proven (below).

ALTER TABLE public.dictionary_entries ADD COLUMN IF NOT EXISTS owner_user_id bigint;

-- The table was created by Hibernate: its UNIQUE (word) constraint has a generated name.
DO $$
DECLARE c record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_dictionary_entries_owner'
                   AND conrelid = 'public.dictionary_entries'::regclass) THEN
        ALTER TABLE public.dictionary_entries ADD CONSTRAINT fk_dictionary_entries_owner
            FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
    END IF;
    FOR c IN
        SELECT con.conname
        FROM pg_constraint con
        WHERE con.conrelid = 'public.dictionary_entries'::regclass AND con.contype = 'u'
          AND con.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                  WHERE attrelid = 'public.dictionary_entries'::regclass AND attname = 'word')]::smallint[]
    LOOP
        EXECUTE format('ALTER TABLE public.dictionary_entries DROP CONSTRAINT %I', c.conname);
    END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_dictionary_entries_shared_word
    ON public.dictionary_entries (word) WHERE owner_user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dictionary_entries_private_word
    ON public.dictionary_entries (owner_user_id, word) WHERE owner_user_id IS NOT NULL;

-- Proven learner-made rows become private to their learner. Proof = all of: no provider payload (data_json), no
-- Vietnamese translation, no deck link, cards of exactly ONE learner, and the row was inserted (updated_at defaults to
-- the insert time) within 5 seconds of that learner's first card of it — the save transaction itself. Rows that do not
-- meet every condition are left shared; their provenance needs a human review (never guessed here).
WITH proven AS (
    SELECT d.id, min(f.user_id) AS owner
    FROM public.dictionary_entries d
    JOIN public.flashcards f ON f.dictionary_entry_id = d.id
    WHERE d.owner_user_id IS NULL
      AND length(btrim(coalesce(d.data_json, ' '))) = 0
      AND d.general_translation_vi IS NULL
      AND d.updated_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.deck_dictionary_entries l WHERE l.dictionary_entry_id = d.id)
    GROUP BY d.id, d.updated_at
    HAVING count(DISTINCT f.user_id) = 1
       AND (abs(extract(epoch FROM (min(f.created_at) - (d.updated_at AT TIME ZONE 'UTC')))) < 5
            OR abs(extract(epoch FROM (min(f.created_at) - (d.updated_at AT TIME ZONE 'Asia/Ho_Chi_Minh')))) < 5)
)
UPDATE public.dictionary_entries d SET owner_user_id = p.owner
FROM proven p
WHERE d.id = p.id
  AND NOT EXISTS (SELECT 1 FROM public.dictionary_entries o WHERE o.owner_user_id = p.owner AND o.word = d.word);
