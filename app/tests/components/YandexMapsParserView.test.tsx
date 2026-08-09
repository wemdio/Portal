import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { YandexMapsParserView } from '@/components/parsers/YandexMapsParserView';
import { authFetchJson } from '@/lib/authFetch';

jest.mock('@/lib/authFetch', () => ({
  authFetchJson: jest.fn(),
}));

/** Список запусков приходит из supabase напрямую, не через authFetchJson. */
const jobsFixture: { rows: unknown[] } = { rows: [] };

jest.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        order: jest.fn(async () => ({ data: jobsFixture.rows, error: null })),
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
    jobsFixture.rows = [];
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

  it('карточка запуска названа сферами и показывает условия сбора по-русски', async () => {
    const job = {
      id: 'a58c75a7-0000-4000-8000-000000000000',
      user_id: 'u1',
      status: 'running',
      config: {
        search_urls: [],
        catalog_filters: {
          cities: ['Москва', 'Москва и Московская область'],
          categories: ['Товары для дома и дачи', 'Кафе'],
          countries: ['Россия'],
        },
        max_results: null,
      },
      progress_stage: 'catalog_search',
      total_links: 0,
      processed_links: 0,
      total_organizations: 0,
      processed_organizations: 0,
      proxy_enabled: false,
      created_at: '2026-08-09T19:31:00Z',
    };
    jobsFixture.rows = [job];
    mockedAuthFetchJson.mockImplementation(async (url) => {
      if (url === '/api/parsers/yandexmaps/queue-status') {
        return { running_jobs: [], pending_count: 0, free_slots: 2, concurrency: 2 };
      }
      if (String(url).includes('/results')) return { organizations: [] };
      throw new Error(`unexpected ${url}`);
    });

    render(<YandexMapsParserView />);

    // Карточка открывается кликом по запуску в истории.
    fireEvent.click(await screen.findByText('#a58c75a7'));

    // Заголовок — сферы, а не безликий номер запуска.
    await screen.findByRole('heading', { name: 'Товары для дома и дачи, Кафе' });
    // Этап по-русски: раньше на экран утекало «catalog_search».
    expect(screen.getByText('Собираем из базы')).toBeInTheDocument();
    expect(screen.queryByText('catalog_search')).toBeNull();
    // Условия сбора видны целиком.
    expect(screen.getByText('Москва, Москва и Московская область')).toBeInTheDocument();
    expect(screen.getByText('Россия')).toBeInTheDocument();
    // Редактора ссылок больше нет: нужны только результаты.
    expect(screen.queryByText('Ссылки организаций')).toBeNull();
  });
});
