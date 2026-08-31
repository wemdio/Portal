import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Step2Verticals } from '@/components/vertical-engine-v2/engine/steps/Step2Verticals';
import { Step3Content } from '@/components/vertical-engine-v2/engine/steps/Step3Content';
import type { VeDossier } from '@/components/vertical-engine-v2/engine/api';
import type { VeVertical } from '@/lib/verticalEngineV2/types';

const mockEnginePatch = jest.fn();

jest.mock('@/components/vertical-engine-v2/engine/api', () => ({
  VE_API: '/api/tools/vertical-engine-v2',
  veEnginePatch: (...args: unknown[]) => mockEnginePatch(...args),
}));

const VERTICAL = {
  id: 'vertical-medicine',
  project_id: 'project-vbi',
  name: 'Частная медицина',
  summary: 'Сети частных клиник и медицинских центров.',
  synonyms: ['частные клиники'],
  potential_pct: 72,
  rank: 1,
  created_at: '2026-08-26T08:00:00.000Z',
  updated_at: '2026-08-26T08:00:00.000Z',
} satisfies VeVertical;

function dossier(counters: Record<string, unknown>): VeDossier {
  return {
    id: 'dossier-1',
    vertical_id: VERTICAL.id,
    status: 'ready',
    error: null,
    data: {
      counters: {
        hh_vacancies_total: 2_017,
        hh_vacancies_sample: [],
        signals: [],
        ...counters,
      },
      dataset_stats: {
        matched_segments: [],
        campaigns: 0,
        sent: 0,
        replies: 0,
        reply_pct: null,
        baseline_pct: null,
        top_subjects: [],
      },
      interpretation: {
        market_summary: '',
        pain_signals: [],
        segment_size_assessment: '',
        dataset_verdict: '',
      },
      computed_at: '2026-08-30T08:00:00.000Z',
    },
  } as unknown as VeDossier;
}

const CURRENT_DOSSIER = dossier({
  companies_total: 28_553,
  directory_rows_total: 31_528,
  companies_unique_total: 28_553,
  companies_with_email: 22_990,
  companies_with_phone: 21_220,
  companies_with_any_contact: 27_104,
  companies_note: 'ОКВЭД 86.2; вся Россия; без ИП.',
});

function renderStep3(value: VeDossier) {
  return render(
    <Step3Content
      vertical={VERTICAL}
      chains={[]}
      vocabs={[]}
      jobs={[]}
      dossiers={[value]}
      onGenerateChain={jest.fn()}
      onGenerateVocab={jest.fn()}
      onGoToBase={jest.fn()}
      onBuildDossier={jest.fn()}
    />,
  );
}

describe('Vertical Engine v2 dossier metrics', () => {
  beforeEach(() => {
    mockEnginePatch.mockReset();
  });

  it('separates raw directory rows, unique companies and unvalidated contact channels', async () => {
    const user = userEvent.setup();
    renderStep3(CURRENT_DOSSIER);

    await user.click(screen.getByRole('tab', { name: /Досье/ }));

    const uniqueCaption = screen.getByText('уникальных компаний по ИНН');
    expect(uniqueCaption.previousElementSibling).toHaveTextContent('28 553');
    expect(uniqueCaption.previousElementSibling).not.toHaveTextContent('~');

    const emailCaption = screen.getByText('компаний с email в справочнике');
    expect(emailCaption.previousElementSibling).toHaveTextContent('22 990');
    const phoneCaption = screen.getByText('компаний с телефоном в справочнике');
    expect(phoneCaption.previousElementSibling).toHaveTextContent('21 220');

    expect(screen.getByText(/31 528 строк до дедупликации/i)).toBeInTheDocument();
    expect(screen.getByText(/не прогноз готовой базы/i)).toBeInTheDocument();
    expect(screen.getByText(/email.*не проверен/i)).toBeInTheDocument();
    expect(screen.queryByText(/контактов в директории/i)).not.toBeInTheDocument();
  });

  it('labels an old rows-only dossier as legacy instead of claiming a unique-company count', async () => {
    const user = userEvent.setup();
    renderStep3(dossier({
      companies_total: 31_528,
      companies_note: 'Старое досье на общем счётчике директории.',
    }));

    await user.click(screen.getByRole('tab', { name: /Досье/ }));

    expect(screen.getByText(/старый расчёт/i)).toBeInTheDocument();
    expect(screen.getByText(/пересоберите досье/i)).toBeInTheDocument();
    expect(screen.queryByText('уникальных компаний по ИНН')).not.toBeInTheDocument();
  });

  it('uses the honest unique/email funnel in the compact vertical summary', () => {
    render(
      <Step2Verticals
        verticals={[VERTICAL]}
        hypotheses={[]}
        selectedVerticalId={VERTICAL.id}
        onPatchHypothesis={jest.fn()}
        onSelectVertical={jest.fn()}
        jobs={[]}
        dossiers={[CURRENT_DOSSIER]}
      />,
    );

    expect(screen.getByText(/28 553 уникальных компаний/i)).toBeInTheDocument();
    expect(screen.getByText(/22 990 с email/i)).toBeInTheDocument();
    expect(screen.queryByText(/~28 553 компаний/i)).not.toBeInTheDocument();
  });
});
