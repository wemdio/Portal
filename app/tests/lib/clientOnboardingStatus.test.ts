/** @jest-environment node */

/**
 * Tests for computeOnboardingStatus — the pure backend logic that powers
 * the /client/dashboard onboarding checklist (Phase 3).
 *
 * The function returns 7 progress items in fixed order:
 *   brief → domains → preset → first_base → first_clean → first_sequence → first_launch
 *
 * Sources of truth (matches Phase 0 design doc):
 *   brief:          instantly schema → client_briefs.fields (any of the
 *                   three core fields: company_description, product_description,
 *                   target_audience must be non-empty)
 *   domains:        instantly schema → client_domain_selections row with
 *                   selected[] non-empty and its size === required_count
 *   preset:         instantly schema → client_campaign_presets row exists with
 *                   email_account_ids[].length > 0; if row exists with empty
 *                   array, blocked_reason mentions the manager
 *   first_base:     public schema   → ANY base_constructor_jobs row, OR
 *                   instantly schema → ANY client_campaign_launches row
 *   first_clean:    public schema   → base_constructor_jobs status='completed'
 *   first_sequence: public schema   → email_sequence_runs status='completed'
 *                   (draft rows are auto-created on tool open — don't count)
 *   first_launch:   instantly schema → client_campaign_launches status IN
 *                   ('active','paused','completed')
 *
 * The function does NOT touch the cache — the route handler does. Keeping
 * caching out of the unit under test makes assertions deterministic.
 */

import { computeOnboardingStatus } from '@/lib/clientOnboarding/checkStatus';

const USER_ID = 'user-A';

interface ChainState {
  table: string;
  eqCalls: Array<{ column: string; value: unknown }>;
}

const state = {
  rowsByTable: {} as Record<string, Array<Record<string, unknown>>>,
  callsByTable: {} as Record<string, number>,
};

function resetState() {
  state.rowsByTable = {};
  state.callsByTable = {};
}

function makeBuilder(table: string) {
  state.callsByTable[table] = (state.callsByTable[table] ?? 0) + 1;
  const local: ChainState = { table, eqCalls: [] };

  const finalize = () => {
    let rows = state.rowsByTable[table] ?? [];
    for (const eq of local.eqCalls) {
      rows = rows.filter((r) => r[eq.column] === eq.value);
    }
    return { data: rows, error: null, count: rows.length };
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    order: () => builder,
    limit: () => builder,
    eq: (column: string, value: unknown) => {
      local.eqCalls.push({ column, value });
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      const result = finalize();
      const filtered = result.data.filter((r) => values.includes(r[column]));
      // builder remains thenable so subsequent ops still work, but for our
      // simple aggregate queries we just override returned data.
      const inLocal = { ...local, eqCalls: [...local.eqCalls] };
      void inLocal;
      return Object.assign(builder, {
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: filtered, error: null, count: filtered.length }),
        maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
      });
    },
    maybeSingle: async () => {
      const result = finalize();
      return { data: result.data[0] ?? null, error: null };
    },
    single: async () => {
      const result = finalize();
      const first = result.data[0] ?? null;
      return { data: first, error: first ? null : { message: 'not found' } };
    },
    then: (resolve: (v: unknown) => void) => resolve(finalize()),
  };

  return builder;
}

function makeFakeClient() {
  return { from: (table: string) => makeBuilder(table) };
}

beforeEach(() => {
  resetState();
});

function callStatus() {
  return computeOnboardingStatus(USER_ID, {
    // The fake clients are typed loosely — the real impl only uses .from()
    // chains so the surface area we depend on is tiny.
    supabaseAdmin: makeFakeClient() as never,
    supabaseInstantly: makeFakeClient() as never,
  });
}

