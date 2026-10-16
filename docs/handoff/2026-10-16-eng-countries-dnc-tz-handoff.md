# Handoff 2026-10-16: ENG country lock, domain do-not-contact, Instantly time zones

Branch for the work: start from `Sergey` (this doc is on it). Code goes to `Sergey` only; merges to test/main and deploys are the owner's (Сергей), each needs his explicit «да».
The cloud session has NO SSH to production: every prod read/write (HST data, research rerun, checks) waits for the local Mac session.

## Owner decisions (2026-10-16)
1. A **hard per-project country list** for ENG collection is required (first real client HST Solutions targets Ireland, UK, EU incl. NL/LU/DE/Nordics, and the US).
2. "US East Coast only" is **not** needed — the US stays whole.
3. Decision-maker (LPR) title search and "tech team 20+" are **out of scope**.
4. The ENG launch time-zone dropdown must offer **every time zone Instantly accepts**.
5. **Domain-level do-not-contact** (e.g. `waystone.com` blocks the whole company at collection and at launch/refill/autopilot) — recommended by Claude so a client's current customers are never collected or mailed; owner asked «что делать», build it unless he drops it.
6. No file upload of client briefs in the cabinet.

## Hard constraints
- RU must not change (market 'ru', Vertical Engine v2, RU cabinet, staff RU tools): gate new behaviour on market==='us'.
- Prefer no migration; if unavoidable: idempotent, applied before the code, `grant ... to service_role`.
- No new `*.test.ts(x)` files (CLAUDE.md). Gates: `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:strict`, `npm run build:workers`, eslint on changed files, full `npx jest`.
- Label every collection/gate change stricter/softer and do the paid-work arithmetic (no silent widening, no re-plan loops, no budget burn when the list leaves nothing to collect; HE_PLAN_MAX_TASKS, widen ladder, dry-vertical stop, nightly refill, autopilot).

## What the code does today (read-only research at d0471c6f5)
## 1) Feasibility: can ENG target HST's countries and company size today?

**Short answer:** some of it, partly. Ireland, the UK, the Netherlands, Germany and the Nordics can be reached, but nothing guarantees it. "US East Coast only", "tech team of 20+" and targeting senior tech people by job title cannot be done. Luxembourg is unknown until prod is checked.

**What works today**
- `market='us'` only picks the English pipeline, not a country. ENG projects are always created with `'us'` (`app/src/app/api/client/eng/projects/route.ts:244`). The market only controls Serper gl/hl and the letter language (`app/src/lib/hypothesisEngine/market.ts:7-25`).
- The main company source (the company catalog) can filter by country on the server (`stages/baseCollect.ts:2905`; RPC in `supabase/migrations/20261015_0033_open_policies_staff_gate.sql:602-647`).
- The ingest script loads IE, UK, DE, NL, SE, DK, NO, FI and the US, among 19 countries (`app/scripts/pdl/ingest-pdl.sql:38-42`).
- Email validation does not care about country (`lib/emailValidation/shared.ts:53-56`).
- Letters copy the client's € figures exactly as written (`prompts/chain.ts:259`).
- The server accepts EU time zones such as `Europe/Isle_of_Man` and `Europe/Belgrade` (`app/src/app/api/client/eng/_launchWindow.ts:171`; `lib/clientLaunch/timezones.ts:40-41`).

**Works, but nothing enforces it**
- A country goes into a collection query only if the planning model writes it. The planner never sees the brief or its geography (`prompts/sourcePlan.ts:67-75`, built at `baseCollect.ts:1554-1560`), and its prompt says to leave countries out "when the whole market is targeted" (`prompts/sourcePlan.en.ts:43,57,79`).
- The only indirect route: once the brief has a targeting frame, the hypotheses model must write size and geography into every hypothesis description (`prompts/hypotheses.en.ts:151`). The planner prints those descriptions (`prompts/sourcePlan.ts:83`).
- With no country set, a query covers every country in the catalog, mixed together in ID order (`20261015_0033:640-647`). US companies will probably dominate.
- Company size: headcount ranges ("201-500" and so on) are used only if the planner sets them. The draft's claim that the size wording "keeps the size filter" is wrong. `heSizeBasisEn` reads only what the planner sees, never `brief.icp` (`baseCollect.ts:1659-1669`), and it only stops a size filter the planner already chose from being removed (`:1683-1697`).

