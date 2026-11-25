-- V41: Alter dictionary collection columns to TEXT to avoid character varying(255) overflows
ALTER TABLE public.dictionary_meanings ALTER COLUMN meaning TYPE text;
ALTER TABLE public.dictionary_examples ALTER COLUMN example TYPE text;
ALTER TABLE public.dictionary_synonyms ALTER COLUMN synonym TYPE text;
ALTER TABLE public.dictionary_collocations ALTER COLUMN collocation TYPE text;
