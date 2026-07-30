/**
 * Пагинация списков AI-звонилки (вкладки «Ассистенты», «Обзвон», «Аналитика»,
 * «История»). Раньше списки рисовались целиком — 359 анализов одной простынёй.
 *
 * Контракт:
 *   const { page, setPage, pageItems, totalPages, total } = usePagination(items, resetKey?)
 *   <Pagination page totalPages total onPageChange unit />
 *
 * Ключевые правила: 30 записей на страницу, смена фильтра (resetKey) возвращает
 * на первую страницу, укоротившийся список не оставляет пользователя на пустой
 * странице.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AI_CALLER_PAGE_SIZE,
  Pagination,
  pageWindow,
  usePagination,
} from '@/components/ai-caller/Pagination';

describe('pageWindow', () => {
  it('shows every page while there are few of them', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('collapses the middle with a single gap near the edges', () => {
    expect(pageWindow(1, 12)).toEqual([1, 2, 'gap', 12]);
    expect(pageWindow(12, 12)).toEqual([1, 'gap', 11, 12]);
  });

  it('keeps neighbours around the current page', () => {
    expect(pageWindow(6, 12)).toEqual([1, 'gap', 5, 6, 7, 'gap', 12]);
  });
});

describe('<Pagination />', () => {
  it('renders nothing when everything fits on one page', () => {
    const { container } = render(
      <Pagination page={1} totalPages={1} total={12} onPageChange={jest.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('reports the visible range and the total', () => {
    render(
      <Pagination
        page={2}
        totalPages={3}
        total={65}
        onPageChange={jest.fn()}
        unit="звонков"
      />,
    );
    expect(screen.getByText('Показано 31–60 из 65 звонков')).toBeInTheDocument();
  });

  it('clamps the last page to the real total', () => {
    render(<Pagination page={3} totalPages={3} total={65} onPageChange={jest.fn()} />);
    expect(screen.getByText('Показано 61–65 из 65 записей')).toBeInTheDocument();
  });

  it('moves back and forth, and blocks the edges', async () => {
    const onPageChange = jest.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <Pagination page={1} totalPages={3} total={65} onPageChange={onPageChange} />,
    );

    expect(screen.getByRole('button', { name: 'Предыдущая страница' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Следующая страница' }));
    expect(onPageChange).toHaveBeenCalledWith(2);

    rerender(
      <Pagination page={3} totalPages={3} total={65} onPageChange={onPageChange} />,
    );
    expect(screen.getByRole('button', { name: 'Следующая страница' })).toBeDisabled();
  });

  it('jumps straight to a page number', async () => {
    const onPageChange = jest.fn();
    const user = userEvent.setup();

    render(<Pagination page={1} totalPages={3} total={65} onPageChange={onPageChange} />);
    await user.click(screen.getByRole('button', { name: '3' }));

    expect(onPageChange).toHaveBeenCalledWith(3);
  });
});

/* ── usePagination ───────────────────────────────────────────────────────── */

function Harness({ items, resetKey }: { items: string[]; resetKey?: unknown }) {
  const { page, setPage, pageItems, totalPages, total } = usePagination(items, resetKey);

  return (
    <div>
      <span data-testid="state">{`${page}/${totalPages} of ${total}`}</span>
      <span data-testid="first">{pageItems[0] ?? '—'}</span>
      <span data-testid="count">{pageItems.length}</span>
      <button onClick={() => setPage(page + 1)}>next</button>
    </div>
  );
}

const items = (n: number) => Array.from({ length: n }, (_, i) => `item-${i + 1}`);

describe('usePagination', () => {
  it('cuts the list into pages of 30', async () => {
    const user = userEvent.setup();
    render(<Harness items={items(65)} />);

    expect(AI_CALLER_PAGE_SIZE).toBe(30);
    expect(screen.getByTestId('state')).toHaveTextContent('1/3 of 65');
    expect(screen.getByTestId('first')).toHaveTextContent('item-1');
    expect(screen.getByTestId('count')).toHaveTextContent('30');

    await user.click(screen.getByRole('button', { name: 'next' }));
    expect(screen.getByTestId('first')).toHaveTextContent('item-31');

    await user.click(screen.getByRole('button', { name: 'next' }));
    expect(screen.getByTestId('state')).toHaveTextContent('3/3 of 65');
    expect(screen.getByTestId('count')).toHaveTextContent('5');
  });

  it('returns to the first page when the filter changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness items={items(65)} resetKey="all" />);

    await user.click(screen.getByRole('button', { name: 'next' }));
    expect(screen.getByTestId('first')).toHaveTextContent('item-31');

    rerender(<Harness items={items(65)} resetKey="interested" />);
    expect(screen.getByTestId('state')).toHaveTextContent('1/3 of 65');
    expect(screen.getByTestId('first')).toHaveTextContent('item-1');
  });

  it('never strands the user on a page that no longer exists', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness items={items(65)} />);

    await user.click(screen.getByRole('button', { name: 'next' }));
    await user.click(screen.getByRole('button', { name: 'next' }));
    expect(screen.getByTestId('state')).toHaveTextContent('3/3 of 65');

    // список схлопнулся до одной страницы — показываем её, а не пустоту
    rerender(<Harness items={items(10)} />);
    expect(screen.getByTestId('state')).toHaveTextContent('1/1 of 10');
    expect(screen.getByTestId('count')).toHaveTextContent('10');
  });

  it('handles an empty list without breaking', () => {
    render(<Harness items={[]} />);
    expect(screen.getByTestId('state')).toHaveTextContent('1/1 of 0');
    expect(screen.getByTestId('first')).toHaveTextContent('—');
  });
});
