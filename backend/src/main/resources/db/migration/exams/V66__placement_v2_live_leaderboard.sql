-- V66__placement_v2_live_leaderboard.sql
-- Leaderboard / placement hotfix (2026-10-02). Derived objects + placement content only; score_events,
-- proficiency_evidence, skill_proficiency and user_proficiency are untouched.
--   * proficiency_placement_question : curated multiple-choice bank (VOCABULARY + GRAMMAR, A1–C1, 8 + 8 per level),
--                                      every option a real English word / form; replaces the V63 pool.
--   * proficiency_placement_item     : V63 pool (200 PSEUDO strings + dictionary words) deactivated — never issued again.
--   * placement issue / attempt      : model_version (1 = V63 yes/no recognition, 2 = multiple choice) + details JSONB.
--   * leaderboard_refresh_state      : require_placement (copy of app.leaderboard.require-placement, written by every refresh).
--   * mv_activity_rank               : recreated — learners need a VALID placement attempt when require_placement is on;
--                                      ROW_NUMBER (points DESC, reached_at ASC, user_id ASC) ⇒ unique rank numbers.

CREATE TABLE IF NOT EXISTS public.proficiency_placement_question (
    id BIGSERIAL PRIMARY KEY,
    question_key VARCHAR(16) NOT NULL,
    skill VARCHAR(12) NOT NULL,
    cefr VARCHAR(2) NOT NULL,
    prompt TEXT NOT NULL,
    options JSONB NOT NULL,
    answer_index SMALLINT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_proficiency_placement_question_key UNIQUE (question_key),
    CONSTRAINT uq_proficiency_placement_question_prompt UNIQUE (prompt),
    CONSTRAINT ck_proficiency_placement_question_skill CHECK (skill IN ('VOCABULARY', 'GRAMMAR')),
    CONSTRAINT ck_proficiency_placement_question_cefr CHECK (cefr IN ('A1', 'A2', 'B1', 'B2', 'C1')),
    CONSTRAINT ck_proficiency_placement_question_blank CHECK (position('___' IN prompt) > 0),
    CONSTRAINT ck_proficiency_placement_question_options CHECK (
        jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = 4),
    CONSTRAINT ck_proficiency_placement_question_answer CHECK (answer_index BETWEEN 0 AND 3)
);
CREATE INDEX IF NOT EXISTS idx_proficiency_placement_question_pool
    ON public.proficiency_placement_question (cefr, skill) WHERE active;

-- The V63 recognition pool (pseudowords + dictionary words labelled by an unverified CEFR column) is retired.
UPDATE public.proficiency_placement_item SET active = FALSE WHERE active;

ALTER TABLE public.proficiency_placement_issue ADD COLUMN IF NOT EXISTS model_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE public.proficiency_placement_attempt ADD COLUMN IF NOT EXISTS model_version SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE public.proficiency_placement_attempt ADD COLUMN IF NOT EXISTS details JSONB NULL;

ALTER TABLE public.leaderboard_refresh_state ADD COLUMN IF NOT EXISTS require_placement BOOLEAN NOT NULL DEFAULT TRUE;

