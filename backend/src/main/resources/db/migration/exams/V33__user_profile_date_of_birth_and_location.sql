-- V33__user_profile_date_of_birth_and_location.sql
-- Add date_of_birth and safely backfill province from legacy city if empty

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS date_of_birth DATE NULL;

-- Backfill province with city only where province is empty and city is non-empty
UPDATE public.user_profiles
SET province = city
WHERE (province IS NULL OR trim(province) = '')
  AND (city IS NOT NULL AND trim(city) != '');
