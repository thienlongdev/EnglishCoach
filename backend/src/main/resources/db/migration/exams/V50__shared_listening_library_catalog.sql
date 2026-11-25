-- V50__shared_listening_library_catalog.sql
-- Phase 2.3: Shared Listening Library - Owner-Approved Curated YouTube Catalog
-- Additive, idempotent catalog migration for system listening materials

-- 1. Add nullable metadata columns to listening_materials if not already present
ALTER TABLE public.listening_materials ADD COLUMN IF NOT EXISTS channel VARCHAR(255);
ALTER TABLE public.listening_materials ADD COLUMN IF NOT EXISTS thumbnail VARCHAR(500);
ALTER TABLE public.listening_materials ADD COLUMN IF NOT EXISTS youtube_video_id VARCHAR(50);

-- 2. Backfill NULL metadata for existing system materials 11-15 (never overwrite non-NULL)
UPDATE public.listening_materials
SET channel = COALESCE(channel, 'TED'),
    thumbnail = COALESCE(thumbnail, 'https://i.ytimg.com/vi/iCvmsMzlF7o/hqdefault.jpg'),
    youtube_video_id = COALESCE(youtube_video_id, 'iCvmsMzlF7o')
WHERE owner_user_id IS NULL AND is_system = TRUE AND id = 11;

UPDATE public.listening_materials
SET channel = COALESCE(channel, 'TED-Ed'),
    thumbnail = COALESCE(thumbnail, 'https://i.ytimg.com/vi/oetVvR5RQUs/hqdefault.jpg'),
    youtube_video_id = COALESCE(youtube_video_id, 'oetVvR5RQUs')
WHERE owner_user_id IS NULL AND is_system = TRUE AND id = 12;

UPDATE public.listening_materials
SET channel = COALESCE(channel, 'Ink Explainer'),
    thumbnail = COALESCE(thumbnail, 'https://i.ytimg.com/vi/49_Ph2q6uIM/hqdefault.jpg'),
    youtube_video_id = COALESCE(youtube_video_id, '49_Ph2q6uIM')
WHERE owner_user_id IS NULL AND is_system = TRUE AND id = 13;

UPDATE public.listening_materials
SET channel = COALESCE(channel, 'TOEIC Listening Mastery'),
    thumbnail = COALESCE(thumbnail, 'https://i.ytimg.com/vi/6XpwwNt-PIE/hqdefault.jpg'),
    youtube_video_id = COALESCE(youtube_video_id, '6XpwwNt-PIE')
WHERE owner_user_id IS NULL AND is_system = TRUE AND id = 14;

UPDATE public.listening_materials
SET channel = COALESCE(channel, 'Cleo Abram'),
    thumbnail = COALESCE(thumbnail, 'https://i.ytimg.com/vi/oX7OduG1YmI/hqdefault.jpg'),
    youtube_video_id = COALESCE(youtube_video_id, 'oX7OduG1YmI')
WHERE owner_user_id IS NULL AND is_system = TRUE AND id = 15;

-- 3. Insert validated owner-approved curated videos (watch-only, is_system = TRUE, owner_user_id = NULL)
-- Video 1: eIho2S0ZahI (TED)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'How to Speak So That People Want to Listen | Julian Treasure | TED', 'https://www.youtube.com/watch?v=eIho2S0ZahI', 'eIho2S0ZahI', 'TED', 'https://i.ytimg.com/vi/eIho2S0ZahI/hqdefault.jpg', NULL, 'B2', 'Ideas & Talks', 'British', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'eIho2S0ZahI' OR sm.audio_url LIKE '%eIho2S0ZahI%')
);

-- Video 2: 8KkKuTCFvzI (TED)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'What Makes a Good Life? Lessons from the Longest Study on Happiness | Robert Waldinger | TED', 'https://www.youtube.com/watch?v=8KkKuTCFvzI', '8KkKuTCFvzI', 'TED', 'https://i.ytimg.com/vi/8KkKuTCFvzI/hqdefault.jpg', NULL, 'B2', 'Ideas & Talks', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = '8KkKuTCFvzI' OR sm.audio_url LIKE '%8KkKuTCFvzI%')
);

-- Video 3: c0KYU2j0TM4 (TED)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'The power of introverts | Susan Cain | TED', 'https://www.youtube.com/watch?v=c0KYU2j0TM4', 'c0KYU2j0TM4', 'TED', 'https://i.ytimg.com/vi/c0KYU2j0TM4/hqdefault.jpg', NULL, 'B2', 'Ideas & Talks', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'c0KYU2j0TM4' OR sm.audio_url LIKE '%c0KYU2j0TM4%')
);

