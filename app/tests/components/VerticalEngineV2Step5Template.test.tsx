import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Step5Template } from '@/components/vertical-engine-v2/engine/steps/Step5Template';
import type { VeBaseSummary } from '@/components/vertical-engine-v2/engine/api';
import type { VeTemplate } from '@/lib/verticalEngineV2/types';

const mockEngineCall = jest.fn();
const mockEnginePost = jest.fn();
const mockEnginePatch = jest.fn();

jest.mock('@/components/vertical-engine-v2/engine/api', () => ({
  VE_API: '/api/tools/vertical-engine-v2',
  veEngineCall: (...args: unknown[]) => mockEngineCall(...args),
  veEnginePost: (...args: unknown[]) => mockEnginePost(...args),
  veEnginePatch: (...args: unknown[]) => mockEnginePatch(...args),
}));

const TEMPLATE_ID = 'template-1';
const BASE_ID = 'base-1';
const AUDIT_URL = `/api/tools/vertical-engine-v2/templates/${TEMPLATE_ID}/segmentation-audit`;
const LAUNCH_URL = `/api/tools/vertical-engine-v2/templates/${TEMPLATE_ID}/launch`;
const PREVIEW_URL = `/api/tools/vertical-engine-v2/bases/${BASE_ID}/template`;

const TEMPLATE = {
  id: TEMPLATE_ID,
  base_id: BASE_ID,
  vertical_id: 'vertical-1',
  fixed_block: 'Общая основа',
  personalization_plan: {
    letters: [],
    additions: [],
    operator_mapping: [
      { operator: 'companyName', column: 'company', matched: true },
    ],
  },
  letters: [
    {
      subject: 'Рост для {{companyName}}',
      body: 'Поможем привлечь больше учеников.',
      wait_days: 0,
      segment_variants: [
        {
          when: 'Медицинские клиники',
          text: 'Поможем клинике {{companyName}} привлечь больше пациентов.',
        },
        {
          when: 'Частные школы',
          text: 'Поможем школе {{companyName}} набрать новый поток.',
        },
        {
          when: 'Вузы',
          text: 'Поможем вузу {{companyName}} привлечь абитуриентов.',
        },
      ],
    },
  ],
  status: 'ready',
  tokens_used: 0,
  cost_usd: 0,
  created_at: '2026-08-27T08:00:00.000Z',
  updated_at: '2026-08-27T08:00:00.000Z',
  launch_info: null,
} as unknown as VeTemplate;

const BASE = {
  id: BASE_ID,
  vertical_id: 'vertical-1',
  hypothesis_id: 'hypothesis-1',
  filename: 'education.csv',
  row_count: 120,
  columns: ['company', 'industry', 'city', 'email'],
  sample_rows: [],
  analysis: null,
  status: 'analyzed',
  source: 'auto',
  created_at: '2026-08-27T07:00:00.000Z',
} as VeBaseSummary;

const PENDING_AUDIT_RESPONSE = {
  ok: true,
  audit: {
    id: 'audit-1',
    status: 'pending',
    template_id: TEMPLATE_ID,
    base_id: BASE_ID,
  },
  job: { id: 'job-audit-1', stage: 'segmentation_audit', status: 'pending' },
};

const COMPLETE_AUDIT = {
  id: 'audit-1',
  status: 'ready',
  template_id: TEMPLATE_ID,
  base_id: BASE_ID,
  input_hash: 'hash-1',
  current: true,
  generated_at: '2026-08-27T08:10:00.000Z',
  summary: {
    status: 'complete',
    total_base_rows: 120,
    launchable_rows: 112,
    excluded: {
      low_relevance: 2,
      invalid_email_status: 1,
      invalid_email: 3,
      duplicate_email: 2,
    },
    segments: [
      {
        when: 'Частные школы',
        count: 70,
        share_pct: 62.5,
        examples: [
          {
            row_index: 3,
            label: 'Лицей Перспектива',
            fields: [
              { label: 'Отрасль', value: 'Школьное образование' },
              { label: 'Город', value: 'Москва' },
            ],
          },
        ],
      },
      {
        when: 'Медицинские клиники',
        count: 30,
        share_pct: 26.8,
        examples: [
          {
            row_index: 40,
            label: 'Клиника Север',
            fields: [{ label: 'Город', value: 'Санкт-Петербург' }],
          },
        ],
      },
      {
        when: 'Вузы',
        count: 0,
        share_pct: 0,
        examples: [],
      },
    ],
    default: {
      count: 12,
      share_pct: 10.7,
      examples: [
        {
          row_index: 88,
          label: 'Учебный центр Север',
          fields: [{ label: 'Город', value: 'Архангельск' }],
        },
      ],
    },
    unclassified_count: 0,
  },
};

