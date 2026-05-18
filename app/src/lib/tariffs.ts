import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export type TariffType = 'standard' | 'pro' | 'custom';

export type TariffLimits = {
  max_contacts: number;
  max_rows: number;
  max_chains_per_month: number;
  max_domains: number;
  max_emails: number;
};

export const TARIFF_DEFAULTS: Record<'standard' | 'pro', TariffLimits> = {
  standard: {
    max_contacts: 10_000,
    max_rows: 20_000,
    max_chains_per_month: 10,
    max_domains: 4,
    max_emails: 16,
  },
  pro: {
    max_contacts: 20_000,
    max_rows: 40_000,
    max_chains_per_month: 20,
    max_domains: 8,
    max_emails: 32,
  },
};

export const SETUP_DAYS = 3;

export type BillingMode = 'invoice' | 'autopayment';

export type ClientTariffRow = {
  id: string;
  user_id: string;
  tariff_type: TariffType;
  max_contacts: number | null;
  max_rows: number | null;
  max_chains_per_month: number | null;
  max_domains: number | null;
  max_emails: number | null;
  paid_at: string | null;
  paid_until: string | null;
  setup_until: string | null;
  is_active: boolean;
  billing_mode: BillingMode | null;
  payment_locked: boolean;
  yookassa_payment_method_id?: string | null;
  auto_renew?: boolean;
  last_renewal_error?: string | null;
  last_renewal_attempt_at?: string | null;
  created_at: string;
  updated_at: string;
};

/** setup — paid but within setup phase; active — ready to use; expired — past paid_until; inactive — not paid */
export type ClientStatus = 'setup' | 'active' | 'expired' | 'inactive';

export function getClientStatus(row: ClientTariffRow | null): ClientStatus {
  if (!row || !row.is_active) return 'inactive';
  const now = new Date();
  if (row.paid_until && new Date(row.paid_until) <= now) return 'expired';
  if (row.setup_until && new Date(row.setup_until) > now) return 'setup';
  return 'active';
}

/**
 * Returns true when the client's portal is locked pending payment.
 *
 * For autopayment mode: the lock auto-lifts once the 3-day setup period
 * expires AND the client has already paid (paid_at is set). This avoids
 * needing a cron job — the gate is evaluated at read time.
 *
 * For invoice mode: the lock is lifted only when the invoice webhook
 * explicitly sets payment_locked = false.
 */
export function isPaymentLocked(row: ClientTariffRow | null): boolean {
  if (!row || !row.payment_locked) return false;
  if (row.billing_mode === 'autopayment' && row.paid_at && row.setup_until) {
    const now = new Date();
    if (new Date(row.setup_until) <= now) return false;
  }
  return true;
}

export function isSubscriptionActive(row: ClientTariffRow | null): boolean {
  return getClientStatus(row) === 'active';
}

export function isInSetupPhase(row: ClientTariffRow | null): boolean {
  return getClientStatus(row) === 'setup';
}

