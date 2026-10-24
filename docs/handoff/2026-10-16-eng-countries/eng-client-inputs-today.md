**Brief attachment in the ENG cabinet: inputs today, document handling, gaps and options**

All paths are relative to `/Users/cybermart/Desktop/Portal-Mac-Transfer-2026-09-06-Updated/Portal/codex-worktrees/landing-ru/`, which is at d0471c6f5 and has the same code as production. Facts about the HST project come from memory, not code: `/Users/cybermart/.claude/projects/-Users-cybermart-Desktop-Portal-Mac-Transfer-2026-09-06-Updated-Portal/memory/eng-site-reader-fix-1016.md`.

Short answer: an ENG client can already give us text besides the site, but a filled brief cannot be attached as a file or link. Only the internal Russian VE2 tool can do that today, and only staff can use it.

---

## 1) Today: what an ENG client can enter besides the site

**Fields.** All are text and all are stored in `he_projects.brief`:

| Field | Server cap (after trim; an empty string deletes it) | Where it is entered |
|---|---|---|
| `business_override` (business description) | 3000 | Create form and Step 1 |
| `offer_override` | 3000 | Step 1 only |
| `style_override` (example email) | 8000 (the UI field has no maxLength) | Step 1 only |
| `signature_override` | 500 (the UI field has no maxLength) | Step 1 only |
| `icp` (Target / Never target, Company size, Geography) | 10 + 10 lines of 150 chars; size and geo 200 each | Create form and Step 1 (us market only) |
| `max_emails_per_company` | 1..100, default 5 (UI offers 1, 2, 3, 5, 10) | Step 1 |

- Caps: `app/src/lib/hypothesisEngine/projectBriefPatch.ts:27,30,33,44,160-168,183-202`; `app/src/lib/hypothesisEngine/icpFrame.ts:29-33,139-163`; `app/src/lib/hypothesisEngine/baseCollectEnqueue.ts:64-70`.
- Style and signature fields without maxLength: `app/src/components/client-eng/EngStepBrief.tsx:1296-1321`.
- Contacts-per-company options: `EngStepBrief.tsx:224,233`.
- The do-not-contact list is paste-only: exact emails, 1,000 per add and 10,000 in total (`app/src/app/api/client/blocklist/_eng.ts:87`, `app/src/lib/clientBlocklist/blockedContacts.ts:24`).
- There is no file upload anywhere in the cabinet. A grep over `components/client-eng`, `app/client/eng`, `api/client/eng`, `api/client/blocklist` and `lib/hypothesisEngine` found no file input, FormData, storage or multipart code.

**When each input is visible**

- **Create form.** Only an account with an empty project list sees it (one account = one site). It has Website (required), Name, "Describe your business" (maxLength 3000) and "Who do you sell to?". It has no offer, style, signature, country or file field, and it sends only the fields that were filled.
  - `app/src/components/client-eng/EngProjectsList.tsx:9-25,156-161,203-305,245,288`
- **Server side of creation.** It normalizes the URL, trims the name to 300 characters, forces market `'us'`, validates the business text and ICP strictly, writes them in the same insert, and queues research immediately.
  - `app/src/app/api/client/eng/projects/route.ts:176-200,214-227,237-247,253`; `projectBriefPatch.ts:242-261`
- **Step 1.** There is always a collapsed "What we know about your business" section. It opens by default only when a technical retry is possible. It holds the four fields plus a "Save overrides" button, the Target audience card (us only) and Contacts per company.
  - `EngStepBrief.tsx:829,872,1192-1330,1339`
- **Inline description box.** It appears only when research failed with `website_thin`. Its "Save and continue" button saves `business_override` and then resumes the same `site_profile` job. That step skips the daily start limit, but the paid-steps gate and the spend ceiling still apply.
  - `EngStepBrief.tsx:321-374,833,998-1038,1160-1190`; `app/src/app/api/client/eng/projects/[id]/research/route.ts:362-383,484-489,541-547`; `app/src/lib/hypothesisEngine/engPaidAccess.ts:36-41`
  - An unreachable site with no description does not get this box, only a hint text (`EngStepBrief.tsx:576-577`).
