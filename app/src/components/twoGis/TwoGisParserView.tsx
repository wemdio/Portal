'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
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
const FACETS_MEMORY_TTL_MS = 5 * 60 * 1000;

let facetsMemoryCache: {
  data: TwoGisFacets;
  storedAt: number;
} | null = null;
let facetsRequest: Promise<TwoGisFacets> | null = null;

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

function readTwoGisFacetsMemoryCache(): TwoGisFacets | null {
  if (
    facetsMemoryCache
    && Date.now() - facetsMemoryCache.storedAt < FACETS_MEMORY_TTL_MS
  ) {
    return facetsMemoryCache.data;
  }
  facetsMemoryCache = null;
  return null;
}

async function loadTwoGisFacets(): Promise<TwoGisFacets> {
  const cached = readTwoGisFacetsMemoryCache();
  if (cached) return cached;

  if (!facetsRequest) {
    facetsRequest = authFetch('/api/tools/2gis-parser/facets')
      .then((response) => readJson<TwoGisFacets>(response))
      .then((data) => {
        facetsMemoryCache = { data, storedAt: Date.now() };
        return data;
      })
      .finally(() => {
        facetsRequest = null;
      });
  }
  return facetsRequest;
}

export function clearTwoGisFacetsMemoryCache() {
  facetsMemoryCache = null;
  facetsRequest = null;
}

function cloneFilters(filters: TwoGisFilters): TwoGisFilters {
  return {
    ...filters,
    cities: filters.cities ? [...filters.cities] : undefined,
    categories: filters.categories ? [...filters.categories] : undefined,
    subcategories: filters.subcategories ? [...filters.subcategories] : undefined,
  };
}

