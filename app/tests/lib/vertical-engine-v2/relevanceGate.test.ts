/** @jest-environment node */

/**
 * Relevance gate contract for bases collected per hypothesis.
 *
 * The vertical is only the broad market boundary. A collected base belongs to
 * one concrete hypothesis, so the gate must judge rows against that narrower
 * audience without becoming aggressive when a required attribute is absent.
 */

const mockCallLLM = jest.fn();

jest.mock('@/lib/verticalEngineV2/llm', () => ({
  callLLMWithSchema: (...args: unknown[]) => mockCallLLM(...args),
  getVeModel: () => 'test-gate-model',
}));

import { findIrrelevantRows } from '@/lib/verticalEngineV2/relevanceGate';

type CoverageAwareGateResult = Awaited<ReturnType<typeof findIrrelevantRows>> & {
  /** Original row indices whose company group was not classified. */
  unchecked: Set<number>;
};

function sentPrompt(): string {
  const messages = mockCallLLM.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
  return messages.map((message) => message.content).join('\n');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCallLLM.mockResolvedValue({
    data: { irrelevant: [] },
    tokensUsed: 12,
    costUsd: 0.001,
  });
});

describe('findIrrelevantRows — selected hypothesis context', () => {
  it('judges RU rows against the exact hypothesis, not only the broad vertical', async () => {
    // Keep the red test runnable before the production signature grows: an
    // assigned variable may carry the future optional context structurally.
    const input = {
      rows: [
        {
          company: 'Санаторий Рассвет',
          website: 'rassvet.example',
          category: '86.90.4',
          vacancy_title: '',
        },
      ],
      verticalName: 'Частная медицина',
      verticalSummary: 'Коммерческие медицинские организации России',
      hypothesisTitle: 'Сети частных клиник',
      hypothesisDescription: 'Городские многопрофильные клиники с несколькими филиалами',
      language: 'ru' as const,
    };

    await findIrrelevantRows(input);

    const prompt = sentPrompt();
    expect(prompt).toContain('Частная медицина');
    expect(prompt).toContain('Сети частных клиник');
    expect(prompt).toContain('Городские многопрофильные клиники с несколькими филиалами');
    expect(prompt).toMatch(/гипотез/i);
    // A missing size/geo/trigger signal must stay fail-open rather than turn
    // every sparse directory row into a false negative.
    expect(prompt).toMatch(/сомневаешься[^\n]*оставляй/i);
  });

  it('carries the same hypothesis boundary into the EN gate', async () => {
    const input = {
      rows: [
        {
          company: 'General Wellness Resort',
          website: 'wellness.example',
          category: 'Hospitality',
          vacancy_title: '',
        },
      ],
      verticalName: 'Private healthcare',
      verticalSummary: 'Commercial healthcare providers in the US',
      hypothesisTitle: 'Multi-location outpatient clinic groups',
      hypothesisDescription: 'Urban operators with two or more outpatient locations',
      language: 'en' as const,
    };

    await findIrrelevantRows(input);

    const prompt = sentPrompt();
    expect(prompt).toContain('Private healthcare');
    expect(prompt).toContain('Multi-location outpatient clinic groups');
    expect(prompt).toContain('Urban operators with two or more outpatient locations');
    expect(prompt).toMatch(/hypothesis/i);
    expect(prompt).toMatch(/when in doubt[^\n]*keep/i);
  });

  it('keeps the vertical-only fallback for legacy bases without a hypothesis', async () => {
    await findIrrelevantRows({
      rows: [{ company: 'Клиника Альфа' }],
      verticalName: 'Частная медицина',
      verticalSummary: 'Коммерческие медицинские организации России',
      language: 'ru',
    });

    const prompt = sentPrompt();
    expect(prompt).toContain('Частная медицина');
    expect(prompt).not.toContain('Сети частных клиник');
  });
});