-- Curated item bank. Prompt = one sentence with one blank (___); exactly one option is correct.
INSERT INTO public.proficiency_placement_question (question_key, skill, cefr, prompt, options, answer_index) VALUES
-- A1 grammar: be / have / there is / do-support / articles / prepositions of time / present simple
('A1-G-01', 'GRAMMAR', 'A1', 'She ___ a teacher.', '["is", "are", "am", "be"]', 0),
('A1-G-02', 'GRAMMAR', 'A1', 'I ___ two brothers and one sister.', '["has", "have", "am", "having"]', 1),
('A1-G-03', 'GRAMMAR', 'A1', 'There ___ three apples on the table.', '["is", "be", "are", "am"]', 2),
('A1-G-04', 'GRAMMAR', 'A1', 'He ___ like coffee.', '["don''t", "isn''t", "not", "doesn''t"]', 3),
('A1-G-05', 'GRAMMAR', 'A1', '___ you speak English?', '["Do", "Does", "Are", "Is"]', 0),
('A1-G-06', 'GRAMMAR', 'A1', 'This is ___ umbrella.', '["a", "an", "some", "many"]', 1),
('A1-G-07', 'GRAMMAR', 'A1', 'My birthday is ___ May.', '["on", "at", "in", "to"]', 2),
('A1-G-08', 'GRAMMAR', 'A1', 'They ___ football every Sunday.', '["plays", "playing", "are play", "play"]', 3),
-- A1 vocabulary: everyday nouns, adjectives, family, home, time
('A1-V-01', 'VOCABULARY', 'A1', 'I drink a cup of ___ every morning.', '["coffee", "chair", "window", "pencil"]', 0),
('A1-V-02', 'VOCABULARY', 'A1', 'The opposite of "hot" is ___.', '["tall", "cold", "fast", "happy"]', 1),
('A1-V-03', 'VOCABULARY', 'A1', 'My mother''s brother is my ___.', '["cousin", "nephew", "uncle", "grandfather"]', 2),
('A1-V-04', 'VOCABULARY', 'A1', 'At night we sleep in the ___.', '["kitchen", "garden", "garage", "bedroom"]', 3),
('A1-V-05', 'VOCABULARY', 'A1', 'There are seven days in a ___.', '["week", "month", "year", "minute"]', 0),
('A1-V-06', 'VOCABULARY', 'A1', 'I read a ___ every night before bed.', '["spoon", "book", "shoe", "door"]', 1),
('A1-V-07', 'VOCABULARY', 'A1', 'It is raining. Take your ___.', '["sandwich", "bicycle", "umbrella", "ticket"]', 2),
('A1-V-08', 'VOCABULARY', 'A1', 'We use our ___ to hear music.', '["eyes", "hands", "feet", "ears"]', 3),
-- A2 grammar: past simple / comparatives / present continuous / going to / modals / quantifiers / past continuous
('A2-G-01', 'GRAMMAR', 'A2', 'Yesterday I ___ to the cinema with my friends.', '["went", "go", "have gone", "going"]', 0),
('A2-G-02', 'GRAMMAR', 'A2', 'She is ___ than her sister.', '["more tall", "taller", "tallest", "the tallest"]', 1),
('A2-G-03', 'GRAMMAR', 'A2', 'Look! The children ___ in the garden.', '["play", "plays", "are playing", "played"]', 2),
('A2-G-04', 'GRAMMAR', 'A2', 'I ___ visit my grandparents next weekend.', '["will to", "going", "am go", "am going to"]', 3),
('A2-G-05', 'GRAMMAR', 'A2', 'We didn''t ___ any milk, so I went to the shop.', '["have", "had", "has", "having"]', 0),
('A2-G-06', 'GRAMMAR', 'A2', 'You ___ wear a seatbelt in the car. It is the law.', '["might", "must", "would", "can"]', 1),
('A2-G-07', 'GRAMMAR', 'A2', 'How ___ money do you need for the trip?', '["many", "lot", "much", "more"]', 2),
('A2-G-08', 'GRAMMAR', 'A2', 'I was watching TV ___ the phone rang.', '["during", "since", "while", "when"]', 3),
-- A2 vocabulary: feelings, phrasal basics, jobs, travel, -ed adjectives
('A2-V-01', 'VOCABULARY', 'A2', 'I''m very ___; I haven''t eaten since breakfast.', '["hungry", "thirsty", "sleepy", "angry"]', 0),
('A2-V-02', 'VOCABULARY', 'A2', 'Could you ___ me the salt, please?', '["borrow", "pass", "lend", "carry"]', 1),
('A2-V-03', 'VOCABULARY', 'A2', 'The bus was late, so we ___ our train.', '["lost", "failed", "missed", "forgot"]', 2),
('A2-V-04', 'VOCABULARY', 'A2', 'She works in a hospital and looks after patients. She is a ___.', '["pilot", "farmer", "waiter", "nurse"]', 3),
('A2-V-05', 'VOCABULARY', 'A2', 'Please turn ___ the lights when you leave the room.', '["off", "up", "in", "over"]', 0),
('A2-V-06', 'VOCABULARY', 'A2', 'It is a long ___ from Hanoi to Ho Chi Minh City by bus.', '["travel", "journey", "luggage", "ticket"]', 1),
('A2-V-07', 'VOCABULARY', 'A2', 'I''m ___ in learning Japanese.', '["interesting", "exciting", "interested", "boring"]', 2),
('A2-V-08', 'VOCABULARY', 'A2', 'My flat is near the city ___, so I can walk to the shops.', '["side", "corner", "edge", "centre"]', 3),
-- B1 grammar: first conditional / for-since / present perfect passive / relatives / reported speech / modals / used to / past perfect
('B1-G-01', 'GRAMMAR', 'B1', 'If it rains tomorrow, we ___ the picnic.', '["will cancel", "would cancel", "cancelled", "had cancelled"]', 0),
('B1-G-02', 'GRAMMAR', 'B1', 'I have lived in this city ___ 2015.', '["for", "since", "from", "during"]', 1),
('B1-G-03', 'GRAMMAR', 'B1', 'This novel ___ by millions of people around the world.', '["has read", "is reading", "has been read", "have been read"]', 2),
('B1-G-04', 'GRAMMAR', 'B1', 'That is the man ___ car was stolen last night.', '["who", "which", "whom", "whose"]', 3),
('B1-G-05', 'GRAMMAR', 'B1', 'He said that he ___ too tired to come.', '["was", "were", "be", "been"]', 0),
('B1-G-06', 'GRAMMAR', 'B1', 'You ___ smoke here. It is not allowed.', '["don''t have to", "mustn''t", "needn''t", "couldn''t"]', 1),
('B1-G-07', 'GRAMMAR', 'B1', 'After a year in the job, I''m used to ___ up at 5 a.m.', '["get", "got", "getting", "have got"]', 2),
('B1-G-08', 'GRAMMAR', 'B1', 'By the time we arrived, the film ___.', '["already started", "has already started", "was already start", "had already started"]', 3),
-- B1 vocabulary: collocations, phrasal verbs, dependent prepositions, word families
('B1-V-01', 'VOCABULARY', 'B1', 'Could you do me a ___ and close the window?', '["favour", "help", "service", "kindness"]', 0),
('B1-V-02', 'VOCABULARY', 'B1', 'The meeting has been ___ until next Monday.', '["put out", "put off", "put up", "put on"]', 1),
('B1-V-03', 'VOCABULARY', 'B1', 'She ___ a lot of money on clothes every month.', '["pays", "costs", "spends", "buys"]', 2),
('B1-V-04', 'VOCABULARY', 'B1', 'I can''t ___ this noise any longer!', '["support", "carry", "hold", "stand"]', 3),
('B1-V-05', 'VOCABULARY', 'B1', 'The company wants an ___ manager with at least five years in the job.', '["experienced", "experiencing", "expert", "expertise"]', 0),
('B1-V-06', 'VOCABULARY', 'B1', 'He apologised ___ being late for the interview.', '["about", "for", "of", "to"]', 1),
('B1-V-07', 'VOCABULARY', 'B1', 'We need to ___ a decision before Friday.', '["do", "have", "make", "put"]', 2),
('B1-V-08', 'VOCABULARY', 'B1', 'Food prices have ___ sharply this year.', '["raised", "arisen", "aroused", "risen"]', 3),
-- B2 grammar: third conditional / verb patterns / inversion with "not only" / wishes / future perfect passive / "it's time" / comparatives
('B2-G-01', 'GRAMMAR', 'B2', 'If I ___ about the traffic, I would have left earlier.', '["had known", "knew", "would know", "have known"]', 0),
('B2-G-02', 'GRAMMAR', 'B2', 'She suggested ___ a taxi to the airport.', '["to take", "taking", "take", "to taking"]', 1),
('B2-G-03', 'GRAMMAR', 'B2', 'Not only ___ late, but he also forgot the tickets.', '["he was", "he did", "was he", "did he was"]', 2),
('B2-G-04', 'GRAMMAR', 'B2', 'Now I wish I ___ harder when I was at school.', '["studied", "would study", "have studied", "had studied"]', 3),
('B2-G-05', 'GRAMMAR', 'B2', 'The report ___ by the time the manager arrives tomorrow.', '["will have been finished", "will be finishing", "has finished", "would finish"]', 0),
('B2-G-06', 'GRAMMAR', 'B2', 'He denied ___ the money from the office.', '["to steal", "stealing", "steal", "to stealing"]', 1),
('B2-G-07', 'GRAMMAR', 'B2', 'It''s high time we ___ home; it''s nearly midnight.', '["go", "will go", "went", "going"]', 2),
('B2-G-08', 'GRAMMAR', 'B2', 'The more you practise, ___ you will become.', '["more confident", "the most confident", "most confident", "the more confident"]', 3),
-- B2 vocabulary: academic / work collocations, phrasal verbs, confusable adjectives
('B2-V-01', 'VOCABULARY', 'B2', 'The government has ___ a new law to reduce plastic waste.', '["introduced", "invented", "produced", "discovered"]', 0),
('B2-V-02', 'VOCABULARY', 'B2', 'Her speech made a lasting ___ on the audience.', '["expression", "impression", "opinion", "sensation"]', 1),
('B2-V-03', 'VOCABULARY', 'B2', 'We need to ___ into account the cost of transport.', '["put", "bring", "take", "make"]', 2),
('B2-V-04', 'VOCABULARY', 'B2', 'His instructions were so ___ that nobody knew what to do.', '["vivid", "valid", "vain", "vague"]', 3),
('B2-V-05', 'VOCABULARY', 'B2', 'She was ___ of stealing money from the company.', '["accused", "blamed", "criticised", "complained"]', 0),
('B2-V-06', 'VOCABULARY', 'B2', 'We''ve ___ out of coffee; could you buy some on your way home?', '["gone", "run", "come", "got"]', 1),
('B2-V-07', 'VOCABULARY', 'B2', 'The new policy will have a significant ___ on small businesses.', '["affect", "effort", "impact", "input"]', 2),
('B2-V-08', 'VOCABULARY', 'B2', 'Because of falling sales, the factory had to ___ 200 workers.', '["lay down", "lay out", "lay by", "lay off"]', 3),
-- C1 grammar: inverted conditionals / negative inversion / non-defining relatives / subjunctive / participle clauses / cleft
('C1-G-01', 'GRAMMAR', 'C1', 'Had I known about the problem, I ___ something about it.', '["would have done", "would do", "had done", "will have done"]', 0),
('C1-G-02', 'GRAMMAR', 'C1', 'Rarely ___ such a talented young musician.', '["I have seen", "have I seen", "I saw", "did I saw"]', 1),
('C1-G-03', 'GRAMMAR', 'C1', 'The proposal, ___ was rejected by the board last year, has now been revised.', '["that", "what", "which", "whose"]', 2),
('C1-G-04', 'GRAMMAR', 'C1', 'The committee recommended that the plan ___ postponed until spring.', '["been", "being", "to be", "be"]', 3),
('C1-G-05', 'GRAMMAR', 'C1', '___ the circumstances, we had no choice but to cancel the event.', '["Given", "Giving", "To give", "Having given"]', 0),
('C1-G-06', 'GRAMMAR', 'C1', 'No sooner had we sat down ___ the lights went out.', '["when", "than", "then", "as"]', 1),
('C1-G-07', 'GRAMMAR', 'C1', 'The suspect is believed ___ the country last week.', '["to leave", "leaving", "to have left", "that he left"]', 2),
('C1-G-08', 'GRAMMAR', 'C1', 'It was not until midnight ___ the election results were announced.', '["when", "which", "then", "that"]', 3),
-- C1 vocabulary: precise academic / formal lexis and collocations
('C1-V-01', 'VOCABULARY', 'C1', 'All flights were cancelled due to ___ weather conditions.', '["adverse", "averse", "diverse", "inverse"]', 0),
('C1-V-02', 'VOCABULARY', 'C1', 'The evidence was ___ to prove that he was guilty.', '["ineffective", "insufficient", "inefficient", "incompetent"]', 1),
('C1-V-03', 'VOCABULARY', 'C1', 'Her argument was seriously ___ by a lack of reliable data.', '["underlined", "undertaken", "undermined", "underestimated"]', 2),
('C1-V-04', 'VOCABULARY', 'C1', 'After the scandal, the minister was forced to ___.', '["step up", "step in", "step on", "step down"]', 3),
('C1-V-05', 'VOCABULARY', 'C1', 'We need a ___ solution to the energy crisis, not just a temporary fix.', '["sustainable", "sustained", "sustaining", "sustenance"]', 0),
('C1-V-06', 'VOCABULARY', 'C1', 'His controversial comments ___ a heated debate on social media.', '["sparkled", "sparked", "spotted", "sprouted"]', 1),
('C1-V-07', 'VOCABULARY', 'C1', 'The novel ___ the struggles of immigrant families in the 1920s.', '["deputes", "deposits", "depicts", "deploys"]', 2),
('C1-V-08', 'VOCABULARY', 'C1', 'She has a ___ knowledge of medieval history.', '["profuse", "prolific", "profane", "profound"]', 3)
ON CONFLICT (question_key) DO NOTHING;