function FacetChecklist({
  label,
  values,
  options,
  onChange,
  disabled,
  loading,
}: {
  label: string;
  values: string[];
  options: TwoGisFacet[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const labelId = useId();
  const listId = useId();
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

  const toggleOption = (value: string, checked: boolean) => {
    if (checked) {
      if (values.includes(value) || values.length >= MAX_FILTER_VALUES) return;
      onChange([...values, value]);
      return;
    }
    onChange(values.filter((selectedValue) => selectedValue !== value));
  };

  return (
    <section aria-labelledby={labelId}>
      <div className="mb-2 flex min-h-6 items-center justify-between gap-3">
        <h3 id={labelId} className="text-sm font-semibold text-gray-900">
          {label}
        </h3>
        {values.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-xs tabular-nums text-gray-500">
              Выбрано: {values.length}
            </span>
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={disabled}
              aria-label={`Очистить: ${label}`}
              className="rounded-md px-1.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Очистить
            </button>
          </div>
        ) : null}
      </div>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        disabled={disabled || loading}
        aria-label={`Поиск: ${label}`}
        aria-controls={listId}
        placeholder="Найти в списке"
        className="mb-2 min-h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-gray-900 focus:ring-2 focus:ring-gray-900/20 disabled:cursor-wait disabled:bg-gray-100"
      />
      <div
        id={listId}
        role="group"
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        aria-busy={loading || undefined}
        className="h-56 overflow-y-auto rounded-lg border border-gray-300 bg-white"
      >
        {loading ? (
          <div
            role="status"
            className="flex h-full flex-col justify-center gap-3 px-4 py-4 text-sm text-gray-500"
          >
            <span>Загружаем список</span>
            {[72, 88, 64, 80].map((width) => (
              <span key={width} className="flex items-center gap-3" aria-hidden="true">
                <span className="h-[18px] w-[18px] rounded border border-gray-300 bg-gray-100" />
                <span
                  className="h-3 rounded bg-gray-100"
                  style={{ width: `${width}%` }}
                />
              </span>
            ))}
          </div>
        ) : visibleOptions.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-gray-500">
            {query.trim() ? 'По вашему запросу ничего нет' : 'Нет доступных значений'}
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {visibleOptions.map((option) => {
              const checked = values.includes(option.value);
              const reachedLimit = !checked && values.length >= MAX_FILTER_VALUES;
              return (
                <label
                  key={option.value}
                  className={`flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2.5 text-sm transition-colors ${
                    checked ? 'bg-gray-100' : 'hover:bg-gray-50'
                  } ${reachedLimit || disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || reachedLimit}
                    onChange={(event) =>
                      toggleOption(option.value, event.currentTarget.checked)
                    }
                    aria-label={option.value}
                    className="h-[18px] w-[18px] shrink-0 rounded border-gray-300 accent-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
                  />
                  <span className="min-w-0 flex-1 leading-5 text-gray-800">
                    {option.value}
                  </span>
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-xs tabular-nums text-gray-500"
                  >
                    {option.count.toLocaleString('ru-RU')}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>
      <p id={descriptionId} className="mt-1.5 text-xs leading-4 text-gray-500">
        {values.length >= MAX_FILTER_VALUES
          ? 'Выбрано максимум 200 значений. Снимите один пункт, чтобы выбрать другой.'
          : loading
            ? 'Справочник загружается. Остальные фильтры уже доступны.'
            : `Без выбора: все. Показано ${visibleOptions.length} из ${options.length}.`}
      </p>
    </section>
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
    <label className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-md px-1.5 text-sm text-gray-700 hover:bg-gray-50">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="h-[18px] w-[18px] shrink-0 rounded border-gray-300 accent-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
      />
      {label}
    </label>
  );
}

export function TwoGisParserView() {
  const [cachedFacetsAtMount] = useState<TwoGisFacets | null>(
    readTwoGisFacetsMemoryCache,
  );
  const facetsRef = useRef<TwoGisFacets | null>(cachedFacetsAtMount);
  const [facets, setFacets] = useState<TwoGisFacets | null>(
    cachedFacetsAtMount,
  );
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS });
  const [rows, setRows] = useState<TwoGisCard[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [searched, setSearched] = useState(false);
  const [searchedFilters, setSearchedFilters] = useState<TwoGisFilters | null>(null);
  const [loadingFacets, setLoadingFacets] = useState(
    cachedFacetsAtMount === null,
  );
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
        const data = await loadTwoGisFacets();
        if (!cancelled) {
          facetsRef.current = data;
          setFacets(data);
        }
      } catch (requestError) {
        if (!cancelled) {
          if (!facetsRef.current) {
            setFacets(null);
            setError(
              requestError instanceof Error
                ? requestError.message
                : 'Не удалось загрузить фильтры 2GIS',
            );
          }
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
    <div className="mx-auto max-w-[1700px] space-y-6 text-left">
      <header className="flex flex-col gap-3 border-b border-gray-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-900">2GIS Парсер</h1>
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
        ) : (
          <div
            aria-hidden="true"
            className="w-48 space-y-2 lg:text-right"
          >
            <div className="ml-auto h-4 w-32 animate-pulse rounded bg-gray-200" />
            <div className="ml-auto h-3 w-48 animate-pulse rounded bg-gray-100" />
          </div>
        )}
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

      <div className="grid gap-8 xl:grid-cols-[420px_minmax(0,1fr)]">
        <aside className="self-start rounded-xl border border-gray-200 bg-white p-6">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900">Фильтры</h2>
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Сбросить
            </button>
          </div>

          <div className="space-y-6">
            {!loadingFacets && !facets ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <p>Справочники 2GIS не загрузились. Поиск и экспорт пока недоступны.</p>
                <button
                  type="button"
                  onClick={() => {
                    clearTwoGisFacetsMemoryCache();
                    setLoadingFacets(true);
                    setError(null);
                    setFacetsAttempt((attempt) => attempt + 1);
                  }}
                  className="mt-3 min-h-10 rounded-md border border-amber-300 bg-white px-3 py-2 text-sm font-medium hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
                >
                  Повторить
                </button>
              </div>
            ) : null}

            <FacetChecklist
              label="Города"
              values={filters.cities}
              options={facets?.cities ?? []}
              onChange={(value) => updateFilter('cities', value)}
              disabled={!facets}
              loading={loadingFacets}
            />
            <FacetChecklist
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
              disabled={!facets}
              loading={loadingFacets}
            />
            <FacetChecklist
              label="Подкатегории"
              values={filters.subcategories}
              options={subcategoryOptions}
              onChange={(value) => updateFilter('subcategories', value)}
              disabled={!facets}
              loading={loadingFacets}
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
                className="min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-gray-900 focus:ring-2 focus:ring-gray-900/20"
              />
              <span
                id="two-gis-name-hint"
                className={`mt-1 block text-xs ${nameTooShort ? 'text-amber-700' : 'text-gray-500'}`}
              >
                Минимум 3 символа
              </span>
            </label>

            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-gray-800">Контакты</legend>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
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
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {searching ? 'Ищем' : 'Показать'}
            </button>
          </div>
        </aside>

        <main className="min-w-0">
          <div className="mb-3 flex min-h-10 flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-gray-900">Результат</h2>
              {count !== null ? (
                <p className="mt-0.5 text-sm text-gray-600">
                  Найдено: <strong className="font-semibold text-gray-900">{count.toLocaleString('ru-RU')}</strong>
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
                        <td className="max-w-72 px-4 py-3 font-medium text-gray-900">{row.name}</td>
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
