import { render, screen } from '@testing-library/react';
import type { VeBaseAudienceSummary } from '@/lib/verticalEngineV2/baseAudienceSummary';
import type { VeBaseSummary } from '@/components/vertical-engine-v2/engine/api';
import { AudienceSummary } from '@/components/vertical-engine-v2/engine/AutoOutreachProject';

const mockVeEngineCall = jest.fn();

jest.mock('@/components/vertical-engine-v2/engine/api', () => ({
  VE_API: '/api/tools/vertical-engine-v2',
  veEngineCall: (...args: unknown[]) => mockVeEngineCall(...args),
  veEnginePost: jest.fn(),
  veEnginePatch: jest.fn(),
}));

// Прогноз базы «Мясопереработка» после второй очереди: 2 426 компаний среза ещё не
// просмотрены, выход 40 контактов (30 компаний) на 1 000 обработанных.
const summary: VeBaseAudienceSummary = {
  base_id: 'b1', hypothesis_id: 'h1', ready: 40, checked_ready: 40, excluded_blocked: 0, excluded_used: 0,
  client_exclusions_applied: false, processed_candidates: 1_000, preview_target: null,
  observed_yield: { candidates: 1_000, ready: 40, contacts_per_candidate: 0.04, as_of: '2026-09-22T10:00:00.000Z', ready_companies: 30 },
  estimate: { contacts: 97, companies: 73, remaining_companies: 2_426, as_of: '2026-09-22T10:00:00.000Z', confidence: 'low',
    scope: 'Считаются компании реестра под условия гипотезы, без повторов и без компаний других баз проекта. Это прогноз по текущему выходу, а не гарантированный остаток.' },
  estimate_reason: null, updated_at: '2026-09-22T10:00:00.000Z', measured_at: '2026-09-24T12:00:00.000Z',
};

const base = { id: 'b1', status: 'analyzed', collect_info: { collection_mode: 'supply' } } as unknown as VeBaseSummary;

describe('AudienceSummary remaining-market estimate', () => {
  it('shows contacts next to companies, the estimate date and that these are new companies', async () => {
    mockVeEngineCall.mockResolvedValue({ ok: true, data: summary });
    render(<AudienceSummary base={base} presetId="" preparationState={{ title: '', description: '', currentStep: null, tone: 'ok' }} />);
    const line = await screen.findByText((_, node) => node?.tagName === 'P'
      && (node.textContent ?? '').startsWith('Предварительная оценка добора: ~97 контактов (≈73 компаний)'));
    expect(line.textContent).toContain('Это оценка новых компаний, а не дополнительных адресов уже найденных');
    expect(line.textContent).toContain('не означает, что добор идёт');
    expect(line.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText(/Оценка с низкой уверенностью от/)).toBeInTheDocument();
    expect(screen.getByText(/осталось 2\s426 компаний, которые база ещё не смотрела/)).toBeInTheDocument();
  });
});
