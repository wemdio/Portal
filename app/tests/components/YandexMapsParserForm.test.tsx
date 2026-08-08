import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { YandexMapsParserForm } from '@/components/parsers/YandexMapsParserForm';
import { authFetchJson } from '@/lib/authFetch';

jest.mock('@/lib/authFetch', () => ({ authFetchJson: jest.fn() }));

const mockedFetch = authFetchJson as jest.MockedFunction<typeof authFetchJson>;

const CITIES = ['Москва', 'Королёв', 'Люберцы', 'Воскресенск', 'Чехов', 'Клин', 'Лобня', 'Дубна'];

const PLACES = CITIES.map((city, index) => ({
  country: 'Россия',
  region: 'Москва и Московская область',
  city,
  companies: 100000 - index,
}));

const RUBRICS = [
  { rubric: 'Доставка еды', companies: 54321 },
  { rubric: 'Кафе', companies: 12345 },
];

/** Справочник отдаётся GET-ом, предпросчёт «сколько найдётся» — POST-ом. */
function mockCatalogApi() {
  mockedFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { total: 4200, capped: false } as never;
    return { places: PLACES, rubrics: RUBRICS } as never;
  });
}

beforeEach(() => {
  mockedFetch.mockReset();
  mockCatalogApi();
});

describe('YandexMapsParserForm', () => {
  it('выбор городов и рубрики уходит в наш каталог, а не в Яндекс', async () => {
    const onCreate = jest.fn();
    render(<YandexMapsParserForm onCreate={onCreate} />);

    // Ждём справочник: до его загрузки форма показывает прежние статические списки.
    await screen.findByText('Доставка еды');

    CITIES.forEach((city) => fireEvent.click(screen.getByText(city)));
    fireEvent.click(screen.getByText('Доставка еды'));
    fireEvent.click(screen.getByRole('button', { name: 'Собрать' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const payload = onCreate.mock.calls[0][0];
    // Главное: прямых обращений к Яндексу нет.
    expect(payload.search_urls).toEqual([]);
    expect(payload.catalog_filters).toEqual({
      cities: CITIES,
      categories: ['Доставка еды'],
      countries: ['Россия'],
    });
    // Лимит убран из формы — отдаём всё, что нашлось, до потолка выдачи.
    expect(payload.max_results).toBe(50000);
  });

  it('без выбранных фильтров кнопка не активна', async () => {
    render(<YandexMapsParserForm onCreate={jest.fn()} />);
    await screen.findByText('Доставка еды');
    expect(screen.getByRole('button', { name: 'Собрать' })).toBeDisabled();
  });

  it('в форме больше нет ни ссылок вручную, ни лимита на запрос', async () => {
    render(<YandexMapsParserForm onCreate={jest.fn()} />);
    await screen.findByText('Доставка еды');
    expect(screen.queryByPlaceholderText(/yandex\.ru\/maps/)).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('страны берутся из каталога и переключаются', async () => {
    mockedFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { total: 0, capped: false } as never;
      return {
        places: [
          ...PLACES,
          { country: 'Казахстан', region: 'Алматы', city: 'Алматы', companies: 50000 },
        ],
        rubrics: RUBRICS,
      } as never;
    });

    render(<YandexMapsParserForm onCreate={jest.fn()} />);

    // По умолчанию показывается Россия, поэтому казахстанских городов не видно.
    await screen.findByText('Москва');
    expect(screen.queryByText('Алматы')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Казахстан/ }));
    await waitFor(() => expect(screen.getByText('Алматы')).toBeTruthy());
  });

  it('без справочника форма откатывается на прежние списки', async () => {
    mockedFetch.mockRejectedValue(new Error('каталог недоступен'));
    const onCreate = jest.fn();
    render(<YandexMapsParserForm onCreate={onCreate} />);

    // «Миллионники» — заголовок статического списка городов.
    await screen.findByText(/Миллионники/i);
    expect(screen.getByText('Москва')).toBeTruthy();
  });
});
