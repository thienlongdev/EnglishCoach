-- V20__translation_revealed_tokens.sql
-- Support word-level token reveal tracking for translation exercises

ALTER TABLE public.translation_session_units
    ADD COLUMN IF NOT EXISTS revealed_tokens_json VARCHAR(512) NOT NULL DEFAULT '[]';
