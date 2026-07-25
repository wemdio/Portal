/**
 * Manager notifications for the client domain-picking step.
 *
 * Mirrors the support-chat pattern (lib/clientSupport/notify.ts +
 * telegramAlert.ts): an in-portal bell row for every admin/technician plus a
 * fire-and-forget Telegram nudge so the manager actually sees it in time.
 *
 * Bell rows use type='info' with entity_type=null on purpose: the
 * notifications CHECK constraint (20260509_0001_create_client_support_chat.sql)
 * allows that combo without a new migration, and reusing 'support_message'
 * would let the support page auto-mark these as read.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { SUPPORT_MANAGER_ROLES } from '@/lib/clientSupport/notify';

const TG_FETCH_TIMEOUT_MS = 15_000;

export interface DomainSelectionNotifyArgs {
  /** Service-role supabase client — RLS is bypassed for the fanout writes. */
  db: SupabaseClient;
  clientUserId: string;
  /** Display name shown in the notification title (company or email). */
  clientDisplayName: string;
  /** Confirmed domains, e.g. ['a.ru', 'b.ru', 'c.online']. */
  domains: string[];
}

function buildBody(domains: string[]): string {
  return `Домены для покупки и настройки: ${domains.join(', ')}`;
}

/**
 * Insert one public.notifications row per active manager (admin/technician).
 * Non-blocking semantics: returns { inserted: 0 } instead of throwing when
 * there are no managers or the insert fails — the selection itself is saved.
 */
export async function notifyManagersOfDomainSelection(
  args: DomainSelectionNotifyArgs,
): Promise<{ inserted: number }> {
  const { db, clientUserId, clientDisplayName, domains } = args;

  const { data: managers, error } = await db
    .from('profiles')
    .select('id')
    .in('role', SUPPORT_MANAGER_ROLES);

  if (error || !managers || managers.length === 0) {
    return { inserted: 0 };
  }

  const rows = managers
    .filter((m) => (m as { id: string }).id !== clientUserId)
    .map((m) => ({
      user_id: (m as { id: string }).id,
      type: 'info',
      title: `${clientDisplayName}: выбраны домены для рассылки`,
      body: buildBody(domains),
      entity_type: null,
      entity_id: null,
    }));

  if (rows.length === 0) return { inserted: 0 };

  const { error: insertError } = await db.from('notifications').insert(rows);
  if (insertError) return { inserted: 0 };

  return { inserted: rows.length };
}

/* ─── Telegram ─────────────────────────────────────────────────────────── */

function getToken(): string {
  return (
    process.env.SUPPORT_ALERTS_TELEGRAM_BOT_TOKEN ||
    process.env.LEAD_ALERTS_TELEGRAM_BOT_TOKEN ||
    process.env.CHANGELOG_BOT_TOKEN ||
    ''
  );
}

function getPortalUrl(): string {
  return (process.env.SUPPORT_ALERTS_PORTAL_URL || process.env.PORTAL_PUBLIC_URL || process.env.NEXT_PUBLIC_SITE_URL || '')
    .trim()
    .replace(/\/+$/, '');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildDomainSelectionMessage(args: {
  clientDisplayName: string;
  domains: string[];
  clientUserId: string;
}): string {
  const lines: string[] = [
    '🌐 <b>Клиент выбрал домены</b>',
    '',
    `<b>Клиент:</b> ${escapeHtml(args.clientDisplayName)}`,
    `<b>Домены:</b> ${escapeHtml(args.domains.join(', '))}`,
    '',
    'Нужно купить и настроить (DNS, ящики, прогрев).',
  ];

  const base = getPortalUrl();
  if (base) {
    lines.push('');
    lines.push(`<a href="${escapeHtml(base)}/admin/clients/${escapeHtml(args.clientUserId)}">Открыть карточку клиента →</a>`);
  }

  return lines.join('\n');
}

/**
 * Telegram nudge into the same operator chat as support alerts. Never throws:
 * a TG outage must not fail the client's "confirm selection" request.
 */
export async function sendDomainSelectionTelegramAlert(args: {
  clientDisplayName: string;
  domains: string[];
  clientUserId: string;
}): Promise<{ sent: boolean; messageId: number | null }> {
  const token = getToken();
  const chatId = process.env.SUPPORT_ALERTS_TELEGRAM_CHAT_ID || '';
  if (!token || !chatId) {
    console.warn(
      `[domain-selection-telegram] skipped (token=${token ? 'set' : 'missing'}, chat=${chatId ? 'set' : 'missing'}). ` +
        'Set SUPPORT_ALERTS_TELEGRAM_CHAT_ID (token falls back to LEAD_ALERTS/CHANGELOG).',
    );
    return { sent: false, messageId: null };
  }

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: buildDomainSelectionMessage(args),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const threadId = Number(process.env.SUPPORT_ALERTS_TELEGRAM_THREAD_ID ?? '');
  if (Number.isFinite(threadId) && threadId > 0) body.message_thread_id = threadId;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TG_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { sent: false, messageId: null };

    const json = (await res.json()) as { ok: boolean; result?: { message_id?: number } };
    return { sent: json.ok, messageId: json.result?.message_id ?? null };
  } catch {
    return { sent: false, messageId: null };
  }
}
