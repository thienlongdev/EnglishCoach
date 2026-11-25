-- V17__dictionary_engine_v2.sql
-- Dictionary Engine V2: Canonical lexical cache columns and indexes

ALTER TABLE public.dictionary_entries 
    ADD COLUMN IF NOT EXISTS entry_type VARCHAR(50) DEFAULT 'WORD',
    ADD COLUMN IF NOT EXISTS data_json TEXT,
    ADD COLUMN IF NOT EXISTS general_translation_vi TEXT,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_dictionary_word_lower 
    ON public.dictionary_entries (LOWER(word));
