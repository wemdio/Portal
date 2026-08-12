import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamHrPanel from '@/components/team/TeamHrPanel';

const mockTalentReservePanel = jest.fn(() => <div>Talent reserve panel mounted</div>);
const mockReviewRequestsPanel = jest.fn(({
  onChanged,
}: {
  onChanged: () => void;
}) => (
  <div>
    <span>Review requests panel mounted</span>
    <button type="button" onClick={onChanged}>Finish request mutation</button>
  </div>
));

jest.mock('../../src/components/team/TeamTalentReservePanel', () => ({
  __esModule: true,
  default: () => mockTalentReservePanel(),
}), { virtual: true });

jest.mock('../../src/components/team/TeamReviewRequestsPanel', () => ({
  __esModule: true,
  default: (props: { onChanged: () => void }) => mockReviewRequestsPanel(props),
}), { virtual: true });

describe('<TeamHrPanel />', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses one HR workspace with two accessible nested tabs and defaults to talent reserve', () => {
    render(<TeamHrPanel newRequestCount={3} onReviewRequestsChanged={jest.fn()} />);

    expect(screen.getByRole('heading', { name: 'HR-процессы' })).toBeInTheDocument();
    const tablist = screen.getByRole('tablist', { name: 'HR-процессы' });
    expect(tablist).toHaveClass('max-w-full', 'overflow-x-auto');

    const talentTab = within(tablist).getByRole('tab', { name: 'Кадровый резерв' });
    const requestsTab = within(tablist).getByRole('tab', {
      name: 'Запросы на ревью, 3 новых',
    });
    expect(talentTab).toHaveAttribute('aria-selected', 'true');
    expect(requestsTab).toHaveAttribute('aria-selected', 'false');
    expect(talentTab).toHaveAttribute('aria-controls');
    expect(requestsTab).toHaveAttribute('aria-controls');
    expect(screen.getByRole('tabpanel', { name: 'Кадровый резерв' })).toHaveTextContent('Talent reserve panel mounted');
    expect(screen.queryByText('Review requests panel mounted')).not.toBeInTheDocument();
  });

  it('shows 99+ visually, exposes the exact count accessibly and does not clear it on open', async () => {
    const onChanged = jest.fn();
    const user = userEvent.setup();
    render(<TeamHrPanel newRequestCount={142} onReviewRequestsChanged={onChanged} />);

    const requestsTab = screen.getByRole('tab', {
      name: 'Запросы на ревью, 142 новых',
    });
    expect(requestsTab).toHaveTextContent('99+');

    await user.click(requestsTab);

    expect(requestsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Запросы на ревью' })).toHaveTextContent('Review requests panel mounted');
    expect(onChanged).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Finish request mutation' }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('hides a zero badge without putting a meaningless zero in the tab name', () => {
    render(<TeamHrPanel newRequestCount={0} onReviewRequestsChanged={jest.fn()} />);

    const requestsTab = screen.getByRole('tab', { name: 'Запросы на ревью' });
    expect(requestsTab).not.toHaveTextContent('0');
  });

  it('supports arrow, Home and End keyboard navigation between nested tabs', async () => {
    const user = userEvent.setup();
    render(<TeamHrPanel newRequestCount={1} onReviewRequestsChanged={jest.fn()} />);
    const talentTab = screen.getByRole('tab', { name: 'Кадровый резерв' });
    const requestsTab = screen.getByRole('tab', { name: 'Запросы на ревью, 1 новый' });

    talentTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(requestsTab).toHaveFocus();
    expect(requestsTab).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Home}');
    expect(talentTab).toHaveFocus();
    expect(talentTab).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{End}');
    expect(requestsTab).toHaveFocus();
    expect(requestsTab).toHaveAttribute('aria-selected', 'true');
  });
});
