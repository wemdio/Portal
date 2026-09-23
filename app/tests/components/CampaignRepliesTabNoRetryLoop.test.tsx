/**
 * Вкладка «Ответы» на странице кампании не крутит запросы в цикле после ошибки.
 *
 * Эффект ленивой загрузки срабатывал при `!repliesLoaded && !repliesLoading`.
 * После ошибки loaded оставался false, loading возвращался в false — и эффект
 * тут же запускал новый запрос, без паузы, пока один не пройдёт (ошибка с
 * 30.04, найдена перепроверкой 22.09). Каждый такой запрос занимает слот общего
 * бюджета чтения писем — теперь людской доли, которой пользуются все на
 * воркспейсе. После ошибки повтор — только кнопкой «Повторить».
 */

import { act, fireEvent, render, screen } from '@testing-library/react';

const calls: string[] = [];
let failReplies = true;

jest.mock('next/navigation', () => ({
  useParams: () => ({ id: 'cmp-1' }),
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams('tab=replies'),
}));

jest.mock('@/lib/clientFetcher', () => ({
  clientApiFetch: jest.fn(async (path: string) => {
    calls.push(path);
    if (path.includes('/replies')) {
      if (failReplies) throw new Error('Не удалось загрузить ответы');
      return { items: [], next_starting_after: null };
    }
    return { campaign: { id: 'cmp-1', name: 'Кампания', status: 1, sequences: [] }, analytics: null, steps: [] };
  }),
}));

async function settle(ticks = 30) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const repliesCalls = () => calls.filter((c) => c.includes('/replies')).length;

it('после ошибки — один запрос, повтор только по кнопке', async () => {
  const Page = (await import('@/app/client/campaigns/[id]/page')).default;
  render(<Page />);
  await settle();

  expect(repliesCalls()).toBe(1);
  expect(screen.getByText('Не удалось загрузить ответы')).toBeInTheDocument();

  failReplies = false;
  fireEvent.click(screen.getByRole('button', { name: /Повторить/ }));
  await settle();

  expect(repliesCalls()).toBe(2);
  expect(screen.queryByText('Не удалось загрузить ответы')).not.toBeInTheDocument();
}, 30_000);
