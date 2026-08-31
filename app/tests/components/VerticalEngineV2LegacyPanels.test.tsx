import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LegacyArchivePanel } from '@/components/vertical-engine-v2/LegacyArchivePanel';
import { LegacyReviewPanel } from '@/components/vertical-engine-v2/LegacyReviewPanel';
import type {
  VeLegacyCandidate,
  VeLegacyProjectDetail,
  VeLegacyProjectSummary,
} from '@/lib/verticalEngineV2/types.legacy';

const CANDIDATE: VeLegacyCandidate = {
  id: 'legacy-candidate-1',
  created_by: 'specialist@example.com',
  name: 'Промышленный прогон',
  website_url: 'https://industry.example',
  status: 'completed',
  market: 'ru',
  autopilot: false,
  created_at: '2026-04-12T10:00:00.000Z',
  linked: false,
};

const PROJECT: VeLegacyProjectSummary = {
  id: 'legacy-project-1',
  created_by: 'specialist@example.com',
  name: 'Архивный проект',
  website_url: 'https://archive.example',
  status: 'completed',
  created_at: '2026-04-12T10:00:00.000Z',
  updated_at: '2026-04-13T10:00:00.000Z',
  origin: 'legacy',
  read_only: true,
  verification: {
    verified_by: 'admin@example.com',
    verified_at: '2026-08-20T10:00:00.000Z',
    review_notes: 'Подтверждён как внутренний прогон.',
    backfill_batch_id: null,
  },
};

const DETAIL: VeLegacyProjectDetail = {
  origin: 'legacy',
  read_only: true,
  verification: PROJECT.verification,
  project: { ...PROJECT },
  hypotheses: [{ id: 'hypothesis-1', tier: 1, title: 'Интеграторы', potential_pct: 72 }],
  verticals: [{ id: 'vertical-1', name: 'АСУ ТП', potential_pct: 72 }],
  chains: [{
    id: 'chain-1',
    language: 'ru',
    letters: [{ subject: 'Идея для отдела продаж', body: 'Здравствуйте.' }],
  }],
  vocabs: [],
  bases: [{ id: 'base-1', filename: 'integrators.csv', row_count: 120, status: 'ready' }],
  templates: [{ id: 'template-1', status: 'ready' }],
  jobs: [],
  dossiers: [],
  cases: [],
};

describe('<LegacyReviewPanel />', () => {
  it('даёт каждому полю постоянное доступное имя и сохраняет approve-handler', async () => {
    const onApprove = jest.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <LegacyReviewPanel
        candidates={[CANDIDATE]}
        busyId={null}
        onApprove={onApprove}
        onRemove={jest.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Поиск кандидатов' })).toBeInTheDocument();
    const notes = screen.getByRole('textbox', {
      name: /Основание проверки.*обязательно/i,
    });
    await user.type(notes, 'Внутренний прогон Сергея, апрель');
    await user.click(screen.getByRole('button', { name: 'Подтвердить внутренний проект' }));

    expect(onApprove).toHaveBeenCalledWith(
      CANDIDATE,
      'Внутренний прогон Сергея, апрель',
    );
  });
});

describe('<LegacyArchivePanel />', () => {
  it('показывает архив как плоский список строк и сохраняет select-handler', async () => {
    const onSelect = jest.fn();
    const user = userEvent.setup();
    const { container } = render(
      <LegacyArchivePanel
        projects={[PROJECT]}
        detail={null}
        detailLoading={false}
        onSelect={onSelect}
        onBack={jest.fn()}
      />,
    );

    const row = screen.getByRole('button', { name: /Архивный проект/i });
    expect(row).toHaveClass('ve2-row');
    expect(row.closest('.ve2-rows')).not.toBeNull();
    expect(container.querySelector('.ve2-card')).toBeNull();

    await user.click(row);
    expect(onSelect).toHaveBeenCalledWith(PROJECT.id);
  });

  it('собирает detail из секций и строк без вложенных карточек', () => {
    const { container } = render(
      <LegacyArchivePanel
        projects={[PROJECT]}
        detail={DETAIL}
        detailLoading={false}
        onSelect={jest.fn()}
        onBack={jest.fn()}
      />,
    );

    for (const name of [
      '02 → Вертикали',
      '03 → Гипотезы',
      '04 → Письма и шаблоны',
      '05 → Базы',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(within(screen.getByRole('region', { name: '02 → Вертикали' }))
      .getByText('АСУ ТП')).toBeInTheDocument();
    expect(container.querySelector('.ve2-card .ve2-card')).toBeNull();
  });
});
