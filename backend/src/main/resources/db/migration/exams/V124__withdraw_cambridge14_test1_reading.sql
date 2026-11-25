-- The printed key and the learner prompts disagree in this immutable legacy edition.
-- Use the existing section-level availability flag. Attempts and score artifacts retain their snapshots.
UPDATE exams.sections s
SET is_runnable = false
FROM exams.form_versions f
WHERE s.form_id = f.id
  AND f.id = 'ecc3704f-d512-5509-98dd-02444c328883'
  AND f.version = 1
  AND f.content_hash = '84034889217a1db7baa3359d5fb1e153e1f8a40fe067fe7cf82f0b1d29bac2a0'
  AND s.id = '97cc6f1f-3908-5fa7-bc22-597da42cf4b6'
  AND s.skill = 'READING'
  AND s.is_runnable IS DISTINCT FROM false;
