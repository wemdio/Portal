# Instantly top research questions pass

2026-06-05. Source: `instantly-top-research-questions.docx` from Telegram Desktop.
No external APIs were used; all numbers came from `instantly_dataset` SQL.

## Method

Baseline pooled cuts were not enough because copy features are confounded by campaign,
segment, offer and list quality. The improved pass used:

- first-email variants only (`step_n = 0`) for copy feature comparisons;
- minimum `sent >= 100` per variant;
- `unique_opened <= sent` to remove impossible open rows;
- campaign-centered deltas: each variant rate minus its own campaign average;
- matched within-campaign checks where a campaign has both "feature present" and
  "feature absent" variants;
- latest `raw_campaign_analytics_overview_snap` per campaign, not one global latest
  snapshot, for lifetime/sequence economics.

Representative pattern:

```sql
SELECT DISTINCT ON (o.campaign_id) o.*
FROM raw_campaign_analytics_overview_snap o
JOIN dataset_snapshots ds ON ds.id = o.snapshot_id AND ds.ok
ORDER BY o.campaign_id, ds.started_at DESC;
```

This fixed a false baseline where the global latest nightly snapshot covered only a
subset of campaigns and made raw-email coverage look impossible.

## Results

### What raises reply, not just open

`cta_navigation_ask` is the strongest stable positive binary signal:

- pooled reply lift: +0.49 pp;
- campaign-centered reply lift: +0.11 pp;
- matched within-campaign: 196 campaigns, +0.47 pp average campaign reply delta.

This is directionally stronger than most subject-line tricks. Open lift shrinks after
campaign control, so public claims should focus on reply and matched campaign checks.

### Personalization: person vs company

`{{companyName}}` beats `{{firstName}}` in this dataset.

- `subject_has_company_name`: 1.63% reply pooled, +0.06 pp campaign-centered reply lift;
  matched within-campaign: 301 campaigns, +0.32 pp average campaign reply delta.
- `{{firstName}}` is sparse and weak/negative: `subject_has_first_name` appears in only
  28 campaigns and has 0.37% pooled reply; matched within-campaign has only 10 campaigns
  and is negative.

Use as a careful claim: company-level relevance looks better than first-name mail-merge,
but true "deep personalization" is not directly observable from `raw_leads.custom_variables`
because that field is empty in the current dataset.

### Length

Short body wins clearly:

- `<50` words: 2.61% reply, +0.29 pp campaign-centered delta.
- `50-99`: 1.11%, -0.16 pp.
- `100-149`: 0.50%, -0.20 pp.

Sentence count tells the same story:

- 1-3 sentences: 3.20%, +0.23 pp.
- 4-5: 2.00%, +0.16 pp.
- 6-8 and 9+ are negative.

### CTAs and sales language

Direct meeting/sales asks are consistently negative:

- `cta_meeting_call`: -0.17 pp campaign-centered; matched avg campaign delta -0.63 pp.
- `cta_15_min`: -0.06 pp campaign-centered; matched avg -0.54 pp on a small 20-campaign set.
- `sales_pitch_words`: -0.26 pp campaign-centered; matched avg -1.17 pp.
- `case_or_metric_claim`: -0.25 pp campaign-centered; matched avg -1.20 pp.
- `timeline_hook`: -0.30 pp campaign-centered; matched avg -1.86 pp.
- invite/webinar/discount patterns are also negative.

The safer public formulation: asking for routing/clarification beats asking for a meeting
or pitching a case in the first email.

### Follow-ups

First email produces the most replies per email, but follow-ups are still material:

- email 1: 35.1% of sends, 58.7% of replies, 1.60% reply/email;
- email 2: 27.2% sends, 23.8% replies, 0.84%;
- email 3: 23.3% sends, 11.5% replies, 0.47%;
- emails 4+ add smaller incremental volume.

Mature campaign sequence economics:

- 1 step: 0.95% reply/lead;
- 2 steps: 2.55%;
- 3 steps: 2.97%;
- 4-5 steps: 3.14%;
- 6+ is only 2 campaigns, not enough to generalize.

This does **not** support "2 steps are best"; it supports "2 is much better than 1,
3-5 still add replies, and 6+ is unproven/sparse."

### Segment vs copy

Target segment spread is larger than most individual copy-feature lifts. High/medium
segment buckets range roughly from ~0.61% to ~1.96% reply. This supports the existing
wiki guardrail: do not attribute all lift to wording; ICP/segment remains a major driver.

### What cannot be answered from this dataset alone

- booked meeting, opportunity, deal value, won/lost: CRM data, not Instantly;
- multichannel lift: channel-order and reply-source data are not in `instantly_dataset`;
- true AI/manual research depth: campaign tags exist, but lead custom-variable keys are 0;
- negative sentiment beyond unsubscribe/not-interested proxies needs reply classification.

## Public-study angle

Strongest defensible thesis from this pass:

> Open rate is a weak optimization target. The reply-positive pattern is short first
> email + company relevance + navigation ask; the reply-negative pattern is sales pitch
> + metric/case brag + meeting/demo/15-minute CTA.

Avoid stronger causal language unless a future model controls for client, segment,
offer, campaign age and mailbox health in one regression.
