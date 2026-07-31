import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TopNavDropdown } from '@/components/TopNavDropdown';

jest.mock('next/link', () => {
  const MockLink = ({
    children,
    href,
    prefetch: _prefetch,
    ...rest
  }: { children: ReactNode; href: string; prefetch?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  );
  MockLink.displayName = 'MockLink';
  return { __esModule: true, default: MockLink };
});

const items = [
  { id: 'first-sales', href: '/analytics/first-sales', label: 'Первичка', isActive: false },
  { id: 'expenses', href: '/expenses', label: 'Расходы и доходы', isActive: false },
];

function renderDropdown(overrides: Partial<React.ComponentProps<typeof TopNavDropdown>> = {}) {
  return render(<TopNavDropdown label="Дашборды" items={items} isActive={false} {...overrides} />);
}

function trigger() {
  return screen.getByRole('button', { name: /Дашборды/ });
}

describe('TopNavDropdown', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('по умолчанию список закрыт', () => {
    renderDropdown();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('открывается наведением и показывает все переданные пункты', () => {
    const { container } = renderDropdown();
    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem').map((node) => node.textContent)).toEqual([
      'Первичка',
      'Расходы и доходы',
    ]);
  });

  it('не закрывается мгновенно — у курсора есть время долететь до списка', () => {
    const { container } = renderDropdown();
    const root = container.firstChild as HTMLElement;
    fireEvent.mouseEnter(root);
    fireEvent.mouseLeave(root);

    act(() => { jest.advanceTimersByTime(100); });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    act(() => { jest.advanceTimersByTime(200); });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('возврат курсора внутрь отменяет запланированное закрытие', () => {
    const { container } = renderDropdown();
    const root = container.firstChild as HTMLElement;
    fireEvent.mouseEnter(root);
    fireEvent.mouseLeave(root);
    fireEvent.mouseEnter(screen.getByRole('menu').parentElement as HTMLElement);

    act(() => { jest.advanceTimersByTime(500); });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('на тач-устройстве наведения нет — список открывается тапом', () => {
    // Тап присылает синтетический mouseenter перед click; если бы наведение
    // работало и там, меню открылось бы и тут же закрылось собственным кликом.
    Object.defineProperty(window, 'matchMedia', {
      value: jest.fn().mockReturnValue({ matches: false }),
      configurable: true,
      writable: true,
    });
    try {
      const { container } = renderDropdown();
      fireEvent.mouseEnter(container.firstChild as HTMLElement);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();

      fireEvent.click(trigger(), { detail: 1 });
      expect(screen.getByRole('menu')).toBeInTheDocument();
    } finally {
      delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    }
  });

  it('открывается кликом — сценарий тач-устройств', () => {
    renderDropdown();
    fireEvent.click(trigger(), { detail: 1 });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(trigger(), { detail: 1 });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Enter на кнопке открывает список и уводит фокус на первый пункт', () => {
    renderDropdown();
    // Клавиатурная активация кнопки приходит как click с detail === 0.
    fireEvent.click(trigger(), { detail: 0 });
    expect(screen.getAllByRole('menuitem')[0]).toHaveFocus();
  });

  it('стрелка вниз открывает список, стрелки ходят по пунктам', () => {
    renderDropdown();
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    const options = screen.getAllByRole('menuitem');
    expect(options[0]).toHaveFocus();

    fireEvent.keyDown(options[0], { key: 'ArrowDown' });
    expect(options[1]).toHaveFocus();

    fireEvent.keyDown(options[1], { key: 'ArrowUp' });
    expect(options[0]).toHaveFocus();
  });

  it('стрелка вверх открывает список на последнем пункте', () => {
    renderDropdown();
    fireEvent.keyDown(trigger(), { key: 'ArrowUp' });
    const options = screen.getAllByRole('menuitem');
    expect(options[options.length - 1]).toHaveFocus();
  });

  it('Esc закрывает список и возвращает фокус на кнопку', () => {
    renderDropdown();
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('единственный доступный пункт — список из одной строки', () => {
    renderDropdown({ items: [items[0]] });
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  });
});
