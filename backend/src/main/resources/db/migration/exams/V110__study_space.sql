-- Không gian học tập (owner 2026-11-02): each learner's own study spaces and the study tools they keep there.
-- Additive only. Every row belongs to exactly one learner (user_id, ON DELETE RESTRICT) and is only ever read or
-- written with that learner's id from the session. Large media (3D models, wallpapers, PDFs) never live here: a
-- layout references catalogue ids and the appearance system; a research PDF stays in the learner's own browser.

-- A space: the CURRENT working layout (auto-saved) and, separately, the learner's PERSONAL DEFAULT layout
-- ("Lưu làm mặc định của tôi"). Clearing or auto-saving the current layout never touches default_layout.
CREATE TABLE IF NOT EXISTS public.study_spaces (
    id              UUID         PRIMARY KEY,
    user_id         BIGINT       NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
    name            VARCHAR(60)  NOT NULL CHECK (length(btrim(name)) > 0),
    position        INTEGER      NOT NULL DEFAULT 0,
    is_active       BOOLEAN      NOT NULL DEFAULT FALSE,
    layout          JSONB        NOT NULL CHECK (jsonb_typeof(layout) = 'object'),
    default_layout  JSONB        CHECK (default_layout IS NULL OR jsonb_typeof(default_layout) = 'object'),
    default_saved_at TIMESTAMPTZ,
    revision        BIGINT       NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_study_spaces_owner ON public.study_spaces (user_id, position, created_at);
-- At most one active space per learner.
CREATE UNIQUE INDEX IF NOT EXISTS uq_study_spaces_one_active ON public.study_spaces (user_id) WHERE is_active;

-- Earlier versions of a space's layout ("Khôi phục phiên bản trước"); bounded per space by the service.
CREATE TABLE IF NOT EXISTS public.study_space_snapshots (
    id          UUID         PRIMARY KEY,
    space_id    UUID         NOT NULL REFERENCES public.study_spaces (id) ON DELETE RESTRICT,
    user_id     BIGINT       NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
    kind        VARCHAR(16)  NOT NULL CHECK (kind IN ('MANUAL', 'BEFORE_CLEAR', 'BEFORE_RESTORE', 'BEFORE_DEFAULT', 'BEFORE_TEMPLATE')),
    label       VARCHAR(60),
    layout      JSONB        NOT NULL CHECK (jsonb_typeof(layout) = 'object'),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_study_space_snapshots_space ON public.study_space_snapshots (space_id, created_at DESC);

-- Tasks (Việc cần làm / Kế hoạch). One record, shown by every widget that lists it.
CREATE TABLE IF NOT EXISTS public.study_tasks (
    id            UUID          PRIMARY KEY,
    user_id       BIGINT        NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
    title         VARCHAR(200)  NOT NULL CHECK (length(btrim(title)) > 0),
    notes         VARCHAR(4000),
    status        VARCHAR(8)    NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DOING', 'DONE')),
    priority      SMALLINT      NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
    due_on        DATE,
    project       VARCHAR(60),
    recurrence    VARCHAR(8)    NOT NULL DEFAULT 'NONE' CHECK (recurrence IN ('NONE', 'DAILY', 'WEEKLY')),
    done_count    INTEGER       NOT NULL DEFAULT 0 CHECK (done_count >= 0),
    last_done_on  DATE,
    position      INTEGER       NOT NULL DEFAULT 0,
    done_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_study_tasks_owner ON public.study_tasks (user_id, status, position);

-- Notes: a NOTE is Markdown text; a BOARD is the JSON of a knowledge canvas. Removing a widget never deletes one.
CREATE TABLE IF NOT EXISTS public.study_notes (
    id          UUID          PRIMARY KEY,
    user_id     BIGINT        NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
    kind        VARCHAR(8)    NOT NULL DEFAULT 'NOTE' CHECK (kind IN ('NOTE', 'BOARD')),
    title       VARCHAR(160)  NOT NULL DEFAULT '',
    body        TEXT          NOT NULL DEFAULT '' CHECK (length(body) <= 200000),
    color       VARCHAR(16)   NOT NULL DEFAULT 'sun',
    pinned      BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_study_notes_owner ON public.study_notes (user_id, updated_at DESC);

-- Focus sessions (Đồng hồ tập trung). The id is chosen by the browser so a repeated report is the same row; the
-- server takes the start time from its own clock and never stores more focused time than its own clock allows.
CREATE TABLE IF NOT EXISTS public.study_focus_sessions (
    id               UUID         PRIMARY KEY,
    user_id          BIGINT       NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
    task_id          UUID         REFERENCES public.study_tasks (id) ON DELETE SET NULL,
    mode             VARCHAR(10)  NOT NULL CHECK (mode IN ('POMODORO', 'COUNTDOWN', 'STOPWATCH')),
    label            VARCHAR(80),
    subject          VARCHAR(40),
    planned_seconds  INTEGER      NOT NULL CHECK (planned_seconds BETWEEN 0 AND 43200),
    focused_seconds  INTEGER      NOT NULL DEFAULT 0 CHECK (focused_seconds BETWEEN 0 AND 43200),
    status           VARCHAR(12)  NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'INTERRUPTED')),
    started_at       TIMESTAMPTZ  NOT NULL,
    ended_at         TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_study_focus_owner_started ON public.study_focus_sessions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_study_focus_task ON public.study_focus_sessions (task_id) WHERE task_id IS NOT NULL;

-- Research library metadata (Nghiên cứu). The document itself stays in the learner's browser; only its metadata,
-- bookmarks and the learner's annotations (quotes with page numbers and notes) are kept with the account.
CREATE TABLE IF NOT EXISTS public.study_research_items (
    id           UUID          PRIMARY KEY,
    user_id      BIGINT        NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
    title        VARCHAR(300)  NOT NULL CHECK (length(btrim(title)) > 0),
    authors      VARCHAR(600),
    year         SMALLINT      CHECK (year IS NULL OR year BETWEEN 1400 AND 2200),
    venue        VARCHAR(300),
    doi          VARCHAR(200),
    url          VARCHAR(1000) CHECK (url IS NULL OR url ~ '^https?://'),
    project      VARCHAR(60),
    tags         VARCHAR(300),
    favorite     BOOLEAN       NOT NULL DEFAULT FALSE,
    file_name    VARCHAR(200),
    file_size    BIGINT,
    last_page    INTEGER       NOT NULL DEFAULT 1 CHECK (last_page >= 1),
    annotations  JSONB         NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(annotations) = 'array'),
    notes        TEXT          NOT NULL DEFAULT '' CHECK (length(notes) <= 50000),
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_study_research_owner ON public.study_research_items (user_id, updated_at DESC);
