-- A retry can settle an interrupted grade against the original charge.
ALTER TABLE public.writing_assessments
    ADD COLUMN grading_reservation_id bigint,
    ADD COLUMN grading_voucher_use_id bigint,
    ADD CONSTRAINT writing_grading_single_charge CHECK
        (grading_reservation_id IS NULL OR grading_voucher_use_id IS NULL);
