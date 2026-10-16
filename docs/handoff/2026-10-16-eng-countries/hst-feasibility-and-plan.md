# HST Solutions (ENG project 2971d740-1f5e-4eb9-a9e5-c04faaf8794c): feasibility, plan and final field values

I read the code only, in `codex-worktrees/landing-ru` at d0471c6f5 (= origin/Sergey = production code). All paths below are relative to that folder. Nothing was written to production, and I did not query the prod DB. Where the critic contradicted a report, the critic's version is used. The corrected values are in `(local Mac scratchpad, not available in the cloud)/hst-final/` (`staff-patch-body.json`, `icp.json`, `he-cases-rows.json`, `offer-no-call.txt`, `build.js`). Do not use the earlier `hst-fields/hst-patch-body.json`: it contains `icp`, and the staff route silently drops it.

---

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

## 2) Plan for HST

Marks: **[OWNER YES]** = production write, needs the owner's explicit yes. **[READ-ONLY]** = no change, but uses SSH to prod.

0. **[READ-ONLY] Prod checks** (SSH to .24, `docker exec psql`).
   - The project's `status`, `market`, `brief ? 'icp'`, `brief->'icp'`, and the lengths of `business_override` and `offer_override`.
   - Hypotheses: `select status, tier, title from he_hypotheses where project_id=… order by status, tier`. Accepted ones are markets the client already selected.
   - Was a frame present when research ran? Look for the hypotheses job log line "рамка ЦА клиента в промпте" (`stages/hypotheses.ts:386-391`). If a frame was there and the model still drifted, a rerun with a frame alone may not fix the list.
   - Pending or running `he_jobs`; counts of `he_verticals`, `he_bases`, `he_chains`, `he_templates` with `launch_info`; `he_cases` by `source`; `select public.he_sending_pool_launched(array['2971d740-1f5e-4eb9-a9e5-c04faaf8794c']::uuid[])`. A staff rerun asks for no confirmation and wipes all of this.
   - Catalog: `select count(*) from public.pdl_companies where country='luxembourg'` (also `'norway'`, `'iceland'`), and `select region, count(*) from public.pdl_companies where country='united states' group by 1 order by 2 desc limit 60`. Do not use `pdl_count_estimate(null,null,array['luxembourg'],null)`: its first argument is the country (`20261015_0033:552-556`), so that call passes Luxembourg as a size, and the function returns a planner estimate, not a count. Do not run `pdl_facets()` on prod either.
1. **Owner decisions before any write.** See section 4: the Blueprint Call, Norway, how strict "no in-house tech" is, the suppression method, the legal sign-off, the sending window, and the mailbox display name.
2. **[OWNER YES] Staff `PATCH /api/tools/hypothesis-engine/projects/2971d740-…`** with `staff-patch-body.json`: three fields, no `icp`, no `style_override`.
   - Caps: business 3000, offer 3000 on 'us', signature 500 (`projectBriefPatch.ts:27-44,141-168`). The route passes only the body (`api/tools/hypothesis-engine/projects/[id]/route.ts:64-71`).
   - These fields reach letters built from now on, quoted word for word (`prompts/chain.ts:250-261`).
3. **[OWNER YES] Write `brief.icp` by SQL**, as a top-level merge (template in section 3). The staff PATCH cannot write `icp` (`projectBriefPatch.ts:62-84`). The client route can, but only with the client's session.
   - Do this before step 5 and never while `site_profile` runs, because that stage reads and rewrites `brief` (`siteProfile.ts:709-738`).
   - The values are already validated offline against the write rules (`icpFrame.ts:29-33,90-92,132-166`). The read side would cut oversized values silently (`:174-192`).
