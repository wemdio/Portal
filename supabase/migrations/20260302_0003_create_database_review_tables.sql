-- Review requests: tracks a specialist's base submission through the review pipeline.
CREATE TABLE IF NOT EXISTS public.database_review_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  owner_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tab_id text NOT NULL,
  tab_name text NOT NULL DEFAULT '',
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  specialist_comment text NOT NULL DEFAULT '',

  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN (
      'submitted',
      'needs_rework',
      'review_approved',
      'sent_to_client',
      'client_approved',
      'client_requested_changes'
    )),

  reviewer_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewer_comment text NOT NULL DEFAULT '',

  telegram_chat_id bigint,
  telegram_message_id bigint,
  telegram_extra_message text NOT NULL DEFAULT '',

  guest_token_hash text,
  guest_token_expires_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_requests_owner
  ON public.database_review_requests(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_review_requests_reviewer
  ON public.database_review_requests(reviewer_user_id);
CREATE INDEX IF NOT EXISTS idx_review_requests_status
  ON public.database_review_requests(status);
CREATE INDEX IF NOT EXISTS idx_review_requests_project
  ON public.database_review_requests(project_id);

ALTER TABLE public.database_review_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "review_requests_all_authenticated" ON public.database_review_requests;
CREATE POLICY "review_requests_all_authenticated"
  ON public.database_review_requests
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Row marks: color highlights and comments on individual rows.
CREATE TABLE IF NOT EXISTS public.database_review_row_marks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  review_request_id uuid NOT NULL REFERENCES public.database_review_requests(id) ON DELETE CASCADE,
  tab_id text NOT NULL,
  row_index integer NOT NULL CHECK (row_index >= 0),

  color text NOT NULL DEFAULT '',
  comment text NOT NULL DEFAULT '',

  author_type text NOT NULL DEFAULT 'reviewer'
    CHECK (author_type IN ('reviewer', 'client', 'specialist')),
  author_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (review_request_id, tab_id, row_index, author_type)
);

CREATE INDEX IF NOT EXISTS idx_row_marks_request
  ON public.database_review_row_marks(review_request_id);

ALTER TABLE public.database_review_row_marks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "row_marks_all_authenticated" ON public.database_review_row_marks;
CREATE POLICY "row_marks_all_authenticated"
  ON public.database_review_row_marks
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "row_marks_anon_select" ON public.database_review_row_marks;
CREATE POLICY "row_marks_anon_select"
  ON public.database_review_row_marks
  FOR SELECT TO anon
  USING (true);

DROP POLICY IF EXISTS "row_marks_anon_insert" ON public.database_review_row_marks;
CREATE POLICY "row_marks_anon_insert"
  ON public.database_review_row_marks
  FOR INSERT TO anon
  WITH CHECK (author_type = 'client');
