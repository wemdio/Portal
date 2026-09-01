import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VeTemplate } from '@/lib/verticalEngineV2/types';
import { Step5Template } from '@/components/vertical-engine-v2/engine/steps/Step5Template';

const mockVeEngineCall = jest.fn();
const mockVeEnginePost = jest.fn();
const mockStartAudit = jest.fn();
const mockAuthFetch = jest.fn();
const mockDownloadBaseCsvResponse = jest.fn();

jest.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

jest.mock('@/lib/verticalEngineV2/baseCsv', () => ({
  downloadBaseCsvResponse: (...args: unknown[]) => mockDownloadBaseCsvResponse(...args),
}));

jest.mock('@/components/vertical-engine-v2/engine/api', () => ({
  VE_API: '/api/tools/vertical-engine-v2',
  veEngineCall: (...args: unknown[]) => mockVeEngineCall(...args),
  veEnginePost: (...args: unknown[]) => mockVeEnginePost(...args),
}));

jest.mock('@/components/vertical-engine-v2/engine/steps/SegmentationAuditPanel', () => ({
  SegmentationAuditPanel: () => <div>Сегментация проверена</div>,
  useSegmentationAudit: () => ({
    templateId: 'template-1',
    phase: 'ready',
    audit: null,
    error: null,
    start: mockStartAudit,
    refresh: jest.fn(),
    markRejected: jest.fn(),
    resolveLaunch: jest.fn(),
    resolving: false,
    resolutionError: null,
    canLaunch: true,
    auditId: 'audit-1',
    summary: {
      status: 'complete',
      totalBaseRows: 10,
      launchableRows: 10,
      unclassifiedCount: 0,
      excluded: {
        lowRelevance: 0,
        relevanceUnchecked: 0,
        invalidEmailStatus: 0,
        invalidEmail: 0,
        duplicateEmail: 0,
      },
      segments: [],
      defaultGroup: { count: 10, sharePct: 100, examples: [] },
    },
    launchInfo: null,
  }),
}));

const template: VeTemplate = {
  id: 'template-1',
  base_id: 'base-1',
  vertical_id: 'vertical-1',
  fixed_block: 'Короткое предложение',
  personalization_plan: { letters: [], additions: [], operator_mapping: [] },
  letters: [{ subject: 'Тема', body: 'Текст письма', wait_days: 0 }],
  status: 'ready',
  tokens_used: 0,
  cost_usd: 0,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
};

describe('Vertical Engine v2 Step 5 client onboarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthFetch.mockResolvedValue({ ok: true });
    mockDownloadBaseCsvResponse.mockResolvedValue(undefined);
    mockVeEngineCall.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        presets: [],
        bound_preset_id: null,
        can_create_client: true,
        mailbox_tag_options: [
          {
            id: 'tag-vbi',
            name: 'VBI',
            instantly_account_id: 'workspace-main',
            instantly_account_label: 'Основной Instantly',
            mailbox_count: null,
            mailbox_ids: ['sender-one@secret.test', 'sender-two@secret.test'],
          },
        ],
      },
    });
    mockVeEnginePost.mockResolvedValue({
      ok: true,
      status: 201,
      data: {
        ok: true,
        client: { id: 'client-1', email: 'client@example.test' },
        preset: {
          id: 'preset-1',
          name: 'VBI Новый клиент',
          instantly_account_id: 'workspace-main',
          instantly_account_label: 'Основной Instantly',
          mailbox_count: 2,
          mailbox_tags: [{ id: 'tag-vbi', name: 'VBI' }],
          mailbox_tag_resolution: 'exact',
          mailbox_ids: ['sender-one@secret.test', 'sender-two@secret.test'],
        },
      },
    });
  });

  it('creates a client preset from a workspace tag without exposing sender addresses', async () => {
    const user = userEvent.setup();
    render(
      <Step5Template
        template={template}
        base={{
          id: 'base-1',
          vertical_id: 'vertical-1',
          hypothesis_id: null,
          filename: 'base.csv',
          row_count: 10,
          columns: ['email'],
          sample_rows: [],
          analysis: null,
          created_at: '2026-09-01T00:00:00.000Z',
          status: 'analyzed',
        }}
        jobs={[]}
        onBuildTemplate={jest.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Скачать CSV для запуска' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /исходный CSV/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Скачать CSV для запуска' }));
    await waitFor(() => {
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/tools/vertical-engine-v2/bases/base-1/export?mode=launch-ready',
      );
    });

    await user.click(screen.getByRole('button', { name: 'Проверить перед запуском' }));
    const createAction = await screen.findByRole('button', { name: 'Создать клиента и пресет' });
    expect(screen.queryByText(/sender-(one|two)@secret\.test/)).not.toBeInTheDocument();
    expect(createAction).toBeEnabled();

    await user.click(createAction);
    await user.type(screen.getByLabelText('Почта для входа'), 'client@example.test');
    await user.type(screen.getByLabelText('Пароль для входа'), 'safe-password');
    await user.selectOptions(
      screen.getByLabelText('Тег почт в Instantly'),
      JSON.stringify(['workspace-main', 'tag-vbi']),
    );
    expect(
      screen.getByRole('option', { name: 'Основной Instantly · VBI · будет проверено при создании' }),
    ).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Создать клиента' }));

    await waitFor(() => {
      expect(mockVeEnginePost).toHaveBeenCalledWith('/api/tools/vertical-engine-v2/launch-clients', {
        template_id: 'template-1',
        email: 'client@example.test',
        password: 'safe-password',
        instantly_account_id: 'workspace-main',
        mailbox_tag_id: 'tag-vbi',
      });
    });

    const presetSelect = await screen.findByLabelText('Клиентский пресет');
    expect(presetSelect).toHaveValue('preset-1');
    expect((screen.getByRole('option', { name: 'VBI Новый клиент' }) as HTMLOptionElement).selected).toBe(true);
    expect(screen.getByText('Основной Instantly')).toBeInTheDocument();
    expect(screen.getByText('VBI')).toBeInTheDocument();
    expect(screen.queryByText(/sender-(one|two)@secret\.test/)).not.toBeInTheDocument();
  });
});