4. **[OWNER YES] Reject the off-target hypotheses** with staff `PATCH /api/tools/hypothesis-engine/hypotheses/[id]` (`route.ts:21-58`).
   - Rejected titles are banned in the next prompt and exact title matches are dropped in code (`hypotheses.ts:99-116,437-462`; the first 60 titles reach the prompt, `:88,420`). Evidence skips them (`evidence.ts:337-348`) and US clustering leaves them out (`clustering.ts:358-364,447`).
   - Keep the financial-services ones unrejected as a fallback. If evidence accepts 0 new hypotheses, the old non-rejected ones are clustered again. If everything was rejected, clustering throws, the project shows "failed" and the client gets a `research_stopped` email (`evidence.ts:839`; `clustering.ts:372-374`; `engClientMail.ts:440-443`).
   - Hypotheses the client accepted survive a rerun and come back as selected markets (`engMarkets.ts:84-96`). The owner decides on those.
5. **[OWNER YES] Rerun research: staff `POST /api/tools/hypothesis-engine/projects/[id]/research`.**
   - It is refused only when something has launched (`research/route.ts:80-108`).
   - It has no confirmation, no paid-access gate and no spend ceiling (`app/worker/hypothesisEngine.ts:1891-1898`). It counts toward the client's daily research limit, default 5 (`engPaidAccess.ts:66-71`).
   - Cost: about $1.9 per run as measured earlier; this cannot be checked from code.
   - **Deleted:** all `he_verticals`, and by cascade chains, vocab, bases, templates with `launch_info`, dossiers, launch schedule, catalog bookmarks and carried companies (`researchJob.ts:299-310`; `clustering.ts:403-413`). Prior "proposed" hypotheses are deleted if at least one new one is accepted (`evidence.ts:839-853`). Site cases are refreshed (`siteProfile.ts:474-518`).
   - **Kept:** rejected hypotheses, accepted hypotheses and uploaded cases.
   - The client is not emailed again when it finishes (`engClientMail.ts:440-441`), so staff must tell them, and should ask them not to edit the brief form during the first three stages. The form unlocks then and could overwrite the frame (`components/client-eng/EngStepBrief.tsx:418-423`).
