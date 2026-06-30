import { render, screen, fireEvent } from '@testing-library/react';
import SignalEnrichmentModal, {
  type SignalEnrichmentModalState,
} from '@/components/SignalEnrichmentModal';
import { BUILTIN_PRESETS } from '@/lib/enrich/extractors/types';

function makeState(overrides: Partial<SignalEnrichmentModalState> = {}): SignalEnrichmentModalState {
  return {
    isOpen: true,
    sourceCol: 1,
    isProcessing: false,
    progress: 0,
    totalRows: 0,
    currentRow: 0,
    error: null,
    startedAt: null,
    detectedJob: null,
    selectedExtractors: ['stack', 'profile'],
    presetId: 'basic',
    customPresets: [],
    cascadeToast: null,
    removeUnreachableAfterDone: false,
    ...overrides,
  };
}

const noopHandlers = {
  onChangeSourceCol: jest.fn(),
  onTogglePreset: jest.fn(),
  onSavePreset: jest.fn(),
  onDeletePreset: jest.fn(),
  onToggleExtractor: jest.fn(),
  onToggleRemoveUnreachable: jest.fn(),
  onClose: jest.fn(),
  onStart: jest.fn(),
  onResume: jest.fn(),
  onStop: jest.fn(),
};

describe('SignalEnrichmentModal — Сервисы сквозной аналитики', () => {
  afterEach(() => jest.clearAllMocks());

  it('renders the "Сервисы сквозной аналитики" preset chip', () => {
    render(
      <SignalEnrichmentModal state={makeState()} headerLabels={['Компания', 'Сайт']} {...noopHandlers} />,
    );
    // Chip is a <button> whose textContent is exactly the preset name (built-in
    // presets carry no delete "×"). The accordion group with the same title has
    // extra description/count text, so an exact-text match isolates the chip.
    const chip = screen
      .getAllByRole('button')
      .find((b) => b.textContent === 'Сервисы сквозной аналитики');
    expect(chip).toBeTruthy();
  });

  it('clicking the chip emits the analytics preset (per-service + rollup keys)', () => {
    const onTogglePreset = jest.fn();
    render(
      <SignalEnrichmentModal
        state={makeState()}
        headerLabels={['Компания', 'Сайт']}
        {...noopHandlers}
        onTogglePreset={onTogglePreset}
      />,
    );
    const chip = screen
      .getAllByRole('button')
      .find((b) => b.textContent === 'Сервисы сквозной аналитики')!;
    fireEvent.click(chip);

    expect(onTogglePreset).toHaveBeenCalledTimes(1);
    const arg = onTogglePreset.mock.calls[0][0] as { id: string; extractors: string[] };
    expect(arg.id).toBe('analytics');
    expect(arg.extractors).toEqual(BUILTIN_PRESETS.analytics.extractors);
    expect(arg.extractors).toEqual(expect.arrayContaining(['svc_roistat', 'svc_alloka', 'analytics_services']));
  });

  it('previews the per-service + rollup columns when the analytics preset is selected', () => {
    render(
      <SignalEnrichmentModal
        state={makeState({
          selectedExtractors: [...BUILTIN_PRESETS.analytics.extractors],
          presetId: 'analytics',
        })}
        headerLabels={['Компания', 'Сайт']}
        {...noopHandlers}
      />,
    );
    // Column-preview pills (collapsed accordion → these labels live only in the preview).
    expect(screen.getByText('Roistat')).toBeInTheDocument();
    expect(screen.getByText('PrimeGate')).toBeInTheDocument();
    expect(screen.getByText('UIScom')).toBeInTheDocument();
    expect(screen.getByText('Обнаружено сервисов')).toBeInTheDocument();
  });

  it('"Запустить" button counts the selected analytics signals', () => {
    render(
      <SignalEnrichmentModal
        state={makeState({
          selectedExtractors: [...BUILTIN_PRESETS.analytics.extractors],
          presetId: 'analytics',
        })}
        headerLabels={['Компания', 'Сайт']}
        {...noopHandlers}
      />,
    );
    // 2 base (stack/profile) + 13 services + 1 rollup = 16 selected extractors.
    const expected = BUILTIN_PRESETS.analytics.extractors.length;
    expect(screen.getByRole('button', { name: new RegExp(`Запустить \\(${expected} `) })).toBeInTheDocument();
  });
});