-- Video 4: rrkrvAUbU9Y (TED)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'The puzzle of motivation | Dan Pink | TED', 'https://www.youtube.com/watch?v=rrkrvAUbU9Y', 'rrkrvAUbU9Y', 'TED', 'https://i.ytimg.com/vi/rrkrvAUbU9Y/hqdefault.jpg', NULL, 'B2', 'Ideas & Talks', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'rrkrvAUbU9Y' OR sm.audio_url LIKE '%rrkrvAUbU9Y%')
);

-- Video 5: Ks-_Mh1QhMc (TED)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'Your Body Language May Shape Who You Are | Amy Cuddy | TED', 'https://www.youtube.com/watch?v=Ks-_Mh1QhMc', 'Ks-_Mh1QhMc', 'TED', 'https://i.ytimg.com/vi/Ks-_Mh1QhMc/hqdefault.jpg', NULL, 'B2', 'Ideas & Talks', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'Ks-_Mh1QhMc' OR sm.audio_url LIKE '%Ks-_Mh1QhMc%')
);

-- Video 6: arj7oStGLkU (TED)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'Inside the Mind of a Master Procrastinator | Tim Urban | TED', 'https://www.youtube.com/watch?v=arj7oStGLkU', 'arj7oStGLkU', 'TED', 'https://i.ytimg.com/vi/arj7oStGLkU/hqdefault.jpg', NULL, 'B2', 'Work & Study', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'arj7oStGLkU' OR sm.audio_url LIKE '%arj7oStGLkU%')
);

-- Video 7: HD3IBffy6Z4 (English with Lucy)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'LEARN 400 adjectives and synonyms & PRONOUNCE in 40 minutes', 'https://www.youtube.com/watch?v=HD3IBffy6Z4', 'HD3IBffy6Z4', 'English with Lucy', 'https://i.ytimg.com/vi/HD3IBffy6Z4/hqdefault.jpg', NULL, 'B2', 'Everyday English', 'British', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'HD3IBffy6Z4' OR sm.audio_url LIKE '%HD3IBffy6Z4%')
);

-- Video 8: jrwglP9EQOU (English with Lucy)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'Pronunciation Training: 3 Ways to speak English MUCH more clearly!', 'https://www.youtube.com/watch?v=jrwglP9EQOU', 'jrwglP9EQOU', 'English with Lucy', 'https://i.ytimg.com/vi/jrwglP9EQOU/hqdefault.jpg', NULL, 'B2', 'Everyday English', 'British', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'jrwglP9EQOU' OR sm.audio_url LIKE '%jrwglP9EQOU%')
);

-- Video 9: 0NPI9gDrgvs (Rachel's English)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'Speaking English: 7 Must-Know Phrases (Perfectly Spoken!)', 'https://www.youtube.com/watch?v=0NPI9gDrgvs', '0NPI9gDrgvs', 'Rachel''s English', 'https://i.ytimg.com/vi/0NPI9gDrgvs/hqdefault.jpg', NULL, 'B1', 'Everyday English', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = '0NPI9gDrgvs' OR sm.audio_url LIKE '%0NPI9gDrgvs%')
);

-- Video 10: 7_z0TA_od9M (Rachel's English)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'Speaking English: You NEED This Vocab!', 'https://www.youtube.com/watch?v=7_z0TA_od9M', '7_z0TA_od9M', 'Rachel''s English', 'https://i.ytimg.com/vi/7_z0TA_od9M/hqdefault.jpg', NULL, 'B2', 'Everyday English', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = '7_z0TA_od9M' OR sm.audio_url LIKE '%7_z0TA_od9M%')
);

-- Video 11: GBee7qwyl5k (Speak English With Vanessa)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    '50 Important Verbs in English for Daily Conversation', 'https://www.youtube.com/watch?v=GBee7qwyl5k', 'GBee7qwyl5k', 'Speak English With Vanessa', 'https://i.ytimg.com/vi/GBee7qwyl5k/hqdefault.jpg', NULL, 'B1', 'Everyday English', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'GBee7qwyl5k' OR sm.audio_url LIKE '%GBee7qwyl5k%')
);

-- Video 12: 6hOH6jflWB8 (Speak English With Vanessa)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'Daily Life English Vocabulary You NEED To Know', 'https://www.youtube.com/watch?v=6hOH6jflWB8', '6hOH6jflWB8', 'Speak English With Vanessa', 'https://i.ytimg.com/vi/6hOH6jflWB8/hqdefault.jpg', NULL, 'B1', 'Everyday English', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = '6hOH6jflWB8' OR sm.audio_url LIKE '%6hOH6jflWB8%')
);

