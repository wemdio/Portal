'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Info, Layers, Play, Loader2 } from 'lucide-react';
import { CATALOG_MAX_RESULTS, CITIES, RUBRICS } from '@/lib/parsers/yandexMapsData';
import { authFetchJson } from '@/lib/authFetch';

type ProxyForm = {
  enabled: boolean;
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: string;
  username: string;
  password: string;
};

// ... (imports remain the same)

/** Пункт списка: значение и, если известно, сколько организаций за ним стоит. */
export type SelectOption = { value: string; count?: number };
export type SelectGroups = Record<string, SelectOption[]>;

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace('.0', '')} млн`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}к`;
  return String(count);
}

/**
 * Больше этого числа пунктов разом не рисуем. В одной России около 2800
 * городов, и отрисовка всех сразу заметно тормозит форму; списки отсортированы
 * по охвату, так что в лимит попадает самое крупное, а остальное ищется полем.
 */
const RENDER_LIMIT = 400;

/** Списки выросли со 145 городов до нескольких тысяч — без поиска не найти. */
function filterGroups(groups: SelectGroups, query: string): SelectGroups {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  const out: SelectGroups = {};
  for (const [group, items] of Object.entries(groups)) {
    // Совпадение по названию группы показывает её целиком: «Татарстан» должен
    // открывать все города республики, а не только одноимённый.
    const groupHit = group.toLowerCase().includes(needle);
    const matched = groupHit ? items : items.filter((item) => item.value.toLowerCase().includes(needle));
    if (matched.length) out[group] = matched;
  }
  return out;
}

/** Обрезает список до лимита, сохраняя порядок групп. */
function capGroups(groups: SelectGroups, limit: number): { groups: SelectGroups; shown: number; total: number } {
  const total = Object.values(groups).reduce((sum, items) => sum + items.length, 0);
  if (total <= limit) return { groups, shown: total, total };
  const out: SelectGroups = {};
  let shown = 0;
  for (const [group, items] of Object.entries(groups)) {
    if (shown >= limit) break;
    const slice = items.slice(0, limit - shown);
    out[group] = slice;
    shown += slice.length;
  }
  return { groups: out, shown, total };
}

