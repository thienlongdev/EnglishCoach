-- V44__feedback_system.sql
-- Two-way Feedback System: Conversation Threads & Messages

CREATE TABLE IF NOT EXISTS public.feedback_threads (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    category VARCHAR(30) NOT NULL DEFAULT 'OTHER',
    subject VARCHAR(120) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    admin_unread BOOLEAN NOT NULL DEFAULT TRUE,
    user_unread BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.feedback_messages (
    id BIGSERIAL PRIMARY KEY,
    thread_id BIGINT NOT NULL REFERENCES public.feedback_threads(id) ON DELETE CASCADE,
    sender_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    from_admin BOOLEAN NOT NULL DEFAULT FALSE,
    content VARCHAR(2000) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fb_threads_user ON public.feedback_threads(user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_fb_threads_admin_inbox ON public.feedback_threads(last_message_at DESC) WHERE status <> 'CLOSED';
CREATE INDEX IF NOT EXISTS idx_fb_threads_unread ON public.feedback_threads(admin_unread) WHERE admin_unread = TRUE;
CREATE INDEX IF NOT EXISTS idx_fb_messages_thread ON public.feedback_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fb_messages_rate ON public.feedback_messages(sender_user_id, created_at DESC);
