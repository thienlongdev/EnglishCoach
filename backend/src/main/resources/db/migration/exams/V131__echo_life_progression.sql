-- Keep paid upgrades and their retry receipts independent of the client-authored narrative.
ALTER TABLE public.echo_life_games
  ADD COLUMN workshop jsonb CHECK (workshop IS NULL OR jsonb_typeof(workshop) = 'object'),
  ADD COLUMN workshop_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE public.echo_life_operations (
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  request_id varchar(80) NOT NULL,
  operation jsonb NOT NULL,
  PRIMARY KEY (user_id, request_id)
);
