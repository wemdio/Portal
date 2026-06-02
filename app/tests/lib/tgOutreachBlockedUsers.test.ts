/**
 * @jest-environment node
 */
import {
  loadBlockedUserIds,
  addBlockedUser,
  removeBlockedUser,
  listBlockedUsers,
} from '@/lib/tgOutreach/blockedUsers';

interface DbCall {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  payload?: Record<string, unknown> | Record<string, unknown>[];
  filter: Record<string, unknown>;
  conflict?: string;
}

interface MockOpts {
  blockedRows?: { tg_user_id: number; tg_username?: string | null; reason?: string | null; created_at?: string }[];
  upsertResult?: { data?: unknown; error?: { message: string } | null };
  updateResult?: { data?: unknown; error?: { message: string } | null };
  deleteResult?: { data?: unknown; error?: { message: string } | null };
}

function makeMockDb(opts?: MockOpts) {
  const calls: DbCall[] = [];
  const blockedRows = opts?.blockedRows ?? [];

  const chain = (table: string) => {
    const ctx: DbCall = { table, op: 'select', filter: {} };
    let pushed = false;
    const pushOnce = () => { if (!pushed) { pushed = true; calls.push(ctx); } };

    const builder: Record<string, unknown> = {
      select: (..._args: unknown[]) => { ctx.op = 'select'; return builder; },
      insert: (data: Record<string, unknown> | Record<string, unknown>[]) => { ctx.op = 'insert'; ctx.payload = data; return builder; },
      update: (data: Record<string, unknown>) => { ctx.op = 'update'; ctx.payload = data; return builder; },
      upsert: (data: Record<string, unknown> | Record<string, unknown>[], onConflictOpts?: { onConflict?: string }) => {
        ctx.op = 'upsert';
        ctx.payload = data;
        if (onConflictOpts?.onConflict) ctx.conflict = onConflictOpts.onConflict;
        return builder;
      },
      delete: () => { ctx.op = 'delete'; return builder; },
      eq: (col: string, val: unknown) => { ctx.filter = { ...ctx.filter, [col]: val }; return builder; },
      order: (..._args: unknown[]) => builder,
      then: (resolve: (val: unknown) => void) => {
        pushOnce();
        if (table === 'tg_outreach_blocked_users' && ctx.op === 'select') {
          resolve({ data: blockedRows, error: null });
          return;
        }
        if (table === 'tg_outreach_blocked_users' && ctx.op === 'upsert') {
          resolve(opts?.upsertResult ?? { data: null, error: null });
          return;
        }
        if (table === 'tg_outreach_dialogs' && ctx.op === 'update') {
          resolve(opts?.updateResult ?? { data: null, error: null });
          return;
        }
        if (table === 'tg_outreach_blocked_users' && ctx.op === 'delete') {
          resolve(opts?.deleteResult ?? { data: null, error: null });
          return;
        }
        resolve({ data: [], error: null });
      },
    };
    return builder;
  };

  return { db: { from: (t: string) => chain(t) } as unknown, calls };
}

