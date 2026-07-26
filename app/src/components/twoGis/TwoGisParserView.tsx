'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { Download, Loader2, RotateCcw, Search } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import type {
  TwoGisCard,
  TwoGisFacet,
  TwoGisFacets,
  TwoGisFilters,
} from '@/lib/twoGis/types';

const PREVIEW_LIMIT = 100;
const MAX_FILTER_VALUES = 200;
const MAX_VISIBLE_FACET_OPTIONS = 100;

type SearchResponse = {
  count: number;
  rows: TwoGisCard[];
  nextCursor: string | null;
};

const EMPTY_FILTERS: Required<Pick<
  TwoGisFilters,
  | 'cities'
  | 'categories'
  | 'subcategories'
  | 'name'
  | 'hasPhone'
  | 'hasEmail'
  | 'hasWebsite'
  | 'hasVkontakte'
  | 'hasInstagram'
>> = {
  cities: [],
  categories: [],
  subcategories: [],
  name: '',
  hasPhone: false,
  hasEmail: false,
  hasWebsite: false,
  hasVkontakte: false,
  hasInstagram: false,
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body === 'object'
      && body
      && 'error' in body
      && typeof body.error === 'string'
        ? body.error
        : `Ошибка запроса (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function selectedValues(event: ChangeEvent<HTMLSelectElement>): string[] {
  return Array.from(event.currentTarget.selectedOptions, (option) => option.value);
}

function cloneFilters(filters: TwoGisFilters): TwoGisFilters {
  return {
    ...filters,
    cities: filters.cities ? [...filters.cities] : undefined,
    categories: filters.categories ? [...filters.categories] : undefined,
    subcategories: filters.subcategories ? [...filters.subcategories] : undefined,
  };
}

function MultiSelect({
  label,
  values,
  options,
  onChange,
  disabled,
}: {
  label: string;
  values: string[];
  options: TwoGisFacet[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  const descriptionId = useId();
  const [query, setQuery] = useState('');
  const visibleOptions = useMemo(() => {
    const selected = new Set(values);
    const selectedOptions = options.filter((option) => selected.has(option.value));
    const normalizedQuery = query.trim().toLocaleLowerCase('ru');
    const matches = options.filter(
      (option) =>
        !selected.has(option.value)
        && (
          !normalizedQuery
          || option.value.toLocaleLowerCase('ru').includes(normalizedQuery)
        ),
    );
    return [
      ...selectedOptions,
      ...matches.slice(0, MAX_VISIBLE_FACET_OPTIONS),
    ];
  }, [options, query, values]);

  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between text-sm font-medium text-gray-800">
        <span>{label}</span>
        {values.length > 0 ? (
          <span className="text-xs font-normal tabular-nums text-gray-500">
            выбрано: {values.length}
          </span>
        ) : null}
      </span>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        disabled={disabled}
        aria-label={`Поиск: ${label}`}
        placeholder="Найти в списке"
        className="mb-1.5 w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm outline-none placeholder:text-gray-400 focus:border-gray-900 focus:ring-2 focus:ring-gray-900/10 disabled:bg-gray-100"
      />
      <select
        aria-label={label}
        aria-describedby={descriptionId}
        multiple
        value={values}
        onChange={(event) =>
          onChange(selectedValues(event).slice(0, MAX_FILTER_VALUES))
        }
        disabled={disabled}
        className="min-h-28 w-full rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm text-gray-800 outline-none transition focus:border-gray-900 focus:ring-2 focus:ring-gray-900/10 disabled:bg-gray-100"
      >
        {visibleOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.value} ({option.count.toLocaleString('ru-RU')})
          </option>
        ))}
      </select>
      <span id={descriptionId} className="mt-1 block text-xs text-gray-500">
        {values.length >= MAX_FILTER_VALUES
          ? 'Достигнут лимит: 200 значений. Пустой выбор означает «все».'
          : `Пустой выбор означает «все». До 200 значений; показано ${visibleOptions.length} из ${options.length}.`}
      </span>
    </label>
  );
}

function ContactToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-1 text-sm text-gray-700 hover:bg-gray-50">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="h-4 w-4 rounded border-gray-300 accent-gray-900"
      />
      {label}
    </label>
  );
}

export function TwoGisParserView() {
  const [facets, setFacets] = useState<TwoGisFacets | null>(null);
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS });
  const [rows, setRows] = useState<TwoGisCard[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [searched, setSearched] = useState(false);
  const [searchedFilters, setSearchedFilters] = useState<TwoGisFilters | null>(null);
  const [loadingFacets, setLoadingFacets] = useState(true);
  const [facetsAttempt, setFacetsAttempt] = useState(0);
  const [searching, setSearching] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const searchVersion = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await authFetch('/api/tools/2gis-parser/facets');
        const data = await readJson<TwoGisFacets>(response);
        if (!cancelled) setFacets(data);
      } catch (requestError) {
        if (!cancelled) {
          setFacets(null);
          setError(
            requestError instanceof Error
              ? requestError.message
              : 'Не удалось загрузить фильтры 2GIS',
          );
        }
      } finally {
        if (!cancelled) setLoadingFacets(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [facetsAttempt]);

  const subcategoryOptions = useMemo(() => {
    const all = facets?.subcategories ?? [];
    const selected = new Set(filters.categories);
    const counts = new Map<string, number>();
    for (const item of all) {
      if (selected.size > 0 && !selected.has(item.category)) continue;
      counts.set(item.value, (counts.get(item.value) ?? 0) + item.count);
    }
    return [...counts.entries()]
      .map(([value, optionCount]) => ({ value, count: optionCount }))
      .sort(
        (left, right) =>
          right.count - left.count
          || left.value.localeCompare(right.value, 'ru'),
      );
  }, [facets, filters.categories]);

  const requestFilters = useMemo<TwoGisFilters>(
    () => ({
      cities: filters.cities,
      categories: filters.categories,
      subcategories: filters.subcategories,
      name: filters.name,
      hasPhone: filters.hasPhone,
      hasEmail: filters.hasEmail,
      hasWebsite: filters.hasWebsite,
      hasVkontakte: filters.hasVkontakte,
      hasInstagram: filters.hasInstagram,
    }),
    [filters],
  );
  const normalizedNameLength = filters.name.trim().length;
  const nameTooShort = normalizedNameLength > 0 && normalizedNameLength < 3;

  const invalidateResults = () => {
    searchVersion.current += 1;
    setRows([]);
    setCount(null);
    setSearched(false);
    setSearchedFilters(null);
    setSearching(false);
    setNotice(null);
  };

  const updateFilter = <Key extends keyof typeof filters>(
    key: Key,
    value: (typeof filters)[Key],
  ) => {
    setFilters((current) => ({ ...current, [key]: value }));
    invalidateResults();
  };

  const runSearch = async () => {
    if (!facets) return;
    const version = searchVersion.current + 1;
    searchVersion.current = version;
    const filtersSnapshot = cloneFilters(requestFilters);
    setSearching(true);
    setRows([]);
    setCount(null);
    setSearched(false);
    setSearchedFilters(null);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch('/api/tools/2gis-parser/search', {
        method: 'POST',
        body: JSON.stringify({ filters: filtersSnapshot, limit: PREVIEW_LIMIT }),
      });
      const data = await readJson<SearchResponse>(response);
      if (searchVersion.current !== version) return;
      setRows(data.rows);
      setCount(data.count);
      setSearched(true);
      setSearchedFilters(filtersSnapshot);
    } catch (requestError) {
      if (searchVersion.current !== version) return;
      setError(
        requestError instanceof Error ? requestError.message : 'Не удалось выполнить поиск',
      );
    } finally {
      if (searchVersion.current === version) setSearching(false);
    }
  };

  const startExport = async () => {
    if (!searchedFilters || count === null || count === 0) return;
    const filtersSnapshot = cloneFilters(searchedFilters);
    setExporting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await authFetch('/api/tools/2gis-parser/export', {
        method: 'POST',
        body: JSON.stringify({ filters: filtersSnapshot }),
      });
      const data = await readJson<{ rowCount: number; downloadUrl: string }>(response);
      const link = document.createElement('a');
      link.href = data.downloadUrl;
      link.download = '';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setNotice(
        `Скачивание началось: ${data.rowCount.toLocaleString('ru-RU')} строк.`,
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : 'Не удалось подготовить CSV',
      );
    } finally {
      setExporting(false);
    }
  };

  const resetFilters = () => {
    searchVersion.current += 1;
    setFilters({ ...EMPTY_FILTERS });
    setRows([]);
    setCount(null);
    setSearched(false);
    setSearchedFilters(null);
    setSearching(false);
    setError(null);
    setNotice(null);
  };

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 text-left">
      <header className="flex flex-col gap-3 border-b border-gray-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950">2GIS Парсер</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-gray-600">
            Выберите города и рубрики, проверьте результат и выгрузите исходные данные 2GIS.
          </p>
        </div>
        {facets ? (
          <div className="text-sm text-gray-600 lg:text-right">
            <div className="font-medium text-gray-900">
              {facets.snapshot.rows.toLocaleString('ru-RU')} карточек
            </div>
            <div>
              {facets.snapshot.scope}, снимок {new Date(`${facets.snapshot.date}T00:00:00`).toLocaleDateString('ru-RU')}
            </div>
          </div>
        ) : null}
      </header>

      {error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
        >
          {notice}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[330px_minmax(0,1fr)]">
        <aside className="self-start rounded-xl border border-gray-200 bg-white p-5">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-950">Фильтры</h2>
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Сбросить
            </button>
          </div>

          {loadingFacets ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загружаем справочники
            </div>
          ) : !facets ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <p>Справочники 2GIS не загрузились. Поиск и экспорт пока недоступны.</p>
              <button
                type="button"
                onClick={() => {
                  setLoadingFacets(true);
                  setError(null);
                  setFacetsAttempt((attempt) => attempt + 1);
                }}
                className="mt-3 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-amber-100"
              >
                Повторить
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              <MultiSelect
                label="Города"
                values={filters.cities}
                options={facets?.cities ?? []}
                onChange={(value) => updateFilter('cities', value)}
              />
              <MultiSelect
                label="Категории"
                values={filters.categories}
                options={facets?.categories ?? []}
                onChange={(value) => {
                  setFilters((current) => ({
                    ...current,
                    categories: value,
                    subcategories: current.subcategories.filter((subcategory) =>
                      (facets?.subcategories ?? []).some(
                        (item) =>
                          item.value === subcategory
                          && (value.length === 0 || value.includes(item.category)),
                      ),
                    ),
                  }));
                  invalidateResults();
                }}
              />
              <MultiSelect
                label="Подкатегории"
                values={filters.subcategories}
                options={subcategoryOptions}
                onChange={(value) => updateFilter('subcategories', value)}
              />

              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-gray-800">
                  Название содержит
                </span>
                <input
                  value={filters.name}
                  onChange={(event) => updateFilter('name', event.currentTarget.value)}
                  placeholder="Например, стоматология"
                  minLength={3}
                  aria-describedby="two-gis-name-hint"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition placeholder:text-gray-400 focus:border-gray-900 focus:ring-2 focus:ring-gray-900/10"
                />
                <span
                  id="two-gis-name-hint"
                  className={`mt-1 block text-xs ${nameTooShort ? 'text-amber-700' : 'text-gray-500'}`}
                >
                  Минимум 3 символа
                </span>
              </label>

              <fieldset>
                <legend className="mb-1 text-sm font-medium text-gray-800">Контакты</legend>
                <div className="grid grid-cols-2 gap-x-2">
                  <ContactToggle label="Есть телефон" checked={filters.hasPhone} onChange={(value) => updateFilter('hasPhone', value)} />
                  <ContactToggle label="Есть email" checked={filters.hasEmail} onChange={(value) => updateFilter('hasEmail', value)} />
                  <ContactToggle label="Есть сайт" checked={filters.hasWebsite} onChange={(value) => updateFilter('hasWebsite', value)} />
                  <ContactToggle label="Есть VK" checked={filters.hasVkontakte} onChange={(value) => updateFilter('hasVkontakte', value)} />
                  <ContactToggle label="Есть Instagram" checked={filters.hasInstagram} onChange={(value) => updateFilter('hasInstagram', value)} />
                </div>
              </fieldset>

              <button
                type="button"
                onClick={() => void runSearch()}
                disabled={searching || !facets || nameTooShort}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gray-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                {searching ? 'Ищем' : 'Показать'}
              </button>
            </div>
          )}
        </aside>

        <main className="min-w-0">
          <div className="mb-3 flex min-h-10 flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-gray-950">Результат</h2>
              {count !== null ? (
                <p className="mt-0.5 text-sm text-gray-600">
                  Найдено: <strong className="font-semibold text-gray-950">{count.toLocaleString('ru-RU')}</strong>
                  {count > rows.length ? `, показаны первые ${rows.length}` : ''}
                </p>
              ) : (
                <p className="mt-0.5 text-sm text-gray-500">Задайте фильтры и запустите поиск.</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => void startExport()}
              disabled={
                exporting
                || loadingFacets
                || !facets
                || !searchedFilters
                || count === null
                || count === 0
              }
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 transition hover:border-gray-400 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {exporting ? 'Готовим CSV' : 'Выгрузить CSV'}
            </button>
          </div>

          {searched && rows.length === 0 ? (
            <div className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 px-6 text-center">
              <p className="text-base font-medium text-gray-900">Ничего не найдено</p>
              <p className="mt-1 max-w-md text-sm text-gray-600">
                Уберите часть условий или сбросьте фильтры и попробуйте ещё раз.
              </p>
              <button
                type="button"
                onClick={resetFilters}
                className="mt-4 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-100"
              >
                Сбросить фильтры
              </button>
            </div>
          ) : rows.length > 0 ? (
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
              <div className="overflow-x-auto">
                <table className="min-w-[980px] w-full border-collapse text-sm">
                  <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="px-4 py-3">Организация</th>
                      <th className="px-4 py-3">Город и адрес</th>
                      <th className="px-4 py-3">Рубрика</th>
                      <th className="px-4 py-3">Контакты</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {rows.map((row) => (
                      <tr key={row.id} className="align-top hover:bg-gray-50/70">
                        <td className="max-w-72 px-4 py-3 font-medium text-gray-950">{row.name}</td>
                        <td className="max-w-72 px-4 py-3 text-gray-700">
                          <div>{row.city_name}</div>
                          <div className="mt-0.5 text-xs text-gray-500">{row.geometry_name}</div>
                        </td>
                        <td className="max-w-64 px-4 py-3 text-gray-700">
                          <div>{row.category}</div>
                          <div className="mt-0.5 text-xs text-gray-500">{row.subcategory}</div>
                        </td>
                        <td className="max-w-80 px-4 py-3 text-gray-700">
                          <div className="space-y-0.5 break-all">
                            {row.phone ? <div>{row.phone}</div> : null}
                            {row.email ? <div>{row.email}</div> : null}
                            {row.website ? <div className="text-xs text-gray-500">{row.website}</div> : null}
                            {row.vkontakte ? <div className="text-xs text-gray-500">VK: {row.vkontakte}</div> : null}
                            {row.instagram ? <div className="text-xs text-gray-500">Instagram: {row.instagram}</div> : null}
                            {!row.phone
                              && !row.email
                              && !row.website
                              && !row.vkontakte
                              && !row.instagram ? (
                              <span className="text-gray-400">Нет основных контактов</span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="flex min-h-72 items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 px-6 text-center text-sm text-gray-500">
              Здесь появятся первые {PREVIEW_LIMIT} карточек.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
