# Self-Improving Eval Loop

Inspired by [Tom Blomfield's YC talk (4:12)](https://www.youtube.com/watch?v=X_JsIHUfUjc) on building self-improving companies. Adapted to our scale: human-in-the-loop weekly, not fully autonomous (yet).

---

## The loop

```
   ┌────────────────────────────────────────┐
   │ 1. User asks question                  │
   └────────────────────────────────────────┘
                     ↓
   ┌────────────────────────────────────────┐
   │ 2. AI reads wiki + queries SQL,        │
   │    composes answer                     │
   └────────────────────────────────────────┘
                     ↓
   ┌────────────────────────────────────────┐
   │ 3. AI logs entry to instantly_dataset  │
   │    .query_log: query, answer, sql      │
   │    fired, wiki pages read, duration,   │
   │    self-assessment (1-5), proposed     │
   │    improvement                         │
   └────────────────────────────────────────┘
                     ↓
   ┌────────────────────────────────────────┐
   │ 4. User gives feedback (-1/0/+1)       │
   │    inline or later                     │
   └────────────────────────────────────────┘
                     ↓ (weekly)
   ┌────────────────────────────────────────┐
   │ 5. Human + AI co-review unreviewed:    │
   │    - failed/partial first              │
   │    - repeated questions (v_query_log_  │
   │      repeats)                          │
   │    - low self-assessment but no user   │
   │      feedback                          │
   └────────────────────────────────────────┘
                     ↓
   ┌────────────────────────────────────────┐
   │ 6. Apply fixes:                        │
   │    - new wiki page                     │
   │    - new SQL view                      │
   │    - new index / lookup row            │
   │    - update playbook                   │
   │    - refine CLAUDE.md instructions     │
   └────────────────────────────────────────┘
                     ↓
   ┌────────────────────────────────────────┐
   │ 7. Mark log rows reviewed_at=now()     │
   │    + improvement_applied=<sha/page>    │
   └────────────────────────────────────────┘
                     ↓
   ┌────────────────────────────────────────┐
   │ 8. Repeat the same question NEXT WEEK  │
   │    → expect succeeded with higher      │
   │      confidence                        │
   └────────────────────────────────────────┘
```

YC's version automates step 6 (auto-PR with fix → AI reviews → merges). We start with human-in-loop at step 6; once we see the same kinds of fixes repeating, automate them.

---

## What the AI must log every session

End of every session where the AI consulted wiki and/or queried the dataset:

```sql
INSERT INTO query_log (
  session_id, agent, agent_version,
  user_query, ai_answer,
  sql_queries, wiki_pages_read,
  duration_ms,
  status, ai_self_assessment, ai_self_reason, improvement_proposed
) VALUES (
  $session_id, 'claude-chat', 'claude-sonnet-4.6',
  $verbatim_user_question, $verbatim_ai_answer,
  ARRAY[<every SQL fired>], ARRAY[<every wiki page consulted>],
  $duration,
  'succeeded' | 'partial' | 'failed' | 'unknown',
  1..5,
  '<one-line reason for self-assessment>',
  '<what would have made this better, or NULL if the answer was clean>'
);
```

**Honesty contract:** AI must mark `status='partial'` or `'failed'` if it had to guess, lacked data, or knows the answer might be wrong. The whole point of the loop is to find weak spots — hiding them defeats it.

**`improvement_proposed`** is critical: even if the answer succeeded, if it took 5 SQL queries when a view would've made it 1, that's an improvement worth proposing.

---

## Weekly review ritual

Friday or whenever. ~30 min with the human.

### Step 1: surface review queue

```sql
SELECT * FROM v_query_log_review_queue LIMIT 50;
```

Failed / partial first, then unknowns, then succeeded-but-low-confidence.

### Step 2: look for repeats

```sql
SELECT * FROM v_query_log_repeats LIMIT 20;
```

Questions asked multiple times → strong signal that a permanent wiki page is missing.

### Step 3: for each row, decide

| Type of problem | Type of fix |
|---|---|
| AI invented data / hallucinated | Wiki page clarifying what's truly in DB |
| AI couldn't find data that DOES exist | New view or better column comment |
| Query took >30s | New index |
| Same question keeps coming | Promote to `playbook.md` or `concepts/<topic>.md` |
| AI used wrong `lookup_*` | Update lookup description |
| AI couldn't decide which table | Refine `dataset-schema.md` |
| Question is genuinely novel | Just write the analysis to `analyses/` |

### Step 4: ship fixes

Real artifacts in repo (migration sql, wiki page, etc.). Then for each log row:

```sql
UPDATE query_log
SET reviewed_at = now(),
    reviewer = 'human-name',
    improvement_applied = 'wiki/subjects/winning-patterns.md commit abc123'
WHERE id IN (...);
```

### Step 5: write retrospective

`wiki/eval/YYYY-WW-review.md` — one page per week. What we found, what we shipped, what we learned about our own data. This itself compounds into meta-knowledge.

---

## When to automate (YC-style autonomous loop)

Once we see:
- Same type of fix repeated >3 weeks
- The fix is purely additive (new view, new index, new wiki page) — not destructive
- We can write a unit test for the fix's effect (the failing query now succeeds)

Then write an automated agent that proposes the fix as a PR overnight. We just review/merge.

We're not there yet. Get manual ritual working first.