- **After research.** All four fields stay editable, but saving re-runs nothing. The PATCH route has no status check and queues no job, so edits reach only letters generated after the save. The UI says so.
  - `app/src/app/api/client/eng/projects/[id]/route.ts:511-667`, save at `:637-643`; `EngStepBrief.tsx:16-21,1252-1263`
- **ICP lock.** The lock is in the UI only (`EngStepBrief.tsx:418-423`). The server accepts `icp` for any us project (`[id]/route.ts:556-586`). After the hypotheses stage the value only affects the template's number check (`template.ts:1012`) and a retry after a technical failure (`hypotheses.ts:385`).
- **Fixed after creation.** The website URL and name cannot be changed (`[id]/route.ts:252-269`; `EngProjectsList.tsx:14-16`).

**How research uses these inputs**

- **site_profile (us market).**
  - It always sends `business_override` and `offer_override`, even when the site reads fine. They go as a separate "CLIENT'S BRIEF — FACTS ABOUT THE CLIENT" block, which wins over the site when they conflict and is marked as data, not instructions.
    - `app/src/lib/hypothesisEngine/stages/siteProfile.ts:528-533,560-577,928-952`; `app/src/lib/hypothesisEngine/prompts/siteProfile.en.ts:43-46,71-83`
  - The ICP goes as "TARGETING WISHES" and is used only for `target_audience`.
  - Current clients and cases are filtered in code down to text that is literally on the site (`siteProfile.ts:955`).
  - Site corpus limits:
    - the home page plus up to 4 content pages and 3 case pages;
    - 2,500 characters per extra page, 12,000 in total;
    - "thin" means under 800 characters or a JS stub;
    - a thin or unreachable site with no description is refused before the paid call.
    - `siteProfile.ts:153,217,220-223,400-407,785-809,853-926`
- **hypotheses.**
  - It reads `business_override` (trimmed, no cap when read) under the label "MANUAL BUSINESS DESCRIPTION FROM THE SPECIALIST". In ENG the client writes this text, and the block has no data-not-instructions line.
    - `app/src/lib/hypothesisEngine/stages/hypotheses.ts:414-418`; `app/src/lib/hypothesisEngine/prompts/hypotheses.en.ts:243-248`, compared with `:131-133,160`
  - It reads the ICP as "CLIENT'S TARGETING FRAME" (`hypotheses.ts:385`).
  - Nothing checks the hypotheses against that frame afterwards, and "Never target" is not used by the row prefilter (`app/src/lib/hypothesisEngine/relevanceGate.ts:1406-1411`, `icpFrame.ts:17-22`).
  - The offer reaches hypotheses only through the saved profile.
- **competitors, brand_cloud, evidence** read only the saved profile (`competitors.ts:197`, `brandCloud.ts:378`, `evidence.ts:458`). **clustering** reads neither the brief nor the profile.

**How letters use these inputs**

- **chain.**
  - The offer and business text go into a "CLIENT'S OWN WORDS" block to be quoted word for word, without rounding.
  - Style and signature are separate blocks.
  - The rest of the brief goes as JSON, without the four text fields, `icp` and `target_audience`.
  - `app/src/lib/hypothesisEngine/stages/chain.ts:291-304,335-346,380-384,414-430`; `app/src/lib/hypothesisEngine/prompts/chain.ts:233-262,640-662`
- **template.**
  - Style, signature and the client's own words go into the plan, letters, critic and rewrite prompts.
  - The full brief JSON is used only in the number fact-check corpus (`stages/template.ts:33-38,791-799,1006-1020`).
- **Brand guard.** If the signature, offer or business text contains "polza" or "outreachos", the chain and template stages fail for good before the first paid call (`app/src/lib/hypothesisEngine/letterBrandGuard.ts:89,664,683-699`; `chain.ts:395-404`; `template.ts:852-858`).

**Staff route that works today without new code.** The internal hypothesis-engine tool lists every `he_project`, including ENG client projects, with no owner filter (`app/src/app/api/tools/hypothesis-engine/projects/route.ts:27-31`).
- Its PATCH writes offer, style, signature and business text into any project (`app/src/app/api/tools/hypothesis-engine/projects/[id]/route.ts:53-71`).
- Its CasesBlock saves pasted case text up to 20,000 characters into `he_cases` (`app/src/components/hypothesis-engine/steps/Step1Research.tsx:548-569`; `app/src/app/api/tools/hypothesis-engine/projects/[id]/cases/route.ts:19,52-73`).
- Those cases reach letters as a separate client-case block, "КЕЙС КЛИЕНТА" (`chain.ts:348-359`).

---

## 2) Documents: what parsing and upload exist, and who may use them

- **Libraries.**
  - Installed: pdf-parse 1.1.4 (bundles pdf.js v1.10.100), mammoth, googleapis, cheerio. The `docx` package is used only to write files.
  - There is no OCR.
  - `app/package.json:76,80,86,94,98`; `app/node_modules/pdf-parse/lib/pdf-parse.js:38-42`
- **Shared extractor.** `extractTextFromBriefFile` reads PDF and DOCX and refuses .doc with a Russian error text. Every other extension is read as UTF-8, so a caller must whitelist extensions (`app/src/lib/emailSequenceV2/briefExtractor.ts:11-31`, `:25`, `:26-27`).
- **RU VE2 brief attach (staff only).** This is the existing "attach the filled brief to the analysis" feature.
  - The route accepts .pdf, .docx, .txt and .md up to 20 MB, behind internal auth. It extracts the text and does not store the file.
    - `app/src/app/api/tools/vertical-engine-v2/projects/[id]/brief/route.ts:25,27,104,134-153`
  - One LLM call (claude-opus-5 by default; input capped at 40,000 characters, output at 16,384 tokens) sorts the text into the template fields plus an ICP frame. The result goes into `ve_projects.brief.client_brief`, and a PUT allows manual edits.
    - `app/src/lib/verticalEngineV2/clientBriefIntake.ts:71,333-373`; `route.ts:180-237`; `app/src/lib/verticalEngineV2/llm.ts:117,131`
  - That parser's system prompt is Russian-only and names the agency "Polza". It also cuts the tail of the Russian template (`clientBriefIntake.ts:84-87,128-136,229-241`).
  - UI: `app/src/components/vertical-engine-v2/engine/steps/ClientBriefBlock.tsx:39,188-196`.
- **How VE2 uses the brief.**
  - **site_profile:** the brief block takes priority over the site and replaces it when the site cannot be read (`app/src/lib/verticalEngineV2/stages/siteProfile.ts:304,322,350`; `prompts/siteProfile.ts:33-43`).
  - **hypotheses:** capped at 12,000 characters, with the brief's ICP applied as a hard exclusion (`clientBriefIntake.ts:74,535-558,564-577`; `stages/hypotheses.ts:207-226`).
  - **chain and template:** capped at 6,000 characters, with the client's customers named only by type for NDA (`clientBriefIntake.ts:433-507`; `stages/chain.ts:239-242`; `stages/template.ts:254`).
  - The English VE2 prompts already have a CLIENT BRIEF block (`verticalEngineV2/prompts/siteProfile.en.ts:28-35`, `prompts/hypotheses.en.ts:99-105`). The compiled brief text still uses Russian labels (`app/src/lib/clientBrief/compile.ts:30-36`).
  - None of the VE2 brief blocks has a data-not-instructions line.
- **RU Portal project brief (ProjectBriefSection, staff with `canEditProjects`).**
  - PDF only, up to 20 MB, with a %PDF signature check; a scan without text is refused with a 422.
  - The file is stored in TWC S3, and the full text goes to `projects.brief_text` with no cap.
  - It feeds only the lead-source hypotheses, which read the first 8,000 characters.
  - Replacing the brief marks those hypotheses stale.
  - `app/src/app/api/projects/[id]/brief/route.ts:22-28,53-55,139,160-232`; `app/src/lib/projectBriefHypotheses/analyzeIcp.ts:19,21,40,70`
- **RU client portal /client/brief.**
  - A typed form, stored in `client_briefs.fields`.
  - The table has `pdf_path`, `pdf_file_name` and `pdf_uploaded_at` columns that no code writes (`supabase/instantly-migrations/20260430_0001_create_client_briefs.sql:13-15`; `app/src/app/api/client/brief/route.ts:31,97`).
  - ENG clients are redirected away from it (`app/src/middleware.ts:486-495`), and nothing in hypothesisEngine or VE2 reads `client_briefs`.
- **Routes that clients can already reach (not connected to ENG).**
  - `/api/brief-scoring/parse-pdf`: PDF only, 20 MB, own objects only, stores nothing (`app/src/middleware.ts:84-101`; `app/src/app/api/brief-scoring/parse-pdf/route.ts:18-19,59-69,104-168`).
  - email-sequence-v2 `extract-values`: reads docx and pdf with no size check and saves the original file to the main S3 (`app/src/app/api/tools/email-sequence-v2/runs/[runId]/extract-values/route.ts:29-30,40-46,75-90`).
  - Other parsers are staff-only: `reply-personalization/extract-text`, `ai-caller/briefs/parse`, `instantly/briefs`.
- **Google Docs.** No brief path accepts a Docs link.
  - The only Docs fetcher is the admin-only reglament import. It uses `export?format=html` and falls back to the Drive API with a service account (`app/src/app/api/reglament/import-google-doc/route.ts:22-33,35-60,62-88,182`).
  - Project `materials_links` are only displayed, never fetched (`app/src/app/projects/[id]/page.tsx:856-861`).
- **Correction to one report.** The uncommitted brief edits in the main checkout are byte-identical to commit 34fa5477f, which is already in d0471c6f5 and on production. The main checkout is simply on an old branch, `04d24c365`. No brief or upload work is in flight.

---

## 3) Gap: what is missing for "attach the filled brief to the analysis"

1. **No intake.** The ENG cabinet has no file input and no Docs link, and hypothesisEngine has no `client_brief` reader. The only `clientBrief` import there is `WebsiteFetchError`, in `stages/io.ts:48`.
2. **No room for a long text.**
   - The VE2 code says real filled briefs run to 20–25k characters (`clientBriefIntake.ts:70`). ENG takes 3,000 for the business text plus 3,000 for the offer.
   - Both fields also go word for word into every letter, so they cannot hold a raw brief.
3. **No prompt slot of its own.** The document must not go into the site corpus:
   - the corpus is labelled WEBSITE TEXT (`siteProfile.en.ts:79-82`);
   - it is the text that clients and cases are checked against (`siteProfile.ts:600-624,955`);
   - it drives the thin-site check (`siteProfile.ts:870-874`);
   - it is cut at 12,000 characters (`siteProfile.ts:221,400-407`).
   
   A separate block is needed in the profile prompt and in the hypotheses prompt. The hypotheses business block also needs a data-not-instructions line and an honest label.
4. **Timing.**
   - Research starts when the project is created (`projects/route.ts:253`).
   - A client can repeat it only after a technical failure (`app/src/lib/hypothesisEngine/researchJob.ts:91-102`).
   - A full repeat pays for every stage again and deletes verticals, bases, templates, chains, vocabularies and dossiers (`researchJob.ts:298-310`).
   - A cheap "refresh profile" needs code: the worker always queues the next stage (`app/worker/hypothesisEngine.ts:1664-1670,1899-1935`), and the stage sets the project back to `researching` (`siteProfile.ts:957-970`).
5. **Thin and unreachable sites.** The checks accept only `business_override` as a substitute (`siteProfile.ts:785-786,874,904`; `research/route.ts:376-383`; `EngStepBrief.tsx:1160-1190`).
6. **Storage leaks.** A new key in `he_projects.brief` would go into every chain prompt's JSON (`chain.ts:335-346,384,428`) and into the template's number check (`template.ts:1012`). The cabinet also cannot see it unless it is whitelisted (`app/src/lib/hypothesisEngine/clientEngProjection.ts:144-151`).
7. **No English parser and no spend gate on parsing.** VE2's parser is Russian, paid and ungated. A self-serve version would need `engPaidAccess` and `he_eng_rate_hit` (`app/src/lib/hypothesisEngine/engRateLimit.ts:1-30`).
8. **No upstream size limit.** nginx for app.outreachos.xyz allows 600 MB bodies (`deploy/nginx/app.outreachos.xyz.conf:35`; production config not checked), so the route must cap size itself.
9. **Brand trap.** Template text containing "Polza" that is pasted into the business, offer or signature fields makes letters fail for good.
10. **Unknown input.** We don't know whether the client's "dox" brief is a .docx file or a Google Docs link, or whether it is in Russian or English. The code cannot tell us.

---

## 4) Options

**A: a "Tell us more" materials slot (text), always visible on the create form and in Step 1.**
- **What changes:**
  - New storage outside `he_projects.brief`: a column or table, with the migration applied before the code. If it is stored in `brief` after all, the key must be removed in `chain.ts:335-346` and `template.ts:1012`.
  - Accepted in POST create (`projects/route.ts:170`) and in PATCH (`[id]/route.ts:252-269`).
  - A separate block in the profile prompt next to the client facts and targeting wishes (`siteProfile.en.ts:30-37,67-83`).
  - A separate block in the hypotheses prompt, plus a fix to the "FROM THE SPECIALIST" label (`hypotheses.en.ts:243-248`).
  - The raw text is not sent to letters; they benefit through the profile.
  - The thin and unreachable checks accept the materials.
  - Editable until site_profile has read it, enforced on the server too, unlike the ICP.
  - Metadata added to the cabinet whitelist.
- **Safety caps:**
  - up to 20,000 characters stored;
  - up to about 8,000 into the profile prompt and about 6,000 into hypotheses;
  - strip `"""`, control and invisible characters (stripUnstorableJsonChars);
  - never put it in the system prompt;
  - log only the character count.
- **Cost per research run:** about +$0.02–0.03 at the full caps. This is an estimate from gpt-5.5 at $5 per 1M input tokens (`app/src/lib/hypothesisEngine/llm.ts:103-104`; `docker-compose.prod.yml:821,823`); it was not measured.
- **Effort:** about 3–4 days with tests and review.
- **Risks:**
  - a client can put instructions in the text (handled by the data-not-instructions block);
  - it does nothing for projects already researched unless a "Refresh profile" is added (about +3 days);
  - two description fields could confuse clients, so the UI text must say which one goes word for word into letters.

**B: .docx/.pdf upload, converted to text, into the same slot (A plus an upload).**
- **What changes:**
  - A new route under `/api/client/eng/`, which is already allowed by `middleware.ts:84-101`.
  - It reuses `extractTextFromBriefFile` with an extension whitelist and English error texts.
  - The file is not stored, only the extracted text, as in VE2.
  - The UI shows what was read (characters, pages, a preview) and a Remove button.
  - No LLM structuring call in the first version.
- **Safety caps:**
  - up to 5 MB, enforced in the route;
  - %PDF signature check;
  - at most about 30 PDF pages, using pdf-parse's `max` option (`pdf-parse.js:40,80`);
  - check the DOCX's uncompressed size before mammoth (zip bomb);
  - a timeout or a separate process, because the bundled pdf.js v1.10.100 is old;
  - `he_eng_rate_hit`, blockDemo and the owner check;
  - .doc refused, and scans refused with a clear message.
- **Cost:** extraction is free (CPU only), and the research cost is the same as A. An English version of VE2's field parser would add a paid call per upload that no one has priced, so leave it out of the first version.
- **Effort:** A + 1.5–2 days, so about 5–7 days in total.
- **Risks:**
  - a wider attack surface from the parser (whether the bundled pdf.js is exposed to CVE-2024-4367 was not checked);
  - scanned PDFs and .doc files fail;
  - a 20–25k-character brief gets cut at the caps;
  - the client's customer names can end up in the profile;
  - "Polza" in the template header could reach letters if the client copies it into the guarded fields.

**C: Google Docs link.**
- **What changes:** the server takes only the document ID from the link and builds the export URL itself, following the reglament pattern but with `format=txt`. It stores a snapshot of the text in the same slot. It must never use the Drive service-account fallback for client documents, because that account can read anything shared with it.
- **Safety caps:** a response of at most 1 MB, a timeout, no redirects to other hosts, and a clear error for a private document.
- **Cost:** the same as A.
- **Effort:** A + 1–1.5 days.
- **Risks:**
  - the server makes a request on client input (SSRF if the URL is not rebuilt from the ID);
  - private-document behaviour was not checked;
  - clients may expect live updates but get a snapshot.

**Recommendation: B, built on A's slot.** One stored materials text with two ways to fill it, paste or .docx/.pdf, in about 5–7 days. Pasting already covers Google Docs, since the client can copy the text out. Build C only if clients actually send links. Add "Refresh profile" (+3 days) only if existing projects need it.

---

## 5) HST test project

**Current state, from memory, not code.** The hst.ie research finished on 2026-10-16 at 08:49 UTC with 13 markets and 31 hypotheses; $1.88 was recorded. The profile is already correct (HST Solutions, Dublin, custom software/AI/cloud, ISO 27001). An earlier evidence run was SIGKILLed by a deploy, and its spend is not recorded, so the real cost per run may be somewhat above $1.88.

**Now, with no code changes:**
- **Free, letters only.** Write a condensed version of the brief into the business text (up to 3,000) and the offer (up to 3,000), plus style and signature. The client can do this in Step 1, or staff can use the internal tool's PATCH. Case text up to 20,000 characters can go into `he_cases` through CasesBlock.
  - This affects only letters generated after the save. Markets and hypotheses stay as they are, and chains or templates already written are not regenerated.
  - The text is quoted word for word in letters, so it must be in the client's own voice and must not contain "Polza" or "outreachos".
- **Full re-run so the brief shapes the profile and hypotheses.** The cabinet will refuse it, so it has to go through the staff research route. That route refuses only when the project has a launch, and skips the cabinet's busy and confirm checks (`app/src/app/api/tools/hypothesis-engine/projects/[id]/research/route.ts:44-52,89`).
  - **Cost:** about $1.88 plus about 1 cent for 6,000 characters of brief text (roughly 1.5k tokens at $5 per 1M, read in site_profile and partly in hypotheses), so about $1.89–1.90. Generating letters again costs extra and has not been priced.
  - **Side effect:** clustering deletes every vertical, base, template, chain, vocabulary and dossier already built (`researchJob.ts:298-310`).
  - It is a production change and needs the owner's explicit «да».

**After A or B ships:**
- A full re-run with the materials costs about $1.88 + $0.02–0.03.
- With "Refresh profile", about $0.1–0.2 (an assumption). That refreshes only the profile; markets stay the same.

**Open questions:**
- Is HST's brief a .docx or a Google Doc, and in which language?
- Does it carry our brand in the header?
- Does HST already have chains or a launch? The re-run is refused if it is launched.

---

**Side note (security):** in the main checkout, the untracked `scripts/download-briefs-local.ps1` has a JWT-shaped key on line 26 that a report identifies as a service-role key (the token was not decoded). The file is not git-ignored, so it could be committed by accident.