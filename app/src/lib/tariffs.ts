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
    max_chains_per_month: 3,
    max_domains: 4,
    max_emails: 16,
  },
  pro: {
    max_contacts: 20_000,
    max_rows: 40_000,
    max_chains_per_month: 6,
    max_domains: 8,
    max_emails: 32,
  },
};

export const SETUP_DAYS = 3;

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
};

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
