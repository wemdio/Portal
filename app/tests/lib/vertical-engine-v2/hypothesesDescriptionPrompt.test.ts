/** @jest-environment node */

/**
 * По description гипотезы потом отбирают компании. Генератор писал рабочие
 * детали признаками покупателя («производители … с Меркурием», «фабрики …
 * со сменами, складами сырья и поставками в федеральные сети», «с наймом
 * рабочих»), и проверка релевантности откладывала компании нужного вида
 * деятельности, у которых этого нет на сайте.
 */
import { buildHypothesesInstantMessages, type HypothesesPromptInput } from '@/lib/verticalEngineV2/prompts/hypotheses';
import { buildHypothesesInstantMessagesEn } from '@/lib/verticalEngineV2/prompts/hypotheses.en';
import { VeHypothesesBatchSchema } from '@/lib/verticalEngineV2/schemas';
import { combineHypothesisCandidates } from '@/lib/verticalEngineV2/stages/hypotheses';
import { veEffectiveEvidenceVerdict, veEvidenceMergeTitles } from '@/lib/verticalEngineV2/stages/evidence';
import { evidenceInputHash, readEvidenceCheckpoint } from '@/lib/verticalEngineV2/evidenceCheckpoint';
import { applyClusteringDecisions } from '@/lib/verticalEngineV2/stages/clustering';

const input = {
  profile: { company: 'Клиент' }, websiteUrl: 'https://client.test', brandCloud: [], competitors: [],
} as unknown as HypothesesPromptInput;

describe('VE2 hypothesis description instructions', () => {
  it('keeps processes, tools, channels, hiring and headcount out of who the buyer is (RU)', () => {
    const [system, user] = buildHypothesesInstantMessages(input).map((message) => message.content);
    expect(system).toContain('Сначала — кто это: вид деятельности, тип компании');
    expect(system).toContain('явные условия отбора');
    expect(system).toContain('рабочие процессы, программы и госсистемы, регуляторику, склады, каналы продаж и найм НЕ пиши признаками компании');
    expect(system).toContain('Затем отдельной фразой — какую боль клиента решает продукт');
    // Size is ranking, not selection: the relevance check never sees the headcount.
    expect(system).toContain('Численность, выручку и объёмы тоже НЕ делай условием отбора');
    expect(system).not.toContain('если они нужны («сеть от 5 точек», «от 200 сотрудников»)');
    expect(user).toContain('процессы, системы, каналы, найм и численность — не признаки компании');
  });

  it('keeps processes, tools, channels, hiring and headcount out of who the buyer is (EN)', () => {
    const [system, user] = buildHypothesesInstantMessagesEn(input).map((message) => message.content);
    expect(system).toContain('First who they are: the activity, the company type');
    expect(system).toContain('explicit selection conditions');
    expect(system).toContain('do NOT write work processes, software and government systems, regulation, warehouses, sales channels or hiring as company attributes');
    expect(system).toContain('Do NOT make headcount, revenue or volume a selection condition either');
    expect(system).not.toContain('when needed ("chains of 5+ locations", "200+ employees")');
    expect(user).toContain('processes, systems, channels, hiring and headcount are not company attributes');
  });
});

/**
 * Широкие гипотезы уровня сектора для ежедневного добора (идея владельца
 * 23.09): узкие базы «Велл Медиа» (wellmedmarketing.ru) — «Медицинские
 * лаборатории», «Франшизы медклиник» — едва дотягивают до 500 и кончаются.
 * Широкие идут отдельным блоком в дополнение к узким и не должны отсеиваться
 * дальше как «слишком общие».
 */
