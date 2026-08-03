/**
 * @jest-environment node
 *
 * proxyHealth.ts — единая точка работы со здоровьем прокси и автосвапом.
 * Покрытие фокусируется на трёх инвариантах:
 *
 * 1. recordProxyError должен уметь ставить cooldown ровно через N подряд
 *    ошибок (порог = CONSECUTIVE_ERROR_THRESHOLD, env-tunable). До порога —
 *    counter растёт, cooldown_until NULL. На пороге — cooldown появляется и
 *    cooldownSet=true в результате.
 *
 * 2. recordAccountProxyFailure должен помечать degraded на пороге
 *    DEGRADED_PROXY_FAILURE_THRESHOLD разных подряд провалов И ставить
 *    cooldown на сутки.
 *
 * 3. canAutoSwap — pre-check guards: свежий аккаунт, degraded, дневной лимит.
 *    Это чистая функция (без БД), поэтому проверяется напрямую.
 *
 * 4. findFreeProxy — должна (а) убрать прокси в cooldown, (б) убрать прокси
 *    уже привязанные к другим аккаунтам, (в) tie-break: меньше ошибок → дольше
 *    не использовался → выигрывает.
 *
 * Стиль мока повторяет tgOutreachBlockedUsers.test.ts: лайт-мок supabase с
 * пишущими call'ами в массив, без эмуляции SQL.
 */

import {
  canAutoSwap,
  recordProxyError,
  recordAccountProxyFailure,
  recordAccountSuccess,
  findFreeProxy,
  CONSECUTIVE_ERROR_THRESHOLD,
  DEGRADED_PROXY_FAILURE_THRESHOLD,
  ACCOUNT_FRESH_DAYS,
  MAX_SWAPS_PER_ACCOUNT_PER_DAY,
  PROXY_COOLDOWN_MINUTES,
  DEGRADED_COOLDOWN_HOURS,
} from '@/lib/tgOutreach/proxyHealth';

interface Call {
  table: string;
  op: 'select' | 'update';
  payload?: Record<string, unknown>;
  filter: Record<string, unknown>;
}

interface MockOpts {
  rows?: Record<string, Record<string, unknown>[]>;
}

