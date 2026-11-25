-- Durable owner-bound replay for explicit Professor questions. No learner data is rewritten.
-- Each successful receipt and its quota settlement commit together; the provider runs outside transactions.
CREATE TABLE public.grammar_professor_receipt (
    user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    request_id varchar(128) NOT NULL,
    request_hash varchar(64) NOT NULL,
    status varchar(16) NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED')),
    reservation_id bigint REFERENCES public.premium_ai_usage(id) ON DELETE RESTRICT,
    response jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, request_id),
    CONSTRAINT ck_grammar_professor_response CHECK ((status = 'COMPLETED') = (response IS NOT NULL))
);
