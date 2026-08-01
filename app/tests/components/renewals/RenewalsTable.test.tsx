import { fireEvent, render, screen, within } from '@testing-library/react';
import RenewalsTable from '@/components/renewals/RenewalsTable';
import type { RenewalTableRow } from '@/lib/renewals/tableRows';

function row(over: Partial<RenewalTableRow> = {}): RenewalTableRow {
  return {
    id: 'r',
    client: 'Клиент',
    name: 'Услуга',
    budget: 100,
    budgetRaw: '100',
    paymentDate: '2026-07-01',
    isPlanned: false,
    contractDate: null,
    kpiFact: null,
    kpiFactRaw: null,
    status: 'В работе',
    manager: null,
    ...over,
  };
}

// Порядок, в котором приходят строки, — это уже отсортированный дефолт
// («свежие сверху»), который отдаёт buildRenewalTableRows. Таблица не должна
// его трогать, пока пользователь не кликнул по заголовку.
const DEFAULT_ORDER: RenewalTableRow[] = [
  row({ id: 'b', client: 'Бета', budget: 200 }),
  row({ id: 'a', client: 'Альфа', budget: 20 }),
  row({ id: 'c', client: 'Вета', budget: 100 }),
];

function clientCells() {
  const table = screen.getByRole('table');
  const body = within(table).getAllByRole('row').slice(1); // без строки заголовка
  return body.map((r) => within(r).getAllByRole('cell')[0].textContent);
}

describe('RenewalsTable — сортировка по клику на заголовок', () => {
  it('без клика показывает строки в порядке, который пришёл с сервера', () => {
    render(<RenewalsTable rows={DEFAULT_ORDER} />);
    expect(clientCells()).toEqual(['Бета', 'Альфа', 'Вета']);
  });

  it('первый клик по «Сумма» — возрастание', () => {
    render(<RenewalsTable rows={DEFAULT_ORDER} />);
    fireEvent.click(screen.getByRole('button', { name: /Сумма/ }));
    expect(clientCells()).toEqual(['Альфа', 'Вета', 'Бета']); // 20, 100, 200
  });

  it('второй клик — убывание', () => {
    render(<RenewalsTable rows={DEFAULT_ORDER} />);
    const header = screen.getByRole('button', { name: /Сумма/ });
    fireEvent.click(header);
    fireEvent.click(header);
    expect(clientCells()).toEqual(['Бета', 'Вета', 'Альфа']); // 200, 100, 20
  });

  it('третий клик сбрасывает к исходному порядку сервера', () => {
    render(<RenewalsTable rows={DEFAULT_ORDER} />);
    const header = screen.getByRole('button', { name: /Сумма/ });
    fireEvent.click(header);
    fireEvent.click(header);
    fireEvent.click(header);
    expect(clientCells()).toEqual(['Бета', 'Альфа', 'Вета']); // назад к исходному
  });

  it('строки без суммы уходят в конец при сортировке в обе стороны', () => {
    const rows = [
      row({ id: 'has-budget', client: 'Есть сумма', budget: 50 }),
      row({ id: 'no-budget', client: 'Без суммы', budget: null, budgetRaw: 'н/д' }),
    ];
    render(<RenewalsTable rows={rows} />);
    const header = screen.getByRole('button', { name: /Сумма/ });

    fireEvent.click(header); // asc
    expect(clientCells()).toEqual(['Есть сумма', 'Без суммы']);

    fireEvent.click(header); // desc
    expect(clientCells()).toEqual(['Есть сумма', 'Без суммы']);
  });

  it('сортировка по клиенту — через ru-локаль (алфавитный порядок)', () => {
    render(<RenewalsTable rows={DEFAULT_ORDER} />);
    fireEvent.click(screen.getByRole('button', { name: /Клиент/ }));
    expect(clientCells()).toEqual(['Альфа', 'Бета', 'Вета']);
  });

  it('заголовок сообщает механику трёх кликов через title', () => {
    render(<RenewalsTable rows={DEFAULT_ORDER} />);
    const header = screen.getByRole('button', { name: /Сумма/ });
    expect(header).toHaveAttribute('title', expect.stringContaining('возрастан'));
    expect(header).toHaveAttribute('title', expect.stringContaining('исходный'));
  });

  it('aria-sort у активной колонки соответствует направлению', () => {
    render(<RenewalsTable rows={DEFAULT_ORDER} />);
    const amountTh = screen.getByRole('columnheader', { name: /Сумма/ });
    expect(amountTh).toHaveAttribute('aria-sort', 'none');

    fireEvent.click(within(amountTh).getByRole('button'));
    expect(amountTh).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(within(amountTh).getByRole('button'));
    expect(amountTh).toHaveAttribute('aria-sort', 'descending');
  });
});