-- Video 13: 6vug8bnKbfQ (mmmEnglish)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'How to OVERCOME SHYNESS & speak confidently in English', 'https://www.youtube.com/watch?v=6vug8bnKbfQ', '6vug8bnKbfQ', 'mmmEnglish', 'https://i.ytimg.com/vi/6vug8bnKbfQ/hqdefault.jpg', NULL, 'B1', 'Everyday English', 'Australian', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = '6vug8bnKbfQ' OR sm.audio_url LIKE '%6vug8bnKbfQ%')
);

-- Video 14: 3-icphihD6Y (BBC Learning English)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'Could you give up fast fashion? 6 Minute English', 'https://www.youtube.com/watch?v=3-icphihD6Y', '3-icphihD6Y', 'BBC Learning English', 'https://i.ytimg.com/vi/3-icphihD6Y/hqdefault.jpg', NULL, 'B2', 'News & Podcasts', 'British', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = '3-icphihD6Y' OR sm.audio_url LIKE '%3-icphihD6Y%')
);

-- Video 15: oRhVmbfy1sY (BBC Learning English)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'Low emission zones - 6 Minute English', 'https://www.youtube.com/watch?v=oRhVmbfy1sY', 'oRhVmbfy1sY', 'BBC Learning English', 'https://i.ytimg.com/vi/oRhVmbfy1sY/hqdefault.jpg', NULL, 'B2', 'News & Podcasts', 'British', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'oRhVmbfy1sY' OR sm.audio_url LIKE '%oRhVmbfy1sY%')
);

-- Video 16: Tcf1dbiWKsk (BBC Learning English)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'How resilient are you? 6 Minute English', 'https://www.youtube.com/watch?v=Tcf1dbiWKsk', 'Tcf1dbiWKsk', 'BBC Learning English', 'https://i.ytimg.com/vi/Tcf1dbiWKsk/hqdefault.jpg', NULL, 'B2', 'News & Podcasts', 'British', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'Tcf1dbiWKsk' OR sm.audio_url LIKE '%Tcf1dbiWKsk%')
);

-- Video 17: Ol18JoeXlVI (Veritasium)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'This Paradox Splits Smart People 50/50', 'https://www.youtube.com/watch?v=Ol18JoeXlVI', 'Ol18JoeXlVI', 'Veritasium', 'https://i.ytimg.com/vi/Ol18JoeXlVI/hqdefault.jpg', NULL, 'C1', 'Science & Tech', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'Ol18JoeXlVI' OR sm.audio_url LIKE '%Ol18JoeXlVI%')
);

-- Video 18: 094y1Z2wpJg (Veritasium)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'The Simplest Math Problem No One Can Solve - Collatz Conjecture', 'https://www.youtube.com/watch?v=094y1Z2wpJg', '094y1Z2wpJg', 'Veritasium', 'https://i.ytimg.com/vi/094y1Z2wpJg/hqdefault.jpg', NULL, 'C1', 'Science & Tech', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = '094y1Z2wpJg' OR sm.audio_url LIKE '%094y1Z2wpJg%')
);

-- Video 19: Xl1XBJLfIDU (SciShow)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'The Addictive Truth About Caffeine', 'https://www.youtube.com/watch?v=Xl1XBJLfIDU', 'Xl1XBJLfIDU', 'SciShow', 'https://i.ytimg.com/vi/Xl1XBJLfIDU/hqdefault.jpg', NULL, 'B2', 'Science & Tech', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'Xl1XBJLfIDU' OR sm.audio_url LIKE '%Xl1XBJLfIDU%')
);

-- Video 20: ew_iZTPoC3c (SciShow)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'Why Do We Yawn?', 'https://www.youtube.com/watch?v=ew_iZTPoC3c', 'ew_iZTPoC3c', 'SciShow', 'https://i.ytimg.com/vi/ew_iZTPoC3c/hqdefault.jpg', NULL, 'B2', 'Science & Tech', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'ew_iZTPoC3c' OR sm.audio_url LIKE '%ew_iZTPoC3c%')
);

-- Video 21: zQGOcOUBi6s (Kurzgesagt � In a Nutshell)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'The Immune System Explained I � Bacteria Infection', 'https://www.youtube.com/watch?v=zQGOcOUBi6s', 'zQGOcOUBi6s', 'Kurzgesagt � In a Nutshell', 'https://i.ytimg.com/vi/zQGOcOUBi6s/hqdefault.jpg', NULL, 'B2', 'Science & Tech', 'International', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'zQGOcOUBi6s' OR sm.audio_url LIKE '%zQGOcOUBi6s%')
);

