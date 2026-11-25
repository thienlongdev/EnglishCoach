-- V63__placement_quiz_division_level.sql
-- Leaderboard prod pipeline Stage 3 — "Bài xếp lớp nhanh" (placement quiz, Proficiency pipeline) and the division
-- level with placement precedence. score_events / proficiency_evidence / skill_proficiency / user_proficiency untouched:
-- placement creates NO evidence and changes NO rating, confidence, peak or relativeMult.
--   * proficiency_placement_item    : quiz pool — REAL words (dictionary_entries, single CEFR label A1–C1, common single
--                                     words) + 200 PSEUDO words (fixed seed 20261001, dictionary + one-letter-distance +
--                                     offensive-substring filtered offline; re-checked against dictionary_entries here).
--   * proficiency_placement_issue   : item list issued by the server for one attempt (append-only).
--   * proficiency_placement_attempt : scored submission (answers, FA, per-level rates, result, VALID/INVALID; append-only).
--   * leaderboard_division_promotion: anti-sandbagging promotions of placement-based divisions (append-only, never lowers).
--   * leaderboard_division_level    : VERIFIED/STALE → PROVISIONAL current_cefr → latest VALID placement (+ promotions);
--                                     floor max(level, peak − 1); no row = no level (Bảng chung only).

CREATE TABLE IF NOT EXISTS public.proficiency_placement_item (
    id BIGSERIAL PRIMARY KEY,
    word VARCHAR(40) NOT NULL,
    kind VARCHAR(10) NOT NULL,
    cefr VARCHAR(2) NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_proficiency_placement_item_word UNIQUE (word),
    CONSTRAINT ck_proficiency_placement_item_kind CHECK (kind IN ('REAL', 'PSEUDO')),
    CONSTRAINT ck_proficiency_placement_item_cefr CHECK (
        (kind = 'REAL' AND cefr IN ('A1', 'A2', 'B1', 'B2', 'C1')) OR (kind = 'PSEUDO' AND cefr IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_proficiency_placement_item_pool ON public.proficiency_placement_item (kind, cefr) WHERE active;

CREATE TABLE IF NOT EXISTS public.proficiency_placement_issue (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    items JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proficiency_placement_issue_user ON public.proficiency_placement_issue (user_id, created_at);

CREATE TABLE IF NOT EXISTS public.proficiency_placement_attempt (
    id BIGSERIAL PRIMARY KEY,
    issue_id UUID NOT NULL REFERENCES public.proficiency_placement_issue(id) ON DELETE RESTRICT,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    items JSONB NOT NULL,
    answers JSONB NOT NULL,
    fa NUMERIC(4, 3) NOT NULL,
    level_rates JSONB NOT NULL,
    result_cefr VARCHAR(2) NULL,
    low_confidence BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(10) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_proficiency_placement_attempt_issue UNIQUE (issue_id),
    CONSTRAINT ck_proficiency_placement_attempt_status CHECK (status IN ('VALID', 'INVALID')),
    CONSTRAINT ck_proficiency_placement_attempt_result CHECK (
        (status = 'VALID' AND result_cefr IN ('A1', 'A2', 'B1', 'B2', 'C1')) OR (status = 'INVALID' AND result_cefr IS NULL)),
    CONSTRAINT ck_proficiency_placement_attempt_fa CHECK (fa >= 0 AND fa <= 1)
);
CREATE INDEX IF NOT EXISTS idx_proficiency_placement_attempt_user ON public.proficiency_placement_attempt (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.leaderboard_division_promotion (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    from_cefr VARCHAR(2) NOT NULL,
    to_cefr VARCHAR(2) NOT NULL,
    share NUMERIC(5, 4) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_leaderboard_division_promotion_up CHECK (public.fn_cefr_step(to_cefr) = public.fn_cefr_step(from_cefr) + 1)
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_division_promotion_user ON public.leaderboard_division_promotion (user_id, created_at DESC);

-- Append-only guards (placement history and promotions are never rewritten).
CREATE OR REPLACE FUNCTION public.fn_placement_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP;
END;
$$;
DROP TRIGGER IF EXISTS trg_proficiency_placement_issue_append_only ON public.proficiency_placement_issue;
CREATE TRIGGER trg_proficiency_placement_issue_append_only BEFORE UPDATE OR DELETE ON public.proficiency_placement_issue
    FOR EACH ROW EXECUTE FUNCTION public.fn_placement_append_only();
DROP TRIGGER IF EXISTS trg_proficiency_placement_attempt_append_only ON public.proficiency_placement_attempt;
CREATE TRIGGER trg_proficiency_placement_attempt_append_only BEFORE UPDATE OR DELETE ON public.proficiency_placement_attempt
    FOR EACH ROW EXECUTE FUNCTION public.fn_placement_append_only();
DROP TRIGGER IF EXISTS trg_leaderboard_division_promotion_append_only ON public.leaderboard_division_promotion;
CREATE TRIGGER trg_leaderboard_division_promotion_append_only BEFORE UPDATE OR DELETE ON public.leaderboard_division_promotion
    FOR EACH ROW EXECUTE FUNCTION public.fn_placement_append_only();

-- Pseudowords (never inserted when the word exists in dictionary_entries of this environment).
INSERT INTO public.proficiency_placement_item (word, kind, cefr)
SELECT v.w, 'PSEUDO', NULL
FROM (VALUES
('speltko'), ('droutdiff'), ('zeadzix'), ('wurnnol'), ('jokdoosk'), ('koartairn'), ('sloantkop'),
('drodpleeb'), ('houdkeesk'), ('spumnon'), ('mainsoff'), ('frouzooss'), ('trodfoog'), ('wourkip'),
('sountzall'), ('prigpeab'), ('bloukkint'), ('hernkelt'), ('chonddaip'), ('floamkeen'), ('skibzoang'),
('drertsea'), ('foornsut'), ('velreeb'), ('flaiglemp'), ('speskroup'), ('veetpim'), ('skourntax'),
('soolrust'), ('waimpzad'), ('sneempnup'), ('bloapom'), ('thangning'), ('brargoand'), ('dairnneax'),
('gourroll'), ('teebdoog'), ('snoadsing'), ('latkunt'), ('joobtrool'), ('groaveend'), ('gresair'),
('bubgull'), ('froomfort'), ('zinfee'), ('froondbut'), ('mostkoux'), ('chintmoab'), ('pournzunt'),
('koottoum'), ('staplusk'), ('doutzust'), ('slelbralt'), ('treltsool'), ('leampgomp'), ('jubzast'),
('trirsoar'), ('feangsea'), ('voagrad'), ('selramp'), ('mishfess'), ('skeakrep'), ('ploadvoon'),
('frirtoosh'), ('blomlux'), ('chemfoat'), ('zoumbai'), ('staimzoag'), ('mandrouss'), ('plimreet'),
('glagsosh'), ('fummoot'), ('choltfain'), ('doabvig'), ('plornrilt'), ('baltfead'), ('geeklead'),
('keestguss'), ('fringmoar'), ('kubzaimp'), ('terrooff'), ('meestrem'), ('lutdurn'), ('pampbouff'),
('jeemnish'), ('zannoam'), ('proukrim'), ('tigfoax'), ('koodzum'), ('flouptrog'), ('blougmosk'),
('snoupmeeb'), ('geampmist'), ('poamkourt'), ('voopleag'), ('zoultfern'), ('keemob'), ('lanzalt'),
('beemkam'), ('noustkind'), ('boogmun'), ('geegsult'), ('soshdeng'), ('boanvi'), ('poapair'), ('gookplam'),
('snoakkip'), ('birnleand'), ('speerntot'), ('brudtreg'), ('pembear'), ('goubtoll'), ('womprult'), ('pamund'),
('goltdeex'), ('soukkisk'), ('pailtloul'), ('drornkesk'), ('shoandkur'), ('peastdoam'), ('brungkib'),
('dushzug'), ('snapdip'), ('gleakpesh'), ('gairtrid'), ('snebmob'), ('sangsart'), ('shurgaill'),
('ploapvemp'), ('grombaill'), ('geastnid'), ('soustzill'), ('zeeproab'), ('froangtex'), ('jupoarn'),
('proultlul'), ('seaskmeap'), ('prenveern'), ('gaingbed'), ('greakned'), ('gleakploa'), ('roabpoust'),
('breegkunt'), ('brepvend'), ('vimfix'), ('zoadtrap'), ('zekdoap'), ('blantgu'), ('fentkem'), ('zeatbroon'),
('jeekplap'), ('snempgib'), ('pembor'), ('willool'), ('gunzout'), ('trengkesk'), ('grouglull'), ('daskzooss'),
('domvoop'), ('soapbeask'), ('zeegplull'), ('thastgolt'), ('hurnpeff'), ('chodou'), ('feantnast'),
('breatseab'), ('brostrert'), ('chivang'), ('chopbaff'), ('geadtai'), ('dristland'), ('runtraiss'),
('wartrig'), ('senbead'), ('stonkad'), ('soufid'), ('zairtroax'), ('vaidtroub'), ('noornkart'), ('flurnvam'),
('skongrur'), ('plenfailt'), ('mokkort'), ('pirnlat'), ('stertkir'), ('baidpeax'), ('shaintoan'),
('plogfoak'), ('grinlomp'), ('zashdall'), ('heestnilt'), ('grounmiff'), ('flearboul'), ('truskdern'),
('flozoask'), ('gliksood'), ('doontrin'), ('vealtset'), ('gabboamp'), ('naistzob')
) AS v(w)
WHERE NOT EXISTS (SELECT 1 FROM public.dictionary_entries d WHERE lower(d.word) = v.w)
ON CONFLICT (word) DO NOTHING;

-- Real words: common single words with exactly one CEFR label in A1–C1 (no phrases / proper nouns / duplicates).
INSERT INTO public.proficiency_placement_item (word, kind, cefr)
SELECT x.w, 'REAL', x.cefr
FROM (
    SELECT lower(d.word) AS w, MIN(upper(d.cefr)) AS cefr
    FROM public.dictionary_entries d
    WHERE d.entry_type = 'WORD' AND d.word ~ '^[a-z]{3,12}$' AND d.cefr IS NOT NULL
    GROUP BY lower(d.word)
    HAVING COUNT(DISTINCT upper(d.cefr)) = 1 AND MIN(upper(d.cefr)) IN ('A1', 'A2', 'B1', 'B2', 'C1')
) x
ON CONFLICT (word) DO NOTHING;

-- Division level with placement (same columns as V59, so dependants keep working).
CREATE OR REPLACE VIEW public.leaderboard_division_level AS
WITH prof AS (
    SELECT up.user_id,
           public.fn_cefr_of_step(GREATEST(public.fn_cefr_step(up.current_cefr),
                                           COALESCE(public.fn_cefr_step(up.peak_cefr) - 1, 0)))::VARCHAR(2) AS cefr,
           up.overall_status::VARCHAR(20) AS source
    FROM public.user_proficiency up
    WHERE up.overall_status IN ('VERIFIED', 'STALE', 'PROVISIONAL') AND up.current_cefr IS NOT NULL
), placement AS (
    SELECT DISTINCT ON (a.user_id) a.user_id, a.result_cefr AS cefr
    FROM public.proficiency_placement_attempt a
    WHERE a.status = 'VALID'
    ORDER BY a.user_id, a.created_at DESC, a.id DESC
), promoted AS (
    SELECT p.user_id, MAX(public.fn_cefr_step(p.to_cefr)) AS step
    FROM public.leaderboard_division_promotion p
    GROUP BY p.user_id
), placed AS (
    SELECT pl.user_id,
           public.fn_cefr_of_step(GREATEST(public.fn_cefr_step(pl.cefr), COALESCE(pr.step, 0),
                                           COALESCE(public.fn_cefr_step(up.peak_cefr) - 1, 0)))::VARCHAR(2) AS cefr,
           'PLACEMENT'::VARCHAR(20) AS source
    FROM placement pl
    LEFT JOIN promoted pr ON pr.user_id = pl.user_id
    LEFT JOIN public.user_proficiency up ON up.user_id = pl.user_id
    WHERE NOT EXISTS (SELECT 1 FROM prof WHERE prof.user_id = pl.user_id)
), x AS (
    SELECT * FROM prof
    UNION ALL
    SELECT * FROM placed
)
SELECT x.user_id, x.cefr, x.source, public.fn_leaderboard_division(public.fn_cefr_step(x.cefr)) AS division
FROM x;
