-- Echo Messenger: one-to-one conversations between English Coach accounts. A friend is someone who follows you back in Community
-- (community_follows, V56): no second friendship table. Every owner foreign key is RESTRICT (AGENTS §21); the application role has DML only.

CREATE TABLE public.messenger_conversations (
    id UUID PRIMARY KEY,
    user_low BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    user_high BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    last_message_id BIGINT,
    last_message_at TIMESTAMPTZ,
    low_read_id BIGINT NOT NULL DEFAULT 0,
    high_read_id BIGINT NOT NULL DEFAULT 0,
    low_delivered_id BIGINT NOT NULL DEFAULT 0,
    high_delivered_id BIGINT NOT NULL DEFAULT 0,
    -- Removing a conversation hides what is in it for that person only, up to this message.
    low_hidden_id BIGINT NOT NULL DEFAULT 0,
    high_hidden_id BIGINT NOT NULL DEFAULT 0,
    low_muted BOOLEAN NOT NULL DEFAULT FALSE,
    high_muted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_messenger_pair UNIQUE (user_low, user_high),
    CONSTRAINT chk_messenger_pair CHECK (user_low < user_high)
);
CREATE INDEX idx_messenger_conversations_low ON public.messenger_conversations (user_low, last_message_at DESC NULLS LAST);
CREATE INDEX idx_messenger_conversations_high ON public.messenger_conversations (user_high, last_message_at DESC NULLS LAST);

CREATE TABLE public.messenger_messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES public.messenger_conversations(id) ON DELETE RESTRICT,
    sender_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    kind VARCHAR(16) NOT NULL DEFAULT 'TEXT',
    body VARCHAR(4000) NOT NULL,
    payload JSONB,
    client_ref UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_messenger_client_ref UNIQUE (sender_id, client_ref),
    CONSTRAINT chk_messenger_kind CHECK (kind IN ('TEXT', 'ARENA_INVITE', 'SHARE_READING', 'SHARE_DECK'))
);
CREATE INDEX idx_messenger_messages_conversation ON public.messenger_messages (conversation_id, id DESC);

CREATE TABLE public.messenger_blocks (
    blocker_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    blocked_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id),
    CONSTRAINT chk_messenger_no_self_block CHECK (blocker_id <> blocked_id)
);
CREATE INDEX idx_messenger_blocks_blocked ON public.messenger_blocks (blocked_id);

-- An invitation is a message with a state. The Arena room itself stays in memory, like every Arena room: only its code is kept here.
CREATE TABLE public.messenger_arena_invites (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES public.messenger_conversations(id) ON DELETE RESTRICT,
    message_id BIGINT NOT NULL UNIQUE REFERENCES public.messenger_messages(id) ON DELETE RESTRICT,
    inviter_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    invitee_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    mode VARCHAR(8) NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    room_code VARCHAR(8),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    responded_at TIMESTAMPTZ,
    CONSTRAINT chk_messenger_invite_status CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED')),
    CONSTRAINT chk_messenger_invite_mode CHECK (mode IN ('FREE', 'GUIDED', 'DUEL')),
    CONSTRAINT chk_messenger_invite_people CHECK (inviter_id <> invitee_id)
);
CREATE INDEX idx_messenger_invites_invitee ON public.messenger_arena_invites (invitee_id, status, expires_at);
CREATE UNIQUE INDEX uq_messenger_invite_pending ON public.messenger_arena_invites (conversation_id) WHERE status = 'PENDING';
