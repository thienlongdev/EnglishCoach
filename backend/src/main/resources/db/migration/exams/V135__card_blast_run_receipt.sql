ALTER TABLE public.card_blast_runs ADD COLUMN issued_run_id varchar(36);
CREATE UNIQUE INDEX uq_card_blast_issued_run ON public.card_blast_runs(issued_run_id)
    WHERE issued_run_id IS NOT NULL;
