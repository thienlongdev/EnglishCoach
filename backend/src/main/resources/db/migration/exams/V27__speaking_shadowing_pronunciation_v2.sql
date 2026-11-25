-- V27: Add pronunciation_score and fluency_score to speaking_shadowing_attempts for Pronunciation V2.2 integration
ALTER TABLE speaking_shadowing_attempts ADD COLUMN IF NOT EXISTS pronunciation_score DOUBLE PRECISION;
ALTER TABLE speaking_shadowing_attempts ADD COLUMN IF NOT EXISTS fluency_score DOUBLE PRECISION;