function makeMockDb(opts?: MockOpts) {
  const calls: Call[] = [];
  const rows = opts?.rows ?? {};

  const chain = (table: string) => {
    const ctx: Call = { table, op: 'select', filter: {} };
    let pushed = false;
    let selectCols = '*';
    let orPredicate: string | null = null;
    let notFilter: { col: string; values: string[] } | null = null;
    const push = () => { if (!pushed) { pushed = true; calls.push(ctx); } };
    const filterRows = (src: Record<string, unknown>[]) => {
      return src.filter((r) => {
        for (const [k, v] of Object.entries(ctx.filter)) {
          if ((r as Record<string, unknown>)[k] !== v) return false;
        }
        if (notFilter) {
          const val = (r as Record<string, unknown>)[notFilter.col];
          if (val != null && notFilter.values.includes(String(val))) return false;
        }
        return true;
      });
    };
    void selectCols; void orPredicate;
    const b: Record<string, unknown> = {
      select: (cols?: string) => { ctx.op = 'select'; if (cols) selectCols = cols; return b; },
      update: (data: Record<string, unknown>) => { ctx.op = 'update'; ctx.payload = data; return b; },
      eq: (col: string, val: unknown) => { ctx.filter = { ...ctx.filter, [col]: val }; return b; },
      not: (col: string, op: string, raw: string) => {
        // .not('proxy_id', 'is', null) или .not('id', 'in', '("a","b")')
        if (op === 'is') {
          // exclude rows where col IS NULL — handled via filter
        } else if (op === 'in') {
          const values = raw.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
          notFilter = { col, values };
        }
        return b;
      },
      or: (pred: string) => { orPredicate = pred; return b; },
      maybeSingle: async () => {
        push();
        const src = rows[table] ?? [];
        const out = filterRows(src);
        return { data: out[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => void) => {
        push();
        if (ctx.op === 'update') {
          // mutate matching rows so subsequent selects see updates
          for (const r of filterRows(rows[table] ?? [])) {
            Object.assign(r, ctx.payload);
          }
          resolve({ data: null, error: null });
          return;
        }
        resolve({ data: filterRows(rows[table] ?? []), error: null });
      },
    };
    return b;
  };
  return { db: { from: (t: string) => chain(t) } as unknown, calls, rows };
}

describe('proxyHealth — recordProxyError', () => {
  it('increments consecutive_errors below threshold without cooldown', async () => {
    const { db } = makeMockDb({
      rows: {
        tg_outreach_proxies: [{ id: 'p1', consecutive_errors: 0, total_errors: 0 }],
      },
    });
    const r = await recordProxyError(db as never, 'p1', 'connect_timeout');
    expect(r.consecutiveErrors).toBe(1);
    expect(r.cooldownSet).toBe(false);
    expect(r.cooldownUntil).toBeNull();
  });

  it(`sets cooldown exactly at the ${CONSECUTIVE_ERROR_THRESHOLD}-th consecutive error`, async () => {
    const { db, rows } = makeMockDb({
      rows: {
        tg_outreach_proxies: [
          { id: 'p1', consecutive_errors: CONSECUTIVE_ERROR_THRESHOLD - 1, total_errors: 5 },
        ],
      },
    });
    const r = await recordProxyError(db as never, 'p1', 'getDialogs_hung');
    expect(r.consecutiveErrors).toBe(CONSECUTIVE_ERROR_THRESHOLD);
    expect(r.cooldownSet).toBe(true);
    expect(r.cooldownUntil).toBeTruthy();
    // Cooldown поставлен примерно через PROXY_COOLDOWN_MINUTES минут.
    const cooldownMs = new Date(r.cooldownUntil!).getTime() - Date.now();
    expect(cooldownMs).toBeGreaterThan((PROXY_COOLDOWN_MINUTES - 1) * 60_000);
    expect(cooldownMs).toBeLessThan((PROXY_COOLDOWN_MINUTES + 1) * 60_000);
    // В строке должно лежать cooldown_reason='auto_consecutive_errors',
    // чтобы UI мог отличить auto от ручного «Подавить».
    expect(rows.tg_outreach_proxies?.[0].cooldown_reason).toBe('auto_consecutive_errors');
  });

  it('records total_errors monotonically alongside consecutive', async () => {
    const { db, rows } = makeMockDb({
      rows: { tg_outreach_proxies: [{ id: 'p1', consecutive_errors: 0, total_errors: 100 }] },
    });
    await recordProxyError(db as never, 'p1', 'tcp_dead');
    expect(rows.tg_outreach_proxies?.[0].total_errors).toBe(101);
    expect(rows.tg_outreach_proxies?.[0].last_error_reason).toBe('tcp_dead');
  });

  it('returns zeros when the proxy row is missing (best-effort, no throw)', async () => {
    const { db } = makeMockDb({ rows: { tg_outreach_proxies: [] } });
    const r = await recordProxyError(db as never, 'missing', 'connect_timeout');
    expect(r).toEqual({ consecutiveErrors: 0, cooldownSet: false, cooldownUntil: null });
  });
});

describe('proxyHealth — recordAccountProxyFailure → degraded (только РАЗНЫЕ прокси)', () => {
  // Инцидент 03.08.2026 (TG_VBI): на свежих аккаунтах свап запрещён, прокси
  // всегда один и тот же — но счётчик рос на каждой ошибке и honest 30% брака
  // пула выбивал degraded «3 разных прокси не помогли» без единого свапа.
  // Новый контракт: провал засчитывается только если провалился ДРУГОЙ прокси,
  // чем в прошлый раз (last_failed_proxy_id).

  it(`marks account degraded when the ${DEGRADED_PROXY_FAILURE_THRESHOLD}-th DISTINCT proxy fails`, async () => {
    const { db, rows } = makeMockDb({
      rows: {
        tg_outreach_accounts: [
          {
            id: 'a1',
            consecutive_proxy_failures: DEGRADED_PROXY_FAILURE_THRESHOLD - 1,
            last_failed_proxy_id: 'p2',
          },
        ],
      },
    });
    const r = await recordAccountProxyFailure(db as never, 'a1', 'p3');
    expect(r.markedDegraded).toBe(true);
    expect(r.consecutiveProxyFailures).toBe(DEGRADED_PROXY_FAILURE_THRESHOLD);
    const upd = rows.tg_outreach_accounts?.[0] as Record<string, unknown>;
    expect(upd.degraded).toBe(true);
    expect(upd.degraded_reason).toBe('multiple_proxies_failed');
    // cooldown 24h примерно. Принимаем разлёт +- 1ч на медленный тест.
    const cooldownMs = new Date(upd.cooldown_until as string).getTime() - Date.now();
    expect(cooldownMs).toBeGreaterThan((DEGRADED_COOLDOWN_HOURS - 1) * 3600 * 1000);
  });

  it('repeat failure on the SAME proxy does not increment and never degrades', async () => {
    // Точный сценарий инцидента: свежий аккаунт, свап запрещён, один прокси
    // моргает N раз подряд. Счётчик не должен дорасти до порога никогда.
    const { db, rows } = makeMockDb({
      rows: {
        tg_outreach_accounts: [
          {
            id: 'a1',
            consecutive_proxy_failures: DEGRADED_PROXY_FAILURE_THRESHOLD - 1,
            last_failed_proxy_id: 'p1',
          },
        ],
      },
    });
    const r = await recordAccountProxyFailure(db as never, 'a1', 'p1');
    expect(r.markedDegraded).toBe(false);
    expect(r.consecutiveProxyFailures).toBe(DEGRADED_PROXY_FAILURE_THRESHOLD - 1);
    const upd = rows.tg_outreach_accounts?.[0] as Record<string, unknown>;
    expect(upd.degraded).toBeUndefined();
    expect(upd.consecutive_proxy_failures).toBe(DEGRADED_PROXY_FAILURE_THRESHOLD - 1);
  });

  it('first failure ever increments to 1 and remembers which proxy failed', async () => {
    const { db, rows } = makeMockDb({
      rows: {
        tg_outreach_accounts: [
          { id: 'a1', consecutive_proxy_failures: 0, last_failed_proxy_id: null },
        ],
      },
    });
    const r = await recordAccountProxyFailure(db as never, 'a1', 'p1');
    expect(r.markedDegraded).toBe(false);
    expect(r.consecutiveProxyFailures).toBe(1);
    const upd = rows.tg_outreach_accounts?.[0] as Record<string, unknown>;
    expect(upd.last_failed_proxy_id).toBe('p1');
    expect(upd.degraded).toBeUndefined();
  });

  it('recordAccountSuccess resets both the counter and last_failed_proxy_id', async () => {
    // Без сброса last_failed_proxy_id повторный провал того же прокси после
    // успешного круга не засчитался бы вообще — счётчик застрял бы на 0.
    const { db, rows } = makeMockDb({
      rows: {
        tg_outreach_accounts: [
          { id: 'a1', consecutive_proxy_failures: 2, last_failed_proxy_id: 'p2' },
        ],
      },
    });
    await recordAccountSuccess(db as never, 'a1');
    const upd = rows.tg_outreach_accounts?.[0] as Record<string, unknown>;
    expect(upd.consecutive_proxy_failures).toBe(0);
    expect(upd.last_failed_proxy_id).toBeNull();

    const r = await recordAccountProxyFailure(db as never, 'a1', 'p2');
    expect(r.consecutiveProxyFailures).toBe(1);
  });
});

describe('proxyHealth — canAutoSwap guards', () => {
  const oldEnough = new Date(Date.now() - (ACCOUNT_FRESH_DAYS + 1) * 24 * 3600 * 1000).toISOString();

  it('OK for mature account, not degraded, no swap history', () => {
    const res = canAutoSwap({
      created_at: oldEnough,
      degraded: false,
      last_proxy_swap_at: null,
      proxy_swaps_today: 0,
    });
    expect(res).toEqual({ ok: true });
  });

  it('refuses degraded accounts', () => {
    const res = canAutoSwap({
      created_at: oldEnough,
      degraded: true,
      last_proxy_swap_at: null,
      proxy_swaps_today: 0,
    });
    expect(res).toEqual({ ok: false, reason: 'account_degraded' });
  });

  it('refuses fresh accounts (< ACCOUNT_FRESH_DAYS)', () => {
    const fresh = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    const res = canAutoSwap({
      created_at: fresh,
      degraded: false,
      last_proxy_swap_at: null,
      proxy_swaps_today: 0,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/account_too_fresh/);
  });

  it('refuses when daily limit reached today', () => {
    const res = canAutoSwap({
      created_at: oldEnough,
      degraded: false,
      last_proxy_swap_at: new Date().toISOString(),
      proxy_swaps_today: MAX_SWAPS_PER_ACCOUNT_PER_DAY,
    });
    expect(res).toEqual({ ok: false, reason: 'daily_limit_reached' });
  });

  it('does NOT refuse when last swap was yesterday — counter is logically zero', () => {
    const yesterday = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    const res = canAutoSwap({
      created_at: oldEnough,
      degraded: false,
      last_proxy_swap_at: yesterday,
      // stale counter from yesterday — pre-check still passes (RPC reset it).
      proxy_swaps_today: MAX_SWAPS_PER_ACCOUNT_PER_DAY,
    });
    expect(res).toEqual({ ok: true });
  });
});

describe('proxyHealth — findFreeProxy selection', () => {
  // Все mock-rows должны иметь is_active=true и cooldown_until=null/прошлое,
  // чтобы попасть в первичный отбор. Tie-break: total_errors ASC, last_used_at ASC.
  it('returns proxy with the LOWEST total_errors (tie-broken by last_used_at)', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const lastWeek = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { db } = makeMockDb({
      rows: {
        tg_outreach_proxies: [
          { id: 'p_good', campaign_id: 'c1', is_active: true, cooldown_until: null, total_errors: 0, total_uses: 5, last_used_at: yesterday, url: 'http://good' },
          { id: 'p_old',  campaign_id: 'c1', is_active: true, cooldown_until: null, total_errors: 0, total_uses: 2, last_used_at: lastWeek, url: 'http://old' },
          { id: 'p_bad',  campaign_id: 'c1', is_active: true, cooldown_until: null, total_errors: 50, total_uses: 100, last_used_at: yesterday, url: 'http://bad' },
        ],
        tg_outreach_accounts: [],
      },
    });
    const r = await findFreeProxy(db as never, 'c1');
    // Same total_errors=0, but p_old was used longer ago → win
    expect(r?.id).toBe('p_old');
  });

  it('excludes proxies already assigned to other accounts (1:1 model)', async () => {
    const { db } = makeMockDb({
      rows: {
        tg_outreach_proxies: [
          { id: 'p1', campaign_id: 'c1', is_active: true, cooldown_until: null, total_errors: 0, last_used_at: null, url: 'http://p1' },
          { id: 'p2', campaign_id: 'c1', is_active: true, cooldown_until: null, total_errors: 0, last_used_at: null, url: 'http://p2' },
        ],
        // p1 уже занят аккаунтом — должен быть пропущен
        tg_outreach_accounts: [{ id: 'a_other', campaign_id: 'c1', proxy_id: 'p1' }],
      },
    });
    const r = await findFreeProxy(db as never, 'c1');
    expect(r?.id).toBe('p2');
  });

  it('returns null when nothing left after filters', async () => {
    const { db } = makeMockDb({
      rows: {
        tg_outreach_proxies: [
          { id: 'p1', campaign_id: 'c1', is_active: true, cooldown_until: null, total_errors: 0, last_used_at: null, url: 'http://p1' },
        ],
        tg_outreach_accounts: [{ id: 'a_other', campaign_id: 'c1', proxy_id: 'p1' }],
      },
    });
    const r = await findFreeProxy(db as never, 'c1');
    expect(r).toBeNull();
  });

  it('excludes proxies passed in excludeProxyIds (caller already tried)', async () => {
    const { db } = makeMockDb({
      rows: {
        tg_outreach_proxies: [
          { id: 'p1', campaign_id: 'c1', is_active: true, cooldown_until: null, total_errors: 0, last_used_at: null, url: 'http://p1' },
          { id: 'p2', campaign_id: 'c1', is_active: true, cooldown_until: null, total_errors: 0, last_used_at: null, url: 'http://p2' },
        ],
        tg_outreach_accounts: [],
      },
    });
    const r = await findFreeProxy(db as never, 'c1', { excludeProxyIds: ['p1'] });
    expect(r?.id).toBe('p2');
  });
});
