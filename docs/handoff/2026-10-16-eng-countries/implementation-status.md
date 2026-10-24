# Implementation status — cloud session, 2026-10-16

Built on `Sergey` from `31d860d3e` strictly per `implementation-plan.md`. Not merged, not deployed. All three flags default **off**: `HE_ENG_COLLECT_COUNTRIES`, `HE_ENG_DNC_DOMAINS`, `HE_ENG_TIMEZONES_ALL`.

Commits:
- `0ccf661` foundation F1–F5 (engCountries, sourcePlanCountryGate, engCountryTimezone, clientBlocklist/blockedDomains, engRolloutFlags; `export` on `INSTANTLY_VALID_TIMEZONES`).
- `3bc878f` lanes A–E.
- the follow-up commit with the independent-review fixes (below).

Gates on the final tree: `typecheck:strict` 0 errors, `build:workers` ok, eslint 0 errors on all changed files (1 pre-existing warning in EngProjectsList.tsx), full `npx jest` 298/298 suites, `npm run build` ok. No `*.test.ts` added or edited, no migration.

Isolation checks: `git diff 31d860d3e` is empty for every RU-protected path in plan §5; `timezones.ts` differs by one `export`. Byte identity vs `31d860d3e` (same script run on both trees): `heCatalogPlanKey('ru'|'us')` without countries, `buildSourcePlanMessagesEn` / `buildCatalogRepairMessagesEn` / `buildCatalogWidenMessagesEn` / RU `buildSourcePlanMessages`, the EN and RU hypotheses prompts without a list, and the classifier on old notes — all identical.

## Deviations from the plan (and why)
- F2 drop reasons add `duplicate_slice` (the plan's dedupe step needs a reason).
- Dispatch assert (`heAssertTaskCountries`, BC): also accepts a scoped pdl task whose countries are a non-empty subset of L — label resolution drops catalog-unknown values, and the strict F2 assert would refuse every such task. Still inside L.
- Empty-countries memo stores `countries_empty_why`; no memo when the repair failed on a provider/model error.
- Late import and the refill final-fail slice degrade (not fail) on an over-cap DNC list: rows still pass the send-time check.
- `projectBriefPatch.ts` is also loaded by the browser, so the dry-vertical reset takes `resumeHeVerticalNightlyRefill` as an argument from the routes.
- The blocklist `?kind=` filter is not implemented.
- `launchSchedule.ts` reads `he_eng_launch_intent` itself (importing engAutoLaunch would be a cycle).
- Project list GET also returns a top-level `collect_countries_enabled` (the create form is shown only when the list is empty).
- Time-zone groups: "United States & Canada" (11) then a separate "Greenland" group.

## Independent review — fixed
1. Domain DNC write gate admitted non-client roles of any market → now requires market `eng` (`_eng.ts`).
2. Paid widen with a listed country missing from the catalog could re-buy an already-read slice nightly → re-gate (countries := L) after label resolution, before the "already read" check.
3. Collection-level DNC read could fail ENG collections even with all flags off → while `HE_ENG_DNC_DOMAINS` is off a read failure degrades (`dnc_unchecked`); send-time checks stay fail-closed.
4. `suggested_timezone` / the 'suggested' window source used zones outside the legacy 8 before the live Instantly check → both now behind `HE_ENG_TIMEZONES_ALL`; the finishing-launch brief read happens only then; the "different time zones" hint shows only with the full list.
5. `countries_uncovered` (and its memo) only when the list emptied the plan — not for a lone `duplicate_slice` or a provider/model repair failure (those get the generic note → provider/source codes).
6. The «Countries» card stays visible read-only when the flag is off but a list is stored.

Also: `do_not_contact_over_cap` added to `HE_COLLECT_STOP_REPEATS_CODES` (its text promises «Collect again», which only those codes get).

## Review — not changed (plan-intended or dormant)
- `repair_discarded` stores a slice that failed the first probe (plan §1A says rememberable; dormant while `HE_SLICE_PROBE_REPAIR_BELOW` = 0).
- New window reads (project intent, same-project templates) can refuse a finishing launch on a DB error — same class as the existing template read (plan §1C "fail-closed").
- Owner-visible: staff launches now prefer the project's «Launch» window and look for the client's last window only inside the same project.
- A refill base where every row is on the DNC list still ends `no_new` (no `do_not_contact` note).

## Owner decisions, 2026-10-16 evening (memory note `notes/vertical-engine/2026-10-16-e7a026229e9d.md`)
- **Rollout: everything at once.** Put all three flags into the prod env together with the deploy (daytime, not during the nightly refill). Right after the deploy: confirm every container runs the new build; live Instantly check of the 94 new zone ids (incl. the 9 suggested ones) on one paused test campaign with no leads; then test on HST. HST is a test client and is re-run from scratch anyway. Merge/deploy and every prod write still need the owner's «да» for that step.
- **Before rolling code back below this release** once domain rows exist: remove the `'@%'` rows first (rollback floor, plan §1B).
- **HST is run like any client, through the cabinet** (business description, target audience, «Countries», Do not contact domains) — no hand-written staff/SQL fields. Countries: Ireland, United Kingdom, Netherlands, Luxembourg, Germany, Denmark, Sweden, Finland, Norway, United States.
- Hidden jurisdictions and the 50-country cap: keep as built.
- **Deferred (do not forget):** per-region sending windows — (a) know each prepared company's country and drop out-of-list companies at send time; (b) split a market's launch into per-region campaigns with their own windows. Meanwhile, for mixed EU + US lists: 13:00–17:00 London time.
- **Letters rule — done:** a call ask is allowed only if the client's offer includes a call, and only from email 2 of the sequence on — never in email 1 (`prompts/chain.ts`, EN_US regulations + EN_US critic only). No opt-out lines (decided earlier).
- **Broader, fewer hypotheses — done** (owner: «чуть шире, можно меньше, как для русских вертикалей»): ENG hypotheses prompt follows VE2's 14.10 audience rules without the audience_scope contract — up to 15 broad audiences (usually 6–12), no minimum or tier quotas, close sub-niches joined with "or", selection conditions only from the client (no invented size/hiring/software/need), no US macro-sector walk, no 25%-per-sector cap, no "US → EU/LatAm" move. Schema floor 8 → 3 (no paid retry for an honest short answer). Clustering asks 3–8 markets instead of 4–12. RU prompts byte-identical (checked against `31d860d3e`).
- **Deploy readiness:** HST should be re-run only after a deploy that includes this commit, so research runs once with the broader hypotheses and the country list.