describe('VE2 broad hypotheses', () => {
  const chain = 'Собственник клиники → поток пациентов → реклама дорожает → маркетинг под ключ → чек лечения окупает канал.';
  const narrow = (title: string, description: string, extra: Record<string, unknown> = {}) =>
    ({ tier: 2, title, description, fit_rationale: chain, rationale: 'Высокая стоимость пациента.', potential_pct: 55,
      search_queries: [`${title} рынок`], ...extra });
  const sector = (title: string, description: string) =>
    ({ title, description, fit_rationale: chain, rationale: 'Десятки тысяч организаций.', potential_pct: 60,
      search_queries: [`${title} число организаций`] });
  const MEDICINE = sector('Частная медицина', 'Частные клиники, медцентры, стоматологии, лаборатории и диагностические центры. Общая боль — пациент дорожает, а сарафан не масштабируется.');
  const DENTAL = sector('Стоматология', 'Стоматологические клиники и кабинеты. Боль — дорогой первичный пациент.');
  const response = {
    broad_hypotheses: [
      MEDICINE,
      // Название узкой гипотезы: гипотезы связываются с вертикалями по названию.
      sector('Санатории и реабилитация', 'Санатории, реабилитационные центры и профилактории.'),
      // Неполная широкая не валит дорогой ответ на 25–40 кандидатов.
      { title: 'Фармацевтика', description: 'Аптеки и дистрибьюторы лекарств.' },
      DENTAL,
    ],
    hypotheses: [
      narrow('Медицинские лаборатории', 'Лабораторные сети и частные пункты анализов с B2C и B2B-направлениями. Боль — удержание клиентов и продвижение пакетных исследований.'),
      narrow('Франшизы медклиник', 'Франчайзеры стоматологий, лабораторий, косметологий и медцентров, которым нужно привлекать франчайзи и пациентов точкам. Боль — двойная воронка.', { broad: true }),
      narrow('Санатории и реабилитация', 'Санатории и реабилитационные центры. Боль — загрузка номерного фонда вне сезона.'),
    ],
  };

  it('asks for 3–5 sector-level hypotheses in a separate block in addition to the narrow list (RU/EN)', () => {
    const [system, user] = buildHypothesesInstantMessages(input).map((message) => message.content);
    expect(system).toContain('ШИРОКИЕ ГИПОТЕЗЫ — ОТДЕЛЬНЫЙ БЛОК broad_hypotheses (3–5 штук, В ДОПОЛНЕНИЕ к основному списку');
    expect(system).toContain('Никаких условий отбора');
    expect(system).toContain('Каждая гипотеза основного списка hypotheses — КОНКРЕТНЫЙ сегмент');
    expect(user).toContain('"broad_hypotheses": [');
    const [systemEn, userEn] = buildHypothesesInstantMessagesEn(input).map((message) => message.content);
    expect(systemEn).toContain('BROAD HYPOTHESES — A SEPARATE broad_hypotheses BLOCK (3–5 of them, IN ADDITION to the main list');
    expect(userEn).toContain('"broad_hypotheses": [');
  });

  it('parses the sector block into flagged candidates ahead of the unchanged narrow ones', () => {
    const candidates = combineHypothesisCandidates(VeHypothesesBatchSchema.parse(response));
    expect(candidates.map((c) => [c.title, c.broad ?? false, c.tier])).toEqual([
      ['Частная медицина', true, 1], ['Стоматология', true, 1],
      ['Медицинские лаборатории', false, 2], ['Франшизы медклиник', false, 2], ['Санатории и реабилитация', false, 2],
    ]);
    // Ответ без блока (старый формат) разбирается как раньше.
    expect(combineHypothesisCandidates(VeHypothesesBatchSchema.parse({ hypotheses: response.hypotheses }))
      .map((c) => [c.title, c.broad ?? false])).toEqual([
      ['Медицинские лаборатории', false], ['Франшизы медклиник', false], ['Санатории и реабилитация', false]]);
    const many = Array.from({ length: 7 }, (_, n) => sector(`Сектор ${n}`, 'Все компании сектора.'));
    expect(combineHypothesisCandidates(VeHypothesesBatchSchema.parse({ ...response, broad_hypotheses: many }))
      .filter((c) => c.broad)).toHaveLength(5);
  });

  it('later stages keep them: evidence does not drop or fold them into narrow ones, clustering gives each its own vertical', () => {
    const candidates = combineHypothesisCandidates(VeHypothesesBatchSchema.parse(response));
    const [medicine, , labs] = candidates;
    expect(veEffectiveEvidenceVerdict(medicine, 'drop', undefined)).toBe('keep');
    expect(veEffectiveEvidenceVerdict(labs, 'drop', undefined)).toBe('drop');
    expect(veEffectiveEvidenceVerdict(medicine, 'merge', labs)).toBe('keep');
    expect(veEffectiveEvidenceVerdict(labs, 'merge', medicine)).toBe('keep');
    expect(veEffectiveEvidenceVerdict(medicine, 'merge', candidates[1])).toBe('merge');
    expect(veEffectiveEvidenceVerdict(labs, 'merge', candidates[3])).toBe('merge');
    expect(veEvidenceMergeTitles(candidates, medicine)).toEqual(['Частная медицина', 'Стоматология']);
    expect(veEvidenceMergeTitles(candidates, labs)).not.toContain('Частная медицина');

    // Возобновлённая проверка источниками не теряет признак.
    const hash = evidenceInputHash({ candidates });
    const checkpoint = readEvidenceCheckpoint({
      version: 1, input_hash: hash, next_index: 1, merged: 0, dropped: 0, evidence_dropped: 0,
      accepted: [{ tier: 1, title: medicine.title, description: medicine.description, fit_rationale: chain,
        evidence: [], seasonality: null, potential_pct: 20, broad: true }],
      usage: { tokensUsed: 0, costUsd: 0 }, today_moscow: '2026-09-23', portfolio_profile: null, markup_history: null,
    }, hash, candidates.length);
    expect(checkpoint?.accepted[0].broad).toBe(true);

    const verticals = applyClusteringDecisions(candidates, [{ name: 'Частные клиники', summary: '', synonyms: [],
      member_titles: ['Частная медицина', 'Медицинские лаборатории', 'Франшизы медклиник'] }]);
    expect(verticals.map((v) => v.memberTitles).sort()).toEqual([
      ['Медицинские лаборатории', 'Франшизы медклиник'], ['Санатории и реабилитация'], ['Стоматология'], ['Частная медицина'],
    ]);
  });
});
