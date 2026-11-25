-- Migration V25: Expand progress_state check constraint on translation_paragraph_session_items
-- Adds 'ACCEPTED', 'NEEDS_REVISION', and 'COMPLETED' to accommodate grading/attempt evaluation results

ALTER TABLE public.translation_paragraph_session_items
    DROP CONSTRAINT IF EXISTS translation_paragraph_session_items_progress_state_check;

ALTER TABLE public.translation_paragraph_session_items
    ADD CONSTRAINT translation_paragraph_session_items_progress_state_check
    CHECK (progress_state IN ('NOT_STARTED', 'IN_PROGRESS', 'SKIPPED', 'ACCEPTED', 'NEEDS_REVISION', 'COMPLETED'));
