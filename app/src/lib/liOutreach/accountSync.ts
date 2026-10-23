import type { SupabaseClient } from '@supabase/supabase-js';
import { UnipileClient } from '@/lib/liOutreach/unipileClient';

/**
 * Синхронизация LinkedIn-аккаунтов портала с Unipile: общий код для кнопки
 * «Синхронизировать» и для воркера (раз в 15 минут).
 *
 * Unipile — источник истины: аккаунты добавляют там, в портале их никто не
 * заводит руками. Поэтому:
 *  - аккаунт есть в Unipile → карточка создаётся/обновляется, статус сохраняется как есть
 *    (OK, CREDENTIALS — разлогинен, ERROR…);
 *  - аккаунта в Unipile больше нет → карточка удаляется;
 *  - дубль (тот же LinkedIn-профиль, а старая запись разлогинена) → лишняя карточка без
 *    кампаний удаляется.
 */

export interface AccountSyncResult {
  synced: number;
  removed: number;
  duplicates_removed: number;
  /** Удаление пропущено: ушло бы слишком много карточек разом — похоже на сбой Unipile. */
  delete_skipped: boolean;
}

interface Row {
  id: string;
  user_id: string;
  unipile_account_id: string;
}

type Log = (level: 'info' | 'warn' | 'error', message: string) => void;

/** Кто будет «владельцем» новых карточек, когда синк идёт без пользователя (воркер). */
async function fallbackOwner(db: SupabaseClient, rows: Row[]): Promise<string | null> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top) return top;
  const { data } = await db.from('li_campaigns').select('user_id').order('created_at', { ascending: true }).limit(1).maybeSingle();
  return (data as { user_id: string } | null)?.user_id ?? null;
}

export async function syncLiAccounts(
  db: SupabaseClient,
  opts: { userId?: string | null; log?: Log } = {},
): Promise<AccountSyncResult> {
  const log = opts.log ?? (() => {});
  const dsn = process.env.UNIPILE_DSN ?? '';
  const apiKey = process.env.UNIPILE_API_KEY ?? '';
  if (!dsn || !apiKey) throw new Error('UNIPILE_DSN / UNIPILE_API_KEY не заданы в env на сервере');

  // Ошибка Unipile бросает исключение раньше любых изменений в базе.
  const live = await new UnipileClient(dsn, apiKey).listAccounts();

  const { data: existingData, error: existingError } = await db
    .from('li_accounts')
    .select('id, user_id, unipile_account_id');
  if (existingError) throw new Error(existingError.message);
  const existing = (existingData ?? []) as Row[];
  const owner = opts.userId ?? (await fallbackOwner(db, existing));

  const syncedAt = new Date().toISOString();
  const liveIds = new Set<string>();
  let synced = 0;

  for (const acc of live) {
    const unipileId = String(acc.id ?? '');
    if (!unipileId) continue;
    liveIds.add(unipileId);

    const sources = Array.isArray(acc.sources) ? (acc.sources as Array<Record<string, unknown>>) : [];
    const status = String(sources[0]?.status ?? '').trim();
    const connParams = (acc.connection_params as Record<string, unknown>) ?? {};
    const im = (connParams.im as Record<string, unknown>) ?? {};
    const publicId = String(im.publicIdentifier ?? '');

    const patch = {
      name: String(acc.name ?? ''),
      is_active: status === 'OK',
      unipile_status: status || null,
      profile_url: publicId ? `https://www.linkedin.com/in/${publicId}` : null,
      headline: String((acc as Record<string, unknown>).headline ?? '') || null,
      last_synced_at: syncedAt,
    };
    const { data: updated } = await db.from('li_accounts').update(patch).eq('unipile_account_id', unipileId).select('id').maybeSingle();
    if (!updated) {
      if (!owner) {
        log('warn', `Аккаунт Unipile ${unipileId} не добавлен: некому назначить карточку`);
        continue;
      }
      await db.from('li_accounts').insert({ user_id: owner, unipile_account_id: unipileId, ...patch });
    }
    synced++;
  }

  // Ушедшие из Unipile. Пустой ответ и «сразу почти всё» — признак сбоя, а не реальных удалений.
  let removed = 0;
  let deleteSkipped = false;
  const stale = existing.filter((r) => !liveIds.has(String(r.unipile_account_id)));
  if (stale.length > 0) {
    const tooMany = live.length === 0 || (existing.length >= 4 && stale.length > existing.length / 2);
    if (tooMany) {
      deleteSkipped = true;
      log('warn', `Синхронизация LinkedIn: из Unipile «ушло» ${stale.length} из ${existing.length} аккаунтов — удаление пропущено, похоже на сбой`);
    } else {
      const { error } = await db.from('li_accounts').delete().in('id', stale.map((r) => r.id));
      if (error) throw new Error(error.message);
      removed = stale.length;
    }
  }

  // Дубли: один LinkedIn-профиль, а старая запись разлогинена. Удаляем лишние без кампаний.
  let duplicatesRemoved = 0;
  const { data: fresh } = await db.from('li_accounts').select('id, profile_url, is_active');
  const rows = (fresh ?? []) as Array<{ id: string; profile_url: string | null; is_active: boolean }>;
  const byProfile = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.profile_url) continue;
    const list = byProfile.get(r.profile_url) ?? [];
    list.push(r);
    byProfile.set(r.profile_url, list);
  }
  const groups = [...byProfile.values()].filter((g) => g.length > 1 && g.some((r) => r.is_active));
  if (groups.length > 0) {
    const [{ data: primary }, { data: extra }] = await Promise.all([
      db.from('li_campaigns').select('account_id').not('account_id', 'is', null),
      db.from('li_campaign_accounts').select('account_id'),
    ]);
    const used = new Set([...(primary ?? []), ...(extra ?? [])].map((r) => String((r as { account_id: string }).account_id)));
    const drop = groups.flatMap((g) => g.filter((r) => !r.is_active && !used.has(r.id)).map((r) => r.id));
    if (drop.length > 0) {
      const { error } = await db.from('li_accounts').delete().in('id', drop);
      if (error) throw new Error(error.message);
      duplicatesRemoved = drop.length;
    }
  }

  return { synced, removed, duplicates_removed: duplicatesRemoved, delete_skipped: deleteSkipped };
}
