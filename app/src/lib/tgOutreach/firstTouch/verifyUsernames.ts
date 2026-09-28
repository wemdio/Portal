/**
 * Фоновая проверка ников в базах — по t.me, до того как ник возьмёт аккаунт.
 *
 * Проверка во время рассылки (send.ts) ловит мёртвый ник только после того,
 * как аккаунт на нём споткнулся. Здесь те же ники проверяются заранее, сразу
 * после загрузки базы: ника нет — контакт уходит в `skipped` с причиной и до
 * аккаунтов не доходит вовсе. Тогда и хвоста из мёртвых ников, на котором
 * 24–28.09.2026 встали все аккаунты ATOL-1, в очереди не образуется.
 *
 * Порядок: сначала базы, включённые в кампании, — по ним скоро пойдут письма;
 * затем свежие невключённые, залитые за последний месяц: базу часто заливают
 * заранее, а галочку ставят потом. Старые брошенные базы не трогаем, пока их
 * снова не включат.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  checkUsernamesOnTme,
  NICK_MISSING_REASON,
  normalizeNick,
  shouldReportTmeDown,
  type TmeCheck,
} from '../usernameExists';

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

/** Ников за один заход: с паузами между запросами это около 20 секунд. */
const BATCH = 40;
/** Через сколько переспросить ник, про который t.me не ответил внятно. */
const RECHECK_UNKNOWN_MS = 60 * 60_000;
const FRESH_DAYS = 30;

interface ContactRow {
  id: string;
  base_id: string;
  username: string;
}

export interface VerifyOutcome {
  /** false — t.me недоступен или поменял вид страницы; ничего не записано. */
  working: boolean;
  checked: number;
  missing: number;
}

