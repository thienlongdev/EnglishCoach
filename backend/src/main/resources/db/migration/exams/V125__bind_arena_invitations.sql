-- Room IDs are ephemeral. Ordinary Messenger invitations keep their existing two-person reservation behavior.
ALTER TABLE public.messenger_arena_invites ADD COLUMN target_room_id uuid;
ALTER TABLE public.messenger_arena_invites DROP CONSTRAINT chk_messenger_invite_mode;
ALTER TABLE public.messenger_arena_invites ADD CONSTRAINT chk_messenger_invite_mode CHECK(mode IN ('FREE','GUIDED','DUEL','TEAM'));
CREATE INDEX idx_messenger_invites_target ON public.messenger_arena_invites(inviter_id,target_room_id) WHERE target_room_id IS NOT NULL;