type LaunchPresetFixture = {
  id: string;
  name: string;
  instantly_account_id: string;
  instantly_account_label: string;
  mailbox_count: number;
  mailbox_tags: Array<{ id: string; name: string }>;
  mailbox_tag_resolution: 'exact' | 'shared' | 'mixed' | 'none' | 'unavailable';
};

const VBI_PRESET: LaunchPresetFixture = {
  id: 'preset-1',
  name: 'VBI',
  instantly_account_id: 'main',
  instantly_account_label: 'Основной Instantly',
  mailbox_count: 16,
  mailbox_tags: [{ id: 'tag-vbi', name: 'VBI mailboxes' }],
  mailbox_tag_resolution: 'exact',
};

const NORTH_PRESET: LaunchPresetFixture = {
  id: 'preset-2',
  name: 'Север',
  instantly_account_id: 'north',
  instantly_account_label: 'Северный workspace',
  mailbox_count: 8,
  mailbox_tags: [{ id: 'tag-north', name: 'North pool' }],
  mailbox_tag_resolution: 'shared',
};

const PRIORITY_SNAPSHOT = {
  version: 1,
  state: 'neutral',
  confidence: 'high',
  evaluated_on: '2026-08-29',
  planned_activation_date: null,
  seasonal_deadline_date: null,
  automatic_activation_eligible: true,
  priority: 70,
};

type PortfolioLifecycle =
  | 'prepared'
  | 'queued'
  | 'activating'
  | 'active'
  | 'uncertain'
  | 'released'
  | 'skipped'
  | 'cancelled';

function recordedPortfolioTemplate({
  status = 'queued',
  activeBundles = 0,
  prioritySnapshot = PRIORITY_SNAPSHOT,
}: {
  status?: PortfolioLifecycle;
  activeBundles?: number;
  prioritySnapshot?: typeof PRIORITY_SNAPSHOT;
} = {}): VeTemplate {
  return {
    ...TEMPLATE,
    launch_info: {
      campaign_id: 'campaign-1',
      campaign_name: 'education.csv',
      campaign_url: 'https://app.instantly.ai/app/campaign/campaign-1',
      leads_count: 112,
      preset_id: 'preset-1',
      created_at: '2026-08-29T08:20:00.000Z',
      priority_snapshot: prioritySnapshot,
    },
    launch_portfolio: {
      item_id: 'portfolio-item-1',
      status,
      mode: 'enforced',
      plan_version: 4,
      priority_snapshot: prioritySnapshot,
      capacity: {
        max_active_bundles: 1,
        active_bundles: activeBundles,
      },
    },
  } as unknown as VeTemplate;
}