**Does not work today**
- **US East Coast:** there is no state or region filter. The catalog stores a region (`supabase/migrations/20260609_0001_create_pdl_companies.sql:13`) and the RPC returns it (`20261015_0033:633`), but the RPC has no region parameter (`:602-609`). Google Maps searches are fixed to region "US" (`baseCollect.ts:3874-3878`).
- **Luxembourg:** not in the ingest script, so it is unknown. Prod probably holds more than the script loads: the code says about 19.5M rows (`pdlCatalog.ts:32`), the ingest README says 6–9M (`app/scripts/pdl/README.md:4`), and there is a `uae` alias (`pdlCatalog.ts:105`). If Luxembourg is missing, the label is silently dropped (`pdlCatalog.ts:215-231`).
- **"Tech team 20+" and "existing engineering function":** no source can observe these.
- **The relevance check** sees no address or headcount (`relevanceGate.ts:1093-1113`). Its prompt says geography and size are "never a requirement" (`:863`).
- **The rest of `brief.icp` (include, exclude, size, geo)** is only a prompt hint. Nothing filters on it (`icpFrame.ts:17-22`; `relevanceGate.ts:1406-1411` returns empty markers).
- **Decision makers (CTO, CIO, VP Engineering):** cannot be targeted. Contacts are addresses found on company websites (`lib/tools/processingSteps.ts:3009-3020`). Letters greet without a name and ask to be pointed to the right person (`prompts/chain.ts:72,81`).
- **The hiring signal (open engineering roles):** the hiring source holds only sales and marketing vacancies (`prompts/sourcePlan.en.ts:12-20,36`; `parsers/engHiring.ts:518-524`). It has no Nordic or Luxembourg country codes (`sourcePlan.en.ts:36`).
- **The other two sources are US-centric:** the startup-funding source (YC, SEC Form D) and research search (gl=us, `stages/searchIo.ts:111-116`).
- **Sending window:** the cabinet dropdown offers only US zones plus UTC, with 09:00–17:00 America/Detroit as default (`_launchWindow.ts:63-75,114-117`). One window applies per campaign.
- **No GDPR/PECR check exists.** Launch is refused if a letter has an opt-out line (`launchTemplate.ts:1747-1775`), and the unsubscribe header is off (`engSendingPreset.ts:143-149`). This is a legal question, not a code fix.

**Smallest safe changes if the owner wants guarantees** (effort figures are my estimates)
1. **A per-project country list.** Add `countries` (catalog spellings) inside `brief.icp`. Inside `icp` it is stripped from letters (`stages/chain.ts:292-304`); a new top-level brief key would leak into letter materials (`chain.ts:335-345`).
   - Enforce it in `heGatePlanForMarket` (`baseCollect.ts:1930-1937`). That covers every plan point, including stored plans (`:6138`), plus `:2452`, `:3545` and `:3649`. Set or intersect `pdl_filters.countries` and `funded_filters.countries`, convert to hiring-source codes, and drop Google Maps tasks when the US is not on the list.
   - If the intersection is empty, drop the query; never widen it.
   - Bookmark keys hash the filters (`catalogCursor.ts` heCatalogSliceKey), so restricted queries get fresh bookmarks automatically.
   - About 1–1.5 days with tests. Medium risk, because it touches the collection path. No migration. RU is not touched: the gate returns the same object for RU (`sourcePlanMarketGate.ts:83-84`), so the new logic must sit behind `market==='us'`.
2. **East Coast filter.** Add a `regions` list to `HePdlFiltersSchema` (`schemas.ts:310-317`). It is a plain `z.object` and would otherwise strip the key; inside the filters, the list also becomes part of the bookmark key. Skip US rows from other regions in `fetchPdlRows`, the same way sizes are skipped at `baseCollect.ts:2979`. The frozen catalog allows this; the live feeds do not.
   - About 1 day. Medium risk: one wrong region spelling would silently drop every US row, so check spellings on prod first. ENG only.
3. **Time zones.** Add `Europe/Isle_of_Man` (UK/IE time) and `Europe/Belgrade` (CET) to `TIMEZONE_CANDIDATES` (`_launchWindow.ts:63-74`). About 1 hour, low risk, ENG only. The no-code alternative is a `he_launch_schedule` row written by SQL, which is a production write.

Every code change goes to Sergey first. Deploying it needs the owner's explicit yes.

---

