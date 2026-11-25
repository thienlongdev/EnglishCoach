-- V13__auth_ownership_integrity.sql
-- Enforce ownership scoping indexes across learning domains and exam attempts

-- 1. Flashcards ownership index
CREATE INDEX IF NOT EXISTS idx_flashcards_user_due ON public.flashcards(user_id, next_review_date);

-- 2. Reading highlights ownership index
CREATE INDEX IF NOT EXISTS idx_reading_highlights_user ON public.document_highlights(user_id);

-- 3. Listening sessions ownership index
CREATE INDEX IF NOT EXISTS idx_listening_sessions_user ON public.listening_sessions(user_id);

-- 4. Speaking sessions ownership index
CREATE INDEX IF NOT EXISTS idx_speaking_sessions_user ON public.speaking_sessions(user_id);

-- 5. Writing sessions ownership index
CREATE INDEX IF NOT EXISTS idx_writing_sessions_user ON public.writing_sessions(user_id);

-- 6. Exam attempts ownership index
CREATE INDEX IF NOT EXISTS idx_attempts_user_status ON exams.attempts(user_id, status);
