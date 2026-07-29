/** @jest-environment node */

import { buildChainMaterialsMessage } from '@/lib/hypothesisEngine/prompts/chain';
import { buildHypothesesInstantMessages } from '@/lib/hypothesisEngine/prompts/hypotheses';
import { buildEvidenceMessages } from '@/lib/hypothesisEngine/prompts/evidence';
import { buildVocabMessages } from '@/lib/hypothesisEngine/prompts/vocab';
import { buildTemplatePlanMessages } from '@/lib/hypothesisEngine/prompts/template';
import { HeSiteProfileSchema, type HeBaseAnalysisOutput, type HeHypothesisCandidate } from '@/lib/hypothesisEngine/schemas';
import { selectPromptHypotheses } from '@/lib/hypothesisEngine/stages/chain';

const MARKER = '✓ ПОДТВЕЖДЕНО СПЕЦИАЛИСТОМ';

describe('selectPromptHypotheses — разметка специалиста', () => {
  it('исключает rejected, accepted идут первыми, порядок внутри групп сохраняется', () => {
    const rows = [
      { title: 'proposed-1', status: 'proposed' },
      { title: 'accepted-1', status: 'accepted' },
      { title: 'rejected-1', status: 'rejected' },
      { title: 'proposed-2', status: 'proposed' },
      { title: 'accepted-2', status: 'accepted' },
    ];
    const { list, fallbackUsed } = selectPromptHypotheses(rows);
    expect(list.map((r) => r.title)).toEqual(['accepted-1', 'accepted-2', 'proposed-1', 'proposed-2']);
    expect(fallbackUsed).toBe(false);
  });

  it('все rejected → откат к полному списку с флагом fallbackUsed (вход не бывает пустым)', () => {
    const rows = [
      { title: 'a', status: 'rejected' },
      { title: 'b', status: 'rejected' },
    ];
    const { list, fallbackUsed } = selectPromptHypotheses(rows);
    expect(list).toHaveLength(2);
    expect(fallbackUsed).toBe(true);
  });

  it('пустой вход → пустой список без флага (legacy-проекты без гипотез)', () => {
    expect(selectPromptHypotheses([])).toEqual({ list: [], fallbackUsed: false });
  });

  it('строки без status (legacy) считаются proposed и не исключаются', () => {
    const { list, fallbackUsed } = selectPromptHypotheses([
      { title: 'legacy' },
      { title: 'acc', status: 'accepted' },
      { title: 'rej', status: 'rejected' },
    ]);
    expect(list.map((r) => r.title)).toEqual(['acc', 'legacy']);
    expect(fallbackUsed).toBe(false);
  });
});

describe('промпты: маркер подтверждения в инжектируемом тексте', () => {
  it('chain: подтверждённая гипотеза получает маркер, обычная — нет', () => {
    const text = buildChainMaterialsMessage({
      language: 'ru',
      verticalName: 'HR-агентства',
      verticalSummary: 'сводка',
      synonyms: [],
      hypotheses: [
        { title: 'Подтверждённая', description: 'описание', potential_pct: 80, tier: 1, confirmed: true, evidence: [] },
        { title: 'Обычная', description: 'описание', potential_pct: 60, evidence: [] },
      ],
      briefText: '{}',
    });
    expect(text).toContain(`${MARKER} — Подтверждённая`);
    expect(text).toContain('[tier 1 · 80%]');
    expect(text).toContain('- [60%] Обычная');
  });

  it('vocab: подтверждённая гипотеза получает маркер', () => {
    const [system, user] = buildVocabMessages({
      verticalName: 'HR-агентства',
      verticalSummary: 'сводка',
      synonyms: [],
      hypotheses: [{ title: 'Подтверждённая', description: 'описание', tier: 2, confirmed: true }],
    });
    expect(user.content).toContain(`${MARKER} — Подтверждённая`);
    expect(user.content).toContain('[tier 2]');
    expect(system.content).toContain(MARKER);
  });

  it('template plan: блок гипотез инжектится только при наличии строк', () => {
    const baseAnalysis: HeBaseAnalysisOutput = {
      geo_distribution: [],
      industry_distribution: [],
      company_type_distribution: [],
      title_distribution: [],
      notable_segments: [],
      data_quality_notes: '',
      recommended_angles: [],
    };
    const chainLetters = [{ subject: 'Тема', body: 'Тело', wait_days: 0 }];

    const withHyps = buildTemplatePlanMessages({
      verticalName: 'HR-агентства',
      verticalSummary: 'сводка',
      chainLetters,
      baseAnalysis,
      columns: ['Имя'],
      hypotheses: [{ title: 'Подтверждённая', description: 'описание', confirmed: true }],
    });
    expect(withHyps[1].content).toContain('ГИПОТЕЗЫ ВЕРТИКАЛИ');
    expect(withHyps[1].content).toContain(`${MARKER} — Подтверждённая`);

    const legacy = buildTemplatePlanMessages({
      verticalName: 'HR-агентства',
      verticalSummary: 'сводка',
      chainLetters,
      baseAnalysis,
      columns: ['Имя'],
    });
    expect(legacy[1].content).not.toContain('ГИПОТЕЗЫ ВЕРТИКАЛИ');
    expect(legacy[1].content).not.toContain(MARKER);
  });
});

describe('промпты: обязательный fit_rationale («почему это рынок для клиента»)', () => {
  const profile = HeSiteProfileSchema.parse({ company_name: 'Польза', product_summary: 'Аутрич-агентство' });

  it('hypotheses: промпт требует цепочку ЛПР → цель → боль → оффер, формат и самопроверка содержат поле', () => {
    const [system, user] = buildHypothesesInstantMessages({
      profile,
      websiteUrl: 'https://polza.ru',
      brandCloud: [],
      competitors: [],
    });
    expect(system.content).toContain('fit_rationale');
    expect(system.content).toContain('ЛПР, по роли');
    expect(system.content).toContain('Тавтологии запрещены');
    expect(user.content).toContain('"fit_rationale"');
    expect(user.content).toContain('все четыре звена цепочки');
  });

  it('evidence: вердикт обязан сохранить/уточнить fit_rationale, цепочка кандидата инжектится в промпт', () => {
    const candidate: HeHypothesisCandidate = {
      tier: 2,
      title: 'HR-агентства',
      description: 'd',
      fit_rationale: 'Собственник HR-агентства → больше клиентов на подбор → нет канала лидов → аутрич-кампания под ключ',
      rationale: '',
      potential_pct: 40,
      search_queries: ['q'],
    };
    const [system, user] = buildEvidenceMessages({
      candidate,
      profile,
      allCandidateTitles: [candidate.title],
      sources: [],
      searchResults: [],
    });
    expect(system.content).toContain('fit_rationale');
    expect(user.content).toContain('"fit_rationale"');
    expect(user.content).toContain(candidate.fit_rationale);
  });
});