## Production catalog countries (`pdl_companies.country`, lowercase PDL spellings, 2026-10-16)
19,566,714 rows, 249 countries. Use these exact spellings for validation/UI.

| country | companies |
|---|---|
| united states | 5,622,536 |
| united kingdom | 1,589,511 |
| brazil | 1,336,543 |
| india | 1,238,231 |
| germany | 944,227 |
| france | 775,913 |
| canada | 668,593 |
| australia | 661,142 |
| netherlands | 622,436 |
| spain | 605,400 |
| china | 521,643 |
| italy | 500,505 |
| turkey | 253,104 |
| mexico | 229,572 |
| belgium | 211,880 |
| switzerland | 207,664 |
| poland | 192,440 |
| south africa | 147,208 |
| sweden | 144,328 |
| argentina | 143,524 |
| indonesia | 128,245 |
| united arab emirates | 126,735 |
| colombia | 120,904 |
| portugal | 119,999 |
| chile | 97,282 |
| denmark | 96,289 |
| norway | 91,404 |
| japan | 89,336 |
| new zealand | 88,429 |
| pakistan | 85,135 |
| austria | 75,654 |
| singapore | 71,238 |
| nigeria | 69,913 |
| ireland | 69,903 |
| peru | 69,187 |
| malaysia | 65,459 |
| czechia | 64,231 |
| finland | 61,681 |
| egypt | 50,378 |
| israel | 49,602 |
| philippines | 49,232 |
| romania | 48,298 |
| bangladesh | 46,667 |
| hungary | 45,593 |
| iran | 45,188 |
| greece | 42,766 |
| saudi arabia | 42,437 |
| vietnam | 41,640 |
| russia | 37,259 |
| hong kong | 36,680 |
| ukraine | 32,681 |
| morocco | 28,313 |
| thailand | 27,844 |
| ecuador | 23,524 |
| kenya | 22,954 |
| south korea | 22,888 |
| bulgaria | 21,819 |
| sri lanka | 21,368 |
| serbia | 19,285 |
| taiwan | 18,636 |
| slovakia | 18,135 |
| croatia | 18,012 |
| lithuania | 17,341 |
| ghana | 17,061 |
| estonia | 15,989 |
| venezuela | 13,859 |
| costa rica | 13,668 |
| cyprus | 13,300 |
| uruguay | 12,680 |
| slovenia | 12,522 |
| tunisia | 12,442 |
| lebanon | 12,428 |
| dominican republic | 11,419 |
| luxembourg | 11,102 |
| jordan | 10,685 |
| latvia | 10,457 |
| panama | 10,218 |
| uganda | 10,133 |
| guatemala | 10,131 |
| qatar | 9,782 |
| nepal | 9,586 |
| senegal | 9,196 |
| algeria | 8,929 |
| côte d'ivoire | 8,642 |
| cameroon | 8,000 |
| azerbaijan | 7,977 |
| tanzania | 7,965 |
| georgia | 7,706 |
| iceland | 7,421 |
| malta | 7,203 |
| puerto rico | 7,114 |
| bolivia | 6,686 |
| kuwait | 6,237 |
| bosnia and herzegovina | 6,154 |
| oman | 5,773 |
| armenia | 5,696 |
| iraq | 5,404 |
| kazakhstan | 5,402 |
| albania | 5,396 |
| bahrain | 5,390 |
| paraguay | 5,173 |
| mauritius | 4,961 |
| el salvador | 4,921 |
| angola | 4,897 |
| north macedonia | 4,880 |
| ethiopia | 4,796 |
| cambodia | 4,777 |
| belarus | 4,623 |
| democratic republic of the congo | 4,246 |
| jamaica | 4,081 |
| zambia | 4,017 |
| myanmar | 3,881 |
| zimbabwe | 3,827 |
| trinidad and tobago | 3,711 |
| mozambique | 3,559 |
| honduras | 3,524 |
| madagascar | 3,257 |
| rwanda | 3,151 |
| uzbekistan | 2,951 |
| mongolia | 2,849 |
| réunion | 2,772 |
| moldova | 2,759 |
| namibia | 2,668 |
| nicaragua | 2,480 |
| kosovo | 2,478 |
| benin | 2,381 |
| botswana | 2,289 |
| montenegro | 2,143 |
| monaco | 2,089 |
| sudan | 2,070 |
| afghanistan | 2,026 |
| são tomé and príncipe | 1,894 |
| maldives | 1,835 |
| bahamas | 1,833 |
| libya | 1,791 |
| palestine | 1,758 |
| syria | 1,757 |
| cayman islands | 1,708 |
| barbados | 1,701 |
| togo | 1,694 |
| burkina faso | 1,622 |
| malawi | 1,617 |
| haiti | 1,548 |
| liechtenstein | 1,418 |
| curaçao | 1,403 |
| jersey | 1,387 |
| mali | 1,381 |
| andorra | 1,317 |
| martinique | 1,314 |
| yemen | 1,314 |
| isle of man | 1,310 |
| somalia | 1,295 |
| guinea | 1,269 |
| guadeloupe | 1,188 |
| cuba | 1,145 |
| faroe islands | 1,116 |
| gabon | 1,098 |
| suriname | 1,090 |
| republic of the congo | 1,087 |
| gibraltar | 1,070 |
| bermuda | 1,049 |
| kyrgyzstan | 1,018 |
| new caledonia | 998 |
| guam | 986 |
| papua new guinea | 978 |
| liberia | 966 |
| belize | 964 |
| sierra leone | 908 |
| british virgin islands | 894 |
| niger | 824 |
| guernsey | 823 |
| guyana | 799 |
| seychelles | 738 |
| aruba | 707 |
| u.s. virgin islands | 690 |
| cape verde | 680 |
| laos | 657 |
| fiji | 646 |
| french polynesia | 641 |
| brunei | 637 |
| the gambia | 627 |
| antigua and barbuda | 620 |
| san marino | 616 |
| eswatini | 594 |
| macau | 559 |
| comoros | 549 |
| mauritania | 538 |
| south sudan | 536 |
| saint lucia | 517 |
| bhutan | 454 |
| lesotho | 447 |
| french guiana | 442 |
| saint kitts and nevis | 425 |
| saint vincent and the grenadines | 408 |
| chad | 363 |
| tajikistan | 351 |
| grenada | 337 |
| burundi | 332 |
| nauru | 331 |
| caribbean netherlands | 314 |
| turks and caicos islands | 297 |
| turkmenistan | 283 |
| equatorial guinea | 277 |
| greenland | 266 |
| vanuatu | 252 |
| central african republic | 247 |
| djibouti | 234 |
| timor-leste | 226 |
| dominica | 205 |
| sint maarten | 181 |
| mayotte | 176 |
| tonga | 159 |
| marshall islands | 158 |
| montserrat | 139 |
| anguilla | 132 |
| samoa | 125 |
| saint barthélemy | 124 |
| tuvalu | 105 |
| solomon islands | 97 |
| british indian ocean territory | 84 |
| north korea | 80 |
| åland islands | 80 |
| guinea-bissau | 76 |
| micronesia | 73 |
| northern mariana islands | 72 |
| cook islands | 71 |
| american samoa | 70 |
| south georgia and the south sandwich islands | 64 |
| svalbard and jan mayen | 63 |
| eritrea | 45 |
| saint martin | 39 |
| palau | 38 |
| kiribati | 36 |
| vatican city | 32 |
| falkland islands | 28 |
| niue | 26 |
| norfolk island | 24 |
| saint pierre and miquelon | 24 |
| cocos (keeling) islands | 20 |
| bouvet island | 18 |
| christmas island | 18 |
| wallis and futuna | 16 |
| saint helena | 16 |
| united states minor outlying islands | 13 |
| french southern territories | 9 |
| pitcairn islands | 6 |
| tokelau | 6 |
| heard island and mcdonald islands | 4 |
| western sahara | 3 |

## Still open (needs the local session + owner «да»)
- HST project `2971d740-1f5e-4eb9-a9e5-c04faaf8794c`: write business/offer/signature + `brief.icp` + 3 `he_cases`, reject off-target hypotheses, rerun research (~$1.9, wipes verticals/bases). Drafts exist only on the Mac (session scratchpad `hst-final/`).
- Owner questions: keep the Blueprint Call in the offer? prototype price €24k vs €15k? Norway in scope? legal check for UK/EU sends without an opt-out line.
- Reminder due ~15:41 (UTC+4): return to the «широкие аудитории» decision for ENG (memory `eng-broad-audiences-assessment-1016`).
- Two small offered fixes: record stage spend during the stage (a deploy SIGKILL loses ~$0.5–1 of accounting), and insert a space between adjacent text blocks in the layout-aware site reader («DORAAligned»).
