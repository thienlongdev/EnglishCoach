-- V49: Promote explicit legacy public listening materials to system content
-- Only promotes rows where owner_user_id IS NULL and is_system = FALSE
UPDATE listening_materials
SET is_system = TRUE
WHERE id IN (11, 12, 13, 14, 15) AND owner_user_id IS NULL AND is_system = FALSE;
