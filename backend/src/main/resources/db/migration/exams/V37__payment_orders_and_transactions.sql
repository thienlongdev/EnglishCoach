-- V37__payment_orders_and_transactions.sql
-- Phase E: Payment Orders, Webhook Transactions, and SePay Integration

-- 1. Payment Orders Table
CREATE TABLE IF NOT EXISTS public.payment_orders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    plan_id BIGINT NOT NULL REFERENCES public.premium_plans(id) ON DELETE RESTRICT,
    plan_code_snapshot VARCHAR(64) NOT NULL,
    plan_name_snapshot VARCHAR(128) NOT NULL,
    duration_months_snapshot INT NOT NULL,
    amount_vnd BIGINT NOT NULL,
    currency VARCHAR(16) NOT NULL DEFAULT 'VND',
    transfer_code VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    provider VARCHAR(32) NOT NULL DEFAULT 'SEPAY',
    expires_at TIMESTAMPTZ NOT NULL,
    paid_at TIMESTAMPTZ NULL,
    provider_transaction_id VARCHAR(128) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_payment_orders_status CHECK (status IN ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED')),
    CONSTRAINT chk_payment_orders_amount CHECK (amount_vnd > 0),
    CONSTRAINT chk_payment_orders_duration CHECK (duration_months_snapshot > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_orders_transfer_code 
    ON public.payment_orders(transfer_code);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user_status_created 
    ON public.payment_orders(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_orders_pending_expires 
    ON public.payment_orders(status, expires_at);

-- 2. Payment Transactions Table (Webhook Inbox & Provider Audit)
CREATE TABLE IF NOT EXISTS public.payment_transactions (
    id BIGSERIAL PRIMARY KEY,
    provider VARCHAR(32) NOT NULL DEFAULT 'SEPAY',
    provider_transaction_id VARCHAR(128) NOT NULL,
    gateway VARCHAR(64) NULL,
    transaction_date TIMESTAMPTZ NULL,
    account_number VARCHAR(64) NOT NULL,
    sub_account VARCHAR(64) NULL,
    payment_code VARCHAR(64) NULL,
    content VARCHAR(512) NULL,
    transfer_type VARCHAR(32) NOT NULL,
    transfer_amount_vnd BIGINT NOT NULL,
    reference_code VARCHAR(128) NULL,
    raw_payload TEXT NULL,
    processing_status VARCHAR(32) NOT NULL DEFAULT 'RECEIVED',
    matched_payment_order_id BIGINT NULL REFERENCES public.payment_orders(id) ON DELETE RESTRICT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ NULL,
    error_message VARCHAR(512) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_payment_transactions_status CHECK (processing_status IN ('RECEIVED', 'PROCESSING', 'MATCHED', 'UNMATCHED', 'IGNORED', 'PROCESSED', 'FAILED')),
    CONSTRAINT chk_payment_transactions_amount CHECK (transfer_amount_vnd >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_transactions_provider_tx_id 
    ON public.payment_transactions(provider_transaction_id);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_status 
    ON public.payment_transactions(processing_status);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_matched_order 
    ON public.payment_transactions(matched_payment_order_id);
