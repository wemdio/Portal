import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { StepNav } from '@/components/vertical-engine-v2/engine/steps/StepNav';
import { Step1Research } from '@/components/vertical-engine-v2/engine/steps/Step1Research';
import { Step2Verticals } from '@/components/vertical-engine-v2/engine/steps/Step2Verticals';
import type { VeHypothesis, VeProject, VeVertical } from '@/lib/verticalEngineV2/types';

const PROJECT: VeProject = {
  id: 'project-keyboard',
  created_by: 'user-1',
  name: 'Keyboard Research',
  website_url: 'https://keyboard.example',
  brief: null,
  status: 'researched',
  market: 'ru',
  error: null,
  llm_model: null,
  tokens_used: 0,
  cost_usd: 0,
  created_at: '2026-08-31T08:00:00.000Z',
  updated_at: '2026-08-31T08:00:00.000Z',
};

const VERTICAL: VeVertical = {
  id: 'vertical-keyboard',
  project_id: PROJECT.id,
  name: 'Корпоративное обучение',
  summary: 'Команды обучения крупных работодателей.',
  synonyms: [],
  potential_pct: 81,
  rank: 1,
  created_at: '2026-08-31T08:00:00.000Z',
  updated_at: '2026-08-31T08:00:00.000Z',
};

const HYPOTHESIS: VeHypothesis = {
  id: 'hypothesis-keyboard',
  project_id: PROJECT.id,
  vertical_id: VERTICAL.id,
  tier: 1,
  title: 'L&D-команды крупных работодателей',
  description: 'Ищут внешних партнёров для обучения сотрудников.',
  evidence: [],
  potential_pct: 79,
  status: 'proposed',
  created_at: '2026-08-31T08:00:00.000Z',
  updated_at: '2026-08-31T08:00:00.000Z',
};

function renderResearch(onStartResearch = jest.fn()) {
  render(
    <Step1Research
      project={PROJECT}
      jobs={[]}
      busy={false}
      onStartResearch={onStartResearch}
      offerValue=""
      onSaveOffer={jest.fn()}
      cases={[]}
    />,
  );

  return {
    onStartResearch,
    restart: screen.getByRole('button', { name: 'Перезапустить' }),
  };
}

function RestartFocusHarness({ onStartResearch }: { onStartResearch: jest.Mock }) {
  const [busy, setBusy] = useState(false);

  return (
    <Step1Research
      project={PROJECT}
      jobs={[]}
      busy={busy}
      onStartResearch={() => {
        onStartResearch();
        setBusy(true);
      }}
      offerValue=""
      onSaveOffer={jest.fn()}
      cases={[]}
    />
  );
}

function Step2FocusHarness() {
  const [hypotheses, setHypotheses] = useState<VeHypothesis[]>([HYPOTHESIS]);

  return (
    <Step2Verticals
      verticals={[VERTICAL]}
      hypotheses={hypotheses}
      selectedVerticalId={null}
      onPatchHypothesis={(id, status) => {
        setHypotheses((current) => current.map((item) => (item.id === id ? { ...item, status } : item)));
      }}
      onSelectVertical={jest.fn()}
      jobs={[]}
    />
  );
}

describe('Vertical Engine v2 keyboard focus', () => {
  it('moves focus into restart confirmation and closes it with Escape', async () => {
    const user = userEvent.setup();
    const { restart } = renderResearch();

    await user.click(restart);

    const dialog = screen.getByRole('alertdialog', { name: 'Подтверждение перезапуска' });
    expect(within(dialog).getByRole('button', { name: 'Да, перезапустить' })).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(restart).toHaveFocus();
  });

  it('returns focus to restart after cancellation', async () => {
    const user = userEvent.setup();
    const { restart } = renderResearch();

    await user.click(restart);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Отмена' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(restart).toHaveFocus();
  });

  it('moves focus to the running status after confirmation starts research', async () => {
    const user = userEvent.setup();
    const onStartResearch = jest.fn();
    render(<RestartFocusHarness onStartResearch={onStartResearch} />);

    await user.click(screen.getByRole('button', { name: 'Перезапустить' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Да, перезапустить' }),
    );

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Идёт исследование…' })).toHaveFocus();
    expect(onStartResearch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Принять', 'Принята'],
    ['Отклонить', 'Отклонена'],
  ])('moves focus to the undo action after %s replaces the optimistic action', async (action, statusLabel) => {
    const user = userEvent.setup();
    render(<Step2FocusHarness />);

    const group = screen.getByRole('group', { name: `Разметка гипотезы «${HYPOTHESIS.title}»` });
    await user.click(within(group).getByRole('button', { name: action }));

    expect(within(group).getByText(statusLabel)).toBeInTheDocument();
    const undo = within(group).getByRole('button', { name: 'Вернуть' });
    expect(undo).toHaveFocus();

    await user.click(undo);

    expect(within(group).getByRole('button', { name: 'Принять' })).toHaveFocus();
  });
});

describe('<StepNav /> locked steps', () => {
  it('disables locked steps and does not invoke onJump', async () => {
    const user = userEvent.setup();
    const onJump = jest.fn();
    render(
      <StepNav
        steps={[
          { id: 1, label: 'Исследование', subtitle: 'Собрать рынок', state: 'active' },
          { id: 2, label: 'Вертикали', subtitle: 'Выбрать направление', state: 'locked' },
        ]}
        onJump={onJump}
      />,
    );

    const lockedStep = screen.getByRole('button', { name: /Вертикали/ });
    expect(lockedStep).toBeDisabled();
    expect(lockedStep).toHaveAttribute('aria-disabled', 'true');

    await user.click(lockedStep);

    expect(onJump).not.toHaveBeenCalled();
  });
});
