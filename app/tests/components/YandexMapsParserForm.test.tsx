import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { YandexMapsParserForm } from '@/components/parsers/YandexMapsParserForm';
import { authFetchJson } from '@/lib/authFetch';

jest.mock('@/lib/authFetch', () => ({ authFetchJson: jest.fn() }));

const mockedFetch = authFetchJson as jest.MockedFunction<typeof authFetchJson>;

const CITIES = ['Москва', 'Королёв', 'Люберцы', 'Воскресенск', 'Чехов', 'Клин', 'Лобня', 'Дубна'];

const REGION = 'Москва и Московская область';

const PLACES = CITIES.map((city, index) => ({
  country: 'Россия',
  region: REGION,
  city,
  companies: 100000 - index,
}));

const RUBRICS = [
  { rubric: 'Доставка еды', companies: 54321, with_contacts: 48000 },
  { rubric: 'Кафе', companies: 12345, with_contacts: 10000 },
  // Объект карты: в каталоге таких сотни тысяч, но звонить там некому.
  { rubric: 'Скамейки', companies: 554000, with_contacts: 20 },
];

/** Справочник отдаётся GET-ом, предпросчёт «сколько найдётся» — POST-ом. */
function mockCatalogApi() {
  mockedFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { total: 4200, capped: false } as never;
    return { places: PLACES, rubrics: RUBRICS } as never;
  });
}

/** Клик по пункту именно в списке: то же название есть в чипах и быстрых кнопках. */
function clickInPicker(testId: string, text: string) {
  const picker = screen.getByTestId(testId);
  const options = within(picker).getAllByText(text);
  fireEvent.click(options[options.length - 1]);
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
    await screen.findByTestId('rubric-picker');
    await within(screen.getByTestId('rubric-picker')).findByText('Доставка еды');

    CITIES.forEach((city) => clickInPicker('city-picker', city));
    clickInPicker('rubric-picker', 'Доставка еды');
    fireEvent.click(screen.getByRole('button', { name: 'Собрать базу' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const payload = onCreate.mock.calls[0][0];
    expect(payload.catalog_filters).toEqual({
      cities: CITIES,
      categories: ['Доставка еды'],
      countries: ['Россия'],
    });
    // Ни ссылок, ни объёма: запуск идёт в свою базу, потолок ставит сервер.
    expect(payload.search_urls).toBeUndefined();
    expect(payload.max_results).toBeUndefined();
  });

  it('регион берётся целиком одним значением, а не списком его городов', async () => {
    const onCreate = jest.fn();
    render(<YandexMapsParserForm onCreate={onCreate} />);
    await within(await screen.findByTestId('city-picker')).findByText(REGION);

    fireEvent.click(within(screen.getByTestId('city-picker')).getByRole('button', { name: 'весь регион' }));
    clickInPicker('rubric-picker', 'Кафе');
    fireEvent.click(screen.getByRole('button', { name: 'Собрать базу' }));

    const payload = onCreate.mock.calls[0][0];
    // Регион, а не восемь городов: поиск сверяет выбранное и с city, и с region,
    // поэтому организации региона без города тоже попадают в выборку.
    expect(payload.catalog_filters.cities).toEqual([REGION]);
  });

  it('«выбрать все» отдаёт регионы, а не тысячи городов', async () => {
    const onCreate = jest.fn();
    render(<YandexMapsParserForm onCreate={onCreate} />);
    await within(await screen.findByTestId('city-picker')).findByText(REGION);

    fireEvent.click(screen.getByRole('button', { name: 'Выбрать все' }));
    clickInPicker('rubric-picker', 'Кафе');
    fireEvent.click(screen.getByRole('button', { name: 'Собрать базу' }));

    expect(onCreate.mock.calls[0][0].catalog_filters.cities).toEqual([REGION]);
  });

  it('рубрики без контактов спрятаны, пока фильтр включён', async () => {
    render(<YandexMapsParserForm onCreate={jest.fn()} />);
    const rubrics = await screen.findByTestId('rubric-picker');
    await within(rubrics).findByText('Доставка еды');

    // «Скамейки» — крупнейшая рубрика набора, но телефон есть у 0%.
    expect(within(rubrics).queryByText('Скамейки')).toBeNull();

    fireEvent.click(within(rubrics).getByRole('button', { name: /только с контактами/ }));
    await waitFor(() => expect(within(rubrics).getByText('Скамейки')).toBeTruthy());
  });

  it('выбранное видно чипами и снимается по одному', async () => {
    render(<YandexMapsParserForm onCreate={jest.fn()} />);
    const cities = await screen.findByTestId('city-picker');
    await within(cities).findByText('Москва');

    clickInPicker('city-picker', 'Москва');
    const chip = within(cities).getByRole('button', { name: 'Убрать Москва' });
    fireEvent.click(chip);
    await waitFor(() => expect(within(cities).queryByRole('button', { name: 'Убрать Москва' })).toBeNull());
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
    const cities = await screen.findByTestId('city-picker');
    await within(cities).findByText('Москва');
    expect(within(cities).queryByText('Алматы')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Казахстан/ }));
    await waitFor(() => expect(within(cities).getAllByText('Алматы').length).toBeGreaterThan(0));
  });

  it('у оператора нет поля ссылок, а объём необязателен и по умолчанию пуст', async () => {
    const onCreate = jest.fn();
    render(<YandexMapsParserForm onCreate={onCreate} />);
    await within(await screen.findByTestId('rubric-picker')).findByText('Доставка еды');

    expect(screen.queryByPlaceholderText(/yandex\.ru\/maps/)).toBeNull();
    // Поле объёма есть, но пустое: пусто означает «забрать всё, что найдётся».
    expect(screen.getByPlaceholderText('все')).toHaveValue(null);

    clickInPicker('city-picker', 'Москва');
    clickInPicker('rubric-picker', 'Кафе');
    fireEvent.click(screen.getByRole('button', { name: 'Собрать базу' }));

    // max_results не уходит вовсе — сервер понимает это как «все».
    expect(onCreate.mock.calls[0][0]).toEqual({
      catalog_filters: { cities: ['Москва'], categories: ['Кафе'], countries: ['Россия'] },
    });
  });

  it('оператор может ограничить объём — тогда он уходит в запрос', async () => {
    const onCreate = jest.fn();
    render(<YandexMapsParserForm onCreate={onCreate} />);
    await within(await screen.findByTestId('city-picker')).findByText('Москва');
    await within(await screen.findByTestId('rubric-picker')).findByText('Кафе');

    clickInPicker('city-picker', 'Москва');
    clickInPicker('rubric-picker', 'Кафе');
    fireEvent.change(screen.getByPlaceholderText('все'), { target: { value: '3000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Собрать базу' }));

    expect(onCreate.mock.calls[0][0]).toEqual({
      catalog_filters: { cities: ['Москва'], categories: ['Кафе'], countries: ['Россия'] },
      max_results: 3000,
    });
  });

  it('кабинет присылает объём: он списывается с тарифа', async () => {
    const onCreate = jest.fn();
    render(<YandexMapsParserForm clientMode onCreate={onCreate} />);
    await within(await screen.findByTestId('city-picker')).findByText('Москва');

    clickInPicker('city-picker', 'Москва');
    clickInPicker('rubric-picker', 'Кафе');
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Запустить поиск' }));

    expect(onCreate.mock.calls[0][0]).toEqual({
      catalog_filters: { cities: ['Москва'], categories: ['Кафе'], countries: ['Россия'] },
      max_results: 500,
    });
    // Ручных ссылок нет и в кабинете.
    expect(screen.queryByText(/Вставить ссылки вручную/)).toBeNull();
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