function configurePortfolioRead({
  status = 'queued',
  globalActiveBundles = 0,
  occupiedBundles = 0,
  prioritySnapshot = PRIORITY_SNAPSHOT,
}: {
  status?: PortfolioLifecycle;
  globalActiveBundles?: number;
  occupiedBundles?: number;
  prioritySnapshot?: typeof PRIORITY_SNAPSHOT;
} = {}) {
  mockEngineCall.mockImplementation(async (url: string) => {
    if (url === '/api/tools/vertical-engine-v2/launch-portfolio?market=ru') {
      return {
        ok: true,
        status: 200,
        data: {
          as_of: '2026-08-29T08:30:00.000Z',
          plan_version: 4,
          mode: 'enforced',
          capacity: {
            max_active_bundles: 1,
            active_bundles: globalActiveBundles,
            next_estimated_release_at: null,
          },
          items: [
            {
              id: 'portfolio-item-1',
              project_id: 'project-1',
              template_id: TEMPLATE_ID,
              status,
              rank: 1,
              priority_snapshot: prioritySnapshot,
              seasonality: null,
              campaigns: [],
              capacity: {
                max_active_bundles: 1,
                occupied_bundles: occupiedBundles,
                slot_available: occupiedBundles < 1,
              },
            },
          ],
        },
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  });
}

function renderStep(template: VeTemplate = TEMPLATE) {
  return render(
    <Step5Template
      template={template}
      base={BASE}
      jobs={[]}
      onBuildTemplate={jest.fn()}
    />,
  );
}

function pendingPostResult() {
  return Promise.resolve({
    ok: true,
    status: 202,
    data: PENDING_AUDIT_RESPONSE,
  });
}

function configureAuditRead(
  audit: unknown,
  options: {
    presets?: LaunchPresetFixture[];
    boundPresetId?: string | null;
  } = {},
) {
  const presets = options.presets ?? [VBI_PRESET];
  const boundPresetId = options.boundPresetId === undefined ? 'preset-1' : options.boundPresetId;
  mockEngineCall.mockImplementation(async (url: string) => {
    if (url === AUDIT_URL) {
      return { ok: true, status: 200, data: { audit } };
    }
    if (url === LAUNCH_URL) {
      return {
        ok: true,
        status: 200,
        data: { presets, bound_preset_id: boundPresetId },
      };
    }
    throw new Error(`Unexpected GET ${url}`);
  });
}

beforeEach(() => {
  mockEngineCall.mockReset();
  mockEnginePost.mockReset();
  mockEnginePatch.mockReset();
});

describe('<Step5Template /> — сегментное превью', () => {
  it('показывает в превью текст сегмента из выборочной классификации', async () => {
    mockEngineCall.mockImplementation(async (url: string) => {
      if (url !== PREVIEW_URL) throw new Error(`Unexpected GET ${url}`);
      return {
        ok: true,
        status: 200,
        data: {
          template: TEMPLATE,
          columns: ['company', 'industry', 'email'],
          sample_rows: [
            {
              company: 'Клиника Север',
              industry: 'Медицина',
              email: 'hello@clinic.example',
            },
          ],
          sample_segments: ['Медицинские клиники'],
        },
      };
    });

    const user = userEvent.setup();
    renderStep();

    const summary = screen.getByText(/Превью по лидам/i);
    await user.click(summary);
    const preview = summary.closest('details');
    expect(preview).not.toBeNull();

    expect(
      await within(preview as HTMLElement).findByText(
        /Поможем клинике Клиника Север привлечь больше пациентов\./i,
      ),
    ).toBeInTheDocument();
    expect(
      within(preview as HTMLElement).queryByText(/Поможем привлечь больше учеников\./i),
    ).not.toBeInTheDocument();
  });

  it('показывает лидов одним плоским листом без вложенных карточек', async () => {
    mockEngineCall.mockImplementation(async (url: string) => {
      if (url !== PREVIEW_URL) throw new Error(`Unexpected GET ${url}`);
      return {
        ok: true,
        status: 200,
        data: {
          template: TEMPLATE,
          columns: ['company', 'industry', 'email'],
          sample_rows: [
            {
              company: 'Клиника Север',
              industry: 'Медицина',
              email: 'hello@clinic.example',
            },
          ],
          sample_segments: ['Медицинские клиники'],
        },
      };
    });

    const user = userEvent.setup();
    renderStep();

    const summary = screen.getByText(/Превью по лидам/i);
    await user.click(summary);
    const preview = summary.closest('details');
    expect(preview).not.toBeNull();

    await within(preview as HTMLElement).findAllByText(/Клиника Север/i);
    expect((preview as HTMLElement).querySelectorAll('.ve2-letter-sheet')).toHaveLength(1);
    expect((preview as HTMLElement).querySelectorAll('.rounded-lg, .rounded-md')).toHaveLength(0);
  });
});

describe('<Step5Template /> — предзапускный аудит сегментации', () => {
  it('начинает с проверки, а не с формы запуска', () => {
    renderStep();

    expect(
      screen.getByRole('button', { name: /Проверить перед запуском/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Создать .*кампан.*на паузе/i }),
    ).not.toBeInTheDocument();
    expect(mockEngineCall).not.toHaveBeenCalled();
    expect(mockEnginePost).not.toHaveBeenCalled();
  });

  it('сначала запускает аудит и не даёт создать кампанию во время проверки', async () => {
    let resolveAudit!: (value: {
      ok: boolean;
      status: number;
      data: typeof PENDING_AUDIT_RESPONSE;
    }) => void;
    const auditRequest = new Promise<{
      ok: boolean;
      status: number;
      data: typeof PENDING_AUDIT_RESPONSE;
    }>((resolve) => {
      resolveAudit = resolve;
    });
    mockEnginePost.mockImplementation((url: string) => {
      if (url === AUDIT_URL) return auditRequest;
      throw new Error(`Launch must not start while audit is pending: ${url}`);
    });

    const user = userEvent.setup();
    renderStep();
    await user.click(
      screen.getByRole('button', { name: /Проверить перед запуском/i }),
    );

    expect(mockEnginePost.mock.calls[0]?.[0]).toBe(AUDIT_URL);
    expect(
      screen.getByRole('heading', { name: /Проверяем сегментацию перед запуском/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Создать .*кампан.*на паузе/i }),
    ).not.toBeInTheDocument();
    expect(
      mockEnginePost.mock.calls.some(([url]) => url === LAUNCH_URL),
    ).toBe(false);

    await act(async () => {
      resolveAudit({ ok: true, status: 202, data: PENDING_AUDIT_RESPONSE });
    });
  });

  it('не выбирает первый пресет автоматически для непривязанного проекта', async () => {
    configureAuditRead(COMPLETE_AUDIT, { boundPresetId: null });
    mockEnginePost.mockImplementation((url: string) => {
      if (url === AUDIT_URL) return pendingPostResult();
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('button', { name: /Проверить перед запуском/i }));

    const select = await screen.findByRole('combobox', { name: /Клиентский пресет/i });
    expect(select).toHaveValue('');
    expect(screen.getByRole('option', { name: /Выберите клиента/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Создать .*кампан.*на паузе/i })).toBeDisabled();
  });

  it('выбирает только явно привязанный пресет', async () => {
    configureAuditRead(COMPLETE_AUDIT, {
      presets: [VBI_PRESET, NORTH_PRESET],
      boundPresetId: NORTH_PRESET.id,
    });
    mockEnginePost.mockImplementation((url: string) => {
      if (url === AUDIT_URL) return pendingPostResult();
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('button', { name: /Проверить перед запуском/i }));

    const select = await screen.findByRole('combobox', { name: /Клиентский пресет/i });
    expect(select).toHaveValue(NORTH_PRESET.id);
    expect(select).toBeDisabled();
    expect(screen.queryByRole('option', { name: /Выберите клиента/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Пресет закреплён за проектом/i)).toBeInTheDocument();
  });

  it('блокирует запуск, если закреплённого пресета нет в доступной выдаче', async () => {
    configureAuditRead(COMPLETE_AUDIT, {
      presets: [VBI_PRESET],
      boundPresetId: 'missing-preset',
    });
    mockEnginePost.mockImplementation((url: string) => {
      if (url === AUDIT_URL) return pendingPostResult();
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('button', { name: /Проверить перед запуском/i }));

    expect(await screen.findByText(/Закреплённый пресет проекта недоступен/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Клиентский пресет/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Создать .*кампан.*на паузе/i })).toBeDisabled();
  });

  it('показывает workspace, тег и число ящиков, но не адреса почт', async () => {
    configureAuditRead(COMPLETE_AUDIT);
    mockEnginePost.mockImplementation((url: string) => {
      if (url === AUDIT_URL) return pendingPostResult();
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    const { container } = renderStep();
    await user.click(screen.getByRole('button', { name: /Проверить перед запуском/i }));

    await screen.findByRole('combobox', { name: /Клиентский пресет/i });
    expect(screen.getByText('Основной Instantly')).toBeInTheDocument();
    expect(container.querySelector('.ve2-tag')).toHaveTextContent('VBI mailboxes');
    expect(screen.getByText(/16 ящиков/i)).toBeInTheDocument();
    expect(container).not.toHaveTextContent('@');
    const summary = container.querySelector('#ve2-launch-preset-summary');
    expect(summary).toHaveClass('border-t', 'pt-3');
    expect(summary).not.toHaveClass('rounded-md', 'bg-gray-50');
  });

  it('обновляет сводку при смене пресета и отправляет выбранный id', async () => {
    configureAuditRead(COMPLETE_AUDIT, {
      presets: [VBI_PRESET, NORTH_PRESET],
      boundPresetId: null,
    });
    mockEnginePost.mockImplementation(async (url: string, body?: unknown) => {
      if (url === AUDIT_URL) return pendingPostResult();
      if (url === LAUNCH_URL) {
        return {
          ok: true,
          status: 200,
          data: {
            launch: {
              campaign_id: 'campaign-north',
              campaign_name: 'education.csv',
              campaign_url: 'https://app.instantly.ai/app/campaign/campaign-north',
              leads_count: 112,
              preset_id: (body as { preset_id?: string } | undefined)?.preset_id,
              created_at: '2026-08-27T08:20:00.000Z',
            },
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('button', { name: /Проверить перед запуском/i }));

    const select = await screen.findByRole('combobox', { name: /Клиентский пресет/i });
    await user.selectOptions(select, NORTH_PRESET.id);
    expect(screen.getByText('Северный workspace')).toBeInTheDocument();
    expect(screen.getByText('North pool')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Создать .*кампан.*на паузе/i }));

    await waitFor(() => {
      expect(mockEnginePost).toHaveBeenCalledWith(LAUNCH_URL, {
        preset_id: NORTH_PRESET.id,
        segmentation_audit_id: 'audit-1',
        confirm_segmentation: true,
      });
    });
  });

  it('блокирует создание кампаний, когда в пресете нет ящиков', async () => {
    configureAuditRead(COMPLETE_AUDIT, {
      presets: [{
        ...VBI_PRESET,
        mailbox_count: 0,
        mailbox_tags: [],
        mailbox_tag_resolution: 'none',
      }],
      boundPresetId: null,
    });
    mockEnginePost.mockImplementation((url: string) => {
      if (url === AUDIT_URL) return pendingPostResult();
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('button', { name: /Проверить перед запуском/i }));

    const select = await screen.findByRole('combobox', { name: /Клиентский пресет/i });
    await user.selectOptions(select, VBI_PRESET.id);
    expect(await screen.findByText(/Тег не назначен/i)).toBeInTheDocument();
    expect(screen.getByText(/0 ящиков/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Создать .*кампан.*на паузе/i })).toBeDisabled();
  });

  it('показывает полную раскладку и запускает только с подтверждённым audit id', async () => {
    configureAuditRead(COMPLETE_AUDIT);
    mockEnginePost.mockImplementation(async (url: string, body?: unknown) => {
      if (url === AUDIT_URL) return pendingPostResult();
      if (url === LAUNCH_URL) {
        return {
          ok: true,
          status: 200,
          data: {
            launch: {
              campaign_id: 'campaign-1',
              campaign_name: 'education.csv',
              campaign_url: 'https://app.instantly.ai/app/campaign/campaign-1',
              leads_count: 112,
              preset_id: (body as { preset_id?: string } | undefined)?.preset_id,
              created_at: '2026-08-27T08:20:00.000Z',
            },
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    renderStep();
    await user.click(
      screen.getByRole('button', { name: /Проверить перед запуском/i }),
    );

    expect(await screen.findByText(/112 получател/i)).toBeInTheDocument();
    expect(screen.getByText('Частные школы')).toBeInTheDocument();
    expect(screen.getByText(/^70$/)).toBeInTheDocument();
    expect(screen.getByText('Медицинские клиники')).toBeInTheDocument();
    expect(screen.getByText(/^30$/)).toBeInTheDocument();
    expect(screen.getByText('Вузы')).toBeInTheDocument();
    expect(screen.getByText(/^0$/)).toBeInTheDocument();
    expect(screen.getByText(/Основной текст.*не совпали/i)).toBeInTheDocument();
    expect(screen.getByText(/^12$/)).toBeInTheDocument();
    expect(screen.getByText('Лицей Перспектива')).toBeInTheDocument();
    expect(screen.getByText('Клиника Север')).toBeInTheDocument();
    expect(screen.getByText('Учебный центр Север')).toBeInTheDocument();
    expect(screen.getByText(/низк.*2|2.*низк/i)).toBeInTheDocument();
    expect(screen.getByText(/невалид.*3|3.*невалид/i)).toBeInTheDocument();
    expect(screen.getByText(/дубл.*2|2.*дубл/i)).toBeInTheDocument();

    const launchButton = screen.getByRole('button', {
      name: /Создать .*кампан.*на паузе/i,
    });
    await user.click(launchButton);

    await waitFor(() => {
      expect(mockEnginePost).toHaveBeenCalledWith(LAUNCH_URL, {
        preset_id: 'preset-1',
        segmentation_audit_id: 'audit-1',
        confirm_segmentation: true,
      });
    });
  });

  it('разрешает запуск после полного аудита, когда сегментных вариантов нет', async () => {
    configureAuditRead({
      ...COMPLETE_AUDIT,
      summary: {
        ...COMPLETE_AUDIT.summary,
        status: 'not_required',
        segments: [],
        default: { count: 112, share_pct: 100, examples: [] },
      },
    });
    mockEnginePost.mockImplementation((url: string) => {
      if (url === AUDIT_URL) return pendingPostResult();
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('button', { name: /Проверить перед запуском/i }));

    expect(
      await screen.findByRole('button', { name: /Создать .*кампан.*на паузе/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Сегментация не требуется');
    expect(screen.getByText(/Основной текст.*сегментация не требуется/i)).toBeInTheDocument();
  });

  it('сбрасывает зелёный gate, если запуск обнаружил устаревший аудит', async () => {
    configureAuditRead(COMPLETE_AUDIT);
    mockEnginePost.mockImplementation(async (url: string) => {
      if (url === AUDIT_URL) return pendingPostResult();
      if (url === LAUNCH_URL) {
        return {
          ok: false,
          status: 409,
          data: {
            code: 'SEGMENTATION_AUDIT_STALE',
            error: 'Аудит сегментации устарел. Обновите проверку перед запуском.',
          },
        };
      }
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('button', { name: /Проверить перед запуском/i }));
    await user.click(
      await screen.findByRole('button', { name: /Создать .*кампан.*на паузе/i }),
    );

    expect(await screen.findByText(/Аудит устарел/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Обновить проверку/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Создать .*кампан.*на паузе/i }),
    ).not.toBeInTheDocument();
  });

  it('после неоднозначного запуска требует явной проверки и разрешает безопасный повтор', async () => {
    const uncertainAudit = {
      ...COMPLETE_AUDIT,
      launch_status: 'uncertain',
      launch_reservation_id: 'reservation-ui-1',
      launch_started_at: '2026-08-28T08:20:00.000Z',
      launch_error: 'Истёк срок ожидания результата запуска',
    };
    configureAuditRead(uncertainAudit);
    mockEnginePost.mockImplementation((url: string) => {
      if (url === AUDIT_URL) return pendingPostResult();
      throw new Error(`Launch must stay blocked while uncertain: ${url}`);
    });
    mockEnginePatch.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        audit: {
          ...uncertainAudit,
          launch_status: 'failed',
          launch_error: 'Специалист подтвердил: кампания не создана',
        },
      },
    });

    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('button', { name: /Проверить перед запуском/i }));

    expect(await screen.findByText(/результат запуска нужно проверить/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Создать .*кампан.*на паузе/i }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: /Кампании нет.*разрешить повтор/i }),
    );

    expect(mockEnginePatch).toHaveBeenCalledWith(AUDIT_URL, {
      audit_id: 'audit-1',
      launch_reservation_id: 'reservation-ui-1',
      resolution: 'no_campaign',
      confirm: true,
    });
    expect(
      await screen.findByRole('button', { name: /Создать .*кампан.*на паузе/i }),
    ).toBeInTheDocument();
  });

  it('сохраняет проверенные вручную campaign id и показывает восстановленный запуск', async () => {
    const uncertainAudit = {
      ...COMPLETE_AUDIT,
      launch_status: 'uncertain',
      launch_reservation_id: 'reservation-ui-2',
      launch_started_at: '2026-08-28T08:20:00.000Z',
      launch_error: 'Сетевой таймаут',
    };
    configureAuditRead(uncertainAudit);
    mockEnginePost.mockImplementation((url: string) => {
      if (url === AUDIT_URL) return pendingPostResult();
      throw new Error(`Unexpected POST ${url}`);
    });
    const recoveredLaunch = {
      campaign_id: 'campaign-primary',
      campaign_name: 'Восстановленный запуск',
      campaign_url: 'https://app.instantly.ai/app/campaign/campaign-primary',
      leads_count: 0,
      preset_id: 'preset-1',
      created_at: '2026-08-28T08:20:00.000Z',
      segmentation_audit_id: 'audit-1',
      campaigns: [
        {
          campaign_id: 'campaign-primary',
          campaign_name: 'Восстановленный запуск',
          campaign_url: 'https://app.instantly.ai/app/campaign/campaign-primary',
          segment: null,
          leads_count: 0,
        },
      ],
    };
    mockEnginePatch.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        audit: {
          ...uncertainAudit,
          launch_status: 'succeeded',
          launch: recoveredLaunch,
        },
      },
    });

    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('button', { name: /Проверить перед запуском/i }));
    const input = await screen.findByLabelText(/ID кампаний/i);
    await user.type(input, 'campaign-primary');
    await user.click(
      screen.getByRole('button', { name: /Кампания создана.*зафиксировать/i }),
    );

    expect(mockEnginePatch).toHaveBeenCalledWith(AUDIT_URL, {
      audit_id: 'audit-1',
      launch_reservation_id: 'reservation-ui-2',
      resolution: 'campaign_created',
      campaign_ids: ['campaign-primary'],
      confirm: true,
    });
    expect(await screen.findByText(/Кампания создана.*на паузе/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Открыть в Instantly/i })).toHaveAttribute(
      'href',
      recoveredLaunch.campaign_url,
    );
  });

  it('не открывает запуск, если после фильтров не осталось получателей', async () => {
    configureAuditRead({
      ...COMPLETE_AUDIT,
      summary: {
        ...COMPLETE_AUDIT.summary,
        launchable_rows: 0,
        segments: COMPLETE_AUDIT.summary.segments.map((segment) => ({
          ...segment,
          count: 0,
          share_pct: 0,
          examples: [],
        })),
        default: { count: 0, share_pct: 0, examples: [] },
      },
    });
    mockEnginePost.mockImplementation((url: string) => {
      if (url === AUDIT_URL) return pendingPostResult();
      throw new Error(`Unexpected POST ${url}`);
    });

    const user = userEvent.setup();
    renderStep();
    await user.click(screen.getByRole('button', { name: /Проверить перед запуском/i }));

    expect(await screen.findByText(/нет получател.*для запуска/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Создать .*кампан.*на паузе/i }),
    ).not.toBeInTheDocument();
  });

  it.each([
    {
      name: 'partial',
      audit: {
        ...COMPLETE_AUDIT,
        summary: {
          ...COMPLETE_AUDIT.summary,
          status: 'incomplete',
          unclassified_count: 4,
        },
      },
      message: /проверка неполная|4 .*не проверен/i,
      action: /Повторить проверку/i,
    },
    {
      name: 'stale',
      audit: { ...COMPLETE_AUDIT, current: false },
      message: /устарел|изменил.*после проверки/i,
      action: /Обновить проверку/i,
    },
  ])('$name блокирует запуск', async ({ audit, message, action }) => {
    configureAuditRead(audit);
    mockEnginePost.mockImplementation((url: string) => {
      if (url === AUDIT_URL) return pendingPostResult();
      throw new Error(`Launch must stay blocked for ${String(audit)}: ${url}`);
    });

    const user = userEvent.setup();
    renderStep();
    await user.click(
      screen.getByRole('button', { name: /Проверить перед запуском/i }),
    );

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: action })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Создать .*кампан.*на паузе/i }),
    ).not.toBeInTheDocument();
    expect(
      mockEnginePost.mock.calls.some(([url]) => url === LAUNCH_URL),
    ).toBe(false);
  });

  it('ошибка аудита видна и не открывает запуск', async () => {
    mockEnginePost.mockResolvedValue({
      ok: false,
      status: 503,
      data: { error: 'Сервис классификации временно недоступен' },
    });

    const user = userEvent.setup();
    renderStep();
    await user.click(
      screen.getByRole('button', { name: /Проверить перед запуском/i }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Сервис классификации временно недоступен',
    );
    expect(
      screen.getByRole('button', { name: /Повторить проверку/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Создать .*кампан.*на паузе/i }),
    ).not.toBeInTheDocument();
  });
});

describe('<Step5Template /> — активация подготовленного launch portfolio', () => {
  it('использует mailbox-scoped capacity пункта, а не глобальную занятость портфеля', async () => {
    const remotePriority = PRIORITY_SNAPSHOT;
    const embeddedPriority = {
      ...PRIORITY_SNAPSHOT,
      state: 'avoid' as const,
      automatic_activation_eligible: false,
      priority: 0,
    };
    configurePortfolioRead({
      status: 'queued',
      globalActiveBundles: 1,
      occupiedBundles: 0,
      prioritySnapshot: remotePriority,
    });

    renderStep(recordedPortfolioTemplate({
      status: 'prepared',
      activeBundles: 1,
      prioritySnapshot: embeddedPriority,
    }));

    const activation = screen.getByRole('region', { name: 'Активация отправки' });
    expect(await within(activation).findByText('Круглый год')).toBeInTheDocument();
    expect(within(activation).getByText(/Sending slot: 0 из 1/i)).toBeInTheDocument();
    expect(
      within(activation).getByRole('checkbox', {
        name: /проверил тексты, получателей и настройки/i,
      }),
    ).toBeInTheDocument();
  });

  it('разрешает queued preflight при занятом снимке capacity для backend live-reconcile', async () => {
    configurePortfolioRead({
      status: 'queued',
      globalActiveBundles: 1,
      occupiedBundles: 1,
    });
    mockEnginePost.mockResolvedValue({
      ok: false,
      status: 409,
      data: { error: 'Live holder всё ещё активен' },
    });

    const user = userEvent.setup();
    renderStep(recordedPortfolioTemplate({ status: 'queued', activeBundles: 1 }));

    const activation = screen.getByRole('region', { name: 'Активация отправки' });
    expect(
      await within(activation).findByText(/live-статус.*освободит.*Completed/i),
    ).toBeInTheDocument();
    const review = within(activation).getByRole('checkbox', {
      name: /проверил тексты, получателей и настройки/i,
    });
    const activate = within(activation).getByRole('button', {
      name: /Активировать отправку/i,
    });
    expect(activate).toBeDisabled();

    await user.click(review);
    expect(activate).toBeEnabled();
    await user.click(activate);

    await waitFor(() => {
      expect(mockEnginePost).toHaveBeenCalledWith(
        '/api/tools/vertical-engine-v2/launch-portfolio/portfolio-item-1/activate',
        expect.objectContaining({
          confirm_campaign_review: true,
          plan_version: 4,
        }),
      );
    });
  });

  it.each([
    ['prepared', 'Кампании подготовлены, но запуск ещё не поставлен в очередь'],
    ['activating', 'Активация отправки выполняется'],
    ['active', 'Отправка уже активна'],
    ['uncertain', 'Статус активации требует сверки'],
    ['released', 'Отправка завершена'],
    ['skipped', 'Запуск пропущен'],
    ['cancelled', 'Запуск отменён'],
  ] as const)('не показывает форму активации для lifecycle %s', async (status, message) => {
    configurePortfolioRead({ status });
    renderStep(recordedPortfolioTemplate({ status: 'queued' }));

    const activation = screen.getByRole('region', { name: 'Активация отправки' });
    expect(await within(activation).findByText(message)).toBeInTheDocument();
    expect(within(activation).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(
      within(activation).queryByRole('button', { name: /Активировать отправку/i }),
    ).not.toBeInTheDocument();
  });
});
