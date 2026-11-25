-- Daily document-recognition allowance (owner 2026-10-18, follow-up of V99): the 20 documents per account and day that
-- Reading uploads and the Listening document extraction may send to the AI host's text recognition (ReadingImportGuard)
-- were counted in process memory and started again at every backend restart. This ledger makes the count durable and
-- shared by every backend process. One row per document that was handed to recognition; a row is only ever settled
-- (STARTED -> SUCCEEDED / FAILED / NOT_SENT), never deleted. The day is counted by creation time from local midnight
-- (Asia/Ho_Chi_Minh), so nothing is reset. No document name, text or content is stored. Additive only.
CREATE TABLE IF NOT EXISTS public.document_recognition_usage (
    id         BIGSERIAL    PRIMARY KEY,
    user_id    BIGINT       NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
    status     VARCHAR(16)  NOT NULL DEFAULT 'STARTED'
               CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED', 'NOT_SENT')),
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ
);

-- The daily count of one account: rows since local midnight.
CREATE INDEX IF NOT EXISTS idx_document_recognition_usage_day
    ON public.document_recognition_usage (user_id, created_at);
