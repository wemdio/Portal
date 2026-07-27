import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  clearTwoGisFacetsMemoryCache,
  TwoGisParserView,
} from '@/components/twoGis/TwoGisParserView';

const mockAuthFetch = jest.fn();
let mockSearchCount = 1;

jest.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => mockAuthFetch(...args),
}));

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  window.sessionStorage.clear();
  clearTwoGisFacetsMemoryCache();
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  mockSearchCount = 1;
  mockAuthFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/facets')) {
      return jsonResponse({
        cities: [
          { value: 'Москва', count: 10 },
          { value: 'Казань', count: 8 },
        ],
        categories: [
          { value: 'Еда', count: 10 },
          { value: 'Услуги', count: 8 },
        ],
        subcategories: [
          { value: 'Кафе', category: 'Еда', count: 10 },
          { value: 'Рестораны', category: 'Еда', count: 6 },
          { value: 'Ремонт', category: 'Услуги', count: 8 },
          { value: 'Кафе', category: 'Услуги', count: 2 },
        ],
        snapshot: { scope: 'Россия', date: '2026-07-26', rows: 4284927 },
      });
    }
    if (url.endsWith('/search')) {
      return jsonResponse({
        count: mockSearchCount,
        rows: [
          {
            id: '4504127908669251',
            name: 'Кафе Волна',
            city_name: 'Москва',
            geometry_name: 'улица 1',
            phone: '+74950000000',
            email: '',
            website: 'https://example.ru',
            category: 'Еда',
            subcategory: 'Кафе',
          },
        ],
        nextCursor: null,
      });
    }
    if (url.endsWith('/export')) {
      return jsonResponse({
        rowCount: 1,
        downloadUrl: '/api/tools/2gis-parser/export/token',
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  document.body.innerHTML = '';
});

describe('<TwoGisParserView />', () => {
  it('filters, previews and starts a separate 2GIS CSV export', async () => {
    const user = userEvent.setup();
    render(<TwoGisParserView />);

    expect(await screen.findByText(/4\s284\s927/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /выгрузить csv/i })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Москва' }));
    await user.click(screen.getByRole('checkbox', { name: 'Казань' }));
    await user.click(screen.getByRole('checkbox', { name: 'Еда' }));
    await user.click(
      screen.getByRole('button', { name: 'Развернуть: Услуги' }),
    );
    await user.click(
      screen.getByRole('checkbox', { name: 'Услуги → Ремонт' }),
    );
    expect(
      screen.getByRole('checkbox', { name: 'Услуги' }),
    ).toBePartiallyChecked();
    await user.click(screen.getByRole('checkbox', { name: 'Есть телефон' }));
    await user.click(screen.getByRole('button', { name: /показать/i }));

    expect(await screen.findByText('Кафе Волна')).toBeInTheDocument();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === 'P'
          && /найдено:\s*1/i.test(element.textContent ?? ''),
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/наша база баз/i)).not.toBeInTheDocument();

    const searchCall = mockAuthFetch.mock.calls.find(([url]) =>
      String(url).endsWith('/search'),
    );
    expect(JSON.parse(searchCall?.[1]?.body as string)).toEqual({
      filters: expect.objectContaining({
        cities: ['Москва', 'Казань'],
        rubricGroups: [
          { category: 'Еда', mode: 'all' },
          {
            category: 'Услуги',
            mode: 'some',
            subcategories: ['Ремонт'],
          },
        ],
        hasPhone: true,
      }),
      limit: 100,
    });

    await user.click(screen.getByRole('button', { name: /выгрузить csv/i }));
    await waitFor(() =>
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/tools/2gis-parser/export',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('blocks CSV export when the result exceeds 500,000 rows', async () => {
    mockSearchCount = 500_001;
    const user = userEvent.setup();
    render(<TwoGisParserView />);

    await screen.findByRole('checkbox', { name: 'Москва' });
    await user.click(screen.getByRole('button', { name: /показать/i }));

    expect(
      await screen.findByText(/экспорт доступен до 500\s000 строк/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /выгрузить csv/i })).toBeDisabled();
    expect(
      mockAuthFetch.mock.calls.some(([url]) => String(url).endsWith('/export')),
    ).toBe(false);
  });

  it('renders the stable filter UI while facet values are still loading', async () => {
    let resolveFacets: ((response: Response) => void) | undefined;
    mockAuthFetch.mockImplementation(
      (url: string) => {
        if (!url.endsWith('/facets')) {
          throw new Error(`Unexpected URL: ${url}`);
        }
        return new Promise<Response>((resolve) => {
          resolveFacets = resolve;
        });
      },
    );

    render(<TwoGisParserView />);

    expect(screen.getByRole('heading', { name: 'Фильтры' })).toBeInTheDocument();
    expect(screen.getByLabelText('Поиск: Города')).toBeDisabled();
    expect(
      screen.getByLabelText('Поиск: Разделы и рубрики 2GIS'),
    ).toBeDisabled();
    expect(screen.getAllByText('Загружаем список')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /показать/i })).toBeDisabled();

    resolveFacets?.(jsonResponse({
      cities: [{ value: 'Москва', count: 10 }],
      categories: [{ value: 'Еда', count: 10 }],
      subcategories: [{ value: 'Кафе', category: 'Еда', count: 10 }],
      snapshot: { scope: 'Россия', date: '2026-07-26', rows: 4284927 },
    }));

    expect(await screen.findByRole('checkbox', { name: 'Москва' })).toBeEnabled();
  });

  it('supports checked, mixed and unchecked category states', async () => {
    const user = userEvent.setup();
    render(<TwoGisParserView />);
    await screen.findByRole('checkbox', { name: 'Еда' });

    await user.click(
      screen.getByRole('button', { name: 'Развернуть: Еда' }),
    );
    const category = screen.getByRole('checkbox', { name: 'Еда' });
    const cafe = screen.getByRole('checkbox', { name: 'Еда → Кафе' });
    const restaurants = screen.getByRole('checkbox', {
      name: 'Еда → Рестораны',
    });

    await user.click(category);
    expect(category).toBeChecked();
    expect(cafe).toBeChecked();
    expect(restaurants).toBeChecked();

    await user.click(cafe);
    expect(category).toBePartiallyChecked();
    expect(cafe).not.toBeChecked();
    expect(restaurants).toBeChecked();

    await user.click(screen.getByRole('button', { name: /показать/i }));
    await screen.findByText('Кафе Волна');
    const partialSearchCall = mockAuthFetch.mock.calls.findLast(([url]) =>
      String(url).endsWith('/search'),
    );
    expect(JSON.parse(partialSearchCall?.[1]?.body as string)).toEqual(
      expect.objectContaining({
        filters: expect.objectContaining({
          rubricGroups: [
            {
              category: 'Еда',
              mode: 'allExcept',
              excludedSubcategories: ['Кафе'],
            },
          ],
        }),
      }),
    );

    await user.click(category);
    expect(category).toBeChecked();
    expect(cafe).toBeChecked();
    expect(restaurants).toBeChecked();

    await user.click(category);
    expect(category).not.toBeChecked();
    expect(cafe).not.toBeChecked();
    expect(restaurants).not.toBeChecked();
  });

  it('can exclude one rubric from a category with more than 200 children', async () => {
    const largeSubcategoryList = Array.from(
      { length: 205 },
      (_, index) => ({
        value: `Рубрика ${String(index).padStart(3, '0')}`,
        category: 'Большой раздел',
        count: 205 - index,
      }),
    );
    mockAuthFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/facets')) {
        return jsonResponse({
          cities: [],
          categories: [{ value: 'Большой раздел', count: 1_000 }],
          subcategories: largeSubcategoryList,
          snapshot: { scope: 'Россия', date: '2026-07-26', rows: 4284927 },
        });
      }
      return jsonResponse({ count: 1, rows: [], nextCursor: null });
    });

    const user = userEvent.setup();
    render(<TwoGisParserView />);
    const category = await screen.findByRole('checkbox', {
      name: 'Большой раздел',
    });
    await user.click(category);
    await user.click(
      screen.getByRole('button', { name: 'Развернуть: Большой раздел' }),
    );

    const firstRubric = screen.getByRole('checkbox', {
      name: 'Большой раздел → Рубрика 000',
    });
    expect(firstRubric).toBeEnabled();
    await user.click(firstRubric);

    expect(category).toBePartiallyChecked();
    expect(firstRubric).not.toBeChecked();
    expect(
      screen.getByText(/целый раздел включает все его рубрики/i),
    ).toBeInTheDocument();
  });

  it('searches category and rubric names without losing hidden selections', async () => {
    const user = userEvent.setup();
    render(<TwoGisParserView />);
    await screen.findByRole('checkbox', { name: 'Еда' });

    await user.click(
      screen.getByRole('button', { name: 'Развернуть: Еда' }),
    );
    await user.click(
      screen.getByRole('checkbox', { name: 'Еда → Рестораны' }),
    );

    const search = screen.getByLabelText('Поиск: Разделы и рубрики 2GIS');
    await user.type(search, 'ремонт');

    expect(
      screen.getByRole('checkbox', { name: 'Услуги → Ремонт' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Свернуть: Услуги' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: 'Еда → Рестораны' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/выбрано: 1 рубрика/i)).toBeInTheDocument();

    await user.clear(search);
    expect(
      screen.getByRole('button', { name: 'Развернуть: Услуги' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: 'Еда → Рестораны' }),
    ).toBeChecked();
  });

  it('reuses facet values when the tool is reopened in the same browser session', async () => {
    const firstRender = render(<TwoGisParserView />);
    expect(await screen.findByRole('checkbox', { name: 'Москва' })).toBeEnabled();
    firstRender.unmount();

    render(<TwoGisParserView />);
    expect(screen.getByRole('checkbox', { name: 'Москва' })).toBeEnabled();

    const facetCalls = mockAuthFetch.mock.calls.filter(([url]) =>
      String(url).endsWith('/facets'),
    );
    expect(facetCalls).toHaveLength(1);
  });

  it('invalidates stale results when filters change', async () => {
    const user = userEvent.setup();
    render(<TwoGisParserView />);
    await screen.findByText(/4\s284\s927/);
    await user.click(screen.getByRole('button', { name: /показать/i }));
    expect(await screen.findByText('Кафе Волна')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /выгрузить csv/i })).toBeEnabled();

    await user.click(screen.getByRole('checkbox', { name: 'Еда' }));

    expect(screen.queryByText('Кафе Волна')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /выгрузить csv/i })).toBeDisabled();
  });

  it('shows VK and Instagram contacts without a false no-contacts label', async () => {
    mockAuthFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/facets')) {
        return jsonResponse({
          cities: [],
          categories: [],
          subcategories: [],
          snapshot: { scope: 'Россия', date: '2026-07-26', rows: 4284927 },
        });
      }
      return jsonResponse({
        count: 1,
        rows: [
          {
            id: '1',
            name: 'Социальная компания',
            city_name: 'Казань',
            geometry_name: '',
            post_code: '',
            phone: '',
            email: '',
            website: '',
            vkontakte: 'https://vk.com/example',
            instagram: 'https://instagram.com/example',
            lon: '',
            lat: '',
            category: 'Услуги',
            subcategory: '',
          },
        ],
        nextCursor: null,
      });
    });

    const user = userEvent.setup();
    render(<TwoGisParserView />);
    await screen.findByText(/4\s284\s927/);
    await user.click(screen.getByRole('button', { name: /показать/i }));

    expect(await screen.findByText('VK: https://vk.com/example')).toBeInTheDocument();
    expect(screen.getByText('Instagram: https://instagram.com/example')).toBeInTheDocument();
    expect(screen.queryByText(/нет основных контактов/i)).not.toBeInTheDocument();
  });

  it('shows a useful empty state', async () => {
    mockAuthFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/facets')) {
        return jsonResponse({
          cities: [],
          categories: [],
          subcategories: [],
          snapshot: { scope: 'Россия', date: '2026-07-26', rows: 4284927 },
        });
      }
      return jsonResponse({ count: 0, rows: [], nextCursor: null });
    });

    const user = userEvent.setup();
    render(<TwoGisParserView />);
    await screen.findByText(/4\s284\s927/);
    await user.click(screen.getByRole('button', { name: /показать/i }));
    expect(await screen.findByText(/ничего не найдено/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /сбросить фильтры/i })).toBeInTheDocument();
  });

  it('searches large facet lists locally and keeps the checkbox DOM bounded', async () => {
    const cities = Array.from({ length: 250 }, (_, index) => ({
      value: `Город ${String(index).padStart(3, '0')}`,
      count: 250 - index,
    }));
    mockAuthFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/facets')) {
        return jsonResponse({
          cities,
          categories: [],
          subcategories: [],
          snapshot: { scope: 'Россия', date: '2026-07-26', rows: 4284927 },
        });
      }
      return jsonResponse({ count: 0, rows: [], nextCursor: null });
    });

    const user = userEvent.setup();
    render(<TwoGisParserView />);
    await screen.findByText(/4\s284\s927/);

    const cityGroup = screen.getByRole('group', { name: 'Города' });
    expect(within(cityGroup).getAllByRole('checkbox')).toHaveLength(100);

    await user.type(screen.getByLabelText('Поиск: Города'), 'Город 249');
    expect(within(cityGroup).getByRole('checkbox', { name: 'Город 249' })).toBeInTheDocument();
    expect(within(cityGroup).queryByRole('checkbox', { name: 'Город 000' })).not.toBeInTheDocument();
  });
});
