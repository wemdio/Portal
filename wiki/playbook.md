# Outreach Playbook

Evidence-backed best practices. Each claim cites its source.

**This page is sparse on purpose.** It fills as analyses accumulate. Don't add claims without data. When evidence contradicts a claim, mark obsolete and link to the new finding.

---

## Subject lines

_(no rules yet — first analyses pending)_

Candidate observations to verify next time we look:
- `'Re: «{{companyName}}»'` paired with personalized variants showed 16.79% reply rate in one ASTI GROUP campaign (small sample, n=131). Needs cross-campaign replication. Source: ad-hoc query 2026-05-22.
- Subject lines with `{{Firstname}}` placeholder appear in top performers (~14-15% open rate by `v_subject_performance`). Sample too small to conclude. TODO.

## Sequence design

_(no rules yet)_

Open questions:
- Optimal `step_n` count per campaign?
- `wait_days` distribution among top performers vs underperformers?
- A/B variant strategy: does variant_n > 2 actually help, or noise?

## Mailbox health

_(no rules yet)_

Open questions:
- What `stat_warmup_score` predicts `status` going negative?
- Does `landed_spam > N` for K consecutive days correlate with future deliverability drop?

## Lead qualification

_(no rules yet)_

Open questions:
- Status distribution: what fraction of `status='lead'` later convert vs. `objection` that we recovered?
- Reply length / sentiment signals not captured by current AI classifier?

## Operational

- **Don't pull /emails at >10 RPM** while `portal-worker-instantly-leads` is up. Shared workspace limit. Pause worker (`docker stop`) for heavy pulls. Source: [log.md 2026-05-22 incident](./log.md).
- **Daily sync runs at 00:00 UTC = 03:00 МСК** via cron on prod (139.60.162.12). Logs in `/var/log/instantly-dataset-sync/`. Worker is naturally idle at that hour. See [sync.mjs](../app/scripts/instantly-dataset/sync.mjs).