describe('findIrrelevantRows — company-level grouping', () => {
  it('checks one representative per company and fans its verdict out to every email row', async () => {
    mockCallLLM.mockResolvedValueOnce({
      // Indices are the original row indices of the group representatives.
      data: { irrelevant: [0, 2] },
      tokensUsed: 12,
      costUsd: 0.001,
    });

    const result = await findIrrelevantRows({
      rows: [
        {
          company: 'Клиника Альфа',
          website: 'alpha.test',
          email: 'one@alpha.test',
          inn: '7700000001',
        },
        {
          // Same legal entity despite different display fields: INN wins.
          company: 'Альфа, филиал',
          website: 'branch.alpha.test',
          email: 'two@alpha.test',
          inn: ' 7700000001 ',
        },
        {
          company: 'Клиника Бета',
          website: 'beta.test',
          email: 'one@beta.test',
          inn: '',
        },
        {
          // Without INN, normalized company + website is the fallback key.
          company: '  клиника бета  ',
          website: ' BETA.TEST ',
          email: 'two@beta.test',
        },
        {
          // A present INN takes priority over the matching fallback fields.
          company: 'Клиника Бета',
          website: 'beta.test',
          email: 'other@beta.test',
          inn: '9900000001',
        },
      ],
      verticalName: 'Частная медицина',
      language: 'ru',
    });

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect((sentPrompt().match(/"i":/g) ?? [])).toHaveLength(3);
    expect(sentPrompt()).not.toContain('Альфа, филиал');
    expect([...result.flagged]).toEqual([0, 1, 2, 3]);
  });
});

describe('findIrrelevantRows — fail-closed coverage', () => {
  it('returns every row of company groups beyond the default 3000-company limit as unchecked', async () => {
    const rows = Array.from({ length: 3_001 }, (_, index) => ({
      company: `Компания ${index}`,
      website: `company-${index}.test`,
      email: `first-${index}@company-${index}.test`,
      inn: String(7_700_000_000 + index),
    }));
    rows.push({
      // The whole company group is outside coverage, not just its representative.
      company: 'Компания 3000, второй адрес',
      website: 'company-3000.test',
      email: 'second-3000@company-3000.test',
      inn: String(7_700_000_000 + 3_000),
    });

    const result = await findIrrelevantRows({
      rows,
      verticalName: 'Частная медицина',
      language: 'ru',
    }) as CoverageAwareGateResult;

    expect(mockCallLLM).toHaveBeenCalledTimes(60);
    expect(result.flagged).toEqual(new Set());
    expect(result.unchecked).toEqual(new Set([3_000, 3_001]));
  });

  it.each(['malformed', 'failed'] as const)(
    'marks a %s LLM batch unchecked while preserving successful verdict fan-out',
    async (failureMode) => {
      mockCallLLM.mockResolvedValueOnce({
        data: { irrelevant: [0] },
        tokensUsed: 12,
        costUsd: 0.001,
      });
      if (failureMode === 'malformed') {
        mockCallLLM.mockResolvedValueOnce({
          data: { unexpected: true },
          tokensUsed: 7,
          costUsd: 0.0005,
        });
      } else {
        mockCallLLM.mockRejectedValueOnce(new Error('temporary gate failure'));
      }

      const rows = [
        {
          company: 'Клиника Альфа',
          website: 'alpha.test',
          email: 'one@alpha.test',
          inn: '7700000001',
        },
        {
          company: 'Альфа, второй адрес',
          website: 'branch.alpha.test',
          email: 'two@alpha.test',
          inn: '7700000001',
        },
        ...Array.from({ length: 50 }, (_, index) => ({
          company: `Клиника ${index + 1}`,
          website: `clinic-${index + 1}.test`,
          email: `mail@clinic-${index + 1}.test`,
          inn: String(7_800_000_001 + index),
        })),
      ];

      const result = await findIrrelevantRows({
        rows,
        verticalName: 'Частная медицина',
        language: 'ru',
      }) as CoverageAwareGateResult;

      expect(mockCallLLM).toHaveBeenCalledTimes(2);
      expect(result.flagged).toEqual(new Set([0, 1]));
      expect(result.unchecked).toEqual(new Set([51]));
    },
  );
});
