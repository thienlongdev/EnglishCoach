-- Synthetic historical shape; no production rows, credentials or Flyway history.
CREATE SCHEMA exams;
CREATE TABLE public.users (id BIGINT PRIMARY KEY, email VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL);
INSERT INTO public.users
SELECT id, ' learner' || id || '@example.test ',
    CASE WHEN id <= 12 THEN '$2a$10$synthetic-migration-fixture'
         WHEN id <= 15 THEN 'OAUTH2' ELSE 'DEV_TEST' END, 'Fixture ' || id
FROM (SELECT generate_series(1,670) id UNION ALL SELECT 674) fixture;
CREATE TABLE public.flashcards (id BIGINT PRIMARY KEY, user_id BIGINT REFERENCES public.users(id), next_review_date TIMESTAMP, word TEXT);
INSERT INTO public.flashcards SELECT id, 1, '2026-01-01'::timestamp, 'fixture-' || id FROM generate_series(1,3871) id;
CREATE TABLE public.document_highlights (id BIGINT PRIMARY KEY, user_id BIGINT REFERENCES public.users(id));
CREATE TABLE public.listening_sessions (id BIGINT PRIMARY KEY, user_id BIGINT REFERENCES public.users(id));
CREATE TABLE public.speaking_sessions (id BIGINT PRIMARY KEY, user_id BIGINT REFERENCES public.users(id), marker TEXT);
INSERT INTO public.speaking_sessions SELECT id, 1, 'speaking-' || id FROM generate_series(1,30) id;
CREATE TABLE public.writing_sessions (id BIGINT PRIMARY KEY, user_id BIGINT REFERENCES public.users(id));
CREATE TABLE exams.attempts (id BIGINT PRIMARY KEY, user_id BIGINT REFERENCES public.users(id), status TEXT);
INSERT INTO exams.attempts SELECT id, 1, 'COMPLETED' FROM generate_series(1,668) id;
