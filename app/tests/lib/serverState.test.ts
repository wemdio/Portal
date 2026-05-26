/**
 * @jest-environment node
 *
 * Контракты serverState — load/save spreadsheet state на сервере с поддержкой
 * state_compressed (gzip+base64) + CAS на updated_at.
 *
 * Эти тесты ловят:
 *   - regress в decompress (если кто-то поломает gzip-handling — apply
 *     перестанет видеть данные новых юзеров);
 *   - regress в CAS-логике (если CAS уйдёт — пойдут lost updates с
 *     юзером работающим в spreadsheet'е во время email job'а);
 *   - regress в fallback на колонку `state` (нужен для совместимости
 *     со старыми записями до миграции 20260518_0001).
 */

import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
const gzipP = promisify(gzip);

// Mock supabaseAdmin до import'а тестируемого модуля
const supabaseState = {
  rows: new Map<string, {
    state: unknown;
    state_compressed: string | null;
    updated_at: string;
  }>(),
  updateResults: [] as Array<{ filter: Record<string, string>; patch: Record<string, unknown>; returned: unknown[] }>,
};

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (_table: string) => {
      let filters: Record<string, string> = {};
      let patch: Record<string, unknown> | null = null;
      const chain = {
        select: (_cols: string) => chain,
        update: (p: Record<string, unknown>) => { patch = p; return chain; },
        eq: (key: string, val: string) => { filters[key] = val; return chain; },
        maybeSingle: async () => {
          const row = supabaseState.rows.get(filters.user_id);
          if (!row) return { data: null, error: null };
          return { data: row, error: null };
        },
        // .select() в конце UPDATE возвращает массив затронутых.
        then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
          // Если это chain после .update().eq().eq().select() → UPDATE.
          if (patch !== null) {
            const userId = filters.user_id;
            const casUpdatedAt = filters.updated_at;
            const row = supabaseState.rows.get(userId);
            if (!row) {
              // Не найдено
              supabaseState.updateResults.push({ filter: filters, patch, returned: [] });
              return resolve({ data: [], error: null });
            }
            if (casUpdatedAt && row.updated_at !== casUpdatedAt) {
              // CAS conflict
              supabaseState.updateResults.push({ filter: filters, patch, returned: [] });
              return resolve({ data: [], error: null });
            }
            // Применяем
            const updated = { ...row, ...patch } as typeof row;
            supabaseState.rows.set(userId, updated);
            supabaseState.updateResults.push({
              filter: filters,
              patch,
              returned: [{ user_id: userId }],
            });
            return resolve({ data: [{ user_id: userId }], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  },
}));

import {
  loadCompressedState,
  saveCompressedStateWithCas,
} from '@/lib/spreadsheet/serverState';

beforeEach(() => {
  supabaseState.rows.clear();
  supabaseState.updateResults.length = 0;
});

async function makeCompressed(obj: unknown): Promise<string> {
  const json = JSON.stringify(obj);
  const buf = await gzipP(Buffer.from(json, 'utf-8'));
  return buf.toString('base64');
}

describe('loadCompressedState', () => {
  it('reads state_compressed (gzip+base64) когда оно есть', async () => {
    const sampleState = {
      version: 1,
      tabs: [{ id: 'tab1', name: 'Tab1', data: [['A', 'B'], ['x', 'y']] }],
      activeTabId: 'tab1',
    };
    supabaseState.rows.set('user1', {
      state: null,
      state_compressed: await makeCompressed(sampleState),
      updated_at: '2026-05-26T10:00:00Z',
    });

    const loaded = await loadCompressedState('user1');
    expect(loaded).not.toBeNull();
    expect(loaded!.state).toEqual(sampleState);
    expect(loaded!.loadedUpdatedAt).toBe('2026-05-26T10:00:00Z');
  });

  it('fallback на колонку state когда state_compressed отсутствует (старые записи)', async () => {
    const sampleState = {
      tabs: [{ id: 'tab1', name: 'Tab1', data: [['A']] }],
    };
    supabaseState.rows.set('user2', {
      state: sampleState,
      state_compressed: null,
      updated_at: '2026-05-20T10:00:00Z',
    });

    const loaded = await loadCompressedState('user2');
    expect(loaded).not.toBeNull();
    expect(loaded!.state).toEqual(sampleState);
  });

  it('возвращает null если строки юзера нет', async () => {
    const loaded = await loadCompressedState('ghost');
    expect(loaded).toBeNull();
  });

  it('обработка битого base64 — fallback на state, или null если и его нет', async () => {
    supabaseState.rows.set('user3', {
      state: null,
      state_compressed: '!!not base64!!',
      updated_at: '2026-05-26T10:00:00Z',
    });
    const loaded = await loadCompressedState('user3');
    expect(loaded).toBeNull(); // битое compressed + null state → null

    // Если есть валидный state как fallback — он должен подхватиться.
    supabaseState.rows.set('user4', {
      state: { tabs: [{ id: 'a', name: 'A', data: [['x']] }] },
      state_compressed: '!!corrupt!!',
      updated_at: '2026-05-26T10:00:00Z',
    });
    const loaded2 = await loadCompressedState('user4');
    expect(loaded2).not.toBeNull();
    expect(loaded2!.state.tabs[0].id).toBe('a');
  });
});

describe('saveCompressedStateWithCas', () => {
  it('успешный save: row не менялась с момента load → ok:true', async () => {
    supabaseState.rows.set('user1', {
      state: null,
      state_compressed: await makeCompressed({ tabs: [] }),
      updated_at: '2026-05-26T10:00:00Z',
    });

    const result = await saveCompressedStateWithCas(
      'user1',
      { tabs: [{ id: 't', name: 'T', data: [['A'], ['1']] }] },
      '2026-05-26T10:00:00Z',
    );
    expect(result.ok).toBe(true);

    // Проверяем что записалось compressed (state=null).
    const stored = supabaseState.rows.get('user1');
    expect(stored?.state).toBeNull();
    expect(stored?.state_compressed).toBeTruthy();
  });

  it('CAS conflict: row изменилась между load и save → ok:false reason:conflict', async () => {
    supabaseState.rows.set('user1', {
      state: null,
      state_compressed: await makeCompressed({ tabs: [] }),
      updated_at: '2026-05-26T10:00:00Z',
    });

    // Загрузили со staled updated_at, потом кто-то параллельно writed.
    supabaseState.rows.set('user1', {
      state: null,
      state_compressed: await makeCompressed({ tabs: [] }),
      updated_at: '2026-05-26T10:05:00Z', // обновилось
    });

    const result = await saveCompressedStateWithCas(
      'user1',
      { tabs: [{ id: 't', name: 'T', data: [['A']] }] },
      '2026-05-26T10:00:00Z', // staled
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('conflict');
  });

  it('not_found когда у юзера вообще нет строки в database_spreadsheet_states', async () => {
    const result = await saveCompressedStateWithCas(
      'ghost',
      { tabs: [] },
      '2026-05-26T10:00:00Z',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  it('круговой round-trip: save → load возвращает то что сохранили', async () => {
    supabaseState.rows.set('user1', {
      state: null,
      state_compressed: await makeCompressed({ tabs: [] }),
      updated_at: '2026-05-26T10:00:00Z',
    });
    const stateToSave = {
      version: 2,
      tabs: [
        { id: 't1', name: 'T1', data: [['col1', 'col2'], ['v1', 'v2']] },
      ],
      activeTabId: 't1',
    };
    const save = await saveCompressedStateWithCas('user1', stateToSave, '2026-05-26T10:00:00Z');
    expect(save.ok).toBe(true);

    const loaded = await loadCompressedState('user1');
    expect(loaded).not.toBeNull();
    expect(loaded!.state).toEqual(stateToSave);
  });
});
