**ENG countries, domain do-not-contact and time zones: implementation plan**

Worktree: `codex-worktrees/landing-ru`, branch `claude/eng-countries-dnc-tz-20261016`. Base for every diff is `e9df07b46` (origin/Sergey). HEAD `f882e72ab` adds only a docs commit on top of it.

Path shorthands:
- BC = `app/src/lib/hypothesisEngine/stages/baseCollect.ts`
- BCR = `app/src/lib/hypothesisEngine/stages/baseCollectRefill.ts`
- LT = `app/src/lib/hypothesisEngine/launchTemplate.ts`
- HE/ = `app/src/lib/hypothesisEngine/`
- API/ = `app/src/app/api/client/eng/`
- CE/ = `app/src/components/client-eng/`
- S = the scratchpad, `(local Mac scratchpad, not available in the cloud)`

---

## 1. Final decisions

### 1A. Country list for collection (owner decision 1; the US stays whole, decision 2)

**Storage.** The list is `he_projects.brief.collect_countries: string[]`.
- It is a top-level brief key, not part of `brief.icp`, and there is no new column.
- Why not `brief.icp`:
  - icp is a soft hint that no code enforces (HE/icpFrame.ts:17-22).
  - Its form locks after research (CE/EngStepBrief.tsx:418-423).
  - `icp: null` wipes the whole frame (HE/projectBriefPatch.ts:203-206).
  - The icp read truncates silently (icpFrame.ts:174-192).
- `brief` is jsonb, and `he_eng_create_project` inserts any jsonb object (supabase/migrations/20261010_0002:84-86,103-105).

**Shape.**
- Values are catalog spellings: lowercase, exactly as in `pdl_companies.country`.
- Deduped and sorted, so the same set always hashes the same.
- At most 50 entries (`HE_COLLECT_COUNTRIES_MAX`).
- A missing key or `[]` means today's behaviour, byte for byte.

**Allowlist.**
- A static module generated from `docs/handoff/2026-10-16-eng-countries/catalog-countries.tsv`: 249 values plus a header and a `(249 rows)` footer.
- The picker hides cuba, iran, north korea, syria, russia and belarus. This is a compliance default; it is one line to reverse, and the owner can do so. That leaves 243 offered values.
- Hidden values are refused on write. A value already stored is still enforced.

**Normaliser.**
- NFKD accent fold, then pdlCatalog's `labelKey` rules (HE/pdlCatalog.ts:69-76).
- An alias table that is a superset of COUNTRY_ALIASES (pdlCatalog.ts:96-106). Additions: england/scotland/wales/northern ireland → united kingdom; holland/the netherlands → netherlands; czech republic → the catalog spelling; türkiye → turkey.
- An unknown or hidden value gets HTTP 400 on write, never a silent drop.

**Read is fail-closed.** `readHeCollectCountries`:
- Missing, null or `[]` → no constraint.
- A non-empty array → every string value is kept, trimmed and lowercased, even if the allowlist no longer knows it. Unknown values are reported as `unavailable`.
- Present but malformed (not an array, or no strings) → the sentinel `['__invalid__']`, which matches nothing.

This works because label resolution drops dead labels, or marks the whole slice dead and removes it, and never widens it (pdlCatalog.ts:224-231; BC:2003-2012). **Stricter.**

**Frozen per base.**
- On the PLAN tick, a market `us` base reads the brief list and writes `collect_info.countries`, only when the list is non-empty. This goes in the same paid checkpoint as the plan (BC:6257-6267).
- Every later tick of that base uses the frozen list: dispatch, harvest, widen (via `collectPlanInput`), and import.
- Bases planned before deploy have no key and keep today's behaviour.
- Collect_info writers spread the object, so the key survives (BC:1444-1458).
- Projection whitelist `COLLECT_INFO_FIELDS=['limit']` keeps it hidden from the client (HE/clientEngProjection.ts:578). **Stricter.**

**Gate rules.** These replace both designs' X∩L rule; they fix the blocker and the coverage major. They apply only when market is `us` and L is non-empty.

- **pdl**
  - Keep the task only if it has a scope key: non-empty `industries` or a non-empty `name` (HE_PDL_SCOPE_FILTER_KEYS, schemas.ts:349). Otherwise drop it with reason `pdl_no_scope`.
  - Kept tasks get `countries := L`, whatever the planner wrote: empty, unresolved ('europe', 'EU', 'Nordics'), disjoint or a subset.
  - So a countries-only or sizes-only slice over L can never exist. Coverage of L is guaranteed by construction.
  - **Stricter** than any slice outside L. **Softer** than a narrower planner pin inside L, but never wider than today's scope slice with no country, which reads all 249 countries.
- **funded**: `countries := L` and the task is never dropped. funded is read page by page by `created_at,id` (BC:3043-3060) and has no materialized CTE. **Stricter.**
- **eng_hiring**: `countries := iso2(L)` (eng_hiring_cache country_code is ISO-2, lowercase). If iso2(L) comes out empty, drop with reason `hiring_no_codes`; never send `countries: []`, because an empty list means "no filter" (BC:3288,3321). Remote postings and postings with a NULL country drop out. **Stricter.**
- **google_maps**
  - Drop the task (reason `maps_us_not_listed`) unless 'united states' is in L.
  - If kept, `maps_query.geo := 'United States'` unless the geo is strictly US: exactly `United States`/`USA`/`US`, a bare US state name, or `, <state name|USPS code>[ ZIP]` anchored at the end. This replaces `buildCountryRegex(['us'])`, which accepts foreign places (atsFilters.ts:56-63).
  - At harvest, maps rows are kept only if their address matches `\b<USPS code>\s+\d{5}(-\d{4})?\b` or `,\s*(United States|USA)\s*$`. Empty addresses are dropped. The count goes to `stats.excluded_outside_countries`.
  - **Stricter.**
- **Other sources**: untouched (the market gate removes them first; sourcePlanMarketGate.ts:55-58).
- After gating, drop later tasks whose `heCatalogSliceKey` duplicates an earlier one (catalogCursor.ts:169-182).
- The gate never adds tasks, is idempotent, and returns the **same object** when market ≠ 'us', when L is empty, or when nothing changes.

**Order at every site.** Market gate → country gate → unfounded-size strip → pdl label resolution.
- buildPlan already strips sizes and resolves labels after its gate (BC:1988-2012).
- The widen path changes from labels-first (BC:2416-2451) to gate-first.

**Call sites.**

