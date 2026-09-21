import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { spreadSchedule } from '@/lib/mail/sendSchedule';
import { requireByoMailboxClient } from '@/lib/byoMailbox/access';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/** Подстановка {{var}} из переменных получателя. */
function applyVars(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}

// Защита API от неограниченного массива recipients (случайная вставка огромного
// CSV или злонамеренный запрос) — не отражает реальный объём пилотной рассылки,
// просто верхняя граница одной постановки в очередь.
const MAX_CAMPAIGN_RECIPIENTS = 2000;

// Обычная syntax-валидация (не полный RFC 5322): один @, непустые local/domain,
// точка в домене, без пробелов. `!email.includes('@')` из старого кода пропускал
// откровенный мусор вроде "not-an-email@" или "@@" в очередь на отправку.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** GET — сводка по кампаниям (для статистики на странице). */
export async function GET(req: NextRequest) {
  const res = await requireByoMailboxClient(req);
  if ('error' in res) return res.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { data, error } = await supabaseAdmin
    .from('client_byo_messages')
    .select('campaign_name, status')
    .eq('client_user_id', res.auth.userId)
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const agg: Record<string, { pending: number; sent: number; failed: number; total: number }> = {};
  for (const r of data ?? []) {
    const key = (r.campaign_name as string) || '(без названия)';
    const c = (agg[key] ??= { pending: 0, sent: 0, failed: 0, total: 0 });
    c.total++;
    if (r.status === 'sent') c.sent++;
    else if (r.status === 'pending' || r.status === 'sending') c.pending++;
    else if (r.status === 'failed') c.failed++;
  }
  const campaigns = Object.entries(agg).map(([name, c]) => ({ name, ...c }));
  return NextResponse.json({ campaigns });
}

/** POST — поставить кампанию в очередь отправки. */
export async function POST(req: NextRequest) {
  const res = await requireByoMailboxClient(req);
  if ('error' in res) return res.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 });
  }

  const mailboxId = String(body.mailboxId ?? '');
  const campaignName = String(body.campaignName ?? '').trim() || 'Рассылка';
  const subject = String(body.subject ?? '').trim();
  const bodyTpl = String(body.body ?? '');
  const recipients = Array.isArray(body.recipients) ? (body.recipients as unknown[]) : [];

  if (!mailboxId) return NextResponse.json({ error: 'Выберите ящик' }, { status: 400 });
  if (!subject) return NextResponse.json({ error: 'Укажите тему' }, { status: 400 });
  if (!bodyTpl.trim()) return NextResponse.json({ error: 'Укажите текст письма' }, { status: 400 });
  if (!recipients.length) return NextResponse.json({ error: 'Добавьте получателей' }, { status: 400 });
  if (recipients.length > MAX_CAMPAIGN_RECIPIENTS) {
    return NextResponse.json(
      { error: `Слишком много получателей за один раз (максимум ${MAX_CAMPAIGN_RECIPIENTS}). Разбейте на несколько кампаний.` },
      { status: 400 },
    );
  }

  // Ящик принадлежит этому клиенту и подтверждён.
  const { data: mb } = await supabaseAdmin
    .from('client_mailbox_accounts')
    .select('id, status, daily_limit')
    .eq('id', mailboxId)
    .eq('client_user_id', res.auth.userId)
    .maybeSingle();
  if (!mb) return NextResponse.json({ error: 'Ящик не найден' }, { status: 404 });
  if (mb.status !== 'verified') {
    return NextResponse.json({ error: 'Ящик ещё не подтверждён' }, { status: 422 });
  }

  const rows: Record<string, unknown>[] = [];
  const seenEmails = new Set<string>(); // дедуп в рамках одной постановки кампании
  for (const raw of recipients) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const email = String(r.email ?? '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) continue;
    if (seenEmails.has(email)) continue;
    seenEmails.add(email);
    const name = String(r.name ?? '').trim();
    const vars: Record<string, string> = {};
    if (r.vars && typeof r.vars === 'object') {
      for (const [k, v] of Object.entries(r.vars as Record<string, unknown>)) vars[k] = String(v ?? '');
    }
    if (name) {
      vars.name ??= name;
      vars.first_name ??= name.split(/\s+/)[0] ?? '';
    }
    rows.push({
      client_user_id: res.auth.userId,
      mailbox_id: mailboxId,
      campaign_name: campaignName,
      to_email: email,
      to_name: name || null,
      subject: applyVars(subject, vars),
      body: applyVars(bodyTpl, vars),
      status: 'pending',
    });
  }

  if (!rows.length) {
    return NextResponse.json({ error: 'Нет валидных email среди получателей' }, { status: 400 });
  }

  // Время каждого письма считается здесь, а не воркером: случайные паузы,
  // рабочее окно и дневной лимит ящика. Раньше вся кампания вставала в очередь
  // одним временем, и воркер выгребал её пачкой с ровным интервалом — по такому
  // ритму холодную рассылку и опознают.
  const schedule = spreadSchedule({
    count: rows.length,
    dailyLimit: Number(mb.daily_limit ?? 0),
  });
  rows.forEach((row, index) => {
    row.scheduled_at = schedule[index].toISOString();
  });

  const { error } = await supabaseAdmin.from('client_byo_messages').insert(rows);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ queued: rows.length });
}
