-- ============================================================================
-- 003: query_log — observability for the AI eval loop
-- Idea source: YC talk "How to Build a Self-Improving Company with AI" (Tom Blomfield, 2026)
--             https://www.youtube.com/watch?v=X_JsIHUfUjc (4:12)
-- ============================================================================

CREATE TABLE IF NOT EXISTS query_log (
  id                   BIGSERIAL PRIMARY KEY,
  ts                   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- session/source provenance
  session_id           TEXT,                                  -- chat session id (free form)
  agent                TEXT NOT NULL,                         -- 'claude-chat' | 'gpt-cli' | 'cron-analyst' | etc.
  agent_version        TEXT,                                  -- e.g. 'claude-sonnet-4.6'

  -- the interaction itself
  user_query           TEXT NOT NULL,                         -- what the human asked, verbatim
  ai_answer            TEXT,                                  -- what the AI replied, full text (markdown ok)

  -- what tools the AI actually used to produce the answer
  sql_queries          TEXT[],                                -- every SELECT/etc. fired during this turn
  wiki_pages_read      TEXT[],                                -- paths under wiki/ that were consulted
  external_calls       TEXT[],                                -- any HTTP/MCP calls

  -- performance
  duration_ms          INT,                                   -- total wall time of the turn
  total_tokens         INT,                                   -- if reportable
  cost_usd             NUMERIC(10, 6),                        -- if reportable

  -- evaluation
  status               TEXT NOT NULL DEFAULT 'unknown',       -- succeeded | partial | failed | unknown
  ai_self_assessment   SMALLINT,                              -- 1-5, AI's own confidence the answer is good (hint, not authoritative)
  ai_self_reason       TEXT,                                  -- one-line AI reasoning for self-assessment
  user_feedback        SMALLINT,                              -- -1 / 0 / +1 from human (ground truth label)
  user_feedback_note   TEXT,                                  -- free text from human

  -- improvement loop
  improvement_proposed TEXT,                                  -- what change would have made this better (new view? wiki page? lookup?)
  improvement_applied  TEXT,                                  -- what was actually shipped (commit sha, migration #, wiki page slug)
  reviewed_at          TIMESTAMPTZ,                           -- when we processed this in the weekly review
  reviewer             TEXT                                   -- who reviewed (human name or 'auto')
);

CREATE INDEX IF NOT EXISTS query_log_ts_idx ON query_log (ts DESC);
CREATE INDEX IF NOT EXISTS query_log_status_idx ON query_log (status) WHERE status != 'succeeded';
CREATE INDEX IF NOT EXISTS query_log_unreviewed_idx ON query_log (ts DESC) WHERE reviewed_at IS NULL;
CREATE INDEX IF NOT EXISTS query_log_agent_idx ON query_log (agent, ts DESC);

COMMENT ON TABLE query_log IS
  'Every AI query against the dataset. Foundation of the YC-style self-improving eval loop:
   weekly we review unreviewed rows (especially failed/partial), identify what would have made
   them succeed, and ship the fix (new wiki page, view, index, lookup, etc.). Source pattern:
   https://www.youtube.com/watch?v=X_JsIHUfUjc';

COMMENT ON COLUMN query_log.status IS
  'succeeded = AI fully answered. partial = answered with caveats / had to guess.
   failed = AI could not answer or gave incorrect answer. unknown = not yet assessed.';
COMMENT ON COLUMN query_log.ai_self_assessment IS
  'AI''s own 1-5 confidence the answer was good. HINT, not authoritative (self-graded).
   Ground truth comes from user_feedback + weekly human review.';
COMMENT ON COLUMN query_log.user_feedback IS
  '-1 = bad answer, 0 = okay, +1 = good. The label that matters.';
COMMENT ON COLUMN query_log.improvement_proposed IS
  'When the AI (or weekly review) identifies what would have made this query work better.
   E.g. "needs index on raw_emails(eaccount, ue_type)" or "wiki page on objection patterns missing".';
COMMENT ON COLUMN query_log.improvement_applied IS
  'After the improvement is shipped, link/sha here. Closes the loop.';

-- ─── view: this week's review queue ────────────────────────────────────────

CREATE OR REPLACE VIEW v_query_log_review_queue AS
SELECT
  id,
  ts,
  agent,
  status,
  ai_self_assessment,
  user_feedback,
  left(user_query, 120) AS user_query_preview,
  array_length(sql_queries, 1) AS sql_count,
  duration_ms,
  improvement_proposed
FROM query_log
WHERE reviewed_at IS NULL
  AND ts > now() - interval '14 days'
ORDER BY
  -- failed first, then partial, then succeeded but with low self-assessment
  CASE status
    WHEN 'failed' THEN 1
    WHEN 'partial' THEN 2
    WHEN 'unknown' THEN 3
    ELSE 4
  END,
  ai_self_assessment NULLS FIRST,
  ts DESC;

COMMENT ON VIEW v_query_log_review_queue IS
  'Rows for the weekly eval review. Ordered: failed → partial → unknown → succeeded-low-confidence.';

-- ─── view: repeated questions (signal: missing wiki coverage) ──────────────

CREATE OR REPLACE VIEW v_query_log_repeats AS
SELECT
  trim(lower(user_query)) AS normalized_query,
  count(*)::int           AS asked_count,
  count(DISTINCT session_id)::int AS by_distinct_sessions,
  min(ts)                 AS first_asked,
  max(ts)                 AS last_asked,
  array_agg(DISTINCT status) AS statuses_seen
FROM query_log
WHERE ts > now() - interval '30 days'
  AND length(user_query) > 10
GROUP BY trim(lower(user_query))
HAVING count(*) > 1
ORDER BY count(*) DESC;

COMMENT ON VIEW v_query_log_repeats IS
  'Questions asked >1x in the last 30 days. Strong signal that the answer should be promoted
   from per-session analysis to a permanent wiki page.';
