import { fireEvent, render, screen, within } from '@testing-library/react';
import VendorBreakdown from '@/components/expenses/VendorBreakdown';
import type { VendorBreakdownItem } from '@/lib/expenses/types';

function item(over: Partial<VendorBreakdownItem> = {}): VendorBreakdownItem {
  return {
    vendorId: 'v',
    vendorName: 'Вендор',
    category: null,
    total: 100,
    ops: 1,
    share: 0.5,
    deltaPrev: null,
    unconvertedCount: 0,
    unconvertedByCurrency: {},
    ...over,
  };
}

// Порядок, в котором приходят `items`, — уже отсортированный сервером дефолт
// (по убыванию суммы, см. aggregate.ts). Таблица не должна его трогать, пока
// пользователь не кликнул по заголовку.
const DEFAULT_ORDER: VendorBreakdownItem[] = [
  item({ vendorId: 'b', vendorName: 'Бета', total: 200 }),
  item({ vendorId: 'a', vendorName: 'Альфа', total: 20 }),
  item({ vendorId: 'c', vendorName: 'Вета', total: 100 }),
];

function vendorCells() {
  const table = screen.getByRole('table');
  const body = within(table).getAllByRole('row').slice(1); // без строки заголовка
  // Первая ячейка — кнопка раскрытия строки с префиксом «▸ »/«▾ » перед
  // именем вендора (см. RowGroup) — обрезаем его, сравниваем только имя.
  return body.map((r) => within(r).getAllByRole('cell')[0].textContent?.replace(/^[▸▾]\s*/, ''));
}

describe('VendorBreakdown — сортировка таблицы по клику на заголовок', () => {
  it('без клика показывает строки в порядке, который пришёл с сервера', () => {
    render(<VendorBreakdown items={DEFAULT_ORDER} query="" queueQuery="" />);
    expect(vendorCells()).toEqual(['Бета', 'Альфа', 'Вета']);
  });

  it('первый клик по «Сумма» — возрастание', () => {
    render(<VendorBreakdown items={DEFAULT_ORDER} query="" queueQuery="" />);
    fireEvent.click(screen.getByRole('button', { name: /Сумма/ }));
    expect(vendorCells()).toEqual(['Альфа', 'Вета', 'Бета']); // 20, 100, 200
  });

  it('второй клик — убывание, третий — сброс к исходному порядку', () => {
    render(<VendorBreakdown items={DEFAULT_ORDER} query="" queueQuery="" />);
    const header = screen.getByRole('button', { name: /Сумма/ });

    fireEvent.click(header);
    fireEvent.click(header);
    expect(vendorCells()).toEqual(['Бета', 'Вета', 'Альфа']); // 200, 100, 20

    fireEvent.click(header);
    expect(vendorCells()).toEqual(['Бета', 'Альфа', 'Вета']); // назад к исходному
  });

  it('сортировка по вендору — через ru-локаль (алфавитный порядок)', () => {
    render(<VendorBreakdown items={DEFAULT_ORDER} query="" queueQuery="" />);
    fireEvent.click(screen.getByRole('button', { name: /^Вендор$/ }));
    expect(vendorCells()).toEqual(['Альфа', 'Бета', 'Вета']);
  });

  it('«Доля» не кликабельна — она всегда даёт тот же порядок, что «Сумма»', () => {
    render(<VendorBreakdown items={DEFAULT_ORDER} query="" queueQuery="" />);
    const shareHeader = screen.getByRole('columnheader', { name: 'Доля' });
    expect(within(shareHeader).queryByRole('button')).toBeNull();
  });

  it('строки без Δ уходят в конец при сортировке по Δ в обе стороны', () => {
    const rows = [
      item({ vendorId: 'has-delta', vendorName: 'Есть дельта', deltaPrev: 5 }),
      item({ vendorId: 'no-delta', vendorName: 'Без дельты', deltaPrev: null }),
    ];
    render(<VendorBreakdown items={rows} query="" queueQuery="" />);
    const header = screen.getByRole('button', { name: 'Δ' });

    fireEvent.click(header); // asc
    expect(vendorCells()).toEqual(['Есть дельта', 'Без дельты']);

    fireEvent.click(header); // desc
    expect(vendorCells()).toEqual(['Есть дельта', 'Без дельты']);
  });
});