export async function verifyBaseUsernames(args: {
  db: SupabaseClient;
  log: LogFn;
  check?: (usernames: string[]) => Promise<TmeCheck>;
  batch?: number;
  now?: Date;
}): Promise<VerifyOutcome> {
  const { db, log } = args;
  const batch = args.batch ?? BATCH;
  const now = args.now ?? new Date();
  const retryBefore = new Date(now.getTime() - RECHECK_UNKNOWN_MS).toISOString();
  const freshSince = new Date(now.getTime() - FRESH_DAYS * 24 * 3600_000).toISOString();
  // Не проверяли вовсе — или t.me в прошлый раз не ответил внятно, и прошёл час.
  const notChecked = `username_checked_at.is.null,and(username_exists.is.null,username_checked_at.lt."${retryBefore}")`;

  const { data: links, error: linksErr } = await db
    .from('tg_outreach_campaign_bases')
    .select('base_id, campaign_id')
    .limit(2000);
  if (linksErr) {
    log('warning', `Проверка ников по t.me: не смог прочитать включённые базы — ${linksErr.message}`);
    return { working: true, checked: 0, missing: 0 };
  }
  const linkRows = (links ?? []) as Array<{ base_id: string; campaign_id: string }>;
  const linkedBaseIds = Array.from(new Set(linkRows.map((l) => l.base_id)));

  const rows: ContactRow[] = [];
  const seen = new Set<string>();
  let readError: string | null = null;
  const take = (found: { data: unknown; error: { message: string } | null }) => {
    if (found.error) {
      readError = found.error.message;
      return;
    }
    for (const r of (found.data ?? []) as ContactRow[]) {
      if (rows.length >= batch || seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(r);
    }
  };

  if (linkedBaseIds.length) {
    take(
      await db
        .from('tg_outreach_base_contacts')
        .select('id, base_id, username')
        .eq('status', 'pending')
        .in('base_id', linkedBaseIds)
        .or(notChecked)
        .order('created_at', { ascending: false })
        .limit(batch),
    );
  }
  if (rows.length < batch && !readError) {
    take(
      await db
        .from('tg_outreach_base_contacts')
        .select('id, base_id, username')
        .eq('status', 'pending')
        .gte('created_at', freshSince)
        .or(notChecked)
        .order('created_at', { ascending: false })
        .limit(batch),
    );
  }
  // Запускаемся раз в минуту — без этой заглушки не применённая миграция
  // (нет колонок проверки) сыпала бы одной и той же ошибкой в журнал воркера.
  if (readError) {
    if (shouldReportTmeDown('base-verifier-db')) {
      log('warning', `Проверка ников по t.me: не смог выбрать контакты — ${readError}`);
    }
    return { working: true, checked: 0, missing: 0 };
  }
  if (!rows.length) return { working: true, checked: 0, missing: 0 };

  const check = await (args.check ?? checkUsernamesOnTme)(rows.map((r) => r.username));
  // Проверка сломана — не пишем ничего: «не знаю» не повод ни выкидывать
  // контакт, ни отмечать его проверенным.
  if (!check.working) return { working: false, checked: 0, missing: 0 };

  const stamp = now.toISOString();
  const exists: string[] = [];
  const unknown: string[] = [];
  const missing: string[] = [];
  for (const r of rows) {
    const verdict = check.verdicts.get(normalizeNick(r.username)) ?? 'unknown';
    if (verdict === 'exists') exists.push(r.id);
    else if (verdict === 'missing') missing.push(r.id);
    else unknown.push(r.id);
  }

  const table = () => db.from('tg_outreach_base_contacts');
  if (exists.length) {
    await table().update({ username_checked_at: stamp, username_exists: true }).in('id', exists);
  }
  if (unknown.length) {
    await table().update({ username_checked_at: stamp, username_exists: null }).in('id', unknown);
  }

  let flipped: ContactRow[] = [];
  if (missing.length) {
    // `status = pending` в условии обязателен: между выборкой и записью круг
    // кампании мог успеть отправить этому контакту — отправленного не трогаем.
    const { data, error } = await table()
      .update({
        status: 'skipped',
        skip_reason: NICK_MISSING_REASON,
        username_checked_at: stamp,
        username_exists: false,
        updated_at: stamp,
      })
      .in('id', missing)
      .eq('status', 'pending')
      .select('id, base_id, username');
    if (error) {
      log('warning', `Проверка ников по t.me: не смог убрать несуществующие ники из очереди — ${error.message}`);
    } else {
      flipped = (data ?? []) as ContactRow[];
    }
  }

  if (flipped.length) await reportMissing(db, log, flipped, linkRows);
  return { working: true, checked: rows.length, missing: flipped.length };
}

/**
 * Сказать об убранных никах в журнале кампании — там, где оператор смотрит.
 *
 * Иначе база молча «похудеет»: было 250 в очереди, стало 240, и непонятно
 * почему. Пишем в кампанию-хозяйку базы и во все, где база включена.
 */
async function reportMissing(
  db: SupabaseClient,
  log: LogFn,
  flipped: ContactRow[],
  links: Array<{ base_id: string; campaign_id: string }>,
): Promise<void> {
  const byBase = new Map<string, string[]>();
  for (const r of flipped) byBase.set(r.base_id, [...(byBase.get(r.base_id) ?? []), r.username]);

  const { data: bases } = await db
    .from('tg_outreach_bases')
    .select('id, name, campaign_id')
    .in('id', Array.from(byBase.keys()));

  for (const base of (bases ?? []) as Array<{ id: string; name: string; campaign_id: string | null }>) {
    const nicks = byBase.get(base.id) ?? [];
    const sample = nicks.slice(0, 5).map((n) => `@${n}`).join(', ') + (nicks.length > 5 ? '…' : '');
    const message =
      `Проверка ников по t.me: в базе «${base.name}» нашлись несуществующие в Telegram ники — ${nicks.length} ` +
      `(${sample}). Убрал их из очереди, писать им не будем.`;
    log('info', message);

    const campaigns = new Set<string>(links.filter((l) => l.base_id === base.id).map((l) => l.campaign_id));
    if (base.campaign_id) campaigns.add(base.campaign_id);
    for (const campaignId of campaigns) {
      await db.from('tg_outreach_logs').insert({ campaign_id: campaignId, level: 'info', message });
    }
  }
}