describe('tgOutreach blockedUsers helpers', () => {
  it('loadBlockedUserIds returns Set<number> filtered by user_id', async () => {
    const { db, calls } = makeMockDb({
      blockedRows: [{ tg_user_id: 1 }, { tg_user_id: 77700123 }],
    });

    const result = await loadBlockedUserIds(db as never, 'user-1');
    expect(result).toEqual(new Set([1, 77700123]));

    const select = calls.find(c => c.table === 'tg_outreach_blocked_users' && c.op === 'select');
    expect(select?.filter).toEqual({ user_id: 'user-1' });
  });

  it('loadBlockedUserIds returns empty set when no rows', async () => {
    const { db } = makeMockDb({ blockedRows: [] });
    const result = await loadBlockedUserIds(db as never, 'user-1');
    expect(result.size).toBe(0);
  });

  it('addBlockedUser upserts blocklist row + bulk-disables can_send for all dialogs of that tg_user_id', async () => {
    const { db, calls } = makeMockDb();

    await addBlockedUser(db as never, 'user-1', 77700123, 'spammer', 'fake auth code');

    const upsert = calls.find(c => c.table === 'tg_outreach_blocked_users' && c.op === 'upsert');
    expect(upsert).toBeDefined();
    expect(upsert?.payload).toMatchObject({
      user_id: 'user-1',
      tg_user_id: 77700123,
      tg_username: 'spammer',
      reason: 'fake auth code',
    });
    expect(upsert?.conflict).toBe('user_id,tg_user_id');

    const bulkUpdate = calls.find(c => c.table === 'tg_outreach_dialogs' && c.op === 'update');
    expect(bulkUpdate).toBeDefined();
    // Audit: помимо самого can_send=false проставляем changed_at/by/reason —
    // без них невозможно потом понять, можно ли безопасно вернуть can_send=true
    // через removeBlockedUser (см. ниже).
    expect(bulkUpdate?.payload).toMatchObject({
      can_send: false,
      can_send_changed_by: 'user-1',
      can_send_changed_reason: 'blocklist_add',
    });
    expect((bulkUpdate?.payload as Record<string, unknown>).can_send_changed_at).toEqual(expect.any(String));
    expect(bulkUpdate?.filter).toMatchObject({ tg_user_id: 77700123 });
  });

  it('addBlockedUser tolerates null username', async () => {
    const { db, calls } = makeMockDb();

    await addBlockedUser(db as never, 'user-1', 77700123, null);

    const upsert = calls.find(c => c.table === 'tg_outreach_blocked_users' && c.op === 'upsert');
    expect(upsert?.payload).toMatchObject({
      user_id: 'user-1',
      tg_user_id: 77700123,
      tg_username: null,
    });
  });

  it('addBlockedUser throws if upsert returns error', async () => {
    const { db } = makeMockDb({ upsertResult: { data: null, error: { message: 'rls denied' } } });
    await expect(addBlockedUser(db as never, 'user-1', 77700123, null)).rejects.toThrow(/rls denied/);
  });

  it('removeBlockedUser deletes by (user_id, tg_user_id)', async () => {
    const { db, calls } = makeMockDb();

    await removeBlockedUser(db as never, 'user-1', 77700123);

    const del = calls.find(c => c.table === 'tg_outreach_blocked_users' && c.op === 'delete');
    expect(del).toBeDefined();
    expect(del?.filter).toEqual({ user_id: 'user-1', tg_user_id: 77700123 });
  });

  it('removeBlockedUser ALSO restores can_send=true on dialogs that were disabled by THIS blocklist', async () => {
    // Симметрия с addBlockedUser. Без неё «отжать кнопку» в ЧС не возвращало
    // диалоги в писабельное состояние — баг был, чинится этим тестом.
    const { db, calls } = makeMockDb();

    await removeBlockedUser(db as never, 'user-1', 77700123);

    const restore = calls.find(c => c.table === 'tg_outreach_dialogs' && c.op === 'update');
    expect(restore).toBeDefined();
    expect(restore?.payload).toMatchObject({
      can_send: true,
      can_send_changed_by: 'user-1',
      can_send_changed_reason: 'blocklist_remove',
    });
    // Главное: восстанавливаем ТОЛЬКО те диалоги, которые этот же блоклист и
    // отключил. Если diaлог поставил «Не писать» воркер (USER_DEACTIVATED) —
    // unblocklisting не должен его трогать, потому что аккаунт всё ещё мёртв.
    expect(restore?.filter).toMatchObject({
      tg_user_id: 77700123,
      can_send_changed_reason: 'blocklist_add',
    });
  });

  it('removeBlockedUser still succeeds if dialog UPDATE fails (delete already happened)', async () => {
    // Restore — best-effort: запись из ЧС уже удалена, и пользователь видит
    // «успех». Если RLS/таймаут не дали обновить диалоги, мы логируем варнинг
    // в console, но не валим основной поток (иначе пользователь жмёт «убрать
    // из ЧС» ещё раз и получает ошибку, хотя запись из ЧС уже ушла).
    const { db } = makeMockDb({
      updateResult: { data: null, error: { message: 'rls denied' } },
    });
    await expect(removeBlockedUser(db as never, 'user-1', 77700123)).resolves.toBeUndefined();
  });

  it('listBlockedUsers returns array of full rows for user_id', async () => {
    const { db, calls } = makeMockDb({
      blockedRows: [
        { tg_user_id: 1, tg_username: 'spammer', reason: 'spam', created_at: '2026-04-01T00:00:00Z' },
        { tg_user_id: 2, tg_username: null, reason: null, created_at: '2026-04-02T00:00:00Z' },
      ],
    });

    const result = await listBlockedUsers(db as never, 'user-1');
    expect(result).toHaveLength(2);
    expect(result[0].tg_user_id).toBe(1);
    expect(result[1].tg_username).toBeNull();

    const select = calls.find(c => c.table === 'tg_outreach_blocked_users' && c.op === 'select');
    expect(select?.filter).toEqual({ user_id: 'user-1' });
  });
});
