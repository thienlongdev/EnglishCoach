-- Authoring custody only. Learner catalog, runtime, media grants and publication use the normalized form graph.
CREATE TABLE exams.private_package_drafts (
    package_id text NOT NULL,
    package_version integer NOT NULL CHECK (package_version > 0),
    content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    package_json json NOT NULL,
    created_by bigint NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (package_id, package_version),
    CHECK (package_json->'manifest'->>'authoringStatus' = 'DRAFT'),
    CHECK (package_json->'form'->>'lifecycleState' = 'DRAFT')
);
