-- Reputation Finder: find companies with bad online reputation for SERM agency outreach

-- Jobs (one per search run)
CREATE TABLE IF NOT EXISTS public.reputation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending','running','completed','failed')) DEFAULT 'pending',
  mode text NOT NULL CHECK (mode IN ('local_reviews','brand_serp')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_candidates integer DEFAULT 0,
  processed_candidates integer DEFAULT 0,
  auto_export_count integer DEFAULT 0,
  review_count integer DEFAULT 0,
  discard_count integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text
);

CREATE INDEX IF NOT EXISTS idx_reputation_jobs_user
  ON public.reputation_jobs(user_id, created_at DESC);

-- Candidates (companies found with reputation issues)
CREATE TABLE IF NOT EXISTS public.reputation_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.reputation_jobs(id) ON DELETE CASCADE,
  company text NOT NULL,
  city text,
  category text,
  source_mode text NOT NULL,
  primary_source text NOT NULL,
  primary_source_url text,
  website text,
  rating numeric(2,1),
  reviews_count integer DEFAULT 0,
  negative_reviews_30d integer DEFAULT 0,
  negative_reviews_90d integer DEFAULT 0,
  unanswered_negative_reviews integer DEFAULT 0,
  negative_serp_results_top10 integer DEFAULT 0,
  issue_themes text[] NOT NULL DEFAULT '{}',
  proof_urls text[] NOT NULL DEFAULT '{}',
  proof_snippets text[] NOT NULL DEFAULT '{}',
  pain_score integer NOT NULL DEFAULT 0,
  confidence_score integer NOT NULL DEFAULT 0,
  classification text NOT NULL CHECK (classification IN ('auto_export','review','discard')) DEFAULT 'review',
  second_source_confirmed boolean NOT NULL DEFAULT false,
  collected_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  review_decision text CHECK (review_decision IS NULL OR review_decision IN ('accept','reject'))
);

CREATE INDEX IF NOT EXISTS idx_reputation_candidates_job
  ON public.reputation_candidates(job_id);
CREATE INDEX IF NOT EXISTS idx_reputation_candidates_classification
  ON public.reputation_candidates(job_id, classification);
CREATE INDEX IF NOT EXISTS idx_reputation_candidates_pain
  ON public.reputation_candidates(job_id, pain_score DESC);
CREATE INDEX IF NOT EXISTS idx_reputation_candidates_dedup
  ON public.reputation_candidates(job_id, company, city);

-- Evidence (individual proof items: reviews, SERP results)
CREATE TABLE IF NOT EXISTS public.reputation_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES public.reputation_candidates(id) ON DELETE CASCADE,
  source text NOT NULL,
  url text,
  snippet text,
  sentiment text NOT NULL CHECK (sentiment IN ('negative','neutral','positive')),
  detected_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reputation_evidence_candidate
  ON public.reputation_evidence(candidate_id);

-- RLS
ALTER TABLE public.reputation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reputation_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reputation_evidence ENABLE ROW LEVEL SECURITY;

-- Jobs: user sees own
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reputation_jobs_select_own' AND tablename = 'reputation_jobs') THEN
    CREATE POLICY reputation_jobs_select_own ON public.reputation_jobs FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reputation_jobs_insert_own' AND tablename = 'reputation_jobs') THEN
    CREATE POLICY reputation_jobs_insert_own ON public.reputation_jobs FOR INSERT WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reputation_jobs_update_own' AND tablename = 'reputation_jobs') THEN
    CREATE POLICY reputation_jobs_update_own ON public.reputation_jobs FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reputation_jobs_delete_own' AND tablename = 'reputation_jobs') THEN
    CREATE POLICY reputation_jobs_delete_own ON public.reputation_jobs FOR DELETE USING (auth.uid() = user_id);
  END IF;
END $$;

-- Candidates: user sees via job ownership
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reputation_candidates_select_own_job' AND tablename = 'reputation_candidates') THEN
    CREATE POLICY reputation_candidates_select_own_job ON public.reputation_candidates FOR SELECT
      USING (EXISTS (SELECT 1 FROM public.reputation_jobs j WHERE j.id = reputation_candidates.job_id AND j.user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reputation_candidates_insert_own_job' AND tablename = 'reputation_candidates') THEN
    CREATE POLICY reputation_candidates_insert_own_job ON public.reputation_candidates FOR INSERT
      WITH CHECK (EXISTS (SELECT 1 FROM public.reputation_jobs j WHERE j.id = reputation_candidates.job_id AND j.user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reputation_candidates_update_own_job' AND tablename = 'reputation_candidates') THEN
    CREATE POLICY reputation_candidates_update_own_job ON public.reputation_candidates FOR UPDATE
      USING (EXISTS (SELECT 1 FROM public.reputation_jobs j WHERE j.id = reputation_candidates.job_id AND j.user_id = auth.uid()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reputation_candidates_delete_own_job' AND tablename = 'reputation_candidates') THEN
    CREATE POLICY reputation_candidates_delete_own_job ON public.reputation_candidates FOR DELETE
      USING (EXISTS (SELECT 1 FROM public.reputation_jobs j WHERE j.id = reputation_candidates.job_id AND j.user_id = auth.uid()));
  END IF;
END $$;

-- Evidence: user sees via candidate → job ownership
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reputation_evidence_select_own' AND tablename = 'reputation_evidence') THEN
    CREATE POLICY reputation_evidence_select_own ON public.reputation_evidence FOR SELECT
      USING (EXISTS (
        SELECT 1 FROM public.reputation_candidates c
        JOIN public.reputation_jobs j ON j.id = c.job_id
        WHERE c.id = reputation_evidence.candidate_id AND j.user_id = auth.uid()
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reputation_evidence_insert_own' AND tablename = 'reputation_evidence') THEN
    CREATE POLICY reputation_evidence_insert_own ON public.reputation_evidence FOR INSERT
      WITH CHECK (EXISTS (
        SELECT 1 FROM public.reputation_candidates c
        JOIN public.reputation_jobs j ON j.id = c.job_id
        WHERE c.id = reputation_evidence.candidate_id AND j.user_id = auth.uid()
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reputation_evidence_delete_own' AND tablename = 'reputation_evidence') THEN
    CREATE POLICY reputation_evidence_delete_own ON public.reputation_evidence FOR DELETE
      USING (EXISTS (
        SELECT 1 FROM public.reputation_candidates c
        JOIN public.reputation_jobs j ON j.id = c.job_id
        WHERE c.id = reputation_evidence.candidate_id AND j.user_id = auth.uid()
      ));
  END IF;
END $$;

-- Service role full access
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reputation_jobs_all_service' AND tablename = 'reputation_jobs') THEN
    CREATE POLICY reputation_jobs_all_service ON public.reputation_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reputation_candidates_all_service' AND tablename = 'reputation_candidates') THEN
    CREATE POLICY reputation_candidates_all_service ON public.reputation_candidates FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'reputation_evidence_all_service' AND tablename = 'reputation_evidence') THEN
    CREATE POLICY reputation_evidence_all_service ON public.reputation_evidence FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;
