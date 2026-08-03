import { fireEvent, render, screen } from '@testing-library/react';
import RenewalsUndatedSection from '@/components/renewals/RenewalsUndatedSection';
import type { RenewalTableRow } from '@/lib/renewals/tableRows';

function row(over: Partial<RenewalTableRow> = {}): RenewalTableRow {
  return {
    id: 'r',
    client: 'Клиент без даты',
    name: 'Услуга',
    budget: 100,
    budgetRaw: '100',
    paymentDate: null,
    isPlanned: false,
    contractDate: null,
    kpiFact: null,
    kpiFactRaw: null,
    status: null,
    manager: null,
    ...over,
  };
}

describe('RenewalsUndatedSection', () => {
  it('ничего не рендерит, когда продлений без даты нет', () => {
    const { container } = render(<RenewalsUndatedSection rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('свёрнут по умолчанию: заголовок с количеством виден, таблицы строк — нет', () => {
    render(<RenewalsUndatedSection rows={[row({ id: 'a' }), row({ id: 'b' })]} />);
    expect(screen.getByText(/Продления без даты оплаты \(2\)/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('клик по заголовку раскрывает таблицу со строками', () => {
    render(<RenewalsUndatedSection rows={[row({ id: 'a', client: 'ООО Ромашка' })]} />);
    fireEvent.click(screen.getByRole('button', { name: /Продления без даты оплаты/ }));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('ООО Ромашка')).toBeInTheDocument();
  });

  it('повторный клик снова сворачивает блок', () => {
    render(<RenewalsUndatedSection rows={[row({ id: 'a' })]} />);
    const header = screen.getByRole('button', { name: /Продления без даты оплаты/ });
    fireEvent.click(header);
    expect(screen.getByRole('table')).toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('aria-expanded отражает текущее состояние', () => {
    render(<RenewalsUndatedSection rows={[row({ id: 'a' })]} />);
    const header = screen.getByRole('button', { name: /Продления без даты оплаты/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });
});
