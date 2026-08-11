import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useTeamReviewRequestSummary } from '@/components/team/useTeamReviewRequestSummary';

const mockTeamApiFetch = jest.fn();

jest.mock('@/components/team/teamApi', () => ({
  ...jest.requireActual('@/components/team/teamApi'),
  teamApiFetch: (...args: unknown[]) => mockTeamApiFetch(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Harness({ enabled }: { enabled: boolean }) {
  const { newCount, refresh } = useTeamReviewRequestSummary(enabled);
  return (
    <div>
      <output aria-label="Новые запросы">{newCount}</output>
      <button type="button" onClick={refresh}>Обновить после изменения</button>
    </div>
  );
}

describe('useTeamReviewRequestSummary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does not fetch or retain a private count while the capability is disabled', async () => {
    mockTeamApiFetch.mockResolvedValue({ newCount: 4 });
    const view = render(<Harness enabled={false} />);

    expect(screen.getByLabelText('Новые запросы')).toHaveTextContent('0');
    expect(mockTeamApiFetch).not.toHaveBeenCalled();

    view.rerender(<Harness enabled />);
    await waitFor(() => expect(screen.getByLabelText('Новые запросы')).toHaveTextContent('4'));
    expect(mockTeamApiFetch).toHaveBeenCalledWith('/api/team/review-requests/summary');

    view.rerender(<Harness enabled={false} />);
    expect(screen.getByLabelText('Новые запросы')).toHaveTextContent('0');
  });

  it('refreshes on focus and only on a visible visibilitychange event', async () => {
    mockTeamApiFetch
      .mockResolvedValueOnce({ newCount: 1 })
      .mockResolvedValueOnce({ newCount: 2 })
      .mockResolvedValueOnce({ newCount: 3 });
    const visibility = jest.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('visible');

    render(<Harness enabled />);
    await waitFor(() => expect(screen.getByLabelText('Новые запросы')).toHaveTextContent('1'));

    fireEvent.focus(window);
    await waitFor(() => expect(screen.getByLabelText('Новые запросы')).toHaveTextContent('2'));

    visibility.mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(mockTeamApiFetch).toHaveBeenCalledTimes(2);

    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(screen.getByLabelText('Новые запросы')).toHaveTextContent('3'));
    expect(mockTeamApiFetch).toHaveBeenCalledTimes(3);
  });

  it('polls the lightweight summary once per minute only while enabled', async () => {
    jest.useFakeTimers();
    mockTeamApiFetch
      .mockResolvedValueOnce({ newCount: 1 })
      .mockResolvedValueOnce({ newCount: 2 });

    const view = render(<Harness enabled />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Новые запросы')).toHaveTextContent('1');

    await act(async () => {
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Новые запросы')).toHaveTextContent('2');
    expect(mockTeamApiFetch).toHaveBeenCalledTimes(2);

    view.rerender(<Harness enabled={false} />);
    await act(async () => {
      jest.advanceTimersByTime(120_000);
      await Promise.resolve();
    });
    expect(mockTeamApiFetch).toHaveBeenCalledTimes(2);
  });

  it('refreshes after a mutation and ignores an older overlapping response', async () => {
    const first = deferred<{ newCount: number }>();
    const second = deferred<{ newCount: number }>();
    mockTeamApiFetch
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render(<Harness enabled />);
    await waitFor(() => expect(mockTeamApiFetch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Обновить после изменения' }));
    expect(mockTeamApiFetch).toHaveBeenCalledTimes(2);

    await act(async () => second.resolve({ newCount: 7 }));
    expect(screen.getByLabelText('Новые запросы')).toHaveTextContent('7');

    await act(async () => first.resolve({ newCount: 2 }));
    expect(screen.getByLabelText('Новые запросы')).toHaveTextContent('7');
  });
});
