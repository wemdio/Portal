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

function renderStep({
  chain = CHAIN,
  onGenerateChain = jest.fn(),
}: {
  chain?: VeChainDto;
  onGenerateChain?: jest.Mock;
} = {}) {
  const onGoToBase = jest.fn();
  const result = render(
    <Step3Content
      vertical={VERTICAL}
      chains={[chain]}
      vocabs={[]}
      jobs={[]}
      dossiers={[]}
      onGenerateChain={onGenerateChain}
      onGenerateVocab={jest.fn()}
      onGoToBase={onGoToBase}
      onBuildDossier={jest.fn()}
    />,
  );
  return { ...result, onGenerateChain, onGoToBase };
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

  it.each(['en', 'pl'] as const)(
    'synchronizes an existing %s chain language and regenerates in the same language',
    async (language) => {
      const user = userEvent.setup();
      const onGenerateChain = jest.fn();
      renderStep({
        chain: {
          ...CHAIN,
          id: `chain-${language}`,
          language,
        },
        onGenerateChain,
      });

      expect(screen.getByRole('combobox', { name: 'Язык цепочки' })).toHaveValue(language);

      await user.click(screen.getByRole('button', { name: 'Перегенерировать' }));

      expect(onGenerateChain).toHaveBeenCalledTimes(1);
      expect(onGenerateChain).toHaveBeenCalledWith(language);
    },
  );

  it('keeps every tabpanel title in the heading outline', async () => {
    const user = userEvent.setup();
    renderStep();

    for (const item of [
      { tab: /Цепочка писем/i, heading: /Цепочка писем/i },
      { tab: /Вокабуляр/i, heading: /Вокабуляр для сбора базы/i },
      { tab: /Досье/i, heading: /Досье вертикали/i },
    ]) {
      await user.click(screen.getByRole('tab', { name: item.tab }));
      const panel = screen.getByRole('tabpanel', { name: item.tab });
      expect(within(panel).getByRole('heading', { level: 3, name: item.heading })).toBeInTheDocument();
    }
  });

  it('implements roving tabindex and keyboard navigation for the tablist', async () => {
    const user = userEvent.setup();
    renderStep();
    const chainTab = screen.getByRole('tab', { name: /Цепочка писем/i });
    const vocabTab = screen.getByRole('tab', { name: /Вокабуляр/i });
    const dossierTab = screen.getByRole('tab', { name: /Досье/i });

    expect(chainTab).toHaveAttribute('tabindex', '0');
    expect(vocabTab).toHaveAttribute('tabindex', '-1');
    expect(dossierTab).toHaveAttribute('tabindex', '-1');

    chainTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(vocabTab).toHaveFocus();
    expect(vocabTab).toHaveAttribute('aria-selected', 'true');
    expect(vocabTab).toHaveAttribute('tabindex', '0');
    expect(chainTab).toHaveAttribute('tabindex', '-1');

    await user.keyboard('{End}');
    expect(dossierTab).toHaveFocus();
    expect(dossierTab).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowRight}');
    expect(chainTab).toHaveFocus();
    expect(chainTab).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowLeft}');
    expect(dossierTab).toHaveFocus();
    expect(dossierTab).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Home}');
    expect(chainTab).toHaveFocus();
    expect(chainTab).toHaveAttribute('aria-selected', 'true');
  });
});
