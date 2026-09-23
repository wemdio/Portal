/** @jest-environment node */

/**
 * Сухой источник: последние ≥1 500 его компаний дали меньше 5 новых готовых
 * контактов (решение владельца 23.09.2026). Истории партий — с прода, проект
 * Когнитус: школы и РАС стояли сутками на картах и реестре с единицами
 * контактов, у Фондов карты — рабочий источник (2,6 %).
 */
import {
  chooseVeAdaptiveSource, finishVeAdaptiveBatch, newVeAdaptiveCollection, validVeAdaptiveCollection, veAdaptiveSourceDry,
  veDryLiveSources, veDrySourcesSummary, veReadyContactKeys, VE_DRY_SOURCE_MIN_COMPANIES, VE_DRY_SOURCE_MIN_CONTACTS,
  type VeAdaptiveCollection, type VeAdaptiveResult, type VeBatchSpend,
} from '@/lib/verticalEngineV2/adaptiveCollection';
import cognitus from './fixtures/cognitusAdaptiveBatches.json';

const spend: VeBatchSpend = { ai_usd: 0, serper_credits: 0, estimated_total_usd: 0, unknown_attempts: 0, complete: true };
const SOURCES: Record<string, string> = { r: 'companies_directory', m: 'yandex_maps', h: 'hh_live', g: 'google_maps' };
/** «m1 64 0, r1 100 1» → партии; ключ среза — `${base}:${срез}`. */
function cognitusBatches(base: 'schools' | 'ras' | 'funds'): VeAdaptiveResult[] {
  return cognitus[base].split(', ').map((item, index) => {
    const [slice, candidates, ready] = item.split(' ');
    return { id: `${base}-${index + 1}`, source_key: `${base}:${slice}`, source: SOURCES[slice[0]],
      candidates: Number(candidates), new_ready: Number(ready), poor: false, spend,
      started_at: '2026-09-22T05:00:00Z', finished_at: '2026-09-22T05:10:00Z' };
  });
}
const totals = (batches: VeAdaptiveResult[], key: string) => batches.filter((batch) => batch.source_key === key)
  .reduce((sum, batch) => ({ companies: sum.companies + batch.candidates, contacts: sum.contacts + batch.new_ready }),
    { companies: 0, contacts: 0 });