-- Thi đua board (as V59) + placement eligibility + unique ranks.
DROP MATERIALIZED VIEW IF EXISTS public.mv_activity_rank;

CREATE MATERIALIZED VIEW public.mv_activity_rank AS
WITH st AS (
    SELECT s.time_zone, s.activity_start_at, s.as_of, s.excluded_user_ids, s.require_placement
    FROM public.leaderboard_refresh_state s
    WHERE s.name = 'LEADERBOARD' AND s.activity_start_at IS NOT NULL AND s.as_of IS NOT NULL
), b AS (
    SELECT (date_trunc('week', st.as_of AT TIME ZONE st.time_zone))::date AS week_start,
           (date_trunc('month', st.as_of AT TIME ZONE st.time_zone))::date AS month_start,
           (st.activity_start_at AT TIME ZONE st.time_zone)::date AS start_day,
           (st.as_of AT TIME ZONE st.time_zone)::date AS today
    FROM st
), periods AS (
    SELECT 'WEEK'::VARCHAR(10) AS period, b.week_start AS period_start,
           GREATEST(b.week_start, b.start_day) AS from_day, b.today FROM b
    UNION ALL
    SELECT 'MONTH'::VARCHAR(10), b.month_start, GREATEST(b.month_start, b.start_day), b.today FROM b
    UNION ALL
    SELECT 'ALL_TIME'::VARCHAR(10), b.start_day, b.start_day, b.today FROM b
), eligible AS (
    SELECT u.id FROM public.users u, st
    WHERE u.role <> 'ROLE_ADMIN' AND u.account_status = 'ACTIVE' AND NOT (u.id = ANY(st.excluded_user_ids))
      AND (NOT st.require_placement OR EXISTS (
              SELECT 1 FROM public.proficiency_placement_attempt pa WHERE pa.user_id = u.id AND pa.status = 'VALID'))
), agg AS (
    SELECT p.period, p.period_start, d.user_id, g.grp,
           ROUND(SUM(d.points))::INTEGER AS points, MAX(d.last_point_at) AS reached_at
    FROM periods p
    JOIN public.leaderboard_activity_daily d ON d.day >= p.from_day AND d.day <= p.today
    JOIN eligible e ON e.id = d.user_id
    CROSS JOIN LATERAL (VALUES ('ALL'::VARCHAR(10)), (d.skill_group::VARCHAR(10))) AS g(grp)
    WHERE d.points > 0
    GROUP BY p.period, p.period_start, d.user_id, g.grp
), scoped AS (
    SELECT a.period, a.period_start, 'GLOBAL'::VARCHAR(10) AS scope, a.grp, a.user_id, a.points, a.reached_at
    FROM agg a
    UNION ALL
    SELECT a.period, a.period_start, dl.division, a.grp, a.user_id, a.points, a.reached_at
    FROM agg a JOIN public.leaderboard_division_level dl ON dl.user_id = a.user_id
    WHERE dl.division IS NOT NULL
)
SELECT s.period, s.period_start, s.scope, s.grp, s.user_id, s.points, s.reached_at,
       (ROW_NUMBER() OVER (PARTITION BY s.period, s.scope, s.grp
                           ORDER BY s.points DESC, s.reached_at ASC, s.user_id ASC))::INTEGER AS rank
FROM scoped s
WHERE s.points > 0
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_activity_rank
    ON public.mv_activity_rank (period, scope, grp, user_id);
CREATE INDEX IF NOT EXISTS ix_mv_activity_rank_top
    ON public.mv_activity_rank (period, scope, grp, rank);