describe('computeOnboardingStatus', () => {
  it('all empty: returns 7 items, all done=false, complete=false, next=brief', async () => {
    const res = await callStatus();
    expect(res.items.map((i) => i.id)).toEqual([
      'brief',
      'domains',
      'preset',
      'first_base',
      'first_clean',
      'first_sequence',
      'first_launch',
    ]);
    expect(res.items.every((i) => i.done === false)).toBe(true);
    expect(res.complete).toBe(false);
    expect(res.next_id).toBe('brief');
  });

  it('only brief filled: brief done, next=domains', async () => {
    state.rowsByTable.client_briefs = [
      {
        client_user_id: USER_ID,
        fields: { product_description: 'CRM для строителей', company_description: '', target_audience: '' },
      },
    ];
    const res = await callStatus();
    expect(res.items.find((i) => i.id === 'brief')?.done).toBe(true);
    expect(res.items.find((i) => i.id === 'domains')?.done).toBe(false);
    expect(res.next_id).toBe('domains');
    expect(res.complete).toBe(false);
  });

  it('domains: selected size === required_count → done=true, otherwise false', async () => {
    // Неполный набор: 2 из 3 — шаг не закрыт.
    state.rowsByTable.client_domain_selections = [
      { client_user_id: USER_ID, selected: ['a.ru', 'b.ru'], required_count: 3 },
    ];
    const res = await callStatus();
    expect(res.items.find((i) => i.id === 'domains')?.done).toBe(false);

    // Полный набор — закрыт.
    state.rowsByTable.client_domain_selections = [
      { client_user_id: USER_ID, selected: ['a.ru', 'b.ru', 'c.online'], required_count: 3 },
    ];
    const res2 = await callStatus();
    expect(res2.items.find((i) => i.id === 'domains')?.done).toBe(true);
    expect(res2.items.find((i) => i.id === 'domains')?.href).toBeNull();
  });

  it('domains: preset already configured (legacy onboarding) → done=true even without a selections row', async () => {
    // Клиенты, онбордженные ДО появления шага domains: менеджер уже купил
    // домены вручную (пресет с email_account_ids), строки в
    // client_domain_selections нет. Шаг не должен «оживать» для них.
    state.rowsByTable.client_campaign_presets = [
      { client_user_id: USER_ID, email_account_ids: ['acc-1', 'acc-2'] },
    ];
    const res = await callStatus();
    expect(res.items.find((i) => i.id === 'domains')?.done).toBe(true);
  });

  it('brief row exists but ALL core fields empty → done=false', async () => {
    state.rowsByTable.client_briefs = [
      {
        client_user_id: USER_ID,
        fields: { company_description: '   ', product_description: '', target_audience: '\n' },
      },
    ];
    const res = await callStatus();
    expect(res.items.find((i) => i.id === 'brief')?.done).toBe(false);
  });

  it('preset configured (email_account_ids non-empty) → done=true', async () => {
    state.rowsByTable.client_campaign_presets = [
      { client_user_id: USER_ID, email_account_ids: ['acc-1', 'acc-2'] },
    ];
    const res = await callStatus();
    expect(res.items.find((i) => i.id === 'preset')?.done).toBe(true);
  });

  it('preset row exists but email_account_ids=[] → done=false + blocked_reason mentions manager', async () => {
    state.rowsByTable.client_campaign_presets = [
      { client_user_id: USER_ID, email_account_ids: [] },
    ];
    const res = await callStatus();
    const preset = res.items.find((i) => i.id === 'preset');
    expect(preset?.done).toBe(false);
    expect(preset?.blocked_reason ?? '').toMatch(/менеджер/i);
    expect(preset?.href).toBeNull();
  });

  it('first_base via base_constructor_jobs (no launches) → done=true', async () => {
    state.rowsByTable.base_constructor_jobs = [
      { user_id: USER_ID, status: 'pending' },
    ];
    const res = await callStatus();
    expect(res.items.find((i) => i.id === 'first_base')?.done).toBe(true);
  });

  it('first_base via client_campaign_launches (no jobs) → done=true', async () => {
    state.rowsByTable.client_campaign_launches = [
      { client_user_id: USER_ID, status: 'uploading' },
    ];
    const res = await callStatus();
    expect(res.items.find((i) => i.id === 'first_base')?.done).toBe(true);
  });

  it('first_clean requires status=completed; pending/processing/failed do NOT count', async () => {
    state.rowsByTable.base_constructor_jobs = [
      { user_id: USER_ID, status: 'pending' },
      { user_id: USER_ID, status: 'processing' },
      { user_id: USER_ID, status: 'failed' },
    ];
    const res = await callStatus();
    expect(res.items.find((i) => i.id === 'first_clean')?.done).toBe(false);

    state.rowsByTable.base_constructor_jobs.push({ user_id: USER_ID, status: 'completed' });
    const res2 = await callStatus();
    expect(res2.items.find((i) => i.id === 'first_clean')?.done).toBe(true);
  });

  it('first_sequence requires status=completed; draft does NOT count', async () => {
    // A draft run is auto-created the moment the client opens the email
    // sequence tool — it must not tick the checklist on its own.
    state.rowsByTable.email_sequence_runs = [
      { user_id: USER_ID, status: 'draft' },
    ];
    const res = await callStatus();
    expect(res.items.find((i) => i.id === 'first_sequence')?.done).toBe(false);

    state.rowsByTable.email_sequence_runs.push({ user_id: USER_ID, status: 'completed' });
    const res2 = await callStatus();
    expect(res2.items.find((i) => i.id === 'first_sequence')?.done).toBe(true);
  });

  it('first_sequence засчитывает completed из v2-таблицы (клиент пишет только в неё)', async () => {
    // Клиентский allowlist пускает только /api/tools/email-sequence-v2 —
    // реальный клиент физически не создаёт v1-run. Без учёта v2 шаг никогда
    // не завершался (пре-существующий баг, найден IA-верификацией 10.07).
    state.rowsByTable.email_sequence_v2_runs = [
      { user_id: USER_ID, status: 'extracting_values' },
    ];
    const res = await callStatus();
    expect(res.items.find((i) => i.id === 'first_sequence')?.done).toBe(false);

    state.rowsByTable.email_sequence_v2_runs.push({ user_id: USER_ID, status: 'completed' });
    const res2 = await callStatus();
    expect(res2.items.find((i) => i.id === 'first_sequence')?.done).toBe(true);
  });

  it('first_launch only counts active/paused/completed; uploading/failed do not', async () => {
    state.rowsByTable.client_campaign_launches = [
      { client_user_id: USER_ID, status: 'uploading' },
      { client_user_id: USER_ID, status: 'failed' },
    ];
    const res = await callStatus();
    expect(res.items.find((i) => i.id === 'first_launch')?.done).toBe(false);

    state.rowsByTable.client_campaign_launches.push({ client_user_id: USER_ID, status: 'active' });
    const res2 = await callStatus();
    expect(res2.items.find((i) => i.id === 'first_launch')?.done).toBe(true);
  });

  it('all 7 done → complete=true, next_id=null', async () => {
    state.rowsByTable.client_briefs = [
      { client_user_id: USER_ID, fields: { product_description: 'X', company_description: '', target_audience: '' } },
    ];
    state.rowsByTable.client_domain_selections = [
      { client_user_id: USER_ID, selected: ['a.ru', 'b.ru', 'c.online'], required_count: 3 },
    ];
    state.rowsByTable.client_campaign_presets = [
      { client_user_id: USER_ID, email_account_ids: ['acc-1'] },
    ];
    state.rowsByTable.base_constructor_jobs = [
      { user_id: USER_ID, status: 'completed' },
    ];
    state.rowsByTable.email_sequence_runs = [
      { user_id: USER_ID, status: 'completed' },
    ];
    state.rowsByTable.client_campaign_launches = [
      { client_user_id: USER_ID, status: 'active' },
    ];
    const res = await callStatus();
    expect(res.items.every((i) => i.done)).toBe(true);
    expect(res.complete).toBe(true);
    expect(res.next_id).toBeNull();
  });

  it('non-completed first_clean still allows first_launch to be done independently', async () => {
    state.rowsByTable.base_constructor_jobs = [];
    state.rowsByTable.client_campaign_launches = [
      { client_user_id: USER_ID, status: 'completed' },
    ];
    const res = await callStatus();
    expect(res.items.find((i) => i.id === 'first_clean')?.done).toBe(false);
    expect(res.items.find((i) => i.id === 'first_launch')?.done).toBe(true);
  });

  it('hrefs: brief / first_base / first_clean / first_sequence / first_launch point to client routes', async () => {
    const res = await callStatus();
    const itemHref = (id: string) => res.items.find((i) => i.id === id)?.href;
    expect(itemHref('brief')).toBe('/client/brief');
    // After Phase 4 consolidation, first_base points at the /client/build hub.
    expect(itemHref('first_base')).toBe('/client/build');
    expect(itemHref('first_clean')).toBe('/client/base-constructor');
    // July 2026 IA rework: «Цепочки писем» — своя страница (была табом парсеров).
    expect(itemHref('first_sequence')).toBe('/client/sequences');
    expect(itemHref('first_launch')).toBe('/client/launch');
  });
});
