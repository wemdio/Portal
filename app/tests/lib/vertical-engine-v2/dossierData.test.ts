/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';

jest.mock('@/lib/companiesSearch/rpcSearch', () => ({
  searchCount: jest.fn(),
}));

jest.mock('@/lib/parsers/hhParser', () => ({
  fetchWithRetry: jest.fn(),
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: null,
}));

import { collectDossierCounters } from '@/lib/verticalEngineV2/dossierData';

function emptyHhResponse(): typeof fetch {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ found: 0, items: [] }),
  }) as unknown as typeof fetch;
}

const INPUT = {
  verticalName: 'Медицинская и стоматологическая практика',
  synonyms: ['частная медицина'],
  roleTitles: [],
};

describe('Vertical Engine v2 dossier directory counters', () => {
  it('uses the isolated stats RPC and reports unique companies separately from raw rows', async () => {
    const db = createMockSupabase({
      rpcHandlers: {
        ve_directory_segment_stats: (_params) => ({
          data: {
            directory_rows_total: 31_528,
            companies_unique_total: 28_553,
            companies_with_email: 22_990,
            companies_with_phone: 21_220,
            companies_with_any_contact: 27_104,
            matched_companies_with_email: 21_500,
            matched_companies_with_phone: 20_800,
            matched_companies_with_any_contact: 26_500,
          },
          error: undefined,
        }),
      },
    });

    const counters = await collectDossierCounters(INPUT, {
      supabase: db as unknown as SupabaseClient,
      fetchImpl: emptyHhResponse(),
    });

    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]).toEqual({
      fn: 've_directory_segment_stats',
      params: expect.objectContaining({
        p_okved_prefixes: expect.any(Array),
        p_include_ip: false,
      }),
    });
    expect(db.rpcCalls[0].params.p_okved_prefixes).toContain('86.2');
    // A weak stem overlap in «материалы, применяемые в медицинских целях»
    // must not pull pharmaceutical manufacturing into private healthcare.
    expect(db.rpcCalls[0].params.p_okved_prefixes).not.toContain('21');
    expect(db.rpcCalls[0].params.p_okved_prefixes).not.toContain('21.2');

    expect(counters).toEqual(expect.objectContaining({
      // Backward-compatible headline now has honest company semantics.
      companies_total: 28_553,
      directory_rows_total: 31_528,
      companies_unique_total: 28_553,
      companies_with_email: 22_990,
      companies_with_phone: 21_220,
      companies_with_any_contact: 27_104,
    }));
    expect(counters.companies_note).toMatch(/уникальн|ИНН/i);
  });

  it('fails safe when the v2 stats RPC is unavailable', async () => {
    const db = createMockSupabase({
      rpcHandlers: {
        ve_directory_segment_stats: () => ({
          data: null,
          error: { message: 'directory stats offline' },
        }),
      },
    });

    const counters = await collectDossierCounters(INPUT, {
      supabase: db as unknown as SupabaseClient,
      fetchImpl: emptyHhResponse(),
    });

    expect(counters).toEqual(expect.objectContaining({
      companies_total: null,
      directory_rows_total: null,
      companies_unique_total: null,
      companies_with_email: null,
      companies_with_phone: null,
      companies_with_any_contact: null,
    }));
    expect(counters.companies_note).toContain('directory stats offline');
  });

  it('fails safe instead of coercing malformed or partial counters to zero', async () => {
    const db = createMockSupabase({
      rpcHandlers: {
        ve_directory_segment_stats: () => ({
          data: {
            directory_rows_total: 100,
            companies_unique_total: null,
            companies_with_email: '',
            companies_with_phone: false,
            companies_with_any_contact: 80,
          },
          error: undefined,
        }),
      },
    });

    const counters = await collectDossierCounters(INPUT, {
      supabase: db as unknown as SupabaseClient,
      fetchImpl: emptyHhResponse(),
    });

    expect(counters).toEqual(expect.objectContaining({
      companies_total: null,
      directory_rows_total: null,
      companies_unique_total: null,
      companies_with_email: null,
      companies_with_phone: null,
      companies_with_any_contact: null,
    }));
    expect(counters.companies_note).toMatch(/некоррект/i);
  });
});
