-- Echo Messenger: finding people and writing to someone who is not a friend yet. No extension: Azure allows neither pg_trgm nor unaccent here, so a name is folded to
-- plain letters (Vietnamese marks off, never an address) and every word's first letters are kept in an array with a GIN index. Friendship stays the Community follow (V56).

CREATE FUNCTION public.ec_fold_name(raw TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(lower(translate(regexp_replace(normalize(coalesce(raw, ''), NFD), '[̀-ͯ]', '', 'g'), 'đĐ', 'dD')), '[^a-z0-9]+', ' ', 'g'))
$$;

CREATE FUNCTION public.ec_name_prefixes(fold TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT left(w, n)), '{}'::text[])
  FROM unnest(string_to_array(fold, ' ')) AS w
  CROSS JOIN LATERAL generate_series(2, least(length(w), 12)) AS n
$$;

CREATE TABLE public.messenger_directory (
    user_id BIGINT PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
    username VARCHAR(24) NOT NULL,
    name_prefixes TEXT[] NOT NULL DEFAULT '{}',
    -- EVERYONE: a stranger's first messages wait in Requests. FRIENDS: only friends can start a conversation.
    message_policy VARCHAR(8) NOT NULL DEFAULT 'EVERYONE',
    -- False: found only by the exact @username.
    discoverable BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_messenger_username CHECK (username ~ '^[a-z0-9][a-z0-9_.]{2,23}$'),
    CONSTRAINT chk_messenger_message_policy CHECK (message_policy IN ('EVERYONE', 'FRIENDS'))
);
-- Serves both = and LIKE 'prefix%' whatever the database's collation is.
CREATE UNIQUE INDEX uq_messenger_directory_username ON public.messenger_directory (username varchar_pattern_ops);
CREATE INDEX idx_messenger_directory_prefixes ON public.messenger_directory USING GIN (name_prefixes);

-- The public name is the profile's, then the account's, never an address. A new row gets a username of its own, which its owner can change.
CREATE FUNCTION public.messenger_directory_sync(uid BIGINT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  shown TEXT;
  fold TEXT;
  base TEXT;
  wanted TEXT;
  tries INT := 0;
BEGIN
  SELECT coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(u.name), '')) INTO shown
  FROM public.users u LEFT JOIN public.user_profiles p ON p.user_id = u.id WHERE u.id = uid;
  IF shown IS NULL OR position('@' IN shown) > 0 THEN shown := ''; END IF;
  fold := public.ec_fold_name(left(shown, 120));
  UPDATE public.messenger_directory SET name_prefixes = public.ec_name_prefixes(fold), updated_at = now() WHERE user_id = uid;
  IF FOUND THEN RETURN; END IF;
  base := left(replace(fold, ' ', ''), 15);
  IF length(base) < 3 THEN base := 'hocvien'; END IF;
  wanted := left(base || '_' || uid, 24);
  WHILE EXISTS (SELECT 1 FROM public.messenger_directory d WHERE d.username = wanted) LOOP
    tries := tries + 1;
    wanted := left(left(base, 8) || '_' || uid || '_' || tries, 24);
  END LOOP;
  INSERT INTO public.messenger_directory (user_id, username, name_prefixes) VALUES (uid, wanted, public.ec_name_prefixes(fold)) ON CONFLICT (user_id) DO NOTHING;
END $$;

CREATE FUNCTION public.messenger_directory_user_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.messenger_directory_sync(NEW.id);
  RETURN NULL;
END $$;

CREATE FUNCTION public.messenger_directory_profile_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.messenger_directory_sync(NEW.user_id);
  RETURN NULL;
END $$;

CREATE TRIGGER trg_messenger_directory_user_new AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.messenger_directory_user_changed();
CREATE TRIGGER trg_messenger_directory_user_name AFTER UPDATE OF name ON public.users
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name) EXECUTE FUNCTION public.messenger_directory_user_changed();
CREATE TRIGGER trg_messenger_directory_profile_new AFTER INSERT ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.messenger_directory_profile_changed();
CREATE TRIGGER trg_messenger_directory_profile_name AFTER UPDATE OF display_name ON public.user_profiles
  FOR EACH ROW WHEN (OLD.display_name IS DISTINCT FROM NEW.display_name) EXECUTE FUNCTION public.messenger_directory_profile_changed();

-- Every account already here gets its row.
SELECT public.messenger_directory_sync(u.id) FROM public.users u ORDER BY u.id;

-- A conversation between people who are not friends: NONE until someone writes, PENDING while it waits in the other person's Requests,
-- ACCEPTED or DECLINED when they answer. Friends never need any of this.
ALTER TABLE public.messenger_conversations
    ADD COLUMN request_state VARCHAR(8) NOT NULL DEFAULT 'NONE',
    ADD COLUMN request_by BIGINT REFERENCES public.users(id) ON DELETE RESTRICT,
    ADD CONSTRAINT chk_messenger_request_state CHECK (request_state IN ('NONE', 'PENDING', 'ACCEPTED', 'DECLINED'));
CREATE INDEX idx_messenger_requests_low ON public.messenger_conversations (user_low) WHERE request_state = 'PENDING';
CREATE INDEX idx_messenger_requests_high ON public.messenger_conversations (user_high) WHERE request_state = 'PENDING';
