/** @jest-environment node */

import { countVeTargetContacts, VE_TARGET_EMAILS_PER_COMPANY_DEFAULT } from '@/lib/verticalEngineV2/companyContactCap';
import { createCollectionTarget, withVeTargetComposition } from '@/lib/verticalEngineV2/collectionTarget';
import { describeReadyComposition } from '@/components/vertical-engine-v2/engine/collectionProgress';
import { getPreparationPresentation } from '@/components/vertical-engine-v2/engine/PreparationProgress';
import type { VeBaseSummary } from '@/components/vertical-engine-v2/engine/api';
import type { VeOutreachPreparation } from '@/lib/verticalEngineV2/outreachSetup';

// База 1a69cda6 «Энергетические компании», 16.09.2026: распределение адресов по
// 39 компаниям с прода (771 адрес, у первой 123). ИНН и почты подставные.
const ENERGY = [123, 80, 73, 69, 55, 41, 37, 36, 35, 31, 29, 27, 26, 12, 12, 11, 11, 10, 7, 6, 6,
  5, 5, 4, 3, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
const energyRows = ENERGY.flatMap((count, i) => Array.from({ length: count }, (_, k) => ({
  company: `Энергокомпания ${i + 1}`, website: `energy${i + 1}.test`, inn: `77010${String(i + 1).padStart(5, '0')}`,
  email: `m${k + 1}@energy${i + 1}.test`, _email_status: 'ok',
})));

describe('VE2 goal counts companies, not address density', () => {
  it('counts at most three addresses of a company toward a preview goal when the specialist set no limit', () => {
    expect(energyRows).toHaveLength(771);
    expect(VE_TARGET_EMAILS_PER_COMPANY_DEFAULT).toBe(3);
    const count = countVeTargetContacts(energyRows, { limit: null, mode: 'preview' });
    expect(count).toEqual({ counted: 92, companies: 39, perCompany: 3 });
    expect(count.counted).toBeLessThanOrEqual(39 * 3);
    // Почтовый домен компании не склеивает: без ИНН компания — это название и сайт.
    const noInn = [
      { company: 'Альфа', website: 'alpha.test', email: 'a1@mail.ru' }, { company: 'Альфа', website: 'alpha.test', email: 'a2@mail.ru' },
      { company: 'Альфа', website: 'alpha.test', email: 'a3@mail.ru' }, { company: 'Альфа', website: 'alpha.test', email: 'a4@mail.ru' },
      { company: 'Бета', website: 'beta.test', email: 'b1@mail.ru' },
    ];
    expect(countVeTargetContacts(noInn, { limit: null, mode: 'preview' })).toEqual({ counted: 4, companies: 2, perCompany: 3 });
  });

  it('keeps the old measure where it was: the specialist limit and daily supply count every ready row', () => {
    // С лимитом готовую базу уже выбрал сам лимит — засчитывается каждая её строка.
    expect(countVeTargetContacts(energyRows, { limit: 5, mode: 'preview' })).toEqual({ counted: 771, companies: 39, perCompany: 5 });
    // Испорченный лимит — не лимит; тогда действует правило по умолчанию.
    expect(countVeTargetContacts(energyRows, { limit: 0, mode: 'preview' }).counted).toBe(92);
    // Ежедневная поставка меряет объём отправки, а не охват.
    expect(countVeTargetContacts(energyRows, { limit: null, mode: 'supply' })).toEqual({ counted: 771, companies: 39, perCompany: null });
    expect(countVeTargetContacts([], { limit: null, mode: 'preview' })).toEqual({ counted: 0, companies: 0, perCompany: 3 });
  });

  it('records the composition next to the goal counter and drops stale address totals', () => {
    const base = { ...createCollectionTarget('preview'), ready_rows: 92 };
    const dense = withVeTargetComposition(base, { counted: 92, companies: 39, perCompany: 3 }, 771);
    expect(dense).toMatchObject({ ready_rows: 92, ready_companies: 39, ready_contacts: 771, counted_per_company: 3 });
    // Когда засчитаны все адреса, прежний итог «адресов больше» не переживает пересчёт.
    const plain = withVeTargetComposition(dense, { counted: 139, companies: 39, perCompany: 5 }, 139);
    expect(plain).toMatchObject({ ready_companies: 39 });
    expect(plain).not.toHaveProperty('ready_contacts');
    expect(plain).not.toHaveProperty('counted_per_company');
  });

  it('shows company composition and prepared status without a competing goal counter', () => {
    const target = withVeTargetComposition({ ...createCollectionTarget('preview'), ready_rows: 92, status: 'limited' as const,
      reason: 'Достигнут защитный предел кандидатов или раундов; цель ещё не набрана' },
    { counted: 92, companies: 39, perCompany: 3 }, 771);
    expect(describeReadyComposition(target)).toBe('Компаний: 39.');
    expect(describeReadyComposition({ ...target, ready_contacts: undefined, counted_per_company: undefined })).toBe('Компаний: 39.');
    // Старая запись без состава ничего не придумывает.
    expect(describeReadyComposition({ ...createCollectionTarget('preview'), ready_rows: 500 })).toBeNull();

    const preparation = { status: 'ready', base_id: 'b1' } as unknown as VeOutreachPreparation;
    const summary = { id: 'b1', status: 'analyzed', source: 'auto', created_at: '2026-09-23T00:00:00Z', vertical_id: 'v1',
      hypothesis_id: 'h1', filename: 'b1', row_count: 771, analysis: null, columns: [], sample_rows: [],
      collect_info: { collection_mode: 'preview', target_progress: target } } as unknown as VeBaseSummary;
    const state = getPreparationPresentation({ preparation, base: summary, jobs: [] });
    expect(state.title).toBe('База и письма готовы к согласованию');
    expect(state.description).toContain('Компаний: 39.');
    expect(state.canContinue).toBe(true);
  });
});
