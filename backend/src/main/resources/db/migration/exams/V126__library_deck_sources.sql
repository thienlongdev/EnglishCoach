-- Optional fields on the taught sense; historical deck links and learner reviews remain untouched.
ALTER TABLE public.deck_dictionary_entries
    ADD COLUMN definition_en varchar(500),
    ADD COLUMN source_kind varchar(32),
    ADD COLUMN reference_level varchar(2);

