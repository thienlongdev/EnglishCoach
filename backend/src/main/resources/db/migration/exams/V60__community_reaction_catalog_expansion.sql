-- =========================================================================
-- V60__community_reaction_catalog_expansion.sql
-- Community Social UX V2: Reaction System V2 & Legacy Normalization
-- =========================================================================

-- 1. Update check constraint on community_post_reactions to allow all Reaction System V2 types and legacy types
ALTER TABLE public.community_post_reactions 
    DROP CONSTRAINT IF EXISTS chk_community_reaction_type;

ALTER TABLE public.community_post_reactions 
    ADD CONSTRAINT chk_community_reaction_type 
    CHECK (reaction_type IN (
        'LOVE', 'HAHA', 'SUPPORT', 'SAD', 'USEFUL',
        'WOW', 'CONFUSED', 'ANGRY', 'CLAP', 'FIRE', 'THINKING', 'CELEBRATE',
        'LIKE', 'IDEA', 'STRONG'
    ));

-- 2. Migrate existing reaction data to canonical Reaction System V2 names
UPDATE public.community_post_reactions 
SET reaction_type = 'LOVE' 
WHERE reaction_type = 'LIKE';

UPDATE public.community_post_reactions 
SET reaction_type = 'USEFUL' 
WHERE reaction_type = 'IDEA';

UPDATE public.community_post_reactions 
SET reaction_type = 'SUPPORT' 
WHERE reaction_type = 'STRONG';

UPDATE public.community_comment_reactions 
SET reaction_type = 'LOVE' 
WHERE reaction_type = 'LIKE';

UPDATE public.community_comment_reactions 
SET reaction_type = 'USEFUL' 
WHERE reaction_type = 'IDEA';

UPDATE public.community_comment_reactions 
SET reaction_type = 'SUPPORT' 
WHERE reaction_type = 'STRONG';