export function getBillingPeriodStart(row: ClientTariffRow | null): string {
  if (row?.setup_until) return row.setup_until;
  if (row?.paid_at) return row.paid_at;
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

export type SubscriptionStatus = {
  status: ClientStatus;
  tariff_type: TariffType;
  limits: TariffLimits;
  paid_at: string | null;
  paid_until: string | null;
  setup_until: string | null;
  billing_mode: BillingMode | null;
  payment_locked: boolean;
};

export type LimitUsage = {
  limit: number;
  used: number;
  remaining: number;
};

export type ClientTariffUsage = Record<keyof TariffLimits, LimitUsage>;

/** Автоплатежи для клиентского ЛК (без раскрытия id карты ЮKassa) */
export type ClientAutopayFields = {
  auto_renew: boolean;
  payment_method_saved: boolean;
  last_renewal_error: string | null;
};

export type ClientTariffUsageSummary = SubscriptionStatus &
  ClientAutopayFields & {
    period_start: string;
    usage: ClientTariffUsage;
  };

function nonNegativeInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function usageBucket(limit: number, used: number): LimitUsage {
  const safeLimit = nonNegativeInt(limit);
  const safeUsed = nonNegativeInt(used);
  return {
    limit: safeLimit,
    used: safeUsed,
    remaining: Math.max(0, safeLimit - safeUsed),
  };
}

export function resolveEffectiveLimits(row: ClientTariffRow | null): TariffLimits {
  if (!row) return TARIFF_DEFAULTS.standard;

  const base = row.tariff_type === 'pro'
    ? TARIFF_DEFAULTS.pro
    : TARIFF_DEFAULTS.standard;

  if (row.tariff_type === 'custom') {
    return {
      max_contacts: row.max_contacts ?? TARIFF_DEFAULTS.pro.max_contacts,
      max_rows: row.max_rows ?? TARIFF_DEFAULTS.pro.max_rows,
      max_chains_per_month: row.max_chains_per_month ?? TARIFF_DEFAULTS.pro.max_chains_per_month,
      max_domains: row.max_domains ?? TARIFF_DEFAULTS.pro.max_domains,
      max_emails: row.max_emails ?? TARIFF_DEFAULTS.pro.max_emails,
    };
  }

  return {
    max_contacts: row.max_contacts ?? base.max_contacts,
    max_rows: row.max_rows ?? base.max_rows,
    max_chains_per_month: row.max_chains_per_month ?? base.max_chains_per_month,
    max_domains: row.max_domains ?? base.max_domains,
    max_emails: row.max_emails ?? base.max_emails,
  };
}

export async function getClientTariffRow(userId: string): Promise<ClientTariffRow | null> {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from('client_tariffs')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  return (data as ClientTariffRow | null) ?? null;
}

export async function getClientLimits(userId: string): Promise<TariffLimits> {
  const row = await getClientTariffRow(userId);
  return resolveEffectiveLimits(row);
}

export async function getSubscriptionStatus(userId: string): Promise<SubscriptionStatus> {
  const row = await getClientTariffRow(userId);
  return {
    status: getClientStatus(row),
    tariff_type: row?.tariff_type ?? 'standard',
    limits: resolveEffectiveLimits(row),
    paid_at: row?.paid_at ?? null,
    paid_until: row?.paid_until ?? null,
    setup_until: row?.setup_until ?? null,
    billing_mode: row?.billing_mode ?? null,
    payment_locked: isPaymentLocked(row),
  };
}

export async function countClientContacts(userId: string, periodStart: string): Promise<number> {
  const { supabaseInstantly } = await import('@/lib/supabaseInstantly');
  if (!supabaseInstantly) return 0;
  const { data } = await supabaseInstantly
    .from('client_campaign_launches')
    .select('accepted_rows')
    .eq('client_user_id', userId)
    .gte('created_at', periodStart)
    .in('status', ['active', 'uploading', 'completed']);
  if (!data) return 0;
  return data.reduce((sum, r) => sum + (Number(r.accepted_rows) || 0), 0);
}

export async function countClientRows(userId: string, periodStart: string): Promise<number> {
  if (!supabaseAdmin) return 0;

  const [baseJobs, hhJobs, searchJobs, yandexJobs, companiesExports] = await Promise.all([
    supabaseAdmin
      .from('base_constructor_jobs')
      .select('initial_row_count')
      .eq('user_id', userId)
      .gte('created_at', periodStart)
      .in('status', ['pending', 'processing', 'completed']),
    supabaseAdmin
      .from('parser_jobs')
      .select('total_parsed,total_found')
      .eq('user_id', userId)
      .eq('parser_type', 'hh_vacancies')
      .gte('created_at', periodStart)
      .in('status', ['pending', 'running', 'completed']),
    supabaseAdmin
      .from('search_parser_jobs')
      .select('total_results')
      .eq('user_id', userId)
      .gte('created_at', periodStart)
      .in('status', ['pending', 'running', 'completed']),
    supabaseAdmin
      .from('yandex_maps_jobs')
      .select('total_links,total_organizations')
      .eq('user_id', userId)
      .gte('created_at', periodStart)
      .in('status', ['pending', 'running', 'completed']),
    supabaseAdmin
      .from('client_companies_search_exports')
      .select('row_count')
      .eq('user_id', userId)
      .gte('created_at', periodStart),
  ]);

  const baseRows = (baseJobs.data ?? []).reduce(
    (sum, row) => sum + nonNegativeInt((row as { initial_row_count?: unknown }).initial_row_count),
    0,
  );
  const hhRows = (hhJobs.data ?? []).reduce((sum, row) => {
    const item = row as { total_parsed?: unknown; total_found?: unknown };
    return sum + Math.max(nonNegativeInt(item.total_parsed), nonNegativeInt(item.total_found));
  }, 0);
  const searchRows = (searchJobs.data ?? []).reduce(
    (sum, row) => sum + nonNegativeInt((row as { total_results?: unknown }).total_results),
    0,
  );
  const yandexRows = (yandexJobs.data ?? []).reduce((sum, row) => {
    const item = row as { total_links?: unknown; total_organizations?: unknown };
    return sum + Math.max(nonNegativeInt(item.total_organizations), nonNegativeInt(item.total_links));
  }, 0);
  const companiesRows = (companiesExports.data ?? []).reduce(
    (sum, row) => sum + nonNegativeInt((row as { row_count?: unknown }).row_count),
    0,
  );

  return baseRows + hhRows + searchRows + yandexRows + companiesRows;
}

export async function countClientEmailAccountsAndDomains(
  userId: string,
): Promise<{ emails: number; domains: number }> {
  const { supabaseInstantly } = await import('@/lib/supabaseInstantly');
  if (!supabaseInstantly) return { emails: 0, domains: 0 };

  const { data } = await supabaseInstantly
    .from('client_campaign_presets')
    .select('email_account_ids')
    .eq('client_user_id', userId)
    .maybeSingle();

  const ids = Array.isArray((data as { email_account_ids?: unknown } | null)?.email_account_ids)
    ? ((data as { email_account_ids?: unknown[] }).email_account_ids ?? [])
      .map((v) => String(v ?? '').trim())
      .filter(Boolean)
    : [];
  const domains = new Set<string>();
  for (const email of ids) {
    const at = email.lastIndexOf('@');
    if (at >= 0 && at < email.length - 1) domains.add(email.slice(at + 1).toLowerCase());
  }

  return { emails: ids.length, domains: domains.size };
}

export async function getClientTariffUsage(userId: string): Promise<ClientTariffUsageSummary> {
  const row = await getClientTariffRow(userId);
  const limits = resolveEffectiveLimits(row);
  const periodStart = getBillingPeriodStart(row);

  const [contacts, rows, chains, presetUsage] = await Promise.all([
    countClientContacts(userId, periodStart),
    countClientRows(userId, periodStart),
    countChains(userId, periodStart),
    countClientEmailAccountsAndDomains(userId),
  ]);

  const paymentMethodSaved = Boolean(row?.yookassa_payment_method_id);

  return {
    status: getClientStatus(row),
    tariff_type: row?.tariff_type ?? 'standard',
    limits,
    paid_at: row?.paid_at ?? null,
    paid_until: row?.paid_until ?? null,
    setup_until: row?.setup_until ?? null,
    billing_mode: row?.billing_mode ?? null,
    payment_locked: isPaymentLocked(row),
    auto_renew: row?.auto_renew === true,
    payment_method_saved: paymentMethodSaved,
    last_renewal_error: row?.last_renewal_error ?? null,
    period_start: periodStart,
    usage: {
      max_contacts: usageBucket(limits.max_contacts, contacts),
      max_rows: usageBucket(limits.max_rows, rows),
      max_chains_per_month: usageBucket(limits.max_chains_per_month, chains),
      max_domains: usageBucket(limits.max_domains, presetUsage.domains),
      max_emails: usageBucket(limits.max_emails, presetUsage.emails),
    },
  };
}

export async function countChains(userId: string, periodStart: string): Promise<number> {
  if (!supabaseAdmin) return 0;

  const [v1, v2] = await Promise.all([
    supabaseAdmin
      .from('email_sequence_runs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', periodStart)
      .in('status', ['completed', 'generating', 'generating_letters']),
    supabaseAdmin
      .from('email_sequence_v2_runs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', periodStart)
      .in('status', ['completed', 'generating_letters']),
  ]);

  return (v1.count ?? 0) + (v2.count ?? 0);
}
