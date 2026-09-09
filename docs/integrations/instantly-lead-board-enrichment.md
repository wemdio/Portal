# Instantly guest lead-board contact enrichment

The qualification worker populates `company_name`, `phone` and `website` before
creating a new `project_lead_board_rows` record. Qualification criteria and
specialist ownership are unchanged.

## Sources and precedence

1. The existing account/campaign-scoped Instantly lookup is filtered to the exact
   recipient email. An explicitly different `campaign` or `campaign_id` is
   rejected; a fuzzy search's first result is not trusted.
2. Standard lead fields take precedence, followed by `custom_variables`, original
   upload `payload`, and nested payload custom variables. Supported English and
   Russian column aliases ignore case, spaces, punctuation and numbered suffixes.
   Arbitrary personalization text is not searched for contact data.
   Explicit website/site fields across these sources take priority over domain
   fields: a provider's `company_domain` cannot hide an uploaded website.
   Complete descriptive headers are also recognized (`Direct Phone (Apollo)`,
   `Номер телефона контактного лица`, `Сайт (Website)`, numbered/bilingual labels).
   Similar service fields such as phone status/extension, company description/ID
   and LinkedIn profile URL are not contact fields. Opaque labels (`Field 17`)
   must be mapped at upload: existing import mapping accepts any source header
   and writes canonical fields. Values alone cannot safely distinguish IDs from
   phones or arbitrary text from company names.
3. Missing company and website values fall back to the current responder's
   signature. Missing phone first falls back to a number deliberately provided in
   the current reply, then to a signature number. Uploaded phone values retain
   priority; a reply does not silently replace existing base metadata.
4. The last website fallback is the corporate sender email domain. This is an
   inference, not a website availability check. Free/disposable mail providers,
   social/messenger links, unsafe URLs and tracking/image links are excluded.

The reply parser retains signatures but removes quoted/forwarded history and
common HTML quote containers before extracting contact details. It preserves
usable `tel:`/website link targets when their visible text is just a label.
Dates, tax IDs, order identifiers and obviously invalid phone values are not
phone candidates. Company names are taken from explicit company/signature lines;
they are not invented from a domain. Ambiguous values remain empty.

## Safety and release

No new Instantly requests, AI calls, website crawling or database dependencies are
introduced. Parsing is bounded and best-effort, so malformed optional enrichment
does not prevent qualification. Missing enrichment does not clear names already
saved on a qualification retry.

Board insertion still uses `ON CONFLICT DO NOTHING`: existing rows, guest edits,
quality, comments and taken flags are not rewritten. Deployment applies this to
newly created automatic rows. Historical rows are not backfilled by this change;
a production backfill needs separate authorization and must respect guest edits.
No schema migration is required.

## Specialist Telegram post

The shared-chat lead post now includes phone and website when available, using
the same board row scoped by qualification ID and proven project ID. This works
for immediate sends and delivery-only retries after a worker restart. Existing
board values, including explicitly cleared fields, take priority over enrichment.
If the board is missing/unavailable, immediate delivery keeps the already resolved
metadata; recovery can use the saved full reply/signature and corporate email
domain without another provider/AI request. Optional contact reads never suppress
the alert. Previously sent posts are not edited.

Contact values are escaped plain text, never raw HTML/href attributes. Long
display fields are bounded before escaping, with reply/AI text fitted into the
remaining Telegram budget while retaining the table link, ID and specialist ping.
Numeric mention targets are preserved even when display names are shortened.