| Where | Change | Label |
|---|---|---|
| Model answer (BC:1988) | `heGatePlan` (market + countries) | stricter |
| After repair (BC:2015) | `heGatePlan` | stricter |
| After probe (BC:2019) | `heGatePlan` | stricter |
| Inside `ensureCatalogSource` (BC:2072-2099) | Gate the repair slice. If it is dropped: `planRepair = {outcome:'failed', error:'срез починки вне списка стран проекта (нет отрасли или имени)', countries_gate:true}`. `heRememberablePlan` treats `countries_gate:true` as rememberable, so there is no nightly re-buy (fixes minor 1). | stricter |
| Probe retry (BC:2245-2256) | Gate `retried` before `probe([retried])`. If dropped, keep the gated plan, use new outcome `'repair_discarded'` (rememberable), and do not call the second probe. | stricter |
| Paid widen (BC:2416-2457) | Widen variant: if the planner's countries resolve to nothing in L, or any value is unresolved → `plan_widening={outcome:'failed', error:'срез вне списка стран проекта'}`, which sets the 7-day cooldown (catalogCursor.ts:300). No scope key → same failure. Otherwise `countries := L`, then labels, then the known-key check (BC:2435-2445). No substitution of a disjoint pin. | stricter |
| Stored plan read (BC:6135-6148) | `heGatePlan` on every read (free). If every task is dropped → one paid replan, as the market gate does today. | stricter |
| `rememberPlan` (BC:3545) | Also apply `gateHeSourcePlanCountries` | stricter, idempotent |
| `dispatchTask` (BC:3649) | `assertHeTaskWithinCountries(task, frozenL)` throws `HeCountryRefusal` before any collector runs | stricter |
| `harvestSlice` (BC:4430) plus its callers (BC:6642, refill final-fail slice BC:5677) | maps address filter with the frozen L | stricter |

**Empty plan caused by the list** (fixes the "client told to relaunch" major).
- In the stop at BC:6230-6255, when country drops contributed, the note becomes `Авто-сборка не дала строк: нет источника для стран проекта — <why>. Коллекторы не вызывались.`
- New client code `countries_uncovered`; its rule sits ABOVE line 223 in HE/clientErrors.ts.
- A free memo, with no migration: upsert `he_catalog_cursors` with `plan = {tasks: [], countries_empty_at: <iso>}` and `plan_key = <key>`.
  - Keep the existing bookmarks: pass their keys as `sliceKeys`, so `pickBookmarks` keeps them (catalogCursor.ts:410-420).
  - `reusablePlan` already rejects an empty plan (BC:3526).
  - A new `emptyCountriesMemo(planKey)` check runs before `buildPlan`. Same key and less than 7 days old → the same failed note plus `(повтор без оплаты)`, and no planner or repair call.
  - The memo only applies when country drops contributed, so RU and today's market-gate empty plans are unchanged. **Stricter** (fewer paid calls).

**Plan key.**
- `promptInput.countries` is set only when L is non-empty. `stableHash` drops undefined (catalogCursor.ts:134-142), so RU keys and keys for us without a list are byte-identical.
- No `HE_SOURCE_PLAN_REVISION` bump (catalogCursor.ts:228).

**Prompts (EN only).**
- The `TARGET COUNTRIES` block is appended to the planner, repair and widen user messages only when countries are present (sourcePlan.en.ts). It says:
  - "countries are applied by code — omit them";
  - "every pdl slice must name industries or a name substring";
  - "eng_hiring countries are set by code";
  - "google_maps only if United States is listed, with a US geo";
  - for widen: "an adjacent-country move must stay inside the list".
- The SYSTEM prompts stay byte-identical.
- Research hypotheses (hypotheses.en.ts) get a conditional block that overrides the US macro-sector checklist and the "US→EU" move (hypotheses.en.ts:186,194). New runs only.
- The RU files `prompts/sourcePlan.ts` and `prompts/hypotheses.ts` are not touched.

**Leak prevention.** HE/stages/chain.ts:340 also strips `collect_countries`. It is byte-identical when the key is absent.

**Write flag.** `HE_ENG_COLLECT_COUNTRIES`, default off.
- While off: POST, PATCH and the staff route return 400 `countries_unavailable`, and GET returns `collect_countries_enabled:false`.
- The engine enforces stored lists regardless.
- Turn it on after every container runs the new code, because an old worker would ignore a list silently.

**Dry-vertical reset.**
- When a PATCH or staff PUT *broadens* the list (old list non-empty AND (new is empty OR new ⊄ old)), call `resumeHeVerticalNightlyRefill` (HE/autoPipeline.ts:2892-2903). It runs only for the project's verticals with `refill_dry_since` set.
- Best effort: logged, never fails the write.
- Narrowing never resets. **Softer**, bounded: one replan per vertical per broadening, and only relevant with HE_VERTICAL_DRY_STOP on.

**Prepared companies (major).** v1 does not apply list changes retroactively; the copy says so.
- Carry-over can still send for 7 days (BCR:3830-3840), and unlaunched bases indefinitely.
- An address-country filter at launch, refill and carry-over is deferred as an owner decision.

**Copy (fixed).**
- "We collect companies only from the countries you choose here. Leave it empty and we choose the countries for each market — companies can then come from any country in our catalog."
- "Changes apply from the next collection. A collection that is already running finishes with the countries it started with. Companies we prepared before the change can still be emailed."
- When US is not selected: "Local business listings cover the United States only, so they are not used for these countries."
- For unavailable values: "No longer available in our catalog: X. Nothing is collected for it."
- When the project has hypotheses: "Market ideas written before you chose countries are not rewritten; new collections still use only these countries."

**Placement.** Its own always-editable «Countries» card on step 1, ABOVE the collapsed `<details>` at CE/EngStepBrief.tsx:1198 and not under the icp lock. Plus an optional collapsed picker in the create form.

### 1B. Domain-level do-not-contact (owner decision 5; ships dark)

**Storage.** `'@'+host` in `client_blocked_contacts.email` (Instantly DB), with source `'manual'`. No migration.
- RU cannot write it: EMAIL_RE needs a local part (blockedContacts.ts:26,32-38).
- engDncRemoval ignores it (engDncRemoval.ts:913-914).

**Write gate (major 1).**
- `kind:'domains'` is accepted only when `HE_ENG_DNC_DOMAINS` is on AND `requireEngMarket(portalDb, userId)` returns ok with market 'eng' (HE/apiGuards.ts:166-193). This is checked before the body is parsed; otherwise 403 and no write.
- Reason: `auth.market` comes from the request host (clientApiHelper.ts:89-92), and the HE RU launch path is fail-OPEN on a blocklist throw (LT:3500-3533).

**Normaliser** (new module `blockedDomains.ts`, fixes the normalisation minor).
- Take the text after the last '@'; strip scheme, path, query, port and `www.`; lowercase.
- Convert IDN to punycode with `new URL('https://'+h).hostname`, then strip trailing dots. Email hosts go through the same conversion.
- Refusals:
  - `invalid`: IP, localhost, or no TLD.
  - `not_company`: a public suffix, or a private suffix via `tldts` `allowPrivateDomains`; `normalizeLeadWebsite`=null (HE-shared leadContactValues.ts:4-10,25-29); or a site-builder host (weebly.com, wordpress.com, squarespace.com, godaddysites.com, business.site).
  - `personal`: any label-boundary suffix is `isFreeProvider`/`isDisposable` (emailValidation/shared.ts:72,95-128), or in the ENG supplement.
- Suffix tests always walk labels.
- `mail.google.com` is classed `not_company` (the harness expectation is fixed).
- The host is stored as typed. Subdomains are reported with a hint to add the parent domain.

**Matching.**
- Entry D blocks host H when `H===D || H.endsWith('.'+D)`.
- It is checked against:
  - the email host;
  - `lead.website`;
  - the row's website column, resolved by `findCompanyKeyColumns(columns).website` (HE/launchHandoff.ts:1025), never a hard-coded `.website`.
- No `custom_variables` matching (fixes the fallback over-blocking minor).
- `kept` keeps the same object references in input order. Email rules are delegated verbatim to `filterBlockedLeads`.

**Collection.**
- `HeBaseExclusionKeys.dncDomains` is an empty set for RU and for `heCarryExclusionKeys`.
- `matchesExclusion` and `matchesExclusionContact` check DNC first (BC:4219-4263).
- Hits are counted separately at selection (`state.excluded_dnc_during_fetch`), at harvest, and at the import recheck (`droppedDoNotContact`). They stay out of `excluded_during_fetch` and `sliceAlreadyHarvested` (BC:6788-6790).

**Collection outcome** (major 3). When DNC is the dominant cause of zero rows:
- note `Авто-сборка не дала строк: все найденные компании — в списке Do not contact клиента (…)`;
- new client code `do_not_contact`, rule ABOVE line 223;
- late import gets kind `'all_do_not_contact'` (BC:5693,5757; HE/validationRetry.ts:1078).
- **Stricter.**

**DNC read on collection** (major 2). The snapshot loads OUTSIDE `runDispatch`'s catch at two points:
1. before the DISPATCH loop, when any catalog task is pending (BC:6398);
2. before `getExcludedKeys()` at HARVEST (BC:6641). This also covers the import tick, which reuses `existingKeys` (BC:7104-7111).

On a read error:
- `info.dnc_read_failures++`, persist, then `requeueSelf(ctx, job, 300_000)`. A requeue spends no attempt (BC:4074-4100).
- After 6 consecutive failures:
  - with no constructor yet (`!info.construct`) → base failed: `Список Do not contact клиента не прочитан (6 раз подряд): …` → client code `internal`;
  - once the constructor is paid → continue without collection-level DNC, set `stats.dnc_unchecked=true` and log. Launch step 5a and refill step 4 still enforce DNC fail-closed.
- An over-cap list (`BlockedContactsOverCapError`) at any point → base failed: `Список Do not contact клиента больше 10 000 записей` → new code `do_not_contact_over_cap`.
- The late import (BC:5733-5760) and the refill final-fail slice (BC:5677) try the snapshot and degrade the same way, because those rows still pass send-time DNC.

**Collection owner (minor).**
- First collection: `he_projects.created_by`.
- Refill bases (`isRefill`): the preset owner of the vertical's launched template. Same read as BCR:5129-5157, using the exported `pickRefillTemplate` (BCR:2419).
- If the two differ: log once. If created_by is null: empty set.

**Send-time.**
- LT step 5a (LT:2045-2091): snapshot + `filterBlockedContacts`, row website column via `siteOf`. The fail-closed catch and the all-blocked refusal are unchanged.
- BCR step 4 (BCR:5451-5456): `args.market==='us'` branch only.
- `appendLeadsToClientCampaign` gets optional `blocklistDomains` (appendLeads.ts:207-219). The HE refill passes `market==='us'` (BCR:5727). Every RU caller passes nothing and runs byte-identical code.
- Autopilot preflight reads via the snapshot (autoPipeline.ts:2363).
- The rows route `ready` count (API/bases/[id]/rows/route.ts:114,188-211).
- **Stricter** for ENG; RU identical.

**Rollback runbook (major 4).** Once any `'@%'` row exists, the reader release is the rollback floor.
- To roll back below it: with the owner's «да», copy the `email like '@%'` rows to a backup file on the server and delete them; restore after roll-forward.
- Pre-deploy (read-only, owner OK): `select count(*) from client_blocked_contacts where email like '@%'` must be 0.
- Post-deploy: the same count joined to `profiles.market <> 'eng'` must stay 0.

**UI caveats (minor).**
- The remove confirmation says: "Companies we skipped while it was listed may not be collected again."
- The base preview (CE/EngStepBases.tsx) shows: "Companies on your Do not contact list stay in older bases but are not added to campaigns."
- Wording "addresses" becomes "entries" in the cap texts.

**Flag.** `HE_ENG_DNC_DOMAINS`, default off; it gates adding only. Turn it on after all containers run the readers.

**Not in v1:** removing people already in running campaigns, exact-email drops at collection, and a "Block company" button on Replies.

### 1C. Time zones (owner decision 4)

