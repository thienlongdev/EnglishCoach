# Writing Module Database Schema Rehearsal Guide

## Overview
This document outlines the rehearsal and verification procedures for applying the additive Writing Module schema to PostgreSQL without risking any pre-existing user or application data.

## Safety Invariants
1. **Zero Destructive Operations**: Only `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and `CONSTRAINT ... UNIQUE` are used. No existing tables (`users`, `speaking_*`, `listening_*`, etc.) are modified.
2. **Foreign Key Integrity**: All references to `users(id)` specify `ON DELETE CASCADE`.
3. **Additive Isolation**: The 9 writing tables are completely decoupled from legacy schema generation.

## Rehearsal Procedure
1. Verify database connectivity:
   ```bash
   psql -h localhost -p 5432 -U postgres -d english_coach -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
   ```
2. Apply `V1__init_writing_tables.sql`:
   ```bash
   psql -h localhost -p 5432 -U postgres -d english_coach -f infra/db/writing/V1__init_writing_tables.sql
   ```
3. Verify table creation:
   ```sql
   SELECT table_name FROM information_schema.tables 
   WHERE table_schema = 'public' AND table_name LIKE 'writing_%' 
   ORDER BY table_name;
   ```
   Expected: 9 tables (`writing_assessments`, `writing_error_memories`, `writing_feedback_issues`, `writing_learning_evidence`, `writing_practices`, `writing_profiles`, `writing_sessions`, `writing_skill_masteries`, `writing_submissions`).
