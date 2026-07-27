/** @jest-environment node */

import { buildChainMaterialsMessage } from '@/lib/hypothesisEngine/prompts/chain';
import { buildVocabMessages } from '@/lib/hypothesisEngine/prompts/vocab';
import { buildTemplatePlanMessages } from '@/lib/hypothesisEngine/prompts/template';
import type { HeBaseAnalysisOutput } from '@/lib/hypothesisEngine/schemas';
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
