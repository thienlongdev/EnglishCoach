-- V35__notifications_core.sql
-- Notification Core: GLOBAL and USER notifications with user interaction states

CREATE TABLE IF NOT EXISTS public.notifications (
    id BIGSERIAL PRIMARY KEY,
    scope VARCHAR(16) NOT NULL,
    type VARCHAR(32) NOT NULL,
    target_user_id BIGINT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    title VARCHAR(255) NOT NULL,
    body VARCHAR(2000) NOT NULL,
    action_url VARCHAR(512) NULL,
    publish_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NULL,
    created_by_user_id BIGINT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_notifications_scope CHECK (scope IN ('GLOBAL', 'USER')),
    CONSTRAINT chk_notifications_scope_target CHECK (
        (scope = 'GLOBAL' AND target_user_id IS NULL) OR
        (scope = 'USER' AND target_user_id IS NOT NULL)
    ),
    CONSTRAINT chk_notifications_expires_after_publish CHECK (
        expires_at IS NULL OR expires_at > publish_at
    )
);

CREATE TABLE IF NOT EXISTS public.notification_user_states (
    notification_id BIGINT NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    read_at TIMESTAMPTZ NULL,
    dismissed_at TIMESTAMPTZ NULL,
    PRIMARY KEY (notification_id, user_id)
);

-- Partial and standard indexes for visibility queries
CREATE INDEX IF NOT EXISTS idx_notifications_user_target_publish
    ON public.notifications(target_user_id, publish_at DESC)
    WHERE scope = 'USER';

CREATE INDEX IF NOT EXISTS idx_notifications_global_publish
    ON public.notifications(publish_at DESC)
    WHERE scope = 'GLOBAL';

CREATE INDEX IF NOT EXISTS idx_notifications_publish_expires
    ON public.notifications(publish_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_notif_user_states_user
    ON public.notification_user_states(user_id, read_at, dismissed_at);