describe('сухой источник по фактическому выходу', () => {
  it('пороги: 1 500 компаний и 5 контактов', () => {
    expect(VE_DRY_SOURCE_MIN_COMPANIES).toBe(1_500);
    expect(VE_DRY_SOURCE_MIN_CONTACTS).toBe(5);
  });

  it('школы и РАС: карты и реестр с единицами контактов на тысячи компаний — сухие', () => {
    const schools = cognitusBatches('schools');
    expect(totals(schools, 'schools:m1')).toEqual({ companies: 3_100, contacts: 4 });
    // Судим по последним ≥1 500 компаниям среза, а не по всей истории.
    expect(veAdaptiveSourceDry(schools, 'schools:m1')).toEqual({ source_key: 'schools:m1', source: 'yandex_maps',
      companies: 1_568, contacts: 4 });
    const ras = cognitusBatches('ras');
    expect(veAdaptiveSourceDry(ras, 'ras:r1')).toMatchObject({ source: 'companies_directory', companies: 1_576, contacts: 1 });
    expect(veAdaptiveSourceDry(ras, 'ras:r3')).toMatchObject({ companies: 1_599, contacts: 0 });
    expect(veDrySourcesSummary([veAdaptiveSourceDry(ras, 'ras:r1')!, veAdaptiveSourceDry(ras, 'ras:r3')!,
      veAdaptiveSourceDry(schools, 'schools:m1')!]))
      .toBe('последние 3175 компаний из реестра дали 1 контакт; последние 1568 компаний из Яндекс Карт дали 4 контакта');
  });

  it('фонды: карты с выходом 2,6 % базу держат, реестр 3 786 → 0 сухой', () => {
    const funds = cognitusBatches('funds');
    expect(totals(funds, 'funds:m1')).toEqual({ companies: 1_814, contacts: 47 });
    expect(veAdaptiveSourceDry(funds, 'funds:m1')).toBeNull();
    expect(veAdaptiveSourceDry(funds, 'funds:r1')).toEqual({ source_key: 'funds:r1', source: 'companies_directory',
      companies: 1_586, contacts: 0 });
    // Живые карты и сухой реестр: база не сухая.
    expect(veDryLiveSources(funds, ['funds:r1', 'funds:m1'])).toBeNull();
    expect(veDryLiveSources(funds, ['funds:r1'])).toHaveLength(1);
    expect(veDryLiveSources(funds, [])).toBeNull();
  });

  it('не срабатывает на ранних партиях: меньше 1 500 компаний источника — не приговор', () => {
    // РАС: карты 1 049 компаний → 2 контакта. Мало, но ещё не доказано.
    const ras = cognitusBatches('ras');
    expect(totals(ras, 'ras:m1')).toEqual({ companies: 1_049, contacts: 2 });
    expect(veAdaptiveSourceDry(ras, 'ras:m1')).toBeNull();
    // Школы: второй запрос карт, 276 компаний без единого контакта.
    expect(veAdaptiveSourceDry(cognitusBatches('schools'), 'schools:m2')).toBeNull();
    const batch = (candidates: number, ready: number, index: number): VeAdaptiveResult => ({ id: `b${index}`, source_key: 'k',
      source: 'yandex_maps', candidates, new_ready: ready, poor: true, spend, started_at: '', finished_at: '' });
    const early = Array.from({ length: 15 }, (_, index) => batch(index < 14 ? 100 : 99, 0, index));
    expect(early.reduce((sum, item) => sum + item.candidates, 0)).toBe(1_499);
    expect(veAdaptiveSourceDry(early, 'k')).toBeNull();
    expect(veAdaptiveSourceDry([...early, batch(1, 0, 99)], 'k')).toMatchObject({ companies: 1_500, contacts: 0 });
    // Граница: четыре контакта на 1 500 — сухой, пять — нет.
    expect(veAdaptiveSourceDry([...early.slice(1), batch(101, 4, 99)], 'k')).toMatchObject({ contacts: 4 });
    expect(veAdaptiveSourceDry([...early.slice(1), batch(101, 5, 99)], 'k')).toBeNull();
  });

  it('сухой источник не выбирается для следующей партии (Фонды, партия 66)', () => {
    // Карты дали два бедных окна подряд (50 и 51 компания без контактов) и
    // попросили смену источника. Раньше выбор уходил на реестр, давший 0 из
    // 3 786, — так и шли 30 партий реестра подряд.
    const funds = cognitusBatches('funds');
    let state: VeAdaptiveCollection = { ...newVeAdaptiveCollection(), replan_attempts: 2, completed: funds.slice(0, 65),
      active_source: 'funds:m1' };
    const last = funds[65];
    expect(last).toMatchObject({ source_key: 'funds:m1', candidates: 50, new_ready: 0 });
    state = finishVeAdaptiveBatch({ ...state, pending: { id: last.id, source_key: last.source_key, source: last.source,
      candidates: last.candidates, ready_before: [], started_at: '2026-09-23T01:20:00Z' } }, [], spend);
    expect(state.replan_needed).toBe(true);
    expect(chooseVeAdaptiveSource(state, ['funds:r1', 'funds:m1'])).toBe('funds:m1');
    // Сухие все — выбирать не из чего.
    expect(chooseVeAdaptiveSource(state, ['funds:r1'])).toBeUndefined();
  });

  it('контакты считаются в единицах цели: лишние адреса одной компании источник не оживляют', () => {
    const company = (name: string, inn: string, boxes: string[]) => boxes.map((box) =>
      ({ company: name, inn, email: `${box}@${inn}.test`, _email_status: 'ok' }));
    const old = company('Центр Радуга', '7700000001', ['info', 'office']);
    const rows = [...old, ...company('Центр Радуга', '7700000001', ['hr', 'buh', 'zakupki']),
      ...company('Фонд Солнце', '7700000002', ['a', 'b', 'c', 'd', 'e', 'f'])];
    const pending = { id: 'p1', source_key: 'k', source: 'yandex_maps', candidates: 60,
      ready_before: veReadyContactKeys(old), started_at: '2026-09-23T00:00:00Z' };
    const capped = finishVeAdaptiveBatch({ ...newVeAdaptiveCollection(), pending }, rows, spend, undefined, 3).completed[0];
    // Радуге до цели не хватало одного адреса, Солнце даёт три из шести.
    expect(capped).toMatchObject({ new_ready: 9, new_target: 4 });
    expect(finishVeAdaptiveBatch({ ...newVeAdaptiveCollection(), pending }, rows, spend, undefined, null).completed[0])
      .toMatchObject({ new_ready: 9, new_target: 9 });

    // 1 500 компаний, из них одна компания с шестью адресами: в цель идут три — источник сухой.
    const dry = Array.from({ length: 14 }, (_, index): VeAdaptiveResult => ({ id: `d${index}`, source_key: 'k',
      source: 'yandex_maps', candidates: 100, new_ready: 0, new_target: 0, poor: true, spend, started_at: '', finished_at: '' }));
    const sixBoxes: VeAdaptiveResult = { ...dry[0], id: 'six', new_ready: 6, new_target: 3 };
    expect(veAdaptiveSourceDry([...dry, sixBoxes], 'k')).toMatchObject({ companies: 1_500, contacts: 3 });
    // Партии до правки поля new_target не имеют: считаем по адресам, как раньше.
    const legacy = { ...sixBoxes } as Partial<VeAdaptiveResult>;
    delete legacy.new_target;
    expect(veAdaptiveSourceDry([...dry, legacy as VeAdaptiveResult], 'k')).toBeNull();
  });

  it('сохранённое состояние до правки остаётся валидным', () => {
    const before = { ...newVeAdaptiveCollection(), replan_attempts: 2, completed: cognitusBatches('funds').slice(-100) };
    expect(before.completed.every((batch) => !('new_target' in batch))).toBe(true);
    expect(validVeAdaptiveCollection(before)).toBe(true);
    const after = finishVeAdaptiveBatch({ ...before, pending: { id: 'next', source_key: 'funds:m1', source: 'yandex_maps',
      candidates: 40, ready_before: [], started_at: '2026-09-23T10:00:00Z' } }, [], spend, undefined, 3);
    expect(after.completed.at(-1)).toMatchObject({ new_ready: 0, new_target: 0 });
    expect(validVeAdaptiveCollection(after)).toBe(true);
    expect(validVeAdaptiveCollection({ ...after, completed: [{ ...after.completed[0], new_target: -1 }] })).toBe(false);
  });
});
