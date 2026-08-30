import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Step3Content } from '@/components/vertical-engine-v2/engine/steps/Step3Content';
import type { VeChainDto } from '@/components/vertical-engine-v2/engine/api';
import type { VeVertical } from '@/lib/verticalEngineV2/types';

const mockEnginePatch = jest.fn();

jest.mock('@/components/vertical-engine-v2/engine/api', () => ({
  VE_API: '/api/tools/vertical-engine-v2',
  veEnginePatch: (...args: unknown[]) => mockEnginePatch(...args),
}));

const VERTICAL: VeVertical = {
  id: 'vertical-1',
  project_id: 'project-1',
  name: 'Частная медицина',
  summary: 'Коммерческие медицинские организации России',
  synonyms: [],
  potential_pct: 79,
  rank: 1,
  created_at: '2026-08-30T08:00:00.000Z',
  updated_at: '2026-08-30T08:00:00.000Z',
};

const CHAIN: VeChainDto = {
  id: 'chain-1',
  vertical_id: VERTICAL.id,
  language: 'ru',
  status: 'ready',
  tokens_used: 0,
  cost_usd: 0,
  created_at: '2026-08-30T08:00:00.000Z',
  updated_at: '2026-08-30T08:00:00.000Z',
  letters: [
    {
      subject: 'Идея для {{company}}',
      body: '{{first_name}}, здравствуйте.\n\nПокажем основной подход.',
      wait_days: 0,
      variants: [
        {
          subject: 'Другой повод для {{company}}',
          body: '{{first_name}}, добрый день.\n\nПокажем альтернативный подход.',
        },
      ],
    },
    {
      subject: null,
      body: '{{first_name}}, дополню цифрой.',
      wait_days: 3,
      variants: [],
    },
  ],
};

function renderStep() {
  const onGoToBase = jest.fn();
  const result = render(
    <Step3Content
      vertical={VERTICAL}
      chains={[CHAIN]}
      vocabs={[]}
      jobs={[]}
      dossiers={[]}
      onGenerateChain={jest.fn()}
      onGenerateVocab={jest.fn()}
      onGoToBase={onGoToBase}
      onBuildDossier={jest.fn()}
    />,
  );
  return { ...result, onGoToBase };
}

describe('<Step3Content /> Open Design structure', () => {
  beforeEach(() => {
    mockEnginePatch.mockReset();
  });

  it('uses text statuses and one hairline sheet instead of nested letter cards', () => {
    const { container } = renderStep();

    expect(screen.getByRole('tab', { name: /Цепочка писем готово/i })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel', {
      name: /Цепочка писем готово/i,
    });
    const sheet = panel.querySelector('.ve2-letter-sheet');
    expect(sheet).not.toBeNull();
    expect(sheet?.querySelectorAll(':scope > .ve2-letter')).toHaveLength(2);
    expect(sheet?.querySelector('.ve2-card')).toBeNull();
    expect(container).not.toHaveTextContent(`${VERTICAL.name}79%`);
    expect(within(panel).getByText(/Без темы: идёт следом за предыдущим/i)).toBeInTheDocument();
    expect(panel.querySelectorAll('.ve2-op').length).toBeGreaterThan(0);
  });

  it('switches the visible A/B draft locally and keeps the shared footer actions', async () => {
    const user = userEvent.setup();
    const { onGoToBase } = renderStep();
    const variants = screen.getByRole('group', { name: 'Вариант письма 1' });

    await user.click(within(variants).getByRole('button', { name: 'B' }));

    expect(screen.getByText(/Другой повод для/i)).toBeInTheDocument();
    expect(screen.getByText(/альтернативный подход/i)).toBeInTheDocument();
    expect(mockEnginePatch).not.toHaveBeenCalled();
    expect(screen.getByText(/2 из 6 · следующая пауза \+2 дня/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Далее: база/i }));
    expect(onGoToBase).toHaveBeenCalledTimes(1);
  });
});