6. **[OWNER YES] Review the new hypotheses.** Reject tier-3 items marked "OUTSIDE CLIENT FRAME:" (`hypotheses.en.ts:148-152`) and anything off-sector. Caveat: if the client picks a market whose hypotheses are all rejected, the cabinet flips them back to accepted (`client/eng/projects/[id]/markets/route.ts:181-183`).
7. **[OWNER YES] Insert the 3 cases by SQL**, in English, with `source='upload'` (template in section 3). Do not use the staff cases POST: its structuring prompt answers in Russian and names Polza (`caseBank.ts:71-78`; `projects/[id]/cases/route.ts:96-110`). Uploaded cases survive reruns, so they can go in at any time; after step 5 the industry words can be checked against the new market names.
8. **Suppression list** (HST's clients and pipeline; the brief names waystone.com, fundbank.com, cameramatics.com and statsports.com at `brief.txt:188-191`).
   - Exact emails can go into the cabinet do-not-contact list (client paste) (`app/api/client/blocklist/_eng.ts:44-56,275-299`). Domains are rejected. The list is enforced at launch, nightly refill and autopilot preflight (`launchTemplate.ts:2023-2075`; `baseCollectRefill.ts:5451-5455`; `autoPipeline.ts:2334-2363`), never at collection.
   - For domains, the options are new code, or a staff "suppression base" **[OWNER YES]**. A non-failed `he_bases` row with `{company, website}` rows excludes those companies from the project's other bases by domain at collection (`baseCollect.ts:4313-4334,4357+`; used at `:2943,3099,3392`). Unverified for this purpose: `vertical_id` is NOT NULL and cascades on a rerun, so it must be created after step 5. It may show in the cabinet or be launchable, so it needs a code read before use.
9. **[OWNER YES] Sending window and mailboxes.** Choose a European zone, by UI change (section 1, change 3) or a `he_launch_schedule` row. For a market mixing IE/UK and the US East Coast, 12:00–17:00 Europe/Isle_of_Man is 07:00–12:00 New York. Also set the display name "Huze Hakim" on the assigned pool mailboxes (`sendingPool.ts:1-10`), or the From line and the signature will disagree.
10. **[OWNER YES] Optional code** (section 1, changes 1–3), committed to Sergey and deployed only on the owner's yes. Without it, check which countries the first bases' queries actually used (`collect_info`) before any launch.

---

## 3) Final field values

Character counts are JS `.length` after trim; for `icp`, after whitespace is collapsed. A scan found no em/en dashes, no "free", "we guarantee", polza/outreachos, @, +353, URLs, or banned clichés and LLM tells (`prompts/chain.ts:429-430`). "hst.ie" appears as a bare domain, which the brand guard ignores.

**Changes from the draft:**
- **Offer:** the last two paragraphs are reworked so the low-commitment first step (the `THE START` slot, `chain.ts:420`) is the materials, not a call (call CTAs are banned, `chain.ts:81`).
- **icp.include[5]:** reworded so "Retail" does not collide with the excluded "consumer retail".
- **icp.exclude:** the old line 6 is split into two lines, so "regulated markets" no longer admits healthcare, pharma or energy firms as targets.
- **Size claim and PATCH body:** the size-filter claim is dropped, and `icp` is removed from the PATCH body.
- **Cases:** rows are mapped to the real `he_cases` columns.

**A. Staff PATCH body** (`hst-final/staff-patch-body.json`)
- `business_override`: **2839/3000** (unchanged from the draft)
- `offer_override`: **2110/3000**. Zero-risk variant without the final Blueprint Call paragraph: **1821/3000** (`offer-no-call.txt`)
- `signature_override`: **48/500**
- `style_override`: not sent. The brief has no sample letter, and an empty string would delete the key.

```json
{"business_override": "HST Solutions is an Irish software engineering and AI company, founded in Dublin in 2007. We give financial services and other regulated businesses senior engineers who are productive from week one, backed by a full delivery pod: solutions architect, project manager and DevOps, all under one contract.\n\nMost of our work is for fund administrators, asset managers, banks, insurers and insurtechs across Ireland, the UK, Europe and the US.\n\nOur four practices:\nData and analytics engineering: data platform modernisation (SQL Server and SSIS to AWS or Azure data lakes), ETL and ELT pipelines, real time streaming (Kafka), data warehouses, Power BI and Tableau reporting, audit trails and data lineage.\nCloud and DevOps: cloud migration, Kubernetes, CI/CD, infrastructure as code (Terraform), DevSecOps, FinOps and site reliability engineering on Azure and AWS.\nProduct and software engineering: custom software, investor portals, internal operations tools, APIs and integrations with custodians and data vendors, QA and testing.\nProduction AI: AI inside existing applications, RAG and LLM assistants, document processing, fraud and anomaly detection, claims and underwriting models. We ship AI to production, not to slide decks.\n\nFinancial services know how: AIFMD Annex IV, UCITS KIID and PRIIPs, Central Bank of Ireland reporting and CP86, DORA ICT risk and third party documentation, MiFID II, Solvency II, GDPR, KYC and client onboarding, FATCA and CRS, digital asset custody.\n\nSelected work:\nWaystone, a global fund governance firm with €1.3T+ assets under management: we moved core holdings and risk data from fragile SSIS jobs to a monitored AWS data lake. 100TB+ of data is processed daily, and committee and regulatory packs now come from a single trusted data layer with full audit trails.\nCompanjon (embedded insurance): a Kafka and Databricks pipeline that captures 100% of API gateway traffic in real time with zero latency impact on production.\niRace Digital (FundBank): client onboarding and KYC across the US, Luxembourg and the Cayman Islands, and self hosted digital asset custody infrastructure on AWS.\n\nTrust: ISO 27001:2022 and ISO 22301:2019 certified, DORA aligned, GDPR compliant, Irish registered company with professional indemnity insurance, a disaster recovery site in Germany and full IP assignment to the client. Profitable with no debt since 2007.\n\nPeople: 140 people across engineering, architecture, UX and delivery. Head office in Sandyford, Dublin, our own delivery centres in Ahmedabad (since 2010) and Kolkata (since 2015), India, and resident engineers in Ireland and the UK. Engineers join the client's standups and work in the client's tools (Slack, Teams, Jira).\n\nKey numbers: 18+ years in business, 250+ projects delivered, 5.0 client rating on Clutch, engineers embedded in 7 to 10 business days.", "offer_override": "We put a senior engineer into your team, backed by a solutions architect, a project manager and DevOps, all under one contract and at a fixed monthly price. Built for fund administrators, asset managers, banks, payments firms, insurers, insurtechs and software vendors that sell into regulated markets.\n\nPrecision Pod: 1 senior engineer (5+ years experience), PM included (up to 6 to 8 hours per month), architecture reviews (up to 2 hours per week), DevOps and QA assist. From €5k to €6k per month.\nPair Pod: 2 senior engineers (for example Data plus Backend). From €10k to €11k per month.\nMini Team: 3 engineers (for example Data plus Backend plus DevOps). From €15k to €16k per month.\nAlso available: managed teams, staff augmentation and fixed price projects.\n\nHow it starts: the engineer joins your standups and works in your tools within 7 to 10 business days of a signed agreement. 3 month minimum, then 30 days notice. No hidden overages: anything beyond the included PM and architecture hours is agreed upfront. You own the code and the IP.\n\nWe add capacity alongside your team or current vendor, often starting with one engineer on a specific backlog item or pipeline problem. We work in your stack: if you are on Azure and Power BI, we work in Azure and Power BI, and we modernise step by step, proving value before expanding scope.\n\nSwap guarantee: if the engineer is not the right fit in the first 2 weeks, we replace them within 5 business days at no cost.\n\nWe are ISO 27001:2022 and ISO 22301:2019 certified, DORA aligned and GDPR compliant, so vendor due diligence moves quickly.\n\nEasiest first step: we send the Waystone case study (published on hst.ie) or our 1 page Stabilise and Ship plan for taking a fragile data platform to production ready (assess in week 1, stabilise by week 6, ship by week 12).\n\nFor teams that want to go further, a 20 minute Blueprint Call with one of our senior architects comes at no cost: we look at your data or engineering problem, share how we solved something similar for fund administrators, banks or insurers, and you leave with a technical roadmap for it.", "signature_override": "Huze Hakim\nCTO and Founder, HST Solutions\nhst.ie"}
```

**B. `brief.icp`** (`hst-final/icp.json`)
- include: 10/10 entries, each within 150 characters: 141, 114, 117, 121, 123, 89, 91, 112, 129, 99
- exclude: 8/10 entries: 115, 59, 67, 71, 123, 136, 131, 48
- size: **129/200**
- geo: **192/200**

```json
{"include":["Fund administrators, ManCos and asset managers in Ireland and Luxembourg: data platform modernisation and regulatory reporting (AIFMD, UCITS)","Fund services and fund technology firms (transfer agency, depositary, fund data) in Ireland, Luxembourg and the UK","Wealth managers, private banks and investment platforms in Ireland, the UK and the EU with their own technology teams","Insurers and insurtechs in Ireland, the UK and the EU: real time partner and claims data, AI that goes live in production","Retail banks, private banks and digital banks in the UK, the EU and the US East Coast that need senior engineering capacity","Banks and digital asset firms working on client onboarding, KYC or custody infrastructure","Payments companies, e-money institutions and fintechs with an existing engineering function","B2B software vendors selling into financial services or other regulated markets, with an engineering team of 20+","Asset and fund managers in the UK, Germany, the Netherlands and the Nordics: data platform modernisation and regulatory reporting","Insurance brokers, MGAs and reinsurers in Ireland, the UK and the EU with in-house technology teams"],"exclude":["Software development agencies, IT consultancies, outsourcing and staff augmentation firms (competitors, not buyers)","Management and digital consultancies and system integrators","Recruitment agencies, staffing firms and IT contractor marketplaces","Companies with no in-house technology, engineering or delivery function","Independent financial advisers, small advisory practices, accountancy firms and other small firms without a technology team","Consumer retail, e-commerce, hospitality, construction, media, local services and other sectors outside financial services and insurance","Healthcare, pharma, energy and other non-financial regulated companies themselves (B2B software vendors selling to them do qualify)","Students, job seekers and individual freelancers"],"size":"200+ employees, or smaller fintechs, insurtechs and software vendors (from 50 employees) with an in-house engineering team of 20+","geo":"Ireland, United Kingdom, EU (priority: Netherlands, Luxembourg, Germany, Denmark, Sweden, Finland, Norway) and US East Coast states only (e.g. New York, Massachusetts, New Jersey, Connecticut)"}
```

SQL template **[OWNER YES]**:
```sql
update public.he_projects
set brief = coalesce(brief, '{}'::jsonb) || jsonb_build_object('icp', $j$<contents of icp.json>$j$::jsonb)
where id = '2971d740-1f5e-4eb9-a9e5-c04faaf8794c' and market = 'us';
```

**C. `he_cases` rows** (`hst-final/he-cases-rows.json`)

Every row has `project_id='2971d740-1f5e-4eb9-a9e5-c04faaf8794c'` and `source='upload'`. Naming the clients is consented in the brief (`brief.txt:40-41,195`).

*Waystone* (filename `Waystone`)
- industry (65): Fund administration, fund governance, ManCos and asset management
- client_type (90): Global fund governance firm (ManCo and fund administrator), €1.3T+ assets under management
- task (102): Replace a fragile legacy SQL Server and SSIS data platform for holdings, risk and regulatory reporting
- metrics: `{"assets_under_management":"€1.3T+","data_processed_daily":"100TB+","analyst_time_freed":"up to 40%"}`
- result (155): 100TB+ of data processed daily on monitored pipelines, and committee and regulatory packs now come from a single trusted data layer with full audit trails.
- text (440): Waystone, a global fund governance firm with €1.3T+ assets under management, had a legacy SQL Server estate with fragile nightly SSIS jobs. HST moved core holdings and risk data to a monitored AWS data lake and consolidated risk and oversight reporting in Power BI. 100TB+ of data is now processed daily, regulatory packs come from a single trusted data layer with full audit trails, and a separate ETL tool frees up to 40% of analyst time.

*Companjon* (filename `Companjon`)
- industry (54): Insurance, insurers and insurtech (embedded insurance)
- client_type (94): European embedded insurer (insurtech) selling through e-commerce, travel and mobility partners
- task (78): Process continuous partner API traffic in real time without slowing production
- metrics: `{"api_gateway_traffic_captured":"100%","latency_impact_on_production":"zero"}`
- result (139): 100% of API gateway traffic captured in real time with zero latency impact on production, so product and partner teams decide on live data.
- text (387): Companjon sells embedded insurance through e-commerce, travel and mobility partners across Europe, and every partner creates continuous API traffic. HST built a Kafka pipeline mirroring all API gateway traffic, streaming into Databricks, with near real time partner dashboards and access controls. Result: 100% of API traffic captured in real time with zero latency impact on production.

*iRace Digital (FundBank)* (filename `iRace Digital (FundBank)`)
- industry (48): Banking, fund services and digital asset custody
- client_type (111): Regulated bank serving institutional investors and fund structures in the US, Luxembourg and the Cayman Islands
- task (110): Rebuild client onboarding and KYC for three jurisdictions and run its own digital asset custody infrastructure
- metrics: `{}`
- result (141): A new onboarding journey is mostly configuration, and the bank keeps full control of its key material with controls it can show a supervisor.
- text (501): iRace Digital (FundBank) serves institutional investors and fund structures across the US, Luxembourg and the Cayman Islands, so onboarding has to satisfy three regulators at once. HST built a shared data model and portal foundation for onboarding (KYC, beneficial ownership, sanctions and PEP screening, FATCA and CRS) and automated self hosted digital asset custody infrastructure on AWS. Result: a new onboarding journey is mostly configuration, and the bank keeps full control of its key material.

SQL template **[OWNER YES]**:
```sql
insert into public.he_cases (project_id, source, filename, industry, client_type, task, metrics, result, text)
select * from jsonb_to_recordset($j$<contents of he-cases-rows.json>$j$::jsonb)
  as r(project_id uuid, source text, filename text, industry text, client_type text, task text, metrics jsonb, result text, text text);
```

How the cases get picked: a case is chosen per market by word overlap with the market name (minimum score 3, `caseBank.ts:261-268`). The critic recomputed the scores: Waystone 7/5/5, Companjon 5/5/3, iRace 9/5/5. Markets for wealth managers, payments or fintech lenders score 0, so their letters will have no named case.

---

## 4) Risks and open questions for the owner

**Risks**
- **Wrong-country contacts:** without code changes, geography is only a prompt hint. Expect US-heavy, all-states companies unless the planner happens to set countries. "US East Coast" cannot be enforced at all.
- **Lead KPI at risk:** HST wants 2–4 attended calls a month with senior tech people. ENG only reaches addresses found on company websites, with nameless letters that ask to be forwarded. At banks and insurers with 200+ staff these are usually generic inboxes.
- **Weak evidence for EU and Irish markets:** research search uses US Google (gl=us). With 0 accepted hypotheses, old non-rejected markets come back, or the run fails and the client gets an email.
- **Current clients receiving letters:** Waystone and FundBank are current clients, financial-services targets the catalog will likely return, and named in the cases. The do-not-contact list takes emails only and does not act at collection, so they can be collected and mailed, possibly with their own case quoted back to them.
- **Unsend-able promises:** the offer lets letters offer the Waystone case study and the Stabilise and Ship plan. Someone must actually send them, and ENG replies are read-only (`engReplies.ts:1-30`).
- **A call ask can still slip in:** even with the reworded offer, a Blueprint Call ask can appear in letters, and no code check catches it. The zero-risk option is the 1821-character variant.
- **A rerun wipes work without asking:** the staff rerun deletes bases, chains and templates with no confirmation. Run step 0 first.
- **Legal:** sending to UK/IE/EU (Germany in particular) with no opt-out line and no unsubscribe header has no legal sign-off. Counsel should decide before any EU/UK send.

**Open questions**
1. Blueprint Call: keep it (2110 characters) or drop it from the offer (1821)? HST calls it their "opening step for every prospect" (`brief.txt:95`), but our letter rules ban call asks.
2. Prototype price: €24,000 (`brief.txt:60`) or €15,000 with money back (`:119,166`)? It is left out of the offer until HST answers.
3. Is Norway in scope? The appendix says "EU including the Nordics"; Norway is Nordic but not EU.
4. The exclude line "Companies with no in-house technology…" is a hard ban. The contract says "not a priority unless approved". Keep it strict or soften it?
5. Which suppression method: client-pasted emails only, a staff suppression base (needs a code read), or new domain-level code?
6. Which of the 31 current hypotheses to reject, and what to do with markets the client already accepted?
7. Sending window zone and hours; From display name "Huze Hakim" on the 3 pool mailboxes.
8. Build the country lock, East Coast filter and time-zone options (about 2.5 days total, ENG only, deploy needs your yes), or go with prompt-only steering and check the first bases' `collect_info`?
9. Who sends the promised materials and handles replies and lead handoff to Huze (info@hst.ie) during the 45-day test?
10. A per-market, data-only country override (editing the stored plan in `he_catalog_cursors`) was not analysed. Do not try it without a code read.