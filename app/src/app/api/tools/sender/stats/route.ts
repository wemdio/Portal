import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';
import type { BounceKinds, DomainHealth } from '@/lib/sender/domainReputation';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PERIOD_DAYS: Record<string, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null };

type Counters = { reached: number; replied: number; bounced: number; leads: number };
type MailboxRow = Counters & {
  id: string; email: string; enabled: boolean; status: string; sent: number; failed: number;
  bounceKinds?: BounceKinds;
};
type DomainRow = Counters & {
  domain: string; mailboxes: number; sent: number; bounceKinds: BounceKinds; health: DomainHealth | null;
};

const domainOf = (email: string) => (email.toLowerCase().split('@')[1] ?? email.toLowerCase());

/**
 * Вкладка «Статистика» «Рассылки»: всё считает sender_stats_dashboard
 * (миграции 20260929_0050, 20261002_0010 — выбор кампании, 20261002_0020 —
 * причины отказов) одним вызовом, здесь — только период и разрез по доменам:
 * строк ящиков сотни, JS справляется. К домену приклеивается проверка DNS
 * (sender_domain_health) — из неё и счётчиков экран собирает репутацию.
 *
 * Период — скользящие сутки от текущего момента, а не календарные: «7 дней»
 * на экране значит последние 168 часов.
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.stats' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const period = req.nextUrl.searchParams.get('period') ?? '30d';
    if (!(period in PERIOD_DAYS)) return jsonError('Неизвестный период', 400);
    const days = PERIOD_DAYS[period];
    const since = days === null ? null : new Date(Date.now() - days * 86_400_000).toISOString();
    // ?campaign=<id> — одна кампания; без него — все сразу.
    const campaign = req.nextUrl.searchParams.get('campaign') || null;
    if (campaign && !UUID_RE.test(campaign)) return jsonError('Неизвестная кампания', 400);

    const { data, error } = await supabaseAdmin.rpc('sender_stats_dashboard', {
      p_since: since,
      p_campaign_id: campaign,
    });
    if (error) return jsonError(error.message, 500);

    const stats = data as { mailboxList: MailboxRow[] } & Record<string, unknown>;
    const byDomain = new Map<string, DomainRow>();
    const domainEntry = (domain: string): DomainRow => {
      const entry = byDomain.get(domain) ?? {
        domain, mailboxes: 0, sent: 0, reached: 0, replied: 0, bounced: 0, leads: 0, bounceKinds: {}, health: null,
      };
      byDomain.set(domain, entry);
      return entry;
    };
    for (const row of stats.mailboxList) {
      const entry = domainEntry(domainOf(row.email));
      entry.mailboxes += 1;
      entry.sent += row.sent;
      entry.reached += row.reached;
      entry.replied += row.replied;
      entry.bounced += row.bounced;
      entry.leads += row.leads;
      for (const [kind, n] of Object.entries(row.bounceKinds ?? {})) {
        const key = kind as keyof BounceKinds;
        entry.bounceKinds[key] = (entry.bounceKinds[key] ?? 0) + Number(n);
      }
    }

    // Репутация нужна и домену, который в периоде молчал: без выбранной
    // кампании показываем все домены включённых ящиков.
    if (!campaign) {
      const { data: enabled } = await supabaseAdmin.from('sender_mailboxes').select('email').eq('enabled', true);
      for (const row of enabled ?? []) {
        const domain = domainOf(String(row.email));
        if (!byDomain.has(domain)) domainEntry(domain);
      }
    }
    if (byDomain.size) {
      // Таблицы ещё нет (миграция не применена) — домены без проверки DNS.
      const { data: health } = await supabaseAdmin
        .from('sender_domain_health')
        .select('domain, checked_at, spf, dmarc, dkim_selector, blacklists, error')
        .in('domain', [...byDomain.keys()]);
      for (const row of (health ?? []) as unknown as DomainHealth[]) {
        const entry = byDomain.get(row.domain);
        if (entry) entry.health = row;
      }
    }

    return NextResponse.json({
      period,
      ...stats,
      domains: [...byDomain.values()].sort((a, b) => b.sent - a.sent),
    });
  });
}
