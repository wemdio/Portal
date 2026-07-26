import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TwoGisParserView } from '@/components/twoGis/TwoGisParserView';

const mockAuthFetch = jest.fn();
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
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  mockAuthFetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/facets')) {
      return jsonResponse({
        cities: [{ value: 'Москва', count: 10 }],
        categories: [{ value: 'Еда', count: 10 }],
        subcategories: [{ value: 'Кафе', category: 'Еда', count: 10 }],
        snapshot: { scope: 'Россия', date: '2026-07-26', rows: 4284927 },
      });
    }
    if (url.endsWith('/search')) {
      return jsonResponse({
        count: 1,
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
    await user.selectOptions(screen.getByLabelText('Города'), 'Москва');
    await user.selectOptions(screen.getByLabelText('Категории'), 'Еда');
    await user.selectOptions(screen.getByLabelText('Подкатегории'), 'Кафе');
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
        cities: ['Москва'],
        categories: ['Еда'],
        subcategories: ['Кафе'],
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

  it('invalidates stale results when filters change', async () => {
    const user = userEvent.setup();
    render(<TwoGisParserView />);
    await screen.findByText(/4\s284\s927/);
    await user.click(screen.getByRole('button', { name: /показать/i }));
    expect(await screen.findByText('Кафе Волна')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /выгрузить csv/i })).toBeEnabled();

    await user.click(screen.getByRole('checkbox', { name: 'Есть email' }));

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

  it('searches large facet lists locally and keeps the select DOM bounded', async () => {
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

    const citySelect = screen.getByLabelText('Города');
    expect(within(citySelect).getAllByRole('option')).toHaveLength(100);

    await user.type(screen.getByLabelText('Поиск: Города'), 'Город 249');
    expect(within(citySelect).getByRole('option', { name: /Город 249/ })).toBeInTheDocument();
    expect(within(citySelect).queryByRole('option', { name: /Город 000/ })).not.toBeInTheDocument();
  });
});
