/** @jest-environment node */

/**
 * ICP из брифа как ОГРАНИЧЕНИЕ генерации гипотез, а не как контекст.
 *
 * В живых брифах ЦА описана формально: размерная полка, отрасли, наблюдаемые
 * триггеры и прямой список «исключить» (у KOMMA — «компании до 250 сотрудников
 * без явной задачи, интеграторов вместо конечных заказчиков, действующих
 * клиентов»). Пока это часть общего блока брифа, движок может выдать вертикаль,
 * которую клиент запретил, и специалист заметит это только глазами.
 */

import { EMPTY_BRIEF_FIELDS } from '@/lib/clientBrief';

jest.mock('@/lib/verticalEngineV2/llm', () => ({
  callLLMWithSchema: jest.fn(),
  getVeModel: jest.fn(() => 'test-research-model'),
}));

import { callLLMWithSchema } from '@/lib/verticalEngineV2/llm';
import {
  compileClientBriefIcpForPrompt,
  parseClientBriefText,
  readClientBrief,
} from '@/lib/verticalEngineV2/clientBriefIntake';

const callLLMMock = callLLMWithSchema as unknown as jest.Mock;

const ICP_FROM_BRIEF = {
  include: ['Российские компании 250–3 000 сотрудников', 'несколько площадок и филиалов'],
  exclude: [
    'компании до 250 сотрудников без явной задачи',
    'интеграторы вместо конечных заказчиков',
    'действующие клиенты и активные сделки',
  ],
  size: '250–3 000 сотрудников, приоритет 500–3 000',
  geo: 'Россия',
  triggers: ['тендер на обновление портала/ВКС', 'вакансии по внутренним коммуникациям'],
  qualification: 'собеседник владеет задачей или влияет на решение',
};

function mockLlmOnce(payload: Record<string, unknown>) {
  callLLMMock.mockResolvedValueOnce({
    data: payload,
    tokensUsed: 100,
    costUsd: 0.001,
    promptTokens: 90,
    completionTokens: 10,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('parseClientBriefText — ICP', () => {
  it('extracts the audience frame the client set, including exclusions', async () => {
    mockLlmOnce({ fields: { ...EMPTY_BRIEF_FIELDS }, icp: ICP_FROM_BRIEF });

    const { brief } = await parseClientBriefText('ОПИСАНИЕ ЦЕЛЕВОЙ АУДИТОРИИ', { fileName: null });

    expect(brief.icp?.exclude).toEqual(
      expect.arrayContaining(['интеграторы вместо конечных заказчиков']),
    );
    expect(brief.icp?.size).toContain('250–3 000');
    expect(brief.icp?.triggers).toEqual(expect.arrayContaining(['тендер на обновление портала/ВКС']));
  });

  it('drops placeholder rows instead of storing them as constraints', async () => {
    mockLlmOnce({
      fields: { ...EMPTY_BRIEF_FIELDS },
      icp: { include: ['-', ''], exclude: ['в разработке'], size: '—', geo: '', triggers: [], qualification: '-' },
    });

    const { brief } = await parseClientBriefText('ОПИСАНИЕ ЦЕЛЕВОЙ АУДИТОРИИ', { fileName: null });

    expect(brief.icp).toBeNull();
  });

  it('survives a model answer without an icp block', async () => {
    mockLlmOnce({ fields: { ...EMPTY_BRIEF_FIELDS } });

    const { brief } = await parseClientBriefText('ОПИСАНИЕ КОМПАНИИ', { fileName: null });

    expect(brief.icp).toBeNull();
  });
});

describe('readClientBrief — обратная совместимость', () => {
  it('reads a brief stored before the icp field existed', () => {
    const brief = readClientBrief({
      brief: {
        client_brief: {
          fields: { company_description: 'Консалтинг' },
          missing: [],
          file_name: 'old.docx',
          uploaded_at: '2026-08-22T10:00:00.000Z',
        },
      },
    });

    expect(brief?.icp).toBeNull();
    expect(brief?.fields.company_description).toBe('Консалтинг');
  });
});

describe('compileClientBriefIcpForPrompt', () => {
  it('renders exclusions as a hard constraint, not a wish', () => {
    const block = compileClientBriefIcpForPrompt(ICP_FROM_BRIEF);

    expect(block).toContain('ИСКЛЮЧИТЬ');
    expect(block).toContain('интеграторы вместо конечных заказчиков');
    expect(block).toContain('250–3 000 сотрудников');
    expect(block).toContain('тендер на обновление портала/ВКС');
  });

  it('returns an empty string when the client set no frame', () => {
    expect(compileClientBriefIcpForPrompt(null)).toBe('');
  });
});
