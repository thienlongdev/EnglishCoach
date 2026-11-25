-- V29: Versioned Role-play schema additions for ownership, system scenarios, audio persistence, and acoustic metrics
ALTER TABLE speaking_scenarios ADD COLUMN IF NOT EXISTS owner_user_id BIGINT;
ALTER TABLE speaking_scenarios ADD COLUMN IF NOT EXISTS is_system BOOLEAN DEFAULT TRUE;
UPDATE speaking_scenarios SET is_system = TRUE WHERE is_system IS NULL;

ALTER TABLE speaking_turns ADD COLUMN IF NOT EXISTS audio_ref VARCHAR(500);
ALTER TABLE speaking_turns ADD COLUMN IF NOT EXISTS segmental_score INTEGER;

CREATE INDEX IF NOT EXISTS idx_speaking_scenarios_owner ON speaking_scenarios(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_speaking_scenarios_system ON speaking_scenarios(is_system);
CREATE INDEX IF NOT EXISTS idx_speaking_turns_client_turn_id ON speaking_turns(client_turn_id);
