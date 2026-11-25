-- Echo Sentinel coverage (owner directive 2026-11-14): exam simulations, Card Blast solo and 1v1. Additive.
-- Activation boundary per activity: results created BEFORE it keep their historical rules (prospective enforcement only;
-- no historical exam, run, match or ranking row is re-evaluated). Rows are permanent.
CREATE TABLE public.sentinel_activation (
    activity VARCHAR(40) PRIMARY KEY,
    active_from TIMESTAMPTZ NOT NULL
);
INSERT INTO public.sentinel_activation(activity, active_from) VALUES
    ('KING_CONQUEST', now()), ('EXAM_SIMULATION', now()), ('CARD_BLAST_SOLO', now()), ('CARD_BLAST_PVP', now());
CREATE FUNCTION public.sentinel_activation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'sentinel_activation rows are permanent';
END $$;
CREATE TRIGGER trg_sentinel_activation_guard BEFORE UPDATE OR DELETE ON public.sentinel_activation
    FOR EACH ROW EXECUTE FUNCTION public.sentinel_activation_guard();

-- One strict attempt per exam attempt, ever: a reloaded page or another tab can never bind the same exam again.
CREATE UNIQUE INDEX ux_sentinel_exam_subject ON public.sentinel_attempts(subject_ref)
    WHERE activity = 'EXAM_SIMULATION' AND subject_ref IS NOT NULL;
-- V94 default privileges give the runtime role rows-only access; no runtime DDL.
