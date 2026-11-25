-- V9__exams_form_components_role_expansion.sql
-- Expand exams.form_components role check constraint to support full multi-skill and 4-skill composite forms (LISTENING, READING, WRITING, SPEAKING, LR)

ALTER TABLE exams.form_components DROP CONSTRAINT IF EXISTS form_components_role_check;
ALTER TABLE exams.form_components ADD CONSTRAINT form_components_role_check CHECK (role IN ('LR', 'SPEAKING', 'WRITING', 'LISTENING', 'READING'));
