import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { sealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { withToolTrace } from '@/lib/toolTrace';
import { readSeedProbesSince } from '@/lib/sender/seedBoxes';
import {
  SEED_PROVIDERS,
  isSeedProvider,
  parseSeedLine,
  parseSeedProxy,
  providerForEmail,
  type SeedProvider,
} from '@/lib/sender/seedBoxRules';

export const dynamic = 'force-dynamic';

const PUBLIC_COLUMNS = 'id, provider, email, imap_host, imap_port, enabled, status, last_error, checked_at, junk_folder, proxy_label, created_at';

/**
 * Контрольные ящики «Рассылки»: список (без паролей) и сводка проб по
 * сервисам за 7 дней. Спека: docs/superpowers/specs/2026-10-07-sender-seed-inbox-placement-design.md
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.seed_boxes.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
    const db = supabaseAdmin;

    const { data: boxes, error } = await db.from('sender_seed_boxes').select(PUBLIC_COLUMNS).order('provider').order('email');
    if (error) return jsonError(error.message, 500);

    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const probes = await readSeedProbesSince<{ seed_box_id: string | null; provider: string; status: string; day: string }>(
      weekAgo, 'seed_box_id, provider, status, day');
    const byBox = new Map<string, { inbox: number; spam: number; missing: number; total: number }>();
    const byProvider = new Map<string, { inbox: number; spam: number; missing: number; total: number }>();
    for (const row of probes) {
      for (const [map, key] of [[byBox, row.seed_box_id], [byProvider, row.provider]] as const) {
        if (!key) continue;
        const acc = map.get(key) ?? { inbox: 0, spam: 0, missing: 0, total: 0 };
        acc.total += 1;
        if (row.status === 'inbox' || row.status === 'spam' || row.status === 'missing') acc[row.status] += 1;
        map.set(key, acc);
      }
    }
    const empty = { inbox: 0, spam: 0, missing: 0, total: 0 };
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    return NextResponse.json({
      // Ежедневная проверка идёт, если со вчерашнего дня появились пробы.
      probesActive: probes.some((row) => row.day >= yesterday),
      boxes: (boxes ?? []).map((box) => ({ ...box, week: byBox.get(String(box.id)) ?? empty })),
      providers: (Object.keys(SEED_PROVIDERS) as SeedProvider[]).map((provider) => ({
        provider,
        label: SEED_PROVIDERS[provider].label,
        week: byProvider.get(provider) ?? empty,
      })),
    });
  });
}

/**
 * Добавить ящики. Два вида тела:
 *  - { provider?, email, password, imap_host? } — один ящик из формы;
 *  - { lines } — строки из выдачи продавца, по одной на ящик: адрес первым
 *    полем, пароль IMAP последним (lib/sender/seedBoxRules.ts → parseSeedLine);
 *    к ним необязательно { proxies } — по прокси на строку, по порядку ящиков,
 *    чтобы первый же вход шёл через прокси, а не с адреса сервера.
 * Вход не проверяется здесь: экран после добавления жмёт «Проверить» по
 * каждому, чтобы запрос не висел минуту на пачке.
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.seed_boxes.create' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);
    const db = supabaseAdmin;

    const body = (await req.json().catch(() => null)) as {
      provider?: unknown; email?: unknown; password?: unknown; imap_host?: unknown; lines?: unknown; proxies?: unknown;
    } | null;
    if (!body) return jsonError('Пустой запрос', 400);

    const entries: Array<{
      email: string; password: string; provider: SeedProvider | null; imapHost: string | null;
      proxy?: { url: string; label: string };
    }> = [];
    const skipped: string[] = [];
    if (typeof body.lines === 'string') {
      for (const raw of body.lines.split(/\r?\n/)) {
        if (!raw.trim()) continue;
        const parsed = parseSeedLine(raw);
        if (!parsed) {
          skipped.push(`${raw.trim().split(/[:;]/)[0].slice(0, 60)} — не разобрал строку`);
          continue;
        }
        entries.push({ ...parsed, provider: null, imapHost: null });
      }
    } else {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password.trim() : '';
      if (!email || !password) return jsonError('Укажите адрес и пароль приложения', 400);
      entries.push({
        email,
        password,
        provider: isSeedProvider(body.provider) ? body.provider : null,
        imapHost: typeof body.imap_host === 'string' && body.imap_host.trim() ? body.imap_host.trim() : null,
      });
    }
    if (!entries.length) return jsonError('Не нашёл ни одного ящика', 400);

    const proxyLines = typeof body.proxies === 'string'
      ? body.proxies.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : [];
    if (proxyLines.length) {
      if (proxyLines.length !== entries.length) {
        return jsonError(`Ящиков ${entries.length}, прокси ${proxyLines.length} — нужно по одному прокси на ящик`, 400);
      }
      const labels = new Set<string>();
      for (const [i, line] of proxyLines.entries()) {
        const proxy = parseSeedProxy(line);
        if (!proxy) return jsonError(`Не понял прокси в строке ${i + 1}. Пример: http://логин:пароль@1.2.3.4:8000`, 400);
        if (labels.has(proxy.label)) return jsonError(`Прокси ${proxy.label} повторяется — один прокси на один ящик`, 400);
        labels.add(proxy.label);
        entries[i].proxy = proxy;
      }
    }

    const rows: Record<string, unknown>[] = [];
    for (const entry of entries) {
      const provider = entry.provider ?? providerForEmail(entry.email);
      if (!provider) {
        skipped.push(`${entry.email} — не Яндекс, Gmail или Mail.ru`);
        continue;
      }
      rows.push({
        provider,
        email: entry.email,
        imap_host: entry.imapHost ?? SEED_PROVIDERS[provider].imapHost,
        imap_port: 993,
        imap_user: entry.email,
        secret_encrypted: sealMailboxSecret({ imapPassword: entry.password, proxyUrl: entry.proxy?.url }),
        proxy_label: entry.proxy?.label ?? null,
        created_by: auth.user.id,
      });
    }

    const created: Array<{ id: string; email: string }> = [];
    for (const row of rows) {
      const { data, error } = await db.from('sender_seed_boxes').insert(row).select('id, email').maybeSingle();
      if (error) {
        const duplicate = error.code === '23505'
          ? (error.message.includes('proxy') ? `прокси ${row.proxy_label} уже стоит на другом ящике` : 'уже добавлен')
          : error.message;
        skipped.push(`${row.email} — ${duplicate}`);
        continue;
      }
      if (data) created.push({ id: String(data.id), email: String(data.email) });
    }
    return NextResponse.json({ created, skipped });
  });
}
