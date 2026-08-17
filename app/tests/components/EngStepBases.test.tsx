/**
 * Render-smoke для <EngStepBases /> (шаг 4 «Bases & Launch») в части объяснимости
 * решений автопилота.
 *
 * Зачем отдельный тест. С появлением пробы каталожного среза автопилот умеет
 * ОТКАЗАТЬСЯ строить базу, а раньше экран показывал у такой базы только бейдж
 * 'failed' и «0 rows»: причина не выбиралась из БД (HE_BASE_LIST_COLUMNS), не
 * входила в DTO и не рисовалась. Отказ читался как поломка. Здесь проверяем,
 * что причина и итог пробы доходят до экрана.
 */

import { render, screen } from '@testing-library/react';
import { EngStepBases } from '@/components/client-eng/EngStepBases';
import type { EngDetail } from '@/components/client-eng/EngProjectWizard';
import type { EngBaseSummary } from '@/components/client-eng/api-client';
import type { HeVertical } from '@/lib/hypothesisEngine/types';

const VERTICAL = { id: 'v1', project_id: 'p1', name: 'Franchise Brands' } as unknown as HeVertical;

function base(overrides: Partial<EngBaseSummary> = {}): EngBaseSummary {
  return {
    id: 'b1',
    vertical_id: 'v1',
    filename: 'auto: Franchise Brands',
    status: 'analyzed',
    row_count: 833,
    columns: [],
    sample_rows: [],
    analysis: null,
    source: 'auto',
    created_at: '2026-08-15T00:00:00Z',
    ...overrides,
  } as EngBaseSummary;
}

function detail(bases: EngBaseSummary[]): EngDetail {
  return {
    project: { id: 'p1', name: 'P', status: 'researched', market: 'us' },
    verticals: [VERTICAL],
    hypotheses: [],
    chains: [],
    bases,
    templates: [],
    jobs: [],
  } as unknown as EngDetail;
}

describe('<EngStepBases /> — объяснимость решений автопилота', () => {
  it('отказ пробы: показывает причину, долю попадания и примеры мимо вертикали', () => {
    render(
      <EngStepBases
        detail={detail([
          base({
            status: 'failed',
            row_count: 0,
            error: 'Вертикаль «Franchise Brands» не покрывается каталогом: подошло 3% из 30 компаний.',
            collect_info: {
              slice_probe: {
                outcome: 'rejected',
                hit_rate: 0.03,
                sampled: 30,
                off_target_examples: ['Le Bilboquet Denver', 'Findlay Family YMCA'],
              },
            },
          }),
        ])}
        onChanged={() => {}}
      />,
    );

    // Причина падения — раньше её на экране не было вовсе.
    expect(screen.getByText(/не покрывается каталогом/)).toBeInTheDocument();
    // Итог пробы: доля, размер выборки и на чём именно решение принято.
    expect(screen.getByText(/only 3% of 30 sampled companies/)).toBeInTheDocument();
    expect(screen.getByText(/Le Bilboquet Denver/)).toBeInTheDocument();
    // Отказ подан как решение, а не как сбой.
    expect(screen.getByText(/not built on purpose/)).toBeInTheDocument();
  });

  it('срез заменён: видно, что было и что стало', () => {
    render(
      <EngStepBases
        detail={detail([
          base({
            collect_info: {
              slice_probe: { outcome: 'repaired', hit_rate: 0.8, first_hit_rate: 0.1, sampled: 30 },
            },
          }),
        ])}
        onChanged={() => {}}
      />,
    );

    expect(screen.getByText(/matched the vertical in 10%/)).toBeInTheDocument();
    expect(screen.getByText(/new one matches 80%/)).toBeInTheDocument();
  });

  it('каталог добавлен в план, где его не было', () => {
    render(
      <EngStepBases
        detail={detail([
          base({ collect_info: { plan_repair: { reason: 'no_catalog_source', outcome: 'repaired' } } })
        ])}
        onChanged={() => {}}
      />,
    );

    expect(screen.getByText(/no company catalog — the autopilot added one/)).toBeInTheDocument();
  });

  it('обычная база без решений автопилота: лишнего блока нет', () => {
    render(<EngStepBases detail={detail([base()])} onChanged={() => {}} />);

    expect(screen.queryByText(/Audience check/)).not.toBeInTheDocument();
    expect(screen.queryByText(/company catalog/)).not.toBeInTheDocument();
  });
});
