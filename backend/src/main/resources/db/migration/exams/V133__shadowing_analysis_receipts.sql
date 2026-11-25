CREATE TABLE public.shadowing_analysis_receipts (
    user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    attempt_key varchar(100) NOT NULL,
    session_id bigint NOT NULL REFERENCES public.speaking_sessions(id) ON DELETE CASCADE,
    unit_id bigint NOT NULL REFERENCES public.speaking_shadowing_units(id) ON DELETE CASCADE,
    audio_sha256 char(64) NOT NULL,
    result_json text NOT NULL,
    PRIMARY KEY (user_id, attempt_key)
);
CREATE INDEX shadowing_receipts_session ON public.shadowing_analysis_receipts(session_id);
CREATE INDEX shadowing_receipts_unit ON public.shadowing_analysis_receipts(unit_id);