**List.** All 102 ids in `INSTANTLY_VALID_TIMEZONES` (app/src/lib/clientLaunch/timezones.ts:30-58; the header's "~92" is stale).
- Labels and groups come from `S/eng-tz/table.mjs`, with one change: the first group is renamed "United States & Canada" and Regina, Glace_Bay and St_Johns move into it.
- New-list labels may name more cities: Central "…, Winnipeg"; Mountain "…, Calgary, Edmonton"; Pacific "…, Vancouver" with its existing caveat. The legacy 8 stay byte-identical in the legacy field.

**Validation is unchanged.** The server already accepts every whitelisted id (API/_launchWindow.ts:171; HE/launchSchedule.ts:89-92). RU options and validation are untouched.

**Deploy-skew fix (minor).**
- `timezones` stays exactly the legacy 8 `{value,label}`.
- A NEW key `timezone_options: {value,label,group}[]` (102 entries) is added to both GETs (API/projects/[id]/launch/route.ts:171; API/templates/[id]/schedule/route.ts:286). It is present only when `HE_ENG_TIMEZONES_ALL` is on.
- New JS renders `timezone_options ?? timezones` and preselects only from `timezones`. No `suggest` flag is needed.

**Release blocker (major 3).**
- `HE_ENG_TIMEZONES_ALL` stays off until a live check confirms the ids, done once with the owner's «да». The check:
  - read Instantly's campaign schema enum;
  - PATCH and GET `campaign_schedule` on one paused campaign with no leads, for each of the 94 new ids;
  - record the date in the timezones.ts header.
- Ids that are not accepted, or not echoed unchanged, are left out of the ENG table.
- New ids from the live enum go into an ENG-only extension list, NOT into `INSTANTLY_VALID_TIMEZONES`, because that would soften RU validateLaunchInput.ts:53-55.
- Drift cost: at most 3 paid classifier runs per template per Launch (engAutoLaunch.ts:766-767,962-973), then 'failed' plus an alert. Bounded, not zero.

**Canonical echo.**
- `readEngCampaignSendingWindow` (API/_launchWindow.ts:336-342) maps the canonical names Instantly may echo back to our link ids, using a generated alias map in `_launchTimezones.ts`, for example America/Nuuk→America/Godthab and Asia/Yangon→Asia/Rangoon.
- Read-only display fix.

**Window resolution** (major 2; ENG only, RU still returns 'preset' at launchSchedule.ts:113 before any new read). The order becomes:
1. explicit
2. template
3. **project**: `he_eng_launch_intent.schedule` for the project (20261012_0001:85-95). Missing table or row → none. Any other read error → readError (fail-closed, as the template read is).
4. **client**: limited to templates of the same project.
5. **suggested**: from the country list.
6. default.

**Default (major 1).**
- `suggestEngTimezoneForCountries(L)` returns a zone only when L is non-empty, has no 'united states', and every country maps to the same offset class (WET, CET or EET, …). Otherwise null.
- It is used in the UI start value (saved schedule → `suggested_timezone` → browser match among the legacy 8 → default) and as the server's 'suggested' source.
- When the list excludes the US and gives no suggestion, a hint reads: "Your countries are in different time zones. Choose the time zone your emails should follow."
- The Detroit default remains for everything else. This is ENG-only and changes hours only for non-US, single-class lists. It is owner-visible and listed in §6.

**Risk list.** Add the zones whose rules changed recently to the release note:
- Bahia_Banderas (labelled Mexico City), Amman, Damascus, Tehran, Cairo, Fiji, Apia;
- plus the design's Chihuahua, Vostok, Asuncion, Godthab, Scoresbysund and Choibalsan.

**Labels:** dropdown softer (UI only); server validation unchanged; window resolution stricter (no cross-project leak).

---

## 2. Foundation (one agent, sequential, must typecheck before any lane starts)

**F1. `app/src/lib/hypothesisEngine/engCountries.ts`** (new, pure, safe in the browser, no runtime imports)

The data is generated offline by `S/eng-build/gen-countries.mjs` from the tsv. iso2 comes from Intl.DisplayNames for 231 values plus the 18 manual ones listed in the design.

```ts
export interface EngCountry { value: string; label: string; iso2: string }
export const ENG_COUNTRIES: readonly EngCountry[];        // offered values, sorted by label
export const ENG_COUNTRIES_HIDDEN: readonly string[];      // cuba, iran, north korea, syria, russia, belarus
export const HE_COLLECT_COUNTRIES_MAX = 50;
export const ENG_COUNTRY_US = 'united states';
export function engCountryKey(raw: string): string;        // NFKD fold + labelKey rules
export function normalizeEngCountry(raw: unknown): string | null;   // alias-aware; catalog value or null (hidden → null)
export function canonicalEngCountries(values: readonly string[]): string[]; // dedupe + sort
export type HeCollectCountriesParse =
  | { ok: true; countries: string[] }                       // null/[] → []
  | { ok: false; error: 'not_array' | 'too_many' | 'unknown'; input?: string };
export function parseHeCollectCountries(raw: unknown): HeCollectCountriesParse;
export function heCollectCountriesErrorText(e: Extract<HeCollectCountriesParse,{ok:false}>): string;
// 'Unknown country: "X". Choose countries from the list.' | 'Choose up to 50 countries.' | 'collect_countries must be a list of country names.'
export function readHeCollectCountries(raw: unknown): { countries: string[]; unavailable: string[] }; // fail-closed per §1A
export function engCountryLabel(value: string): string;
export function engCountryIso2(value: string): string | null;
```

**F2. `app/src/lib/hypothesisEngine/sourcePlanCountryGate.ts`** (new, pure, server). It imports F1, `HE_PDL_SCOPE_FILTER_KEYS` (schemas.ts:349), `heCatalogSliceKey` (catalogCursor.ts:169) and plan types.

```ts
export type HeCountryDropReason = 'pdl_no_scope' | 'maps_us_not_listed' | 'hiring_no_codes';
export function gateHeTaskCountries(task: HeCollectTask, countries: readonly string[]):
  { task: HeCollectTask; changed: boolean } | { dropped: HeCountryDropReason };
export function gateHeSourcePlanCountries(plan: HeSourcePlan, market: HeMarket, countries: readonly string[]):
  { plan: HeSourcePlan; dropped: Array<{ source: string; reason: HeCountryDropReason }>; changed: number }; // same object if no-op
export function gateHeWidenTaskCountries(task: HeCollectTask, countries: readonly string[]):
  { task: HeCollectTask } | { refused: 'outside_list' | 'pdl_no_scope' };
export function heUsMapsGeo(geo: string | undefined): string;          // strict US or 'United States'
export function heUsMapsAddress(address: string): boolean;             // harvest filter
export function heTaskWithinCountries(task: HeCollectTask, countries: readonly string[]): boolean;
export class HeCountryRefusal extends Error { readonly source: string }
export function assertHeTaskWithinCountries(task: HeCollectTask, countries: readonly string[]): void; // no-op if empty
```

**F3. `app/src/lib/hypothesisEngine/engCountryTimezone.ts`** (new, pure, safe in the browser). It imports F1 and `isInstantlyValidTimezone`.

```ts
export function suggestEngTimezoneForCountries(countries: readonly string[]): string | null;
```

It holds a single-zone country map to whitelisted ids, plus hardcoded offset classes (WET, CET, EET, …). When all countries map to one id, it returns that id; when they share a class, the first sorted country's id.

**F4. `app/src/lib/clientBlocklist/blockedDomains.ts`** (new; `blockedContacts.ts` stays byte-identical)

```ts
export type HeBlockedDomainRefusal = 'invalid' | 'personal' | 'not_company';
export function normalizeBlockedDomain(raw: unknown):
  { ok: true; domain: string; subdomainOf: string | null } | { ok: false; refused: HeBlockedDomainRefusal; input: string };
export function parseBlockedEntry(stored: unknown): { kind: 'email'; email: string } | { kind: 'domain'; domain: string } | null;
export interface BlockedContactSnapshot { emails: ReadonlySet<string>; domains: ReadonlySet<string> }
export class BlockedContactsOverCapError extends Error {}
export async function getBlockedContactSnapshot(db: SupabaseClient, userId: string): Promise<BlockedContactSnapshot>;
// copies every completeness check of blockedContacts.ts:54-83 with a cross-reference comment; over-cap → BlockedContactsOverCapError
export function contactHost(value: unknown): string | null;        // email host or website host, punycode, no www
export function blockedDomainHit(domains: ReadonlySet<string>, value: unknown): string | null;
export function filterBlockedContacts<T extends { email: string; website?: string | null }>(
  leads: readonly T[], snapshot: BlockedContactSnapshot, siteOf?: (lead: T, index: number) => unknown,
): { kept: T[]; blockedCount: number; blockedByEmail: number; blockedByDomain: number }; // same refs, input order
```

**F5. `app/src/lib/hypothesisEngine/engRolloutFlags.ts`** (new). It uses the same ON_VALUES convention as engDncRemoval.ts:168-174.

```ts
export function heEngCollectCountriesEnabled(env?: NodeJS.ProcessEnv): boolean;  // HE_ENG_COLLECT_COUNTRIES
export function heEngDncDomainsEnabled(env?: NodeJS.ProcessEnv): boolean;        // HE_ENG_DNC_DOMAINS
export function heEngTimezonesAllEnabled(env?: NodeJS.ProcessEnv): boolean;      // HE_ENG_TIMEZONES_ALL
```

**Cross-lane contracts** (fixed names; no lane may rename them)
- Brief key `collect_countries`.
- collect_info `countries`, `dnc_read_failures`.
- Task state `excluded_dnc_during_fetch`.
- Stats `excluded_do_not_contact`, `dropped_do_not_contact`, `excluded_outside_countries`, `dnc_unchecked`.
- Client codes `countries_uncovered`, `do_not_contact`, `do_not_contact_over_cap`.
- Late-import kind `all_do_not_contact`.
- API keys:
  - projects: `brief.collect_countries: string[]`, `brief.collect_countries_unavailable: string[]`, `collect_countries_enabled: boolean`;
  - launch GET: `timezone_options?`, `suggested_timezone?`;
  - blocklist: item `kind:'email'|'domain'`, `value`; page `domains_total`, `domains_enabled`;
  - POST blocklist: `{text, kind?:'emails'|'domains'}` → domains response `{kind:'domains', added, already_listed, invalid, personal, not_company, subdomains:{count, examples}, total}`.

---

## 3. Lanes (exclusive file ownership; all five run in parallel after foundation)

### Lane A: collection engine
Files: BC, HE/catalogCursor.ts, HE/prompts/sourcePlan.en.ts, HE/validationRetry.ts, HE/clientErrors.ts, CE/clientFailureText.ts

**BC**
- **Types.** `HeCollectInfo` (BC:1040) gets `countries?`, `dnc_read_failures?`. `HePlanRepair` (BC:967) gets `countries_gate?: true`. `HeSliceProbe.outcome` (BC:1024) gets `'repair_discarded'`. The task state gets `excluded_dnc_during_fetch?`.
- **`collectPlanInput`** (BC:1480-1569) takes `countries: readonly string[]`. It sets `promptInput.countries` only when non-empty (type `SourcePlanPromptInputEn`).
- **Gate wrapper.** `heGatePlanForMarket` (BC:1930-1947) becomes `heGatePlan(ctx, plan, market, countries, where, marketDropped, countryDropped)`. It logs every drop and change.
- **buildPlan, ensureCatalogSource, ensureSliceMatchesVertical, widen, rememberable**: thread `countries` through and apply the §1A rules at BC:1988, 2015, 2019, 2072-2099, 2245-2256, 2416-2457 and 2327-2330.
- **`createHeCatalogRun`** (BC:3505-3630):
  - `rememberPlan` also applies `gateHeSourcePlanCountries`;
  - new `emptyCountriesMemo(planKey)` and `rememberEmptyCountriesPlan(planKey)`, implemented with catalogCursor helpers.
- **`dispatchTask`** (BC:3632):
  - new param `countries`;
  - assert after BC:3649;
  - the catalog fetchers (`fetchPdlRows`/`fetchFundedRows`/`fetchEngHiringRows`, BC:2869/3018/3276) use a new `exclusionReason(keys, …): 'dnc' | 'other' | null` and return `excludedDncDuringFetch` separately;
  - fix the staff log at BC:3775-3781.
- **Exclusion keys**:
  - `HeBaseExclusionKeys` and `emptyExclusionKeys` (BC:4179-4207) get `dncDomains`;
  - `loadOtherBaseExclusionKeys(ctx, projectId, baseId, market, dncDomains: ReadonlySet<string> | null)` (BC:4313);
  - matchers BC:4219-4263 check DNC first.
- **`harvestSlice`** (BC:4430) takes `countries`, applies the maps address filter, and returns `excludedDnc` and `excludedOutsideCountries`.
- **`heRecheckImportedRows`** (BC:4484) returns `droppedDoNotContact`.
- **Stage** (BC:5851+):
  - derive L after BC:5940: `market!=='us'` → []; `info.plan` present → `info.countries ?? []`; otherwise `readHeCollectCountries(project.brief?.collect_countries).countries`;
  - memo check before `buildPlan` (BC:6166);
  - write `info.countries` before the persist at BC:6267;
  - countries note plus memo at BC:6230-6255;
  - `ensureDnc` points and policy (§1B), with the owner resolved by a local `resolveHeDncOwner()`;
  - stats at BC:6663-6671;
  - DNC-dominant `closeWithoutRows` reason; keep DNC counts out of `sliceAlreadyHarvested` (BC:6788);
  - import-tick DNC reason at BC:7115-7139;
  - `prepareHeLateConstructImport` gets kind `'all_do_not_contact'` (BC:5693,5757);
  - the refill final-fail slice (BC:5677) gets frozen L plus a degraded DNC read.

**catalogCursor.ts**
- Doc comment saying countries are part of the plan-key input, with no revision bump.
- Export `heCountriesEmptyMemoAt(row, planKey, nowMs): string | null` (7 days).

**sourcePlan.en.ts**
- Export `type SourcePlanPromptInputEn = SourcePlanPromptInput & { countries?: string[] }`.
- Conditional TARGET COUNTRIES block in the planner, repair and widen user messages (sourcePlan.en.ts:112-192).
- SYSTEM constants (:31-81) stay byte-identical.

**validationRetry.ts:1078**: handle `'all_do_not_contact'` the same way as `all_in_other_bases`, with the DNC note.

**clientErrors.ts**
- New rules ABOVE line 223, in this order: DNC unreadable → `internal`; over-cap → `do_not_contact_over_cap`; `в списке Do not contact клиента` → `do_not_contact`; `нет источника для стран проекта` → `countries_uncovered`.

**clientFailureText.ts**
- The three codes in the union (around :40-108) and in FAILURES. `countries_uncovered` and `do_not_contact` are added to `HE_COLLECT_STOP_REPEATS_CODES` (:140-144).
- Texts must be English and free of vendor and table names (tests/architecture/verticalEngineV2Isolation.test.ts:228-238).
  - countries_uncovered: "None of our company sources cover the countries chosen for this project for this market." What to do: "Add countries or clear the list in «Countries» on step 1, then press «Collect again» for this market on step 3."
  - do_not_contact: "Every company found for this market is on your Do not contact list." What to do: "Remove the domains you want to reach from Do not contact, then press «Collect again»."
  - over_cap: "Your Do not contact list is over its limit of 10,000 entries." What to do: "Remove entries you no longer need, then press «Collect again»."

### Lane B: API, validation, projection, research prompts, blocklist API
Files: API/projects/route.ts, API/projects/[id]/route.ts, HE/projectBriefPatch.ts, HE/clientEngProjection.ts, app/src/app/api/tools/hypothesis-engine/projects/[id]/collect-countries/route.ts (new), app/src/app/api/client/blocklist/_eng.ts, app/src/app/api/client/blocklist/route.ts, HE/engDashboard.ts, HE/stages/hypotheses.ts, HE/prompts/hypotheses.en.ts, HE/stages/chain.ts

**projectBriefPatch.ts**
- `HeBriefPatchClientFields.collect_countries?: string[] | null` (:77-84).
- The no_fields guard includes it (:120-128).
- In the write: null or `[]` → delete; else set the canonical list (beside :203-207).
- `buildHeEngCreateBrief` writes a non-empty list (:242-261).

**PATCH** (API/projects/[id]/route.ts:522-668)
- Parse `collect_countries` after the body parse, before any DB access, like icp at :559-567.
- Flag off with the key present → 400 `countries_unavailable`.
- Add it to `briefRequested` (:573-577).
- Non-us → 409 "Countries apply only to projects in the US market", next to :584-586 and before the cap write.
- Pass it in clientFields (:637-643).
- After success: audit `client.eng.project.collect_countries_changed` {before, after}, plus the broadening dry reset.

**POST create** (API/projects/route.ts:150-203): optional `collect_countries`, same parse and flag rules.

**Staff route** (new)
- `requireInternalToolAuth`, as tools/hypothesis-engine/projects/[id]/route.ts:55-60 does.
- GET returns `{countries, unavailable, labels, allowlist}`. PUT takes `{countries: string[]|null}`.
- Market ≠ us → 409 'Только для проектов рынка us'.
- Write via `patchHeProjectBrief(…, {}, {collect_countries})`.
- Gated by the same flag. The existing staff PATCH and the RU tool UI are not touched.

**clientEngProjection.ts**
- `brief.collect_countries`, `brief.collect_countries_unavailable` (computed beside :1308).
- Top-level `collect_countries_enabled`.
- `excluded_do_not_contact` added to `COLLECT_STATS_FIELDS` (:514-520).

**hypotheses.ts and hypotheses.en.ts**
- `HypothesesPromptInputEn.collectCountries?: string[]` (labels; hypotheses.en.ts:72-75).
- Passed only for us with a non-empty list (hypotheses.ts:385-420).
- A conditional block; byte-identical when absent.

**chain.ts:340**: also strip `collect_countries: _cc`.

**Blocklist**
- `_eng.ts`:
  - POST `kind:'domains'` branch per §1B: flag, then `requireEngMarket`, then the existing block refusal (:475), `parseEngBlocklistDomains`, insert via the existing add machinery (:557-664) with `'@'+domain`, audit `client.blocklist.eng_domains_added`;
  - GET items get `kind`/`value`, plus `domains_total` (head count `.like('email','@%')`) and `domains_enabled`;
  - DELETE of a domain row → audit `client.blocklist.eng_domain_removed`;
  - cap texts "entries" (:102-136).
- route.ts: only the ENG demo object (:36-47) gets `domains_total:0, domains_enabled:false`. RU code below the fork is not edited.
- engDashboard.ts:1550-1551: wording "entries".

### Lane C: send-time DNC and window resolution
Files: LT, HE/launchSchedule.ts, HE/engClientLaunch.ts, BCR, app/src/lib/clientLaunch/appendLeads.ts, HE/autoPipeline.ts, API/bases/[id]/rows/route.ts

**LT**
- Step 5a (LT:2045-2091): snapshot plus `filterBlockedContacts` with `siteOf` from `findCompanyKeyColumns(base.columns).website`. Rebuild `leadRowIndices` by object identity.
- New MESSAGES key `blockedByDomainNote` (en; plus a ru string for type completeness, never used on the RU path).
- Audit `blockedByDomain` (LT:3325).
- Window: pass `projectId` and `projectCountries` at LT:1833.
- `launchWindowNote` texts for the 'project' and 'suggested' sources (LT:637, 955), and the condition at LT:3245.
- RU function LT:3443-3540 untouched.

**launchSchedule.ts**
- Args `projectId: string | null` and `projectCountries?: readonly string[]`.
- Source union adds `'project' | 'suggested'` (:52).
- The order from §1C.
- The non-us return at :113 stays first.

**engClientLaunch.ts:599-605**: pass `project.id` and `readHeCollectCountries(project.brief…)`.

**BCR**
- Step 4 (:5451-5456): `args.market==='us'` → snapshot plus `filterBlockedContacts`. siteOf comes from the own rows' `finalColumns` website column, or from the carried company's columns via `carriedLeadOwner`.
- `runStats.skipped_blocklist_domain`.
- The else branch is the existing two lines.
- `appendGroup` passes `blocklistDomains: args.market==='us'` (:5727-5731).

**appendLeads.ts:207-219**: `blocklistDomains?: boolean`. Undefined or false → current lines unchanged. True → snapshot path, matching the email host plus `lead.website` only.

**autoPipeline.ts:2363**: `getBlockedContactSnapshot`. The over-cap head count stays as it is.

**rows/route.ts**: snapshot plus `filterBlockedContacts` with the website column at :114 and :188-211. `blocked` now includes domain hits.

### Lane D: time-zone server
Files: API/_launchWindow.ts, API/_launchTimezones.ts (new, data only), app/src/lib/clientLaunch/timezones.ts, API/projects/[id]/launch/route.ts, API/templates/[id]/schedule/route.ts

**`_launchTimezones.ts`**
- `ENG_TIMEZONE_TABLE: {value,label,group}[]`, 102 entries per §1C.
- `ENG_TIMEZONE_ECHO_ALIASES: Record<string,string>`.

**`_launchWindow.ts`**
- Keep `EngSendingWindowTimezoneOption`, `ENG_SENDING_WINDOW_TIMEZONES` (the legacy 8, unchanged) and every existing export signature; launchSchedule.ts imports them.
- Add `ENG_SENDING_WINDOW_TIMEZONE_OPTIONS`, built from `INSTANTLY_VALID_TIMEZONES` in table order:
  - whitelisted ids missing from the table → group 'Other', listed in `…_UNLABELED`;
  - table ids missing from the whitelist → `…_DROPPED`.
- Add `engSendingWindowTimezoneOptions()`.
- Apply the echo alias in `readEngCampaignSendingWindow` (:336-342).
- Comment at :49-62.

**timezones.ts:30**: the `export` keyword only.

**Launch GET (:164-174)**
- `timezone_options` when `heEngTimezonesAllEnabled()`.
- `suggested_timezone` from F3 using the project brief list.
- `timezones` unchanged.

**Schedule GET (:286)**: `timezone_options` behind the same flag. `noteDroppedTimezones` (:84-96) also logs `…_UNLABELED` once.

### Lane E: client UI
Files: CE/api-client.ts, CE/EngCountryPicker.tsx (new), CE/EngStepBrief.tsx, CE/EngProjectsList.tsx, CE/EngDoNotContact.tsx, CE/EngStepLaunch.tsx, CE/EngStepReview.tsx, CE/EngStepBases.tsx

**api-client.ts**
- `collect_countries?: string[] | null` on `EngBriefPatch` (:885) and on the `createEngProject` input (:860).
- Project types: `collect_countries`, `collect_countries_unavailable`, `collect_countries_enabled`.
- `EngSendingWindowTimezoneOption.group?` (:618-622).
- `timezone_options?` and `suggested_timezone?` (:431, :649).
- Blocklist `kind`, `value`, `domains_total`, `domains_enabled` (:1636-1671).
- `addEngBlockedDomains` (:1831-1847).

**EngCountryPicker.tsx**: searchable multi-select over `ENG_COUNTRIES`, with chips, keyboard access and a client-side max of 50.

**EngStepBrief.tsx**
- Its own card above :1198, always editable, shown only when `collect_countries_enabled`.
- The useServerDrafts/SaveStatus pattern of the cap form (:813, :942-955). The PATCH sends only `collect_countries`.
- The §1A copy, the unavailable note, the maps note, and the hypotheses note.

**EngProjectsList.tsx:105-163**: optional collapsed «Countries (optional)».

**EngDoNotContact.tsx**: the design's UI (mode switch only when `domains_enabled`, results, "Whole company" tag, "N entries · M domains") plus the fixed removal caveat.

**EngStepLaunch.tsx:1802-1811**
- Options come from `timezone_options ?? timezones`.
- Preselection: `info.schedule` → `suggested_timezone` → `browserTimezoneIn(timezones)` (legacy 8 only) → default.
- The multi-zone hint.
- Update the comments at :7 and :155-160.

**EngStepReview.tsx:229-294**
- `<optgroup>` for consecutive equal `group` values; flat when there is no group.
- The fallback at :262-264 stays.
- The Timezone field spans the full row (`sm:col-span-3`).
- Summary labels come from the same list.

**EngStepBases.tsx**
- "N companies skipped — on your Do not contact list" from `excluded_do_not_contact`.
- The preview caveat line.

---

## 4. Migration

None.
- `brief` and `collect_info` are jsonb.
- The country plan key and the slice keys change through the existing hashes (catalogCursor.ts:134-182).
- The empty-plan memo uses the existing `he_catalog_cursors.plan/plan_key` columns (catalogCursor.ts:262-289,346-356).
- DNC uses the existing table, unique key and RPC (instantly-migrations 20260611_0001:19-28; 20260901_0001:9-35).
- Time zones: the stored-value checks are only `<> ''` (20260926_0002:31) and object type (20261012_0001:94).
- No new tables, so tests/migrations/grants.test.ts is not involved.

Rollout order:
1. Run the pre-deploy read-only checks (owner OK): the `'@%'` count is 0; distinct `funded_companies.country`; jobhive `country_code` distribution.
2. Deploy all code with the three flags off.
3. Confirm every container runs the new build.
4. `HE_ENG_COLLECT_COUNTRIES` on.
5. `HE_ENG_DNC_DOMAINS` on.
6. Live Instantly enum check (owner «да»), then `HE_ENG_TIMEZONES_ALL` on.
7. Set the HST list via the staff route (prod write, «да»).

Rollback notes:
- Rolling back below this release turns every stored country list into "no constraint". Before rolling back, pause refill and autopilot for projects with lists, or accept that.
- The DNC rollback floor is in §1B.
- Time zones need nothing.

---

## 5. Verification

**Gates** (in `app/`, one agent, after all lanes merge):
- `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:strict`
- `npm run build:workers`
- `npx eslint <every changed file>`
- `npx jest` (full suite; no new `*.test.ts`)
- `npm run build`

**Existing tests to watch:**
- tests/architecture/verticalEngineV2Isolation.test.ts:228-238 (new error texts);
- tests/lib/clientReports/appendLeadsLedgerIntegration.test.ts (mocks blockedContacts; the flag-off path must call only the mocked functions);
- tests/lib/clientBlocklist.test.ts.

**Offline harnesses** in `S/eng-build/harness/`. TS entries are bundled with `npx esbuild --bundle --platform=node --format=esm --tsconfig=app/tsconfig.json`. HEAD copies come from `git archive e9df07b46 app/src app/tsconfig.json`, with `node_modules` symlinked.

- **H1 countries**
  - All 249 tsv values are present: 243 offered plus 6 hidden.
  - Each has an iso2; labels are unique.
  - Accent and alias inputs resolve ('Curacao', 'Cote d'Ivoire', 'England', 'USA', 'u.s.a.').
  - Unknown, hidden and more than 50 are rejected.
  - `readHeCollectCountries` is fail-closed (missing → []; garbage → sentinel; stale value kept and listed as unavailable).
- **H2 gate properties.** Fixtures: `{countries:['europe']}`, `{countries:['EU'],sizes:['11-50']}`, `{sizes:['51-200']}`, `{countries:['united states of america'],industries:[…]}`, funded with and without industries, hiring with remote/gb/uk, maps with US / 'Rio de Janeiro' / 'Perth, WA' / empty geo. Lists: [], [us], [ie, gb], the HST list. Assert:
  - L=[] gives the same object (`===`);
  - no task is added;
  - idempotence (gate∘gate deep-equals gate);
  - every kept pdl task has scope and countries=L;
  - hiring codes ⊆ iso2(L), and an empty iso2(L) drops the task;
  - maps only with US, and a strict geo;
  - widen refusals;
  - `heUsMapsAddress` true/false table.
- **H3 call sites** (fixes the coverage minor). Bundle BC with `tests/helpers/mockSupabase` and a stubbed `callLLMWithSchema` that returns out-of-list and no-scope slices. Drive the paths: new plan, repair dropped, probe retry dropped, widen, stored plan, remember, dispatch, harvest. Assert:
  - `pdl_companies`/`funded_companies`/`eng_hiring_cache` reads and child-job inserts only ever see in-list filters;
  - the empty-plan memo prevents a second LLM call within 7 days;
  - a gate-dropped repair is still stored.
- **H4 RU and empty-list byte identity, HEAD vs branch**
  - `heCatalogPlanKey('ru', x)` and `heCatalogPlanKey('us', x)` without countries;
  - `buildSourcePlanMessages(En)`, `buildCatalogRepairMessagesEn` and `buildCatalogWidenMessagesEn` strings without countries;
  - hypotheses EN messages without the list;
  - chain brief JSON without the key;
  - `harvestSlice` and `heRecheckImportedRows` outputs for ru keys and for us keys with an empty DNC set;
  - `resolveHeLaunchSendingWindow` with market 'ru' returns 'preset' with zero DB calls.
- **H5 DNC.** Normalise, refuse, subdomain, punycode email host, label-walk misses (acme.com vs me.com, notwaystone.com, waystone.com.evil.io), the snapshot completeness throws including over-cap, and `filterBlockedContacts` identity and order with split counts.
- **H6 collection DNC.** Selection, harvest and recheck counts are kept separate; a DNC-only empty base gives the `do_not_contact` note; the requeue counter and the degrade-after-construct policy.
- **H7 time zones**
  - Rerun `S/eng-tz/check.mjs` against the new TS module: 102 entries = whitelist, `_DROPPED` and `_UNLABELED` empty, the legacy 8 in `timezones` byte-identical.
  - `preselect.mjs`: legacy preselection is unchanged for 13 browser zones.
  - Echo aliases round-trip.
  - Suggested zones' offsets match each country's capital zone in Jan and Jul of 2026 and 2027.
- **H8 client codes.** `classifyHeClientError` returns the right code for every new note and does not change the code for a corpus of existing notes.

**RU and isolation checks**
- `git diff --stat e9df07b46 --` must be empty for:
  - `app/src/lib/verticalEngineV2`, `app/src/components/client`, `app/src/app/client`;
  - `HE/prompts/sourcePlan.ts`, `HE/prompts/hypotheses.ts`;
  - `app/src/lib/clientBlocklist/blockedContacts.ts`, `domainPolicy.ts`, `app/src/lib/emailValidation/shared.ts`;
  - `app/src/lib/clientLaunch/{runLaunch,validateLaunchInput,scheduleMapping}.ts`;
  - `app/src/app/api/tools/hypothesis-engine/projects/[id]/route.ts`;
  - `supabase/`.
- The `timezones.ts` diff is exactly one `export ` token.
- Hunk review:
  - appendLeads only behind the flag;
  - LT edits only inside us step 5a and the window path;
  - BCR step 4 only in the `market==='us'` branch;
  - launchSchedule line :113 still precedes every new read.
- Positive DNC grep:
  - `getBlockedContactSnapshot(` must appear in LT step 5a, BCR step 4's us branch, the appendLeads flag branch, autoPipeline.ts readHeRefillBlocklistHold, rows/route.ts and BC;
  - every remaining `getBlockedEmailSet(` must sit in an allow-listed RU/VE2 file or branch: VE2 files, runLaunch.ts:216, gisSignalOutreach, the VE2 export route, LT:3511, BCR's else branch, and the appendLeads flag-off path.

---

## 6. Risks to watch in review

1. **Gate call-site coverage.** All seven sites must call it: BC:1988, 2015, 2019, ensureCatalogSource, the probe retry, widen, stored-plan read, rememberPlan and the dispatch assert. A missed site lets out-of-list rows through. H3 is the guard.
2. **Order.** Gate before labels everywhere. A label-first path makes 'EU'/'luxemburg' slices dead, or an unresolved pin escapes.
3. **The fail-closed sentinel** must never reach a code path that turns "no labels resolved" into `countries: []`.
4. **Maps harvest filter.** It drops US rows with no ZIP or an empty address (fewer rows; stricter). Check a real parser address sample before turning the flag on.
5. **funded SEC spellings** ('korea, republic of') will not match; the hiring feed filters by vacancy country, not HQ, and excludes remote and NULL postings.
6. **Empty-plan memo** overwrites the vertical's stored plan and key (bookmarks kept). Reverting the list costs one paid replan.
7. **Prepared companies are not retroactive.** The copy must say so; carry-over and unlaunched bases can still send to removed countries.
8. **Mixed-version windows.** Countries: an old worker ignores lists, so writes are flagged off until rollout. DNC: an old reader throws (refusal or outage), so the reader release is the rollback floor and `'@%'` must stay 0 for non-ENG profiles.
9. **Two copies of the snapshot completeness checks** (blockedContacts.ts:54-83 and blockedDomains.ts) can drift apart. Cross-reference comments are required.
10. **A PDL bookmark moves past DNC-excluded rows** (BC:2943-2946). Removing a domain does not bring those companies back in the same slice; the UI must say so.
11. **DNC degrade-after-construct** relies on send-time enforcement. Any new ENG send path must use `getBlockedContactSnapshot`.
12. **Time zones.**
    - Instantly enum drift until the live check (flag off).
    - Older tzdata at Instantly for the recently changed zones listed in §1C.
    - Dawson stays fixed UTC-7.
    - Staff messages show raw ids.
13. **Behaviour changes owners will notice.**
    - The project-scoped window removes the cross-project 'client' fallback, so staff launches for multi-project clients may pick different hours.
    - The suggested default moves non-US single-zone lists off Detroit.
14. **Brief read-merge-write race** with siteProfile (projectBriefPatch.ts:170-215 vs siteProfile.ts:715-737). This exists today for every brief key.
15. **Open owner decisions.**
    - The hidden-jurisdiction list.
    - The suggested-zone default (keep or veto).
    - Live enum check «да».
    - The HST list, who sets it, and whether research is rerun.
    - Turning DNC on, and the rollback floor.
    - Whether to filter prepared companies by country later.
    - Whether 50 is the right maximum.