import {
  CLIENT_REPORT_EXPORT_STATUSES,
  type ClientReportExportKind,
  type ClientReportExportStatus,
} from './types';

const EXPORT_KINDS = new Set<ClientReportExportKind>([
  'rejected',
  'working',
  'submitted',
]);
const SCORE_FILTERS = new Set(['all', 'A', 'B', 'C']);
const EXPORT_STATUSES = new Set<ClientReportExportStatus>(CLIENT_REPORT_EXPORT_STATUSES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EXPORT_RANGE_MS = 367 * 24 * 60 * 60 * 1_000;

export type ClientReportExportJobFilters = {
  preset: string;
  from: string;
  to: string;
  fromUtc: string;
  toExclusiveUtc: string;
  score: 'all' | 'A' | 'B' | 'C';
  campaignId: string | null;
  allowedCampaignIds: string[];
};

export type ClientReportExportJob = {
  id: string;
  clientUserId: string;
  kind: ClientReportExportKind;
  filters: ClientReportExportJobFilters;
  status: ClientReportExportStatus;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function isoInstant(value: unknown, label: string): string {
  const raw = nonEmptyString(value, label);
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be an ISO timestamp`);
  return date.toISOString();
}

function parseFilters(value: unknown): ClientReportExportJobFilters {
  let decoded = value;
  if (typeof decoded === 'string') {
    try { decoded = JSON.parse(decoded); }
    catch { throw new Error('Export job filters must contain valid JSON'); }
  }
  const raw = asRecord(decoded, 'Export job filters');
  const from = nonEmptyString(raw.from, 'filters.from');
  const to = nonEmptyString(raw.to, 'filters.to');
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw new Error('Export calendar boundaries must use YYYY-MM-DD');
  }
  const fromUtc = isoInstant(raw.fromUtc, 'filters.fromUtc');
  const toExclusiveUtc = isoInstant(raw.toExclusiveUtc, 'filters.toExclusiveUtc');
  const rangeMs = Date.parse(toExclusiveUtc) - Date.parse(fromUtc);
  if (rangeMs <= 0 || rangeMs > MAX_EXPORT_RANGE_MS) {
    throw new Error('Export date range must be positive and at most 367 days');
  }
  if (!SCORE_FILTERS.has(String(raw.score))) {
    throw new Error(`Unsupported export score filter: ${String(raw.score)}`);
  }
  if (!Array.isArray(raw.allowedCampaignIds)) {
    throw new Error('filters.allowedCampaignIds must be an array');
  }
  const allowedCampaignIds = [...new Set(raw.allowedCampaignIds.map((item) =>
    nonEmptyString(item, 'allowed campaign id'),
  ))];
  const campaignId = raw.campaignId === null || raw.campaignId === undefined
    ? null
    : nonEmptyString(raw.campaignId, 'filters.campaignId');
  if (campaignId && !allowedCampaignIds.includes(campaignId)) {
    throw new Error('Requested campaign is not in the allowed campaign set');
  }

  return {
    preset: nonEmptyString(raw.preset, 'filters.preset'),
    from,
    to,
    fromUtc,
    toExclusiveUtc,
    score: String(raw.score) as ClientReportExportJobFilters['score'],
    campaignId,
    allowedCampaignIds,
  };
}

/**
 * Fail closed when a queued export's authorization snapshot is no longer
 * covered by the client's current campaign grants.
 */
export function isClientReportExportAccessCurrent(
  filters: unknown,
  currentCampaignIds: readonly string[],
): boolean {
  let parsed: ClientReportExportJobFilters;
  try {
    parsed = parseFilters(filters);
  } catch {
    return false;
  }

  if (parsed.allowedCampaignIds.length === 0) return false;
  const current = new Set(
    currentCampaignIds
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return parsed.allowedCampaignIds.every((campaignId) => current.has(campaignId));
}

/** Validate the persisted queue payload again at the trust boundary of the worker. */
export function parseClientReportExportJob(value: unknown): ClientReportExportJob {
  const raw = asRecord(value, 'Export job');
  const id = nonEmptyString(raw.id, 'Export job id');
  const clientUserId = nonEmptyString(
    raw.client_user_id ?? raw.clientUserId,
    'Export client user id',
  );
  if (!UUID_RE.test(id) || !UUID_RE.test(clientUserId)) {
    throw new Error('Export job and client identifiers must be UUIDs');
  }
  if (!EXPORT_KINDS.has(raw.kind as ClientReportExportKind)) {
    throw new Error(`Unsupported export kind: ${String(raw.kind)}`);
  }
  const status = nonEmptyString(raw.status, 'Export job status');
  if (!EXPORT_STATUSES.has(status as ClientReportExportStatus)) {
    throw new Error(`Unsupported export status: ${status}`);
  }
  return {
    id,
    clientUserId,
    kind: raw.kind as ClientReportExportKind,
    filters: parseFilters(raw.filters),
    status: status as ClientReportExportJob['status'],
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlTextArray(values: readonly string[]): string {
  if (values.length === 0) return 'ARRAY[]::text[]';
  return `ARRAY[${values.map(sqlLiteral).join(', ')}]::text[]`;
}

/**
 * Sanitize every textual CSV cell at the database boundary. COPY still owns
 * RFC-4180 quoting; this expression removes embedded row breaks and prefixes
 * spreadsheet formulas with a literal apostrophe.
 */
export function formulaSafeCsvTextSql(expression: string): string {
  const flattened = `regexp_replace(coalesce((${expression})::text, ''), E'[\\r\\n]+', ' ', 'g')`;
  return `CASE WHEN ${flattened} ~ '^[[:space:]]*[=+@-]' THEN '''' || ${flattened} ELSE ${flattened} END`;
}

function scoreCodeSql(expression: string): string {
  return `CASE
    WHEN ${expression} IS NULL THEN 'error'
    WHEN ${expression} > 1000000 THEN 'A'
    WHEN ${expression} >= 15001 THEN 'B'
    WHEN ${expression} >= 1001 THEN 'C'
    ELSE 'rejected'
  END`;
}

function domainScorePredicate(kind: ClientReportExportKind, score: ClientReportExportJobFilters['score']): string {
  if (kind === 'rejected') {
    return "source.score_code = 'rejected'";
  }
  if (kind !== 'working') throw new Error(`Domain predicate is unavailable for ${kind}`);
  if (score === 'all') return "source.score_code IN ('A', 'B', 'C')";
  return `source.score_code = ${sqlLiteral(score)}`;
}

function buildDomainExportSql(job: ClientReportExportJob): string {
  const userId = sqlLiteral(job.clientUserId);
  const from = sqlLiteral(job.filters.fromUtc);
  const to = sqlLiteral(job.filters.toExclusiveUtc);
  const scorePredicate = domainScorePredicate(job.kind, job.filters.score);

  return `
WITH domain_facts AS (
  SELECT
    s.client_user_id,
    s.domain,
    s.company_name,
    s.score,
    s.score_code,
    s.rating,
    s.spf,
    s.metadata->>'email' AS email,
    s.metadata->>'email_validation_status' AS email_validation_status,
    s.metadata->>'email2' AS second_email,
    s.metadata->>'email2_validation_status' AS second_email_validation_status,
    s.email_found_count,
    s.email_validated_count,
    s.routed_campaign_id AS campaign_id,
    s.routed_campaign_name_snapshot AS campaign_name,
    (s.routed_campaign_id IS NOT NULL) AS campaign_identity_known,
    s.source_kind,
    s.metadata->>'source_filename' AS source_filename,
    s.source_run_id,
    s.source_job_id,
    s.source_row_id,
    s.scored_at,
    s.legacy_inferred
  FROM public.client_pipeline_domain_snapshots s

  UNION ALL

  SELECT
    r.client_user_id,
    m.domain,
    coalesce(nullif(m.company_name, ''), m.scraped_name),
    m.score,
    ${scoreCodeSql('m.score')},
    m.rating,
    m.spf,
    m.email,
    m.email_validation_status,
    m.email2,
    m.email2_validation_status,
    ((m.email IS NOT NULL)::int + (m.email2 IS NOT NULL)::int),
    ((m.email_validation_status IN ('valid','role_address','free_provider','catch_all'))::int
      + (m.email2_validation_status IN ('valid','role_address','free_provider','catch_all'))::int),
    NULL::text,
    NULL::text,
    false AS campaign_identity_known,
    'manual_scoring_legacy',
    r.source_filename,
    r.id::text,
    NULL::text,
    m.id::text,
    m.processed_at,
    true
  FROM public.client_manual_score_rows m
  JOIN public.client_manual_score_runs r ON r.id = m.run_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.client_pipeline_domain_snapshots s
    WHERE s.client_user_id = r.client_user_id
      AND s.source_run_id = r.id::text
      AND s.source_row_id = m.id::text
  )

  UNION ALL

  SELECT
    j.client_user_id,
    d.domain,
    c.company_name,
    c.score,
    ${scoreCodeSql('c.score')},
    c.rating,
    c.spf,
    NULL::text,
    NULL::text,
    NULL::text,
    NULL::text,
    0,
    0,
    NULL::text,
    NULL::text,
    false AS campaign_identity_known,
    'large_file_legacy',
    j.source_filename,
    NULL::text,
    j.id::text,
    d.id::text,
    coalesce(d.scored_at, c.scored_at),
    true
  FROM public.large_score_domains d
  JOIN public.large_score_jobs j ON j.id = d.job_id
  LEFT JOIN public.mailganer_domain_scores c ON c.domain = d.domain
  WHERE d.status IN ('scored', 'cached')
    AND NOT EXISTS (
      SELECT 1 FROM public.client_pipeline_domain_snapshots s
      WHERE s.client_user_id = j.client_user_id
        AND s.source_job_id = j.id::text
        AND s.source_row_id = d.id::text
    )

  UNION ALL

  SELECT
    a.client_user_id,
    a.domain,
    coalesce(a.company_name, a.hh_employer_name),
    a.endpoint_score,
    ${scoreCodeSql('a.endpoint_score')},
    a.endpoint_raw->>'rating',
    a.endpoint_spf,
    coalesce(a.resolved_email, a.email_found),
    a.email_validation_status,
    a.email2,
    a.email2_validation_status,
    ((coalesce(a.resolved_email, a.email_found) IS NOT NULL)::int + (a.email2 IS NOT NULL)::int),
    ((a.email_validation_status IN ('valid','role_address','free_provider','catch_all'))::int
      + (a.email2_validation_status IN ('valid','role_address','free_provider','catch_all'))::int),
    a.routed_campaign_id,
    NULL::text,
    (a.routed_campaign_id IS NOT NULL) AS campaign_identity_known,
    'auto_pipeline_legacy',
    NULL::text,
    NULL::text,
    NULL::text,
    a.hh_employer_id,
    coalesce(a.processed_at, a.first_seen_at),
    true
  FROM public.client_auto_pipeline_seen_employers a
  WHERE NOT EXISTS (
    SELECT 1 FROM public.client_pipeline_domain_snapshots s
    WHERE s.client_user_id = a.client_user_id
      AND s.source_row_id = a.hh_employer_id
      AND s.source_kind IN ('auto_pipeline', 'hh', 'base_of_bases')
  )
)
SELECT
  ${formulaSafeCsvTextSql('source.domain')} AS domain,
  ${formulaSafeCsvTextSql('source.company_name')} AS company_name,
  source.score,
  source.score_code,
  ${formulaSafeCsvTextSql('source.rating')} AS rating,
  ${formulaSafeCsvTextSql('source.spf')} AS spf,
  ${formulaSafeCsvTextSql('source.email')} AS email,
  ${formulaSafeCsvTextSql('source.email_validation_status')} AS email_validation_status,
  ${formulaSafeCsvTextSql('source.second_email')} AS second_email,
  ${formulaSafeCsvTextSql('source.second_email_validation_status')} AS second_email_validation_status,
  source.email_found_count,
  source.email_validated_count,
  ${formulaSafeCsvTextSql('source.campaign_id')} AS campaign_id,
  ${formulaSafeCsvTextSql('source.campaign_name')} AS campaign_name,
  ${formulaSafeCsvTextSql('source.source_kind')} AS source,
  ${formulaSafeCsvTextSql('source.source_filename')} AS source_filename,
  ${formulaSafeCsvTextSql('source.source_run_id')} AS source_run_id,
  ${formulaSafeCsvTextSql('source.source_job_id')} AS source_job_id,
  ${formulaSafeCsvTextSql('source.source_row_id')} AS source_row_id,
  source.scored_at,
  source.legacy_inferred
FROM domain_facts source
WHERE source.client_user_id = ${userId}::uuid
  AND source.scored_at >= ${from}::timestamptz
  AND source.scored_at < ${to}::timestamptz
  AND ${scorePredicate}
ORDER BY source.scored_at, source.source_kind, source.source_row_id, source.domain`;
}

function buildSubmittedExportSql(job: ClientReportExportJob): string {
  const userId = sqlLiteral(job.clientUserId);
  const from = sqlLiteral(job.filters.fromUtc);
  const to = sqlLiteral(job.filters.toExclusiveUtc);
  const allowed = sqlTextArray(job.filters.allowedCampaignIds);
  const campaign = job.filters.campaignId
    ? `source.campaign_id = ${sqlLiteral(job.filters.campaignId)}`
    : `source.campaign_id = ANY(${allowed})`;
  const score = job.filters.score === 'all'
    ? "source.score_code IN ('A', 'B', 'C')"
    : `source.score_code = ${sqlLiteral(job.filters.score)}`;

  return `
WITH submitted_contacts AS (
  SELECT
    l.client_user_id,
    l.email,
    l.company_name,
    l.domain,
    l.score,
    l.score_code,
    l.campaign_id,
    l.campaign_name_snapshot AS campaign_name,
    l.submitted_at,
    'accepted' AS provider_status,
    'identity_confirmed' AS provider_confidence,
    true AS confirmed,
    true AS identity_complete,
    b.accepted_count,
    b.requested_count,
    l.external_contact_id,
    l.source_kind,
    l.source_run_id,
    l.source_job_id,
    l.source_row_id,
    l.legacy_inferred
  FROM public.client_campaign_contact_ledger l
  JOIN public.client_campaign_append_batches b ON b.id = l.append_batch_id
  WHERE l.append_status = 'accepted'

  UNION ALL

  -- Some provider responses confirm only an aggregate accepted count. Preserve
  -- the attempted identities, but never present them as individually accepted.
  SELECT
    l.client_user_id,
    l.email,
    l.company_name,
    l.domain,
    l.score,
    l.score_code,
    l.campaign_id,
    l.campaign_name_snapshot AS campaign_name,
    coalesce(b.finished_at, l.submitted_at),
    'accepted_aggregate_only' AS provider_status,
    'identity_unknown' AS provider_confidence,
    false AS confirmed,
    false AS identity_complete,
    b.accepted_count,
    b.requested_count,
    NULL::text AS external_contact_id,
    l.source_kind,
    l.source_run_id,
    l.source_job_id,
    l.source_row_id,
    l.legacy_inferred
  FROM public.client_campaign_contact_ledger l
  JOIN public.client_campaign_append_batches b ON b.id = l.append_batch_id
  WHERE l.append_status = 'submitted'
    AND b.status = 'completed'
    AND b.identity_complete = false
    AND b.accepted_count > 0

  UNION ALL

  -- Before identity-level append events existed, routed immutable snapshots
  -- were the strongest local fact. They prove the attempted destination, not
  -- individual provider acceptance, so confidence stays explicitly limited.
  SELECT
    s.client_user_id,
    address.email,
    s.company_name,
    s.domain,
    s.score,
    s.score_code,
    s.routed_campaign_id,
    s.routed_campaign_name_snapshot,
    s.routed_at,
    'snapshot_routed' AS provider_status,
    'not_confirmed' AS provider_confidence,
    false AS confirmed,
    false AS identity_complete,
    NULL::integer AS accepted_count,
    NULL::integer AS requested_count,
    NULL::text AS external_contact_id,
    s.source_kind,
    s.source_run_id,
    s.source_job_id,
    coalesce(s.source_row_id, '') || ':' || address.position::text,
    s.legacy_inferred
  FROM public.client_pipeline_domain_snapshots s
  CROSS JOIN LATERAL (
    VALUES
      (s.metadata->>'email', s.metadata->>'email_validation_status', 1),
      (s.metadata->>'email2', s.metadata->>'email2_validation_status', 2)
  ) AS address(email, validation_status, position)
  WHERE s.routed_campaign_id IS NOT NULL
    AND s.routed_at IS NOT NULL
    AND nullif(btrim(address.email), '') IS NOT NULL
    AND address.validation_status IN ('valid','role_address','free_provider','catch_all')
    AND NOT EXISTS (
      SELECT 1 FROM public.client_campaign_contact_ledger l
      WHERE l.client_user_id = s.client_user_id
        AND l.campaign_id = s.routed_campaign_id
        AND lower(btrim(l.email)) = lower(btrim(address.email))
        AND l.append_status IN ('submitted', 'accepted')
    )

  UNION ALL

  SELECT
    a.client_user_id,
    address.email,
    coalesce(a.company_name, a.hh_employer_name),
    a.domain,
    a.endpoint_score,
    ${scoreCodeSql('a.endpoint_score')},
    a.routed_campaign_id,
    NULL::text,
    coalesce(a.processed_at, a.first_seen_at),
    'legacy_submitted' AS provider_status,
    'not_confirmed' AS provider_confidence,
    false AS confirmed,
    false AS identity_complete,
    NULL::integer,
    NULL::integer,
    NULL::text AS external_contact_id,
    'auto_pipeline_legacy',
    NULL::text,
    NULL::text,
    a.hh_employer_id || ':' || address.position::text,
    true
  FROM public.client_auto_pipeline_seen_employers a
  CROSS JOIN LATERAL (
    VALUES
      (coalesce(a.resolved_email, a.email_found), a.email_validation_status, 1),
      (a.email2, a.email2_validation_status, 2)
  ) AS address(email, validation_status, position)
  WHERE a.status = 'routed'
    AND a.routed_campaign_id IS NOT NULL
    AND nullif(btrim(address.email), '') IS NOT NULL
    AND address.validation_status IN ('valid','role_address','free_provider','catch_all')
    AND NOT EXISTS (
      SELECT 1 FROM public.client_campaign_contact_ledger l
      WHERE l.client_user_id = a.client_user_id
        AND l.campaign_id = a.routed_campaign_id
        AND lower(btrim(l.email)) = lower(btrim(address.email))
        AND l.append_status IN ('submitted', 'accepted')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.client_pipeline_domain_snapshots s
      WHERE s.client_user_id = a.client_user_id
        AND s.routed_campaign_id = a.routed_campaign_id
        AND s.routed_at IS NOT NULL
        AND lower(btrim(address.email)) IN (
          lower(btrim(s.metadata->>'email')),
          lower(btrim(s.metadata->>'email2'))
        )
    )
)
SELECT
  ${formulaSafeCsvTextSql('source.email')} AS email,
  ${formulaSafeCsvTextSql('source.company_name')} AS company_name,
  ${formulaSafeCsvTextSql('source.domain')} AS domain,
  source.score,
  source.score_code,
  ${formulaSafeCsvTextSql('source.campaign_id')} AS campaign_id,
  ${formulaSafeCsvTextSql('source.campaign_name')} AS campaign_name,
  source.submitted_at,
  ${formulaSafeCsvTextSql('source.provider_status')} AS provider_status,
  ${formulaSafeCsvTextSql('source.provider_confidence')} AS provider_confidence,
  source.confirmed,
  source.identity_complete,
  source.accepted_count AS batch_accepted_count,
  source.requested_count AS batch_requested_count,
  ${formulaSafeCsvTextSql('source.external_contact_id')} AS external_contact_id,
  ${formulaSafeCsvTextSql('source.source_kind')} AS source,
  ${formulaSafeCsvTextSql('source.source_run_id')} AS source_run_id,
  ${formulaSafeCsvTextSql('source.source_job_id')} AS source_job_id,
  ${formulaSafeCsvTextSql('source.source_row_id')} AS source_row_id,
  source.legacy_inferred
FROM submitted_contacts source
WHERE source.client_user_id = ${userId}::uuid
  AND source.submitted_at >= ${from}::timestamptz
  AND source.submitted_at < ${to}::timestamptz
  AND ${score}
  AND ${campaign}
ORDER BY source.submitted_at, source.campaign_id, source.email`;
}

export function buildClientReportExportSelectSql(job: ClientReportExportJob): string {
  return job.kind === 'submitted'
    ? buildSubmittedExportSql(job)
    : buildDomainExportSql(job);
}

export function buildClientReportExportStorageKey(job: ClientReportExportJob): string {
  return `client-reports/${job.clientUserId}/${job.id}/${job.kind}-${job.filters.from}-${job.filters.to}.csv.gz`;
}
