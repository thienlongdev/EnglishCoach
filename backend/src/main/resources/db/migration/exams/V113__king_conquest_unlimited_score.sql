-- Soán ngôi has no score ceiling: word points keep adding up for every valid new word. Stored results above the old
-- limit must be accepted; existing rows are untouched. The word count stays bounded by the match's own word limit.
ALTER TABLE public.king_conquest_results DROP CONSTRAINT IF EXISTS king_conquest_results_score_check;
ALTER TABLE public.king_conquest_results ADD CONSTRAINT king_conquest_results_score_check CHECK (score >= 0);
