# ENG handoff 2026-10-16: countries, domain do-not-contact, time zones, client HST

Everything the local session knew, for the cloud session that continues the work. Read in this order.

1. `../2026-10-16-eng-countries-dnc-tz-handoff.md`: owner decisions, hard constraints, the production catalog's country spellings.
2. `implementation-plan.md`: **the ready implementation plan.** Three design lanes and three adversarial challenges were merged into one plan; the challenges' blockers and majors are already fixed in it. It contains:
   - final decisions per feature (storage, shapes, defaults, wording, stricter/softer labels);
   - the shared "foundation" modules and their signatures;
   - lanes with exclusive file ownership;
   - the verification plan and the risks.

   Start the build from this file. Do not re-design.
3. `design-specs-and-challenges.json`: the full per-feature specs (country lock, domain DNC, time zones) and their challenges, with path:line evidence. Use it as a reference when the plan is terse.
4. Data and harnesses the plan refers to:
   - `catalog-countries.tsv`: the 249 values of `pdl_companies.country`, with counts, read on prod 2026-10-16.
   - `harness/iso-map.mjs`: maps country values to ISO2 codes via Intl.DisplayNames.
   - `harness/table.mjs`, `check.mjs`, `offsets.mjs`, `preselect.mjs`: the proposed list of all 102 Instantly time zones with labels and groups, and its checks.
   - `harness/probe.cjs`: a probe for domain normalisation.
5. `hst-client.md`: the first real ENG client (HST Solutions, project `2971d740-1f5e-4eb9-a9e5-c04faaf8794c`):
   - its current state;
   - the drafted field values;
   - the brief text (contacts removed).

   Payloads are in `hst-staff-patch-body.json`, `hst-icp.json`, `hst-cases-rows.json` and `hst-offer-no-call.txt`. `hst-feasibility-and-plan.md` is the read-only analysis of what ENG can and cannot do for this client and the step-by-step plan.
6. `eng-client-inputs-today.md`: what an ENG client can enter besides the website today, where each input goes, and the options for briefs. The owner decided: no file upload.
7. `broad-audiences-assessment.md`: the assessment of porting VE2's broad audiences to ENG.
   - The owner has not answered its four questions.
   - Remind the owner around 15:41 UTC+4 on 2026-10-16: the local reminder died with the move.
8. `context-memory.md`: the local Claude memory notes that matter for this work:
   - the owner and team;
   - release rules;
   - the parallel VE2 chat;
   - the state of ENG releases;
   - the lockdown;
   - the no-opt-out rule;
   - lessons from earlier waves (paid-work arithmetic, frozen plan state, gate labels).

## Rules that bind the cloud session

- Answer the owner (Сергей, UTC+4, not technical) in plain Russian, with no jargon. Check facts before raising an alarm.
- Code goes to `Sergey` only. Merges Sergey→test→main and deploys belong to the owner, or need his explicit «да» for that exact step.
- No new `*.test.ts(x)` files. Run these gates:
  - `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:strict`
  - `npm run build:workers`
  - eslint on the changed files
  - the full `npx jest`
- RU must not change: gate new behaviour on market `us`.
- Prefer no migration.
- The cloud has **no access to production** (no SSH key; it must never be copied). Anything that reads or writes prod waits for the local Mac session and the owner's «да». That includes:
  - writing HST's fields;
  - rejecting hypotheses;
  - re-running research (about $1.9; it wipes the project's verticals and bases);
  - checking catalog values.
- Never print secrets. Do not commit `.env*`.

## State at handoff

- The site-reader fix is in main and deployed (06:47 UTC). HST's site now reads 6,591 chars, and its research finished at 08:49 UTC with the old empty brief (13 markets, 31 hypotheses, $1.88).
- Production is at `8b8580c42`, plus later deploys by the owner. `Sergey` carries these handoff docs on top.
- Nothing for the three features is implemented yet.
