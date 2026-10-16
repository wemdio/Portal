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

## Waits for the Mac session / owner «да»
Rollout per plan §4: read-only pre-checks (`'@%'` count = 0; funded `country` and jobhive `country_code` distributions) → deploy with flags off → confirm all containers → `HE_ENG_COLLECT_COUNTRIES` on → `HE_ENG_DNC_DOMAINS` on → live Instantly enum check of the 94 new ids (incl. the 9 suggested ones) → `HE_ENG_TIMEZONES_ALL` on → HST list via the staff route `PUT /api/tools/hypothesis-engine/projects/2971d740-…/collect-countries`.
Owner decisions still open (plan §6 item 15): hidden jurisdictions, suggested-zone default, live check, HST list and research rerun, DNC on + rollback floor, later country filter for prepared companies, max 50.
