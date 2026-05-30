# Outreach Playbook

Evidence-backed best practices. Each claim cites its source.

**This page is sparse on purpose.** It fills as analyses accumulate. Don't add claims without data. When evidence contradicts a claim, mark obsolete and link to the new finding.

---

## Subject lines — SETTLED: low-leverage, don't optimize for them

Subject wording barely moves the business outcome. Evidence (2026-05-29..30):
- Within-campaign A/B (same list): route-style vs pitch-style 3.53% vs 3.24%, **z=1.37, p=0.17 — n.s.**
- Cross-campaign "wins" (z=40 for «к кому обратиться» 5.35%) are a **segment confound**, not subject effect.
- **Reply rate >~1% is a vanity metric for leads**: leads-per-1k is flat across reply buckets (1-2%:0.089, 2-3%:0.082, 3%+:0.093). Lifting reply 2%→4% via wording ≈ 0 extra leads.
- Subject can only affect open+reply; it can NEVER affect lead conversion.

**Rule:** don't run subject A/B for reply. If you must compare, use `v_subject_ab_within_campaign` + a z-test; never pool across campaigns. Detail: [subjects/winning-patterns.md](./subjects/winning-patterns.md).

## Sequence design — KEEP follow-ups (steps 2-3 carry ~half the leads)

**Strongest validated finding (workflow 2026-05-30, survived full adversarial scrutiny, conf 78).**
Follow-up replies convert to a qualified lead ~**2× more often** than first-touch replies:
- First-touch 4.31% vs follow-up 10.31% (z=6.77, OR=2.55)
- **Within-campaign** (139 campaigns producing both): 4.59% vs 10.66% (z=6.35); paired sign-test p=0.0022; leave-one-out robust; 50 distinct campaigns.
- ~54% of qualified leads arrive after email 1; emails 2-3 alone carry ~47%.

**Rule:** do NOT cut sequences to 1-2 emails. Emails 2-3 are worth their send budget on the money metric. ~565 campaigns are ≤2 steps — candidates to extend. Source: query_log id=12.

## Mailbox health — NOT the binding constraint on leads

The cross-campaign "60× leads gradient by mailbox health" is a **confound of campaign age + qualifier coverage**, not causal (workflow 2026-05-30, refuted, conf 88). Among equally-healthy clients, leads still swing to zero; segment/ICP drives leads. Mailbox health still matters for deliverability hygiene, but it is NOT the lever for lead yield. Source: query_log id=11.

## Lead qualification

- **Reply quality does NOT separate lead-producers from dead projects.** Positive-interest reply share is statistically identical (lead-producers 46.5% vs never-qualified 47.6%, z=1.08, p=0.28) — dead projects' replies are genuine human interest, not junk. The discriminator is segment/ICP + campaign maturity, not reply quality. Source: query_log id=10.

## ⚠️ Methodology guardrails (hard-won)

- **Campaign AGE confounds leads/1k.** New campaigns haven't accrued leads yet → look "bad" and masquerade as a mailbox/list/segment effect. Control for age (or use only mature campaigns) before any leads-per-1k claim. Killed 3 plausible findings on 2026-05-30.
- **Use `new_leads_contacted_count`, not `contacted_count`**, for unique-leads denominators (contacted_count counts email events, ~2× inflated).
- **Verify operational claims against LIVE logs.** A workflow agent claimed the qualifier was crashing on a 412 spend-cap for ~25 campaigns; live logs showed 0 errors, healthy. Dataset analysis ≠ live system state.
- **Subject/tactic claims:** within-campaign + z-test, never cross-campaign pooling.

## Operational

- **Don't pull /emails at >10 RPM** while `portal-worker-instantly-leads` is up. Shared workspace limit. Pause worker (`docker stop`) for heavy pulls. Source: [log.md 2026-05-22 incident](./log.md).
- **Daily sync runs at 00:00 UTC = 03:00 МСК** via cron on prod (139.60.162.12). Logs in `/var/log/instantly-dataset-sync/`. Worker is naturally idle at that hour. See [sync.mjs](../app/scripts/instantly-dataset/sync.mjs).
