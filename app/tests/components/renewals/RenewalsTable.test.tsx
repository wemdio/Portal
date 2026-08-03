import { fireEvent, render, screen, within } from '@testing-library/react';
import RenewalsTable from '@/components/renewals/RenewalsTable';
import type { RenewalTableRow } from '@/lib/renewals/tableRows';

function row(over: Partial<RenewalTableRow> = {}): RenewalTableRow {
  return {
    transactionId: 1,
    client: 'Клиент',
    inn: '7714379242',
    amount: 100,
    paymentDate: '2026-07-01',
    method: 'task_text',
    methodLabel: 'текст задачи AMO',
    note: null,
    purpose: 'Оплата услуг',
    amoDealId: null,
    amoDealUrl: null,
    ...over,
  };
}

// Порядок, в котором приходят строки, — это уже отсортированный дефолт
// («свежие сверху»), который отдаёт buildRenewalTableRows. Таблица не должна
// его трогать, пока пользователь не кликнул по заголовку.
const DEFAULT_ORDER: RenewalTableRow[] = [
  row({ transactionId: 2, client: 'Бета', amount: 200 }),
  row({ transactionId: 1, client: 'Альфа', amount: 20 }),
  row({ transactionId: 3, client: 'Вета', amount: 100 }),
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

describe('RenewalsTable — ссылка на сделку AMO', () => {
  it('показывает ссылку, когда она есть', () => {
    render(<RenewalsTable rows={[row({ amoDealId: 33462035, amoDealUrl: 'https://x.amocrm.ru/leads/detail/33462035' })]} />);
    const link = screen.getByRole('link', { name: '#33462035' });
    expect(link).toHaveAttribute('href', 'https://x.amocrm.ru/leads/detail/33462035');
  });

  it('без сделки показывает прочерк', () => {
    render(<RenewalsTable rows={[row({ amoDealId: null, amoDealUrl: null })]} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
