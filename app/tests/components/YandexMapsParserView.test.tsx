import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { YandexMapsParserView } from '@/components/parsers/YandexMapsParserView';
import { authFetchJson } from '@/lib/authFetch';

jest.mock('@/lib/authFetch', () => ({
  authFetchJson: jest.fn(),
}));

jest.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        order: jest.fn().mockResolvedValue({ data: [], error: null }),
      })),
    })),
  },
}));

jest.mock('@/components/parsers/YandexMapsParserForm', () => ({
  YandexMapsParserForm: ({
    busy,
    onCreate,
  }: {
    busy?: boolean;
    onCreate: (payload: {
      search_urls: string[];
      max_results: number;
      headless: boolean;
      proxy: {
        enabled: boolean;
        protocol: 'http';
        host: string;
        port: string;
        username: string;
        password: string;
      };
    }) => Promise<void>;
  }) => (
    <button
      type="button"
      disabled={busy}
      onClick={() => onCreate({
        search_urls: ['https://yandex.ru/maps/?text=Москва%20Доставка%20еды'],
        max_results: 5000,
        headless: true,
        proxy: {
          enabled: false,
          protocol: 'http',
          host: '',
          port: '',
          username: '',
          password: '',
        },
      })}
    >
      Запустить парсинг
    </button>
  ),
}));

const mockedAuthFetchJson = authFetchJson as jest.MockedFunction<typeof authFetchJson>;

describe('YandexMapsParserView', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockedAuthFetchJson.mockReset();
    mockedAuthFetchJson.mockImplementation(async (url) => {
      if (url === '/api/parsers/yandexmaps/queue-status') {
        return {
          running_jobs: [],
          pending_count: 0,
          free_slots: 2,
          concurrency: 2,
        };
      }
      throw new Error('Сессия истекла. Войдите заново.');
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('shows a create failure even when no job exists in history', async () => {
    render(<YandexMapsParserView />);

    fireEvent.click(screen.getByRole('button', { name: 'Запустить парсинг' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Запуск не создан. Сессия истекла. Войдите заново.');
    expect(screen.getByText('Нет запусков')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Запустить парсинг' })).toBeEnabled());
  });
});
