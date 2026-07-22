# Instantly Dataset Wiki — Agent Instructions

You are an AI agent operating on this wiki. Read this file first **every session**.

This wiki implements [Karpathy's LLM-Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) for our Instantly cold-outreach dataset. Knowledge accumulates and compounds — don't re-derive things that are already written here.

---

## Three Layers

```
┌──────────────────────────────────────────────┐
│ Layer 3:  User asks questions                │
└──────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────┐
│ Layer 2:  THIS WIKI (you read first)         │
│           markdown, cross-referenced,        │
│           append-only logs, curated pages    │
└──────────────────────────────────────────────┘
                    ↓ fallback
┌──────────────────────────────────────────────┐
│ Layer 1:  Postgres `instantly_dataset`       │
│           raw_* tables (truth), lookup_*,    │
│           v_* views, dataset_snapshots       │
│           host: 139.60.162.12:35432           │
└──────────────────────────────────────────────┘
```

**Rule:** before querying SQL, check the wiki. Before answering, write anything new you learned back into the wiki.

---

## Wiki Layout

| File / Dir | Purpose | Who writes |
|---|---|---|
| `CLAUDE.md` (this file) | Schema & workflows. Read first. | Human + rarely AI |
| `README.md` | Human-facing intro to the wiki | Human |
| `index.md` | Table of contents with 1-line summaries | AI maintains |
| `log.md` | Chronological append-only insights log | AI appends |
| `playbook.md` | Distilled best practices for outreach | AI revises as evidence accumulates |
| `concepts/` | Definitions, schema explanation, metric meanings | AI writes once, revises rarely |
| `campaigns/<id>.md` | Per-campaign analysis (only for significant ones) | AI on demand |
| `clients/<slug>.md` | Per-client summary (group of campaigns) | AI on demand |
| `verticals/<slug>.md` | Per-industry observations | AI on demand |
| `subjects/<slug>.md` | Winning/losing subject-line patterns | AI on demand |
| `mailboxes/<slug>.md` | Mailbox health observations | AI on demand |
| `analyses/<YYYY-MM-DD>-<topic>.md` | One-off question/answer logs | AI on demand |
| `eval/<YYYY-WW>-review.md` | Weekly retrospective of the query_log eval loop | Human + AI co-fills |

## Self-improving eval loop (MANDATORY)

We follow a [YC-style observability loop](concepts/eval-loop.md). At the **end of every session** where you consulted the wiki and/or queried `instantly_dataset`, you MUST log the interaction to `query_log` so the weekly review can find patterns and we can improve the system.

```sql
INSERT INTO query_log (
  session_id, agent, agent_version,
  user_query, ai_answer,
  sql_queries, wiki_pages_read,
  duration_ms,
  status, ai_self_assessment, ai_self_reason, improvement_proposed
) VALUES (
  $session_id, 'claude-chat', '<your model id>',
  $verbatim_user_question, $verbatim_ai_answer,
  ARRAY[<every SQL you fired>], ARRAY[<every wiki page you read>],
  $duration_ms,
  'succeeded' | 'partial' | 'failed' | 'unknown',
  1..5,
  '<one line: why you self-graded that score>',
  '<what would have made this query work better, or NULL if clean>'
);
```

**Honesty contract:** mark `status='partial'` or `'failed'` truthfully. Hiding weak answers defeats the loop. Also propose `improvement_proposed` even on successes — if it took 5 queries when a view would've made it 1, that's improvement.

Full ritual: see [concepts/eval-loop.md](concepts/eval-loop.md).

---

## Database Quick-Reference

Connection: `postgresql://instantly:<pw>@139.60.162.12:35432/instantly_dataset` (read it from `.env` → `INSTANTLY_DATASET_DB_URL`)

**Quickest way to run SQL from a shell:**
```bash
node app/scripts/instantly-dataset/q.mjs "SELECT count(*) FROM raw_emails"
# or pipe stdin:
echo "SELECT ..." | node app/scripts/instantly-dataset/q.mjs
# or from file:
node app/scripts/instantly-dataset/q.mjs --file query.sql
# JSON output for piping:
node app/scripts/instantly-dataset/q.mjs --json "SELECT ..."
```

No boilerplate — `q.mjs` handles connect/auth/table-print/cleanup. Use it instead of writing inline `node -e "..."` every time.

**Tables (raw_*):** `raw_campaigns`, `raw_campaign_steps`, `raw_accounts`, `raw_leads`, `raw_emails`, `raw_lead_lists`, `raw_email_templates`, `raw_custom_tags`, `raw_custom_tag_mappings`, `raw_lead_labels`, `raw_block_list`, `raw_subsequences`

**Snapshot tables (analytics):** `raw_campaign_analytics_overview_snap`, `raw_campaign_analytics_daily_snap`, `raw_campaign_step_analytics_snap`, `raw_warmup_analytics_snap`. All FK to `dataset_snapshots(id)`.

**Lookup tables for magic numbers** (always JOIN these instead of guessing): `lookup_ue_types`, `lookup_interest_status`, `lookup_campaign_status`, `lookup_account_status`, `lookup_warmup_status`, `lookup_provider_code`

**Pre-built views:** `v_subject_performance` (subject × open/reply rate), `v_campaign_summary`, `v_account_daily_volume`, `v_thread_outcomes`, `v_lead_journey`, `v_latest_snapshot`

**Every table and important column has a `COMMENT`** — query `information_schema.columns` or `pg_description` to discover semantics live.

See `concepts/dataset-schema.md` for the full picture, `concepts/key-metrics.md` for metric definitions.

---

## Workflows

### Ingest (you read new raw data)
1. Skim the source (query or document).
2. Decide: is this generally useful (write to wiki) or one-off (write to `analyses/`)?
3. Update the relevant page. Add cross-links to other pages where this concept fits.
4. Update `index.md` if you created a new page.
5. Append a line to `log.md`: `YYYY-MM-DD: <what you learned>`.

### Query (user asks something)
1. Search `index.md` and `playbook.md` first.
2. Search `analyses/` for similar previous questions.
3. If wiki insufficient, drop to SQL — but ONLY query what's needed.
4. Cite both wiki and SQL sources in your answer.
5. If the answer reveals an insight that compounds (would help future queries), write it back to the appropriate page.

### Lint (periodic, when prompted)
1. Read `log.md` chronologically — flag claims that newer evidence contradicts.
2. Find orphan pages (not linked from `index.md` or any other page).
3. Find stale concept pages (e.g., column comments updated in DB but `concepts/dataset-schema.md` outdated).
4. Report findings in `analyses/<today>-wiki-lint.md`, don't auto-fix without user confirmation.

---

## Style

- **English headers, Russian/English body** depending on user's language. Match the user.
- **Concise.** A page should fit on one screen if possible. Long pages = split into sub-pages with cross-links.
- **Always link** when you mention another concept: `[interest_status](../concepts/dataset-schema.md#interest_status)`.
- **Cite SQL queries** in fenced code blocks so the user can re-run them.
- **Date all insights.** `2026-05-26: ...`. Helps lint find stale claims.
- **Never delete** historical log entries. Mark obsolete in-place: `~~old claim~~ → updated 2026-MM-DD: <new>`.

---

## What this wiki is NOT

- ❌ A duplicate of the SQL data (the DB is the source of truth for facts)
- ❌ A replacement for `lookup_*` tables (those are live, AI joins to them)
- ❌ A place for personal opinions (only evidence-backed observations)
- ❌ Auto-generated dumps (if AI just produces a wall of SQL output, that goes to `analyses/`, not the wiki proper)

The wiki is **summarized knowledge** that compounds. Each page should make a future agent faster, not just record what happened.
