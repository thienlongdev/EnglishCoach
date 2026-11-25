-- Echo Messenger, next generation: replies, reactions, unsend, attachments, conversation themes, groups, per-person
-- conversation choices (pin, archive, timed mute, marked unread), restricting a person, activity status.
-- Additive only: every existing conversation and message keeps its row and its meaning. Every owner foreign key is
-- RESTRICT (AGENTS §21); the application role has DML only (default privileges of V94 cover the new tables).

-- ── Conversations: a kind, a shared theme, and (groups only) a name and a picture ─────────────────────────────
ALTER TABLE public.messenger_conversations
    ADD COLUMN kind VARCHAR(6) NOT NULL DEFAULT 'DIRECT',
    ADD COLUMN title VARCHAR(80),
    ADD COLUMN avatar_key VARCHAR(120),
    ADD COLUMN avatar_version INT NOT NULL DEFAULT 0,
    -- Shared by everyone in the conversation, like its name: changing it is said in the conversation.
    ADD COLUMN theme VARCHAR(16) NOT NULL DEFAULT 'pearl',
    ADD COLUMN created_by BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    ALTER COLUMN user_low DROP NOT NULL,
    ALTER COLUMN user_high DROP NOT NULL,
    ADD CONSTRAINT chk_messenger_kind_shape CHECK (
        (kind = 'DIRECT' AND user_low IS NOT NULL AND user_high IS NOT NULL AND title IS NULL)
        OR (kind = 'GROUP' AND user_low IS NULL AND user_high IS NULL AND title IS NOT NULL AND created_by IS NOT NULL)),
    ADD CONSTRAINT chk_messenger_theme CHECK (theme ~ '^[a-z]{3,16}$');

-- ── Messages: a reply names the message it answers; an unsent message keeps its place and loses its words ────
ALTER TABLE public.messenger_messages
    ADD COLUMN reply_to BIGINT REFERENCES public.messenger_messages(id) ON DELETE RESTRICT,
    ADD COLUMN deleted_at TIMESTAMPTZ,
    DROP CONSTRAINT chk_messenger_kind,
    ADD CONSTRAINT chk_messenger_kind CHECK (kind IN ('TEXT', 'ARENA_INVITE', 'SHARE_READING', 'SHARE_DECK', 'SYSTEM'));

-- ── Reactions: one per person per message (changing it replaces it) ─────────────────────────────────────────
CREATE TABLE public.messenger_reactions (
    message_id BIGINT NOT NULL REFERENCES public.messenger_messages(id) ON DELETE RESTRICT,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    emoji VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id)
);

-- ── Attachments: the bytes live on the storage volume under storage_key; this row is who may read them ──────
-- message_id is null while the file waits in the composer; such a row is removed with its file after an hour.
CREATE TABLE public.messenger_attachments (
    id UUID PRIMARY KEY,
    owner_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    conversation_id UUID NOT NULL REFERENCES public.messenger_conversations(id) ON DELETE RESTRICT,
    message_id BIGINT REFERENCES public.messenger_messages(id) ON DELETE RESTRICT,
    position SMALLINT NOT NULL DEFAULT 0,
    kind VARCHAR(5) NOT NULL,
    file_name VARCHAR(160) NOT NULL,
    mime VARCHAR(100) NOT NULL,
    size_bytes INT NOT NULL,
    width INT,
    height INT,
    storage_key VARCHAR(120) NOT NULL,
    thumb_key VARCHAR(120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at TIMESTAMPTZ,
    CONSTRAINT chk_messenger_attachment_kind CHECK (kind IN ('IMAGE', 'FILE')),
    CONSTRAINT chk_messenger_attachment_size CHECK (size_bytes > 0 AND size_bytes <= 10485760)
);
CREATE INDEX idx_messenger_attachments_message ON public.messenger_attachments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_messenger_attachments_pending ON public.messenger_attachments (created_at) WHERE message_id IS NULL;
CREATE INDEX idx_messenger_attachments_owner ON public.messenger_attachments (owner_id, created_at) WHERE removed_at IS NULL;
CREATE INDEX idx_messenger_attachments_conversation ON public.messenger_attachments (conversation_id, created_at DESC) WHERE message_id IS NOT NULL AND removed_at IS NULL;

-- ── Groups: who is in, since which message, and their own marks for that group ─────────────────────────────
CREATE TABLE public.messenger_members (
    conversation_id UUID NOT NULL REFERENCES public.messenger_conversations(id) ON DELETE RESTRICT,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    role VARCHAR(6) NOT NULL DEFAULT 'MEMBER',
    added_by BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at TIMESTAMPTZ,
    -- Someone who joins later reads from here on; what was said before stays with those who were there.
    since_id BIGINT NOT NULL DEFAULT 0,
    read_id BIGINT NOT NULL DEFAULT 0,
    hidden_id BIGINT NOT NULL DEFAULT 0,
    muted_until TIMESTAMPTZ,
    pinned_at TIMESTAMPTZ,
    archived_id BIGINT NOT NULL DEFAULT 0,
    marked_unread BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (conversation_id, user_id),
    CONSTRAINT chk_messenger_member_role CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER'))
);
CREATE INDEX idx_messenger_members_user ON public.messenger_members (user_id) WHERE left_at IS NULL;

-- ── One-to-one conversations: a person's own choices (the row appears only when one is made) ───────────────
CREATE TABLE public.messenger_prefs (
    conversation_id UUID NOT NULL REFERENCES public.messenger_conversations(id) ON DELETE RESTRICT,
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    muted_until TIMESTAMPTZ,
    pinned_at TIMESTAMPTZ,
    -- Archived while nothing newer than this message has arrived: a new message brings the conversation back without a write.
    archived_id BIGINT NOT NULL DEFAULT 0,
    marked_unread BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_messenger_prefs_user ON public.messenger_prefs (user_id);

-- ── Restricting: quieter than blocking. Their messages wait aside, without a notice, a read mark or my activity ──
CREATE TABLE public.messenger_restrictions (
    user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    restricted_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, restricted_id),
    CONSTRAINT chk_messenger_no_self_restrict CHECK (user_id <> restricted_id)
);
CREATE INDEX idx_messenger_restrictions_target ON public.messenger_restrictions (restricted_id);

-- ── Activity status: last seen is written when the last page of a person closes, never while they are online ──
ALTER TABLE public.messenger_directory
    ADD COLUMN show_activity BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN last_seen_at TIMESTAMPTZ;