// Custom MultiSelect Component
function MultiSelect({
  options,
  value,
  onChange,
  disabled,
  className,
  clientMode,
  searchPlaceholder,
  emptyHint,
}: {
  options: SelectGroups;
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  className?: string;
  clientMode?: boolean;
  searchPlaceholder?: string;
  emptyHint?: string;
}) {
  const [query, setQuery] = useState('');
  const matched = useMemo(() => filterGroups(options, query), [options, query]);
  const { groups: visible, shown: visibleCount, total: matchedCount } = useMemo(
    () => capGroups(matched, RENDER_LIMIT),
    [matched],
  );

  const toggleOption = (option: string) => {
    if (disabled) return;
    const next = value.includes(option)
      ? value.filter((v) => v !== option)
      : [...value, option];
    onChange(next);
  };

  // Выбираем всё, что нашлось по запросу, а не только отрисованную часть —
  // иначе кнопка молча теряла бы то, что не поместилось в лимит отрисовки.
  const selectMatched = () => {
    if (disabled) return;
    const all = Object.values(matched).flatMap((items) => items.map((item) => item.value));
    onChange([...new Set([...value, ...all])]);
  };

  return (
    <div
      className={`rounded-lg overflow-hidden flex flex-col ${clientMode ? '' : 'border border-gray-300 bg-white'} ${className ?? ''}`}
      style={clientMode ? { background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider-strong)' } : undefined}
    >
      <div
        className={`flex items-center gap-2 px-2 py-1.5 ${clientMode ? '' : 'border-b border-gray-200 bg-gray-50/70'}`}
        style={clientMode ? { borderBottom: '1px solid var(--cp-divider)' } : undefined}
      >
        <input
          type="text"
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder ?? 'Поиск…'}
          className={clientMode ? 'ds-input w-full text-xs' : 'block w-full rounded-md border-gray-300 text-xs px-2 py-1 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none'}
        />
        {query.trim() && matchedCount > 0 && (
          <button
            type="button"
            onClick={selectMatched}
            className={clientMode ? 'ds-btn-ghost shrink-0 text-[11px]' : 'shrink-0 text-[11px] px-2 py-1 rounded-md border border-gray-200 bg-white text-gray-700 hover:bg-gray-100'}
          >
            выбрать {matchedCount}
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar my-1 mr-1">
        {visibleCount === 0 && (
          <div className="px-3 py-4 text-xs" style={{ color: clientMode ? 'var(--cp-paper-faint)' : 'rgb(107 114 128)' }}>
            {emptyHint ?? 'Ничего не найдено.'}
          </div>
        )}
        {Object.entries(visible).map(([group, items]) => (
          <div key={group}>
            <div
              className={`sticky top-0 z-10 py-2 px-3 ${clientMode ? '' : 'bg-gray-100 border-b border-gray-200 shadow-sm'}`}
              style={clientMode ? { background: 'var(--cp-surface-elev)', borderBottom: '1px solid var(--cp-divider)' } : undefined}
            >
              <div
                className="text-xs font-bold uppercase tracking-wider"
                style={clientMode ? { color: 'var(--cp-paper-faint)' } : { color: 'rgb(55 65 81)' }}
              >
                {group}
              </div>
            </div>
            <div className="p-2 space-y-1">
              {items.map(({ value: item, count }) => {
                const isSelected = value.includes(item);
                return (
                  <div
                    key={item}
                    onClick={() => toggleOption(item)}
                    className={`px-3 py-2 rounded-md text-sm cursor-pointer transition-all duration-200 flex items-center justify-between group ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${
                      clientMode
                        ? (isSelected ? '' : 'hover:bg-[var(--cp-surface-elev)]')
                        : isSelected
                          ? 'bg-blue-50 text-blue-700 shadow-sm ring-1 ring-blue-100'
                          : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
                    }`}
                    style={
                      clientMode
                        ? isSelected
                          ? { background: 'var(--cp-surface-active)', color: 'var(--cp-paper)' }
                          : { color: 'var(--cp-paper-mute)' }
                        : undefined
                    }
                  >
                    <span className="font-medium">{item}</span>
                    {typeof count === 'number' && !isSelected && (
                      <span
                        className="ml-2 shrink-0 text-[11px] tabular-nums"
                        style={{ color: clientMode ? 'var(--cp-paper-faint)' : 'rgb(156 163 175)' }}
                      >
                        {formatCount(count)}
                      </span>
                    )}
                    {isSelected && (
                      <span
                        className={clientMode ? '' : 'text-blue-600 bg-blue-100 rounded-full p-0.5'}
                        style={clientMode ? { color: 'var(--cp-paper)' } : undefined}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {matchedCount > visibleCount && (
          <div
            className="px-3 py-2 text-[11px]"
            style={{ color: clientMode ? 'var(--cp-paper-faint)' : 'rgb(107 114 128)' }}
          >
            Показаны {visibleCount} самых крупных из {matchedCount.toLocaleString('ru-RU')} — остальное найдётся поиском.
          </div>
        )}
      </div>
    </div>
  );
}

type CatalogPlace = { country: string; region: string; city: string; companies: number };
type CatalogRubric = { rubric: string; companies: number };

/** Пока справочник не пересчитан, форма работает на прежних списках. */
function staticGroups(source: Record<string, string[]>): SelectGroups {
  return Object.fromEntries(
    Object.entries(source).map(([group, items]) => [group, items.map((value) => ({ value }))]),
  );
}

function useCatalogDictionaries() {
  const [places, setPlaces] = useState<CatalogPlace[]>([]);
  const [rubrics, setRubrics] = useState<CatalogRubric[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await authFetchJson<{ places: CatalogPlace[]; rubrics: CatalogRubric[] }>(
          '/api/parsers/yandexmaps/catalog',
        );
        if (cancelled) return;
        setPlaces(Array.isArray(data?.places) ? data.places : []);
        setRubrics(Array.isArray(data?.rubrics) ? data.rubrics : []);
      } catch {
        // Каталог недоступен — форма откатится на прежние статические списки.
        if (!cancelled) { setPlaces([]); setRubrics([]); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { places, rubrics, loading };
}

export function YandexMapsParserForm(props: {
  busy?: boolean;
  /** Client portal: client-language wording (no «URL», «парсер»). */
  clientMode?: boolean;
  onCreate: (payload: {
    search_urls: string[];
    catalog_filters?: { cities?: string[]; categories?: string[]; countries?: string[] };
    max_results: number;
    headless: boolean;
    proxy: ProxyForm;
  }) => Promise<void> | void;
}) {
  const clientMode = props.clientMode;
  // Прокси и headless остаются в запросе ради совместимости API: сбор идёт из
  // своей базы и ни того, ни другого не использует.
  const [headless, _setHeadless] = useState(true);

  const [proxy, _setProxy] = useState<ProxyForm>({
    enabled: false,
    protocol: 'http',
    host: '',
    port: '',
    username: '',
    password: '',
  });

  const [selectedCities, setSelectedCities] = useState<string[]>([]);
  const [selectedRubrics, setSelectedRubrics] = useState<string[]>([]);
  const [customKeyword, setCustomKeyword] = useState('');
  const [showHowItWorks, setShowHowItWorks] = useState(false);

  const { places, rubrics: catalogRubrics, loading: dictLoading } = useCatalogDictionaries();
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);

  // Страны берутся из каталога: сколько стран залито — столько и покажем.
  const countries = useMemo(() => {
    const totals = new Map<string, number>();
    for (const place of places) {
      totals.set(place.country, (totals.get(place.country) ?? 0) + place.companies);
    }
    return [...totals]
      .filter(([country]) => country)
      .sort((a, b) => b[1] - a[1])
      .map(([country, companies]) => ({ country, companies }));
  }, [places]);

  // Показывать сразу города всех стран — это тысячи пунктов. Пока пользователь
  // не выбрал сам, подразумеваем Россию (или самую крупную из залитых стран).
  // Значение выводится, а не записывается в состояние: запись через эффект
  // давала лишнюю перерисовку на каждой загрузке справочника.
  const activeCountries = useMemo(() => {
    if (selectedCountries.length) return selectedCountries;
    if (!countries.length) return [];
    return [(countries.find((item) => item.country === 'Россия') ?? countries[0]).country];
  }, [countries, selectedCountries]);

  // Места. Если у организаций заполнен только регион (Баку, сводные листы
  // регионов), выбираемым пунктом становится сам регион — поиск умеет
  // сопоставлять и по городу, и по региону.
  const cityGroups = useMemo<SelectGroups>(() => {
    if (!places.length) return staticGroups(CITIES);
    const active = new Set(activeCountries);
    const multiCountry = active.size > 1;
    const grouped = new Map<string, Map<string, number>>();
    for (const place of places) {
      if (!active.has(place.country)) continue;
      const value = place.city || place.region;
      if (!value) continue;
      const base = place.region || place.country;
      const label = multiCountry ? `${place.country} · ${base}` : base;
      const bucket = grouped.get(label) ?? new Map<string, number>();
      bucket.set(value, (bucket.get(value) ?? 0) + place.companies);
      grouped.set(label, bucket);
    }
    const groupTotal = (items: Map<string, number>) => [...items.values()].reduce((a, b) => a + b, 0);
    return Object.fromEntries(
      [...grouped]
        .sort((a, b) => groupTotal(b[1]) - groupTotal(a[1]))
        .map(([label, items]) => [
          label,
          [...items]
            .sort((a, b) => b[1] - a[1])
            .map(([value, count]) => ({ value, count })),
        ]),
    );
  }, [places, activeCountries]);

  // Рубрики — плоским списком по убыванию охвата: у Яндекса своя таксономия,
  // и раскладывать её по нашим темам значило бы снова показывать пункты,
  // которых в базе нет.
  const rubricGroups = useMemo<SelectGroups>(() => {
    if (!catalogRubrics.length) return staticGroups(RUBRICS);
    return {
      'рубрики Яндекс.Карт': catalogRubrics.map((item) => ({ value: item.rubric, count: item.companies })),
    };
  }, [catalogRubrics]);

  const allCities = useMemo(
    () => Object.values(cityGroups).flatMap((items) => items.map((item) => item.value)),
    [cityGroups],
  );

  const catalogFilters = useMemo(() => {
    const cities = selectedCities.map((city) => city.trim()).filter(Boolean);
    const categories = (customKeyword.trim() ? [customKeyword.trim()] : selectedRubrics)
      .map((category) => category.trim())
      .filter(Boolean);
    // Одни только страны — это не запрос, а состояние формы по умолчанию.
    if (!cities.length && !categories.length) return undefined;
    return { cities, categories, countries: activeCountries };
  }, [activeCountries, customKeyword, selectedCities, selectedRubrics]);

  // Сколько найдётся — считаем до запуска, чтобы пустой результат был виден
  // сразу, а не через минуту в списке задач.
  const [preview, setPreview] = useState<{ total: number; capped: boolean } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewToken = useRef(0);

  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    if (!catalogFilters) { setPreview(null); setPreviewBusy(false); setPreviewFailed(false); return; }
    const token = ++previewToken.current;
    setPreviewBusy(true);
    setPreviewFailed(false);
    // Жёсткий предел: без него запрос мог висеть минутами (у supabase-клиента
    // свой таймаут в 2 минуты и три повтора), а в форме всё это время
    // оставалось «считаем…», и было непонятно, сломалось или считается.
    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), 15_000);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const data = await authFetchJson<{ total: number; capped: boolean }>(
            '/api/parsers/yandexmaps/catalog',
            { method: 'POST', body: JSON.stringify({ catalog_filters: catalogFilters }), signal: abort.signal },
          );
          if (token === previewToken.current) {
            setPreview({ total: Number(data?.total ?? 0), capped: Boolean(data?.capped) });
          }
        } catch {
          if (token === previewToken.current) { setPreview(null); setPreviewFailed(true); }
        } finally {
          clearTimeout(deadline);
          if (token === previewToken.current) setPreviewBusy(false);
        }
      })();
    }, 400);
    return () => { clearTimeout(timer); clearTimeout(deadline); abort.abort(); };
  }, [catalogFilters]);

  const previewLabel = !catalogFilters
    ? null
    : previewBusy
      ? 'считаем, сколько найдётся…'
      : previewFailed
        ? 'не удалось посчитать — собрать всё равно можно'
        : preview === null
          ? null
          : preview.total === 0
            ? 'по этим условиям в базе ничего нет — измените город или рубрику'
            : `в базе найдётся ${preview.capped ? 'более ' : ''}${preview.total.toLocaleString('ru-RU')} организаций`;

  const canSubmit = Boolean(catalogFilters);

  const toggleCountry = useCallback((country: string) => {
    setSelectedCountries((prev) => {
      // Пока пользователь не выбирал сам, отталкиваемся от страны по умолчанию,
      // иначе клик по уже подсвеченной России добавлял бы её второй раз.
      const base = prev.length ? prev : activeCountries;
      const next = base.includes(country) ? base.filter((item) => item !== country) : [...base, country];
      // Пустой выбор означал бы «города всех стран разом» — оставляем как было.
      return next.length ? next : base;
    });
    // Города прошлой страны в выборе только мешают.
    setSelectedCities([]);
  }, [activeCountries]);

  /** Ряд стран. Рисуется только когда каталог отдал больше одной страны. */
  const countryPicker = countries.length > 1 ? (
    <div className="flex flex-wrap gap-1.5">
      {countries.map(({ country, companies }) => {
        const active = activeCountries.includes(country);
        return (
          <button
            key={country}
            type="button"
            onClick={() => toggleCountry(country)}
            className={
              clientMode
                ? 'ds-btn-ghost text-[11px]'
                : `text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    active
                      ? 'border-blue-200 bg-blue-50 text-blue-700'
                      : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                  }`
            }
            style={
              clientMode
                ? active
                  ? { background: 'var(--cp-surface-active)', color: 'var(--cp-paper)' }
                  : { color: 'var(--cp-paper-mute)' }
                : undefined
            }
          >
            {country}
            <span className="ml-1.5 opacity-60 tabular-nums">{formatCount(companies)}</span>
          </button>
        );
      })}
    </div>
  ) : null;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!catalogFilters) return;
    await props.onCreate({
      search_urls: [],
      catalog_filters: catalogFilters,
      // Лимит убран из формы: отдаём всё, что нашлось, до потолка выдачи.
      max_results: CATALOG_MAX_RESULTS,
      headless,
      proxy,
    });
  };

  // ── Client portal: purpose-built editorial form (city × category first).
  if (clientMode) {
    const countLabel = previewLabel ?? 'Выберите города и категорию';
    return (
      <form onSubmit={onSubmit} className="neu-card p-5 sm:p-6 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold m-0" style={{ color: 'var(--cp-paper)' }}>
              Поиск по городам и категориям
            </h2>
            <p className="mt-1 text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
              Выберите города и категорию бизнеса — соберём организации с Яндекс.Карт.
            </p>
          </div>
          <button type="button" onClick={() => setShowHowItWorks(true)} className="ds-btn-ghost shrink-0 text-xs">
            Как это работает
          </button>
        </div>

        {countryPicker && (
          <div>
            <label className="ds-eyebrow mb-1.5 block">страна</label>
            {countryPicker}
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="ds-eyebrow">города</label>
            <div className="flex items-center gap-1">
              <button type="button" className="ds-btn-ghost text-[11px]" style={{ padding: '2px 8px' }} onClick={() => setSelectedCities(allCities)}>
                все
              </button>
              <button type="button" className="ds-btn-ghost text-[11px]" style={{ padding: '2px 8px' }} onClick={() => setSelectedCities([])}>
                сбросить
              </button>
            </div>
          </div>
          <MultiSelect
            options={cityGroups}
            value={selectedCities}
            onChange={setSelectedCities}
            clientMode
            className="h-56"
            searchPlaceholder="Поиск города или региона…"
            emptyHint={dictLoading ? 'Загружаем список…' : 'Ничего не найдено.'}
          />
          <p className="mt-1.5 text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
            {selectedCities.length > 0 ? `Выбрано городов: ${selectedCities.length}` : 'Нажмите на города, чтобы выбрать.'}
          </p>
        </div>

        <div>
          <label className="ds-eyebrow mb-1.5 block">категория бизнеса</label>
          <input
            className="ds-input w-full"
            placeholder="например: автосервис, кофейня, стоматология"
            value={customKeyword}
            onChange={(e) => setCustomKeyword(e.target.value)}
          />
          <p className="mt-1.5 text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
            Впишите свою категорию — или выберите из списка ниже.
          </p>
          <div className="mt-2" style={customKeyword.trim() ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
            <MultiSelect
              options={rubricGroups}
              value={selectedRubrics}
              onChange={setSelectedRubrics}
              disabled={Boolean(customKeyword.trim())}
              clientMode
              className="h-44"
              searchPlaceholder="Поиск категории…"
              emptyHint={dictLoading ? 'Загружаем список…' : 'Ничего не найдено.'}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <span className="text-xs" style={{ color: 'var(--cp-paper-faint)' }}>{countLabel}</span>
          <button
            type="submit"
            disabled={props.busy || !canSubmit}
            className="ds-btn-primary inline-flex items-center gap-2 px-5 disabled:opacity-40"
          >
            {props.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Запустить поиск
          </button>
        </div>

        {showHowItWorks && (
          <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: 'var(--cp-scrim)' }}>
            <div className="w-full max-w-lg neu-card overflow-hidden">
              <div className="px-6 py-4" style={{ borderBottom: '1px solid var(--cp-divider)' }}>
                <h3 className="text-base font-semibold m-0" style={{ color: 'var(--cp-paper)' }}>
                  Как работает поиск по Яндекс.Картам
                </h3>
              </div>
              <div className="px-6 py-4 space-y-3 text-xs leading-relaxed" style={{ color: 'var(--cp-paper-mute)' }}>
                <p>Вы выбираете города и категорию бизнеса — мы составляем запросы по Яндекс.Картам (город × категория) и проходим выдачу организаций.</p>
                <p>Для каждой организации собираем карточку: название, адрес, сайт, контакты. Дубли по одному домену объединяем.</p>
                <p>Больше городов и категорий — больше организаций, но дольше. Большие задачи лучше запускать партиями.</p>
              </div>
              <div className="flex items-center justify-end px-6 py-4" style={{ borderTop: '1px solid var(--cp-divider)' }}>
                <button type="button" onClick={() => setShowHowItWorks(false)} className="ds-btn-primary">
                  Понятно
                </button>
              </div>
            </div>
          </div>
        )}
      </form>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {/* Фильтры — единственный блок формы. Ввод ссылок вручную и «организаций
          на 1 запрос» убраны: сбор идёт из своей базы, поисковых URL там нет,
          а лимит на запрос потерял смысл — отдаём всё, что нашлось. */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-gray-100 bg-gray-50/50">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-violet-100 text-violet-600">
                  <Layers className="h-3.5 w-3.5" />
                </span>
                Фильтры
              </h3>
              <p className="text-sm text-gray-500 mt-1">
                Страна, города и рубрики. Сбор идёт из нашей базы организаций Яндекс.Карт.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowHowItWorks(true)}
              className="shrink-0 inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 border border-amber-200 hover:bg-amber-100 hover:border-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-1"
            >
              <Info className="h-3.5 w-3.5 mr-1" />
              <span>Как это работает</span>
            </button>
          </div>
        </div>

        <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-2">
            {countryPicker && (
              <div className="space-y-1.5">
                <label className="block text-sm font-medium text-gray-700">Страна</label>
                {countryPicker}
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <label className="block text-sm font-medium text-gray-700">Города и регионы</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded-md border border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100"
                  onClick={() => setSelectedCities(allCities)}
                >
                  Выбрать все
                </button>
                <button
                  type="button"
                  className="text-xs px-2 py-1 rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50"
                  onClick={() => setSelectedCities([])}
                >
                  Очистить
                </button>
              </div>
            </div>
            <MultiSelect
              options={cityGroups}
              value={selectedCities}
              onChange={setSelectedCities}
              className="h-[28rem] shadow-sm focus-within:ring-1 focus-within:ring-blue-500 focus-within:border-blue-500"
              searchPlaceholder="Поиск города или региона…"
              emptyHint={dictLoading ? 'Загружаем список…' : 'Ничего не найдено.'}
            />
            <p className="text-xs text-gray-500">Нажмите для выбора. Цифра справа — сколько организаций в базе.</p>
          </div>

          <div className="space-y-5">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Своё ключевое слово</label>
              <input
                className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none sm:text-sm px-3 py-2"
                placeholder="Например: автосервис"
                value={customKeyword}
                onChange={(e) => setCustomKeyword(e.target.value)}
              />
              <p className="text-xs text-gray-500">Если заполнено, выбранные ниже рубрики игнорируются.</p>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-gray-700">Рубрики</label>
              <MultiSelect
                options={rubricGroups}
                value={selectedRubrics}
                onChange={setSelectedRubrics}
                disabled={Boolean(customKeyword.trim())}
                className={`h-[22rem] shadow-sm focus-within:ring-1 focus-within:ring-blue-500 focus-within:border-blue-500 ${Boolean(customKeyword.trim()) ? 'bg-gray-50 opacity-60' : ''}`}
                searchPlaceholder="Поиск категории…"
                emptyHint={dictLoading ? 'Загружаем список…' : 'Ничего не найдено.'}
              />
            </div>

          </div>
        </div>
      </div>

      {/* Settings Section */}
      <div className="flex items-center justify-between pt-4">
        <div className="text-sm text-gray-500">
          {previewLabel ? (
            <span className={preview?.total === 0 ? 'text-amber-600 font-medium' : undefined}>{previewLabel}</span>
          ) : null}
        </div>
        <button
          type="submit"
          disabled={props.busy || !canSubmit}
          className="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-6 py-3 text-base font-medium text-white shadow-sm hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform active:scale-95"
        >
          {props.busy ? 'Собираем…' : 'Собрать'}
        </button>
      </div>

      {showHowItWorks && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl">
            <div className="px-6 py-5 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">Как работает парсер Яндекс.Карт</h3>
            </div>
            <div className="px-6 py-4 space-y-3 text-sm text-gray-700">
              <p>
                Выбор <span className="font-semibold">страны, города и рубрики</span> ищет по нашей внутренней базе
                организаций Яндекс.Карт. Это выдача за секунды, без обращений к Яндексу и без прокси.
              </p>
              <p>
                Списки городов и рубрик <span className="font-semibold">построены из самой базы</span>, а цифра рядом с
                пунктом — сколько за ним организаций. Перед запуском видно, сколько всего найдётся.
              </p>
              <p>
                Живой парсинг Яндекса остаётся только для <span className="font-semibold">вставленных вручную ссылок</span>:
                он нужен, когда организации ещё нет в базе. Такой запуск идёт через прокси и занимает часы.
              </p>
              <p>
                Сама база <span className="font-semibold">пополняется фоном</span> — понемногу каждый день, поэтому
                карточки постепенно освежаются без нагрузки на Яндекс.
              </p>
              <p>
                Чтобы получить <span className="font-semibold">качественную выдачу</span>:
              </p>
              <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                <li>если по выбранным условиям показано «ничего нет» — поменяйте рубрику: у Яндекса своя формулировка;</li>
                <li>крупные города частью привязаны к региону, поэтому в списке есть и города, и регионы;</li>
                <li>после выгрузки проверьте дубли и отсейте нерелевантные рубрики.</li>
              </ul>
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-6 py-4">
              <button
                type="button"
                onClick={() => setShowHowItWorks(false)}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Понятно
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}