-- Video 22: sNhhvQGsMEc (Kurzgesagt � In a Nutshell)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'The Fermi Paradox � Where Are All The Aliens? (1/2)', 'https://www.youtube.com/watch?v=sNhhvQGsMEc', 'sNhhvQGsMEc', 'Kurzgesagt � In a Nutshell', 'https://i.ytimg.com/vi/sNhhvQGsMEc/hqdefault.jpg', NULL, 'C1', 'Science & Tech', 'International', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'sNhhvQGsMEc' OR sm.audio_url LIKE '%sNhhvQGsMEc%')
);

-- Video 23: ATDCsY-VJPA (Thomas Frank)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'How I take notes from books', 'https://www.youtube.com/watch?v=ATDCsY-VJPA', 'ATDCsY-VJPA', 'Thomas Frank', 'https://i.ytimg.com/vi/ATDCsY-VJPA/hqdefault.jpg', NULL, 'B2', 'Work & Study', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'ATDCsY-VJPA' OR sm.audio_url LIKE '%ATDCsY-VJPA%')
);

-- Video 24: ctdUGVmEvfo (Thomas Frank)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    '3 habits for better work-life balance', 'https://www.youtube.com/watch?v=ctdUGVmEvfo', 'ctdUGVmEvfo', 'Thomas Frank', 'https://i.ytimg.com/vi/ctdUGVmEvfo/hqdefault.jpg', NULL, 'B2', 'Work & Study', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'ctdUGVmEvfo' OR sm.audio_url LIKE '%ctdUGVmEvfo%')
);

-- Video 25: FbD8n4J_MuM (Thomas Frank)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'How to Learn Any Skill Twice as Fast', 'https://www.youtube.com/watch?v=FbD8n4J_MuM', 'FbD8n4J_MuM', 'Thomas Frank', 'https://i.ytimg.com/vi/FbD8n4J_MuM/hqdefault.jpg', NULL, 'B2', 'Work & Study', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'FbD8n4J_MuM' OR sm.audio_url LIKE '%FbD8n4J_MuM%')
);

-- Video 26: PCtQ6sipdqA (Ali Abdaal)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'How to Find Time for Everything with a Full Time Job', 'https://www.youtube.com/watch?v=PCtQ6sipdqA', 'PCtQ6sipdqA', 'Ali Abdaal', 'https://i.ytimg.com/vi/PCtQ6sipdqA/hqdefault.jpg', NULL, 'B2', 'Work & Study', 'International', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'PCtQ6sipdqA' OR sm.audio_url LIKE '%PCtQ6sipdqA%')
);

-- Video 27: gcGquCZxsJc (Ali Abdaal)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'Productivity for Lazy People - The RAD System', 'https://www.youtube.com/watch?v=gcGquCZxsJc', 'gcGquCZxsJc', 'Ali Abdaal', 'https://i.ytimg.com/vi/gcGquCZxsJc/hqdefault.jpg', NULL, 'B2', 'Work & Study', 'International', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'gcGquCZxsJc' OR sm.audio_url LIKE '%gcGquCZxsJc%')
);

-- Video 28: qUHLCobRgaE (Rick Steves' Europe)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'European Travel Skills: Planning Your Itinerary - Rick Steves'' Europe Travel Guide', 'https://www.youtube.com/watch?v=qUHLCobRgaE', 'qUHLCobRgaE', 'Rick Steves'' Europe', 'https://i.ytimg.com/vi/qUHLCobRgaE/hqdefault.jpg', NULL, 'B2', 'Culture & Travel', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'qUHLCobRgaE' OR sm.audio_url LIKE '%qUHLCobRgaE%')
);

-- Video 29: P8--q-K3olA (Rick Steves' Europe)
INSERT INTO public.listening_materials (
    title, audio_url, youtube_video_id, channel, thumbnail, duration_seconds, cefr_level, topic, accent, is_system, owner_user_id
) SELECT
    'European Travel Skills: Arrival in Europe - Rick Steves'' Europe Travel Guide', 'https://www.youtube.com/watch?v=P8--q-K3olA', 'P8--q-K3olA', 'Rick Steves'' Europe', 'https://i.ytimg.com/vi/P8--q-K3olA/hqdefault.jpg', NULL, 'B2', 'Culture & Travel', 'American', TRUE, NULL
WHERE NOT EXISTS (
    SELECT 1 FROM public.listening_materials sm WHERE sm.is_system = TRUE AND (sm.youtube_video_id = 'P8--q-K3olA' OR sm.audio_url LIKE '%P8--q-K3olA%')
);

