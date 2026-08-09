'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Info, Layers, Play, Loader2, ChevronDown, ChevronRight, X } from 'lucide-react';
import { CITIES, RUBRICS } from '@/lib/parsers/yandexMapsData';
import { authFetchJson } from '@/lib/authFetch';

/**
 * Пункт списка: значение, сколько организаций за ним стоит и какая их доля
 * имеет телефон, сайт или почту. Доля важна для рубрик: «Скамейки» — вторая
 * по размеру рубрика каталога, но контакты есть у 0%, и для аутрича она пуста.
 */
export type SelectOption = { value: string; count?: number; share?: number };
export type SelectGroups = Record<string, SelectOption[]>;
/** Значение, которым выбирается группа целиком: для региона — сам регион. */
export type GroupValues = Record<string, string>;

export type SortMode = 'count' | 'alpha' | 'share';

const SORT_LABELS: Record<SortMode, string> = {
  count: 'по охвату',
  alpha: 'по алфавиту',
  share: 'по контактам',
};

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace('.0', '')} млн`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}к`;
  return String(count);
}

function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * Сколько пунктов рисуем сразу и на сколько прибавляем по кнопке. В одной
 * России около 2800 городов, а рубрик несколько тысяч — рисовать всё сразу
 * заметно тормозит форму. Списки отсортированы по охвату, так что в первую
 * порцию попадает самое крупное, а до остального можно дойти и кнопкой, и
 * поиском: раньше хвост за жёстким лимитом достать было нечем.
 */
const INITIAL_RENDER = 300;
const RENDER_STEP = 700;

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

/** Оставляет только выбранное — режим «показать выбор» при длинном списке. */
function keepSelected(groups: SelectGroups, selected: Set<string>): SelectGroups {
  const out: SelectGroups = {};
  for (const [group, items] of Object.entries(groups)) {
    const matched = items.filter((item) => selected.has(item.value));
    if (matched.length) out[group] = matched;
  }
  return out;
}

function sortGroups(groups: SelectGroups, mode: SortMode): SelectGroups {
  const weight = (item: SelectOption) => (mode === 'share' ? item.share ?? -1 : item.count ?? 0);
  const compare = (a: SelectOption, b: SelectOption) =>
    mode === 'alpha' ? a.value.localeCompare(b.value, 'ru') : weight(b) - weight(a) || a.value.localeCompare(b.value, 'ru');
  const total = (items: SelectOption[]) => items.reduce((sum, item) => sum + (item.count ?? 0), 0);
  const entries = Object.entries(groups).map(([group, items]) => [group, [...items].sort(compare)] as const);
  entries.sort((a, b) =>
    mode === 'alpha' ? a[0].localeCompare(b[0], 'ru') : total(b[1]) - total(a[1]) || a[0].localeCompare(b[0], 'ru'),
  );
  return Object.fromEntries(entries);
}

/**
 * Список с поиском, группами и выбором группы целиком.
 *
 * Раньше это был короткий скролл на 400 пунктов: увидеть свой выбор было
 * нельзя, взять регион целиком — тоже, а хвост списка доставался только
 * поиском. Здесь: чипы выбранного, выбор группы одним кликом, сворачивание
 * групп, сортировка и догрузка хвоста.
 */
function MultiSelect({
  options,
  value,
  onChange,
  disabled,
  className,
  clientMode,
  searchPlaceholder,
  emptyHint,
  groupValues,
  columns = 1,
  sortModes = ['count', 'alpha'],
  toolbarExtra,
  maxBulkSelect,
  testId,
}: {
  options: SelectGroups;
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  className?: string;
  clientMode?: boolean;
  searchPlaceholder?: string;
  emptyHint?: string;
  /** Название группы → значение, которое выбирает её целиком (регион). */
  groupValues?: GroupValues;
  /** Раскладывать ли пункты в две колонки на широком экране. */
  columns?: 1 | 2;
  sortModes?: SortMode[];
  /** Свои переключатели в шапке списка (например, «только с контактами»). */
  toolbarExtra?: ReactNode;
  /**
   * Потолок выбора «одной кнопкой». Для рубрик он низкий: каждая рубрика
   * добавляет в запрос `like '%…%'` по двум колонкам, и выбор всех двух с
   * половиной тысяч разом положил бы поиск. Города сверяются равенством по
   * индексу — там потолок не нужен.
   */
  maxBulkSelect?: number;
  testId?: string;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>(sortModes[0] ?? 'count');
  const [onlySelectedRaw, setOnlySelected] = useState(false);
  // Режим «показать выбор» сам гаснет, когда снят последний пункт: кнопка
  // возврата рисуется только при непустом выборе, и без этого из пустого
  // списка было бы не выйти.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const onlySelected = onlySelectedRaw && value.length > 0;
  const bulkLimit = maxBulkSelect ?? Number.POSITIVE_INFINITY;

  const selectedSet = useMemo(() => new Set(value), [value]);

  // Новый запрос, сортировка или режим — снова показываем первую порцию: иначе
  // догруженные тысячи пунктов остаются в DOM и тормозят ввод в поиске. Ключ
  // сравнивается прямо при отрисовке, а не сбрасывается эффектом: список
  // пунктов пересобирается на каждый выбор, и эффект по нему схлопывал бы
  // догруженный хвост при каждом клике.
  const renderKey = `${query}|${sort}|${onlySelected}`;
  const [rendering, setRendering] = useState({ key: renderKey, limit: INITIAL_RENDER });
  const limit = rendering.key === renderKey ? rendering.limit : INITIAL_RENDER;
  const showMore = () => setRendering({ key: renderKey, limit: limit + RENDER_STEP });

  const matched = useMemo(() => {
    const byQuery = filterGroups(options, query);
    return onlySelected ? keepSelected(byQuery, selectedSet) : byQuery;
  }, [options, query, onlySelected, selectedSet]);
  const visible = useMemo(() => sortGroups(matched, sort), [matched, sort]);
  const matchedCount = useMemo(
    () => Object.values(matched).reduce((sum, items) => sum + items.length, 0),
    [matched],
  );

  const toggleOption = (option: string) => {
    if (disabled) return;
    onChange(selectedSet.has(option) ? value.filter((v) => v !== option) : [...value, option]);
  };

  const addAll = (items: string[]) => {
    if (disabled) return;
    onChange([...new Set([...value, ...items])]);
  };

  const removeAll = (items: string[]) => {
    if (disabled) return;
    const drop = new Set(items);
    onChange(value.filter((item) => !drop.has(item)));
  };

  // Выбираем всё, что нашлось по запросу, а не только отрисованную часть —
  // иначе кнопка молча теряла бы то, что не поместилось в лимит отрисовки.
  const selectMatched = () => {
    addAll(Object.values(matched).flatMap((items) => items.map((item) => item.value)));
  };

  const surface = clientMode
    ? { background: 'var(--cp-surface-rest)', border: '1px solid var(--cp-divider-strong)' }
    : undefined;
  const muted = clientMode ? 'var(--cp-paper-faint)' : 'rgb(107 114 128)';
  const chipClass = clientMode
    ? 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]'
    : 'inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] text-blue-700';
  const smallButton = clientMode
    ? 'ds-btn-ghost shrink-0 text-[11px]'
    : 'shrink-0 rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-100';

  // Порция отрисовки распределяется по группам сверху вниз: свёрнутая группа
  // ничего не тратит, поэтому свернув крупный регион видно следующие.
  let budget = limit;
  const rendered: Array<{ group: string; items: SelectOption[]; hidden: number }> = [];
  for (const [group, items] of Object.entries(visible)) {
    if (collapsed[group]) {
      rendered.push({ group, items: [], hidden: items.length });
      continue;
    }
    if (budget <= 0) {
      rendered.push({ group, items: [], hidden: items.length });
      continue;
    }
    const slice = items.slice(0, budget);
    budget -= slice.length;
    rendered.push({ group, items: slice, hidden: items.length - slice.length });
  }
  const hiddenCount = rendered.reduce((sum, group) => sum + (collapsed[group.group] ? 0 : group.hidden), 0);

  const columnClass = columns === 2 ? 'sm:grid-cols-2 2xl:grid-cols-3' : '';

  return (
    <div
      data-testid={testId}
      className={`rounded-lg overflow-hidden flex flex-col ${clientMode ? '' : 'border border-gray-300 bg-white'} ${className ?? ''}`}
      style={surface}
    >
      <div
        className={`px-2 py-1.5 space-y-1.5 ${clientMode ? '' : 'border-b border-gray-200 bg-gray-50/70'}`}
        style={clientMode ? { borderBottom: '1px solid var(--cp-divider)' } : undefined}
      >
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={query}
            disabled={disabled}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder ?? 'Поиск…'}
            className={clientMode ? 'ds-input w-full text-xs' : 'block w-full rounded-md border-gray-300 text-xs px-2 py-1 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none'}
          />
          {query.trim() && matchedCount > 0 && matchedCount <= bulkLimit && (
            <button type="button" onClick={selectMatched} className={smallButton}>
              выбрать {matchedCount}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" style={{ color: muted }}>
          {sortModes.length > 1 && (
            <div className="flex items-center gap-1">
              <span className="opacity-70">сортировка:</span>
              {sortModes.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setSort(mode)}
                  className={`rounded px-1.5 py-0.5 ${
                    sort === mode
                      ? clientMode ? '' : 'bg-blue-50 text-blue-700'
                      : clientMode ? 'opacity-60' : 'hover:bg-gray-100'
                  }`}
                  style={clientMode && sort === mode ? { background: 'var(--cp-surface-active)', color: 'var(--cp-paper)' } : undefined}
                >
                  {SORT_LABELS[mode]}
                </button>
              ))}
            </div>
          )}
          {toolbarExtra}
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => setOnlySelected((v) => !v)}
              className={`rounded px-1.5 py-0.5 ${
                onlySelected
                  ? clientMode ? '' : 'bg-blue-50 text-blue-700'
                  : clientMode ? 'opacity-60' : 'hover:bg-gray-100'
              }`}
              style={clientMode && onlySelected ? { background: 'var(--cp-surface-active)', color: 'var(--cp-paper)' } : undefined}
            >
              {onlySelected ? 'показать все' : `показать выбор (${value.length})`}
            </button>
          )}
        </div>
        {value.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 pt-0.5">
            {value.slice(0, 24).map((item) => (
              <span
                key={item}
                className={chipClass}
                style={clientMode ? { background: 'var(--cp-surface-active)', color: 'var(--cp-paper)' } : undefined}
              >
                {item}
                <button
                  type="button"
                  aria-label={`Убрать ${item}`}
                  onClick={() => toggleOption(item)}
                  className="opacity-60 hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {value.length > 24 && (
              <span className="text-[11px]" style={{ color: muted }}>
                и ещё {value.length - 24}
              </span>
            )}
            <button type="button" onClick={() => onChange([])} className={`${smallButton} ml-auto`}>
              снять все
            </button>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar my-1 mr-1">
        {matchedCount === 0 && (
          <div className="px-3 py-4 text-xs" style={{ color: muted }}>
            {onlySelected ? 'Ничего не выбрано.' : emptyHint ?? 'Ничего не найдено.'}
          </div>
        )}
        {rendered.map(({ group, items, hidden }) => {
          const all = visible[group] ?? [];
          const selectedInGroup = all.filter((item) => selectedSet.has(item.value)).length;
          const groupValue = groupValues?.[group];
          const groupValueSelected = Boolean(groupValue && selectedSet.has(groupValue));
          return (
            <div key={group}>
              <div
                className={`sticky top-0 z-10 py-1.5 px-3 ${clientMode ? '' : 'bg-gray-100 border-b border-gray-200 shadow-sm'}`}
                style={clientMode ? { background: 'var(--cp-surface-elev)', borderBottom: '1px solid var(--cp-divider)' } : undefined}
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCollapsed((prev) => ({ ...prev, [group]: !prev[group] }))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    aria-label={collapsed[group] ? `Развернуть ${group}` : `Свернуть ${group}`}
                  >
                    {collapsed[group] ? <ChevronRight className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
                    <span
                      className="truncate text-xs font-bold uppercase tracking-wider"
                      style={clientMode ? { color: 'var(--cp-paper-faint)' } : { color: 'rgb(55 65 81)' }}
                    >
                      {group}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums opacity-60">
                      {selectedInGroup ? `${selectedInGroup}/${all.length}` : all.length}
                    </span>
                  </button>
                  {groupValue ? (
                    <button
                      type="button"
                      onClick={() => (groupValueSelected ? removeAll([groupValue]) : addAll([groupValue]))}
                      className={smallButton}
                      style={clientMode && groupValueSelected ? { background: 'var(--cp-surface-active)', color: 'var(--cp-paper)' } : undefined}
                    >
                      {groupValueSelected ? 'снять регион' : 'весь регион'}
                    </button>
                  ) : all.length <= bulkLimit ? (
                    <button
                      type="button"
                      onClick={() => addAll(all.map((item) => item.value))}
                      className={smallButton}
                    >
                      все
                    </button>
                  ) : null}
                  {selectedInGroup > 0 && (
                    <button
                      type="button"
                      onClick={() => removeAll(all.map((item) => item.value))}
                      className={smallButton}
                    >
                      снять
                    </button>
                  )}
                </div>
              </div>
              {items.length > 0 && (
                <div className={`grid gap-1 p-2 ${columnClass}`}>
                  {items.map(({ value: item, count, share }) => {
                    const isSelected = selectedSet.has(item);
                    return (
                      <div
                        key={item}
                        onClick={() => toggleOption(item)}
                        className={`px-3 py-1.5 rounded-md text-sm cursor-pointer transition-all duration-200 flex items-center justify-between gap-2 group ${disabled ? 'opacity-50 cursor-not-allowed' : ''} ${
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
                        <span className="truncate font-medium">{item}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {typeof share === 'number' && (
                            <span
                              className="text-[11px] tabular-nums"
                              title="доля организаций с телефоном, сайтом или почтой"
                              style={{ color: isSelected && !clientMode ? 'rgb(37 99 235)' : muted }}
                            >
                              {formatShare(share)}
                            </span>
                          )}
                          {typeof count === 'number' && !isSelected && (
                            <span className="text-[11px] tabular-nums" style={{ color: clientMode ? 'var(--cp-paper-faint)' : 'rgb(156 163 175)' }}>
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
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {!collapsed[group] && hidden > 0 && items.length > 0 && (
                <div className="px-3 pb-2 text-[11px]" style={{ color: muted }}>
                  и ещё {hidden.toLocaleString('ru-RU')} в этой группе
                </div>
              )}
            </div>
          );
        })}
        {hiddenCount > 0 && (
          <div className="flex items-center justify-between gap-2 px-3 py-2 text-[11px]" style={{ color: muted }}>
            <span>Скрыто {hiddenCount.toLocaleString('ru-RU')} — список длинный, рисуем порциями.</span>
            <button type="button" onClick={showMore} className={smallButton}>
              показать ещё
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

type CatalogPlace = { country: string; region: string; city: string; companies: number };
type CatalogRubric = { rubric: string; companies: number; with_contacts?: number };

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

/**
 * Ниже этой доли организаций с контактами рубрика бесполезна для аутрича:
 * скамейки, детские и мусорные площадки — крупнейшие рубрики каталога, но
 * телефона нет ни у одной. Порог мягкий: настоящие рубрики держат 20-86%.
 */
const MIN_CONTACT_SHARE = 0.15;
/** Сколько крупных рубрик показать быстрым выбором над списком. */
const QUICK_RUBRICS = 14;
/**
 * Потолок выбора рубрик одной кнопкой. Каждая рубрика — это `like '%…%'` по
 * двум колонкам в условии поиска, поэтому «выбрать все 2600» превратилось бы
 * в запрос, который база не досчитает.
 */
const MAX_RUBRIC_BULK = 50;
/**
 * Потолка на выдачу больше нет — забираем всё, что нашлось. Это число лишь
 * говорит, где сбор перестаёт помещаться в HTTP-запрос и уходит в очередь к
 * воркеру: тот же CATALOG_INLINE_LIMIT, что и на сервере. Отдельной константой,
 * а не импортом: модуль каталога тянет за собой supabaseAdmin, и в клиентский
 * бандл ему нельзя.
 */
const CATALOG_INLINE_LIMIT = 20000;

export function YandexMapsParserForm(props: {
  busy?: boolean;
  /** Client portal: client-language wording (no «парсер»). */
  clientMode?: boolean;
  onCreate: (payload: {
    catalog_filters: { cities?: string[]; categories?: string[]; countries?: string[] };
    /** Только кабинет: объём считается по тарифу. У оператора потолок серверный. */
    max_results?: number;
  }) => Promise<void> | void;
}) {
  const clientMode = props.clientMode;
  const [maxResults, setMaxResults] = useState(250);
  /**
   * Сколько организаций забрать — необязательное ограничение. `null` (пустое
   * поле) означает «все, сколько найдётся», и это поведение по умолчанию:
   * выбрал фильтры — забрал всё, хоть миллион. Число нужно только тогда, когда
   * человек сознательно хочет меньше.
   */
  const [amount, setAmount] = useState<number | null>(null);

  const [selectedCities, setSelectedCities] = useState<string[]>([]);
  const [selectedRubrics, setSelectedRubrics] = useState<string[]>([]);
  const [customKeyword, setCustomKeyword] = useState('');
  const [showHowItWorks, setShowHowItWorks] = useState(false);

  const { places, rubrics: catalogRubrics, loading: dictLoading } = useCatalogDictionaries();
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [onlyWithContacts, setOnlyWithContacts] = useState(true);

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
  // сопоставлять и по городу, и по региону. Регион же выбирается целиком
  // кнопкой в шапке группы: одно значение вместо сотен городов в запросе.
  const { cityGroups, cityGroupValues } = useMemo<{ cityGroups: SelectGroups; cityGroupValues: GroupValues }>(() => {
    if (!places.length) return { cityGroups: staticGroups(CITIES), cityGroupValues: {} };
    const active = new Set(activeCountries);
    const multiCountry = active.size > 1;
    const grouped = new Map<string, { region: string; items: Map<string, number> }>();
    for (const place of places) {
      if (!active.has(place.country)) continue;
      const value = place.city || place.region;
      if (!value) continue;
      const base = place.region || place.country;
      const label = multiCountry ? `${place.country} · ${base}` : base;
      const bucket = grouped.get(label) ?? { region: place.region, items: new Map<string, number>() };
      bucket.items.set(value, (bucket.items.get(value) ?? 0) + place.companies);
      grouped.set(label, bucket);
    }
    const groupTotal = (items: Map<string, number>) => [...items.values()].reduce((a, b) => a + b, 0);
    const entries = [...grouped].sort((a, b) => groupTotal(b[1].items) - groupTotal(a[1].items));
    return {
      cityGroups: Object.fromEntries(
        entries.map(([label, bucket]) => [
          label,
          [...bucket.items].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count })),
        ]),
      ),
      cityGroupValues: Object.fromEntries(
        entries.filter(([, bucket]) => bucket.region).map(([label, bucket]) => [label, bucket.region]),
      ),
    };
  }, [places, activeCountries]);

  // Доля организаций с контактами по рубрике приходит из справочника. До
  // пересчёта справочника её может не быть — тогда фильтр не применяем, иначе
  // список схлопнулся бы в пустой.
  const rubricShares = useMemo(() => {
    const out = new Map<string, number>();
    for (const item of catalogRubrics) {
      if (typeof item.with_contacts !== 'number' || !item.companies) continue;
      out.set(item.rubric, item.with_contacts / item.companies);
    }
    return out;
  }, [catalogRubrics]);
  const hasContactStats = useMemo(() => [...rubricShares.values()].some((share) => share > 0), [rubricShares]);
  const contactFilterOn = onlyWithContacts && hasContactStats;

  // Рубрики — плоским списком по убыванию охвата: у Яндекса своя таксономия,
  // и раскладывать её по нашим темам значило бы снова показывать пункты,
  // которых в базе нет.
  const rubricGroups = useMemo<SelectGroups>(() => {
    if (!catalogRubrics.length) return staticGroups(RUBRICS);
    const items = catalogRubrics
      .map((item) => ({ value: item.rubric, count: item.companies, share: rubricShares.get(item.rubric) }))
      .filter((item) =>
        // Выбранное не прячем: иначе снятый чип было бы негде вернуть.
        !contactFilterOn || selectedRubrics.includes(item.value) || (item.share ?? 1) >= MIN_CONTACT_SHARE,
      );
    return { 'рубрики Яндекс.Карт': items };
  }, [catalogRubrics, contactFilterOn, rubricShares, selectedRubrics]);

  const hiddenRubrics = catalogRubrics.length
    ? catalogRubrics.length - (rubricGroups['рубрики Яндекс.Карт']?.length ?? catalogRubrics.length)
    : 0;

  // Быстрый выбор сферы: крупнейшие рубрики, у которых есть с кем говорить.
  const quickRubrics = useMemo(() => {
    if (!catalogRubrics.length) return [];
    return catalogRubrics
      .filter((item) => (rubricShares.get(item.rubric) ?? 1) >= MIN_CONTACT_SHARE)
      .slice(0, QUICK_RUBRICS)
      .map((item) => item.rubric);
  }, [catalogRubrics, rubricShares]);

  /** «Выбрать все» берёт регионы, а не города: 80 значений вместо 2800. */
  const allPlaceValues = useMemo(() => {
    const out: string[] = [];
    for (const [group, items] of Object.entries(cityGroups)) {
      const groupValue = cityGroupValues[group];
      if (groupValue) out.push(groupValue);
      else out.push(...items.map((item) => item.value));
    }
    return [...new Set(out)];
  }, [cityGroups, cityGroupValues]);

  const catalogFilters = useMemo(() => {
    const cities = selectedCities.map((city) => city.trim()).filter(Boolean);
    const categories = (customKeyword.trim() ? [customKeyword.trim()] : selectedRubrics)
      .map((category) => category.trim())
      .filter(Boolean);
    // Одни только страны — это не запрос, а состояние формы по умолчанию.
    if (!cities.length && !categories.length) return undefined;
    return { cities, categories, countries: activeCountries };
  }, [activeCountries, customKeyword, selectedCities, selectedRubrics]);

  // Предпросчёта «сколько найдётся» здесь больше нет: он уходил на каждое
  // изменение фильтра и стоил полного прохода по всем подходящим строкам —
  // счёт обязан досмотреть выборку до конца, в отличие от самого сбора, который
  // останавливается, набрав нужное. Объём каждой рубрики и места по-прежнему
  // виден в списках: он берётся из заранее посчитанных справочников.
  const runLabel = !catalogFilters
    ? 'Выберите места и сферы'
    : amount === null
      // Сколько найдётся, мы не знаем, поэтому такой сбор всегда уходит в
      // очередь: миллион строк в HTTP-запрос не поместится.
      ? 'заберём всё, что найдётся — сбор пойдёт в фоне'
      : `заберём до ${amount.toLocaleString('ru-RU')} организаций${
          amount > CATALOG_INLINE_LIMIT ? ' — сбор пойдёт в фоне' : ''
        }`;

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

  /** Переключатель «только с контактами» — живёт в шапке списка рубрик. */
  const contactToggle = hasContactStats ? (
    <button
      type="button"
      onClick={() => setOnlyWithContacts((v) => !v)}
      className={`rounded px-1.5 py-0.5 ${
        onlyWithContacts
          ? clientMode ? '' : 'bg-blue-50 text-blue-700'
          : clientMode ? 'opacity-60' : 'hover:bg-gray-100'
      }`}
      style={clientMode && onlyWithContacts ? { background: 'var(--cp-surface-active)', color: 'var(--cp-paper)' } : undefined}
      title="Скрывает рубрики без телефонов и сайтов: скамейки, площадки, парковки"
    >
      только с контактами{onlyWithContacts && hiddenRubrics > 0 ? ` (−${hiddenRubrics})` : ''}
    </button>
  ) : null;

  /** Быстрый выбор сферы одной кнопкой — над списком рубрик. */
  const quickRubricRow = quickRubrics.length > 0 && !customKeyword.trim() ? (
    <div className="flex flex-wrap gap-1.5">
      {quickRubrics.map((rubric) => {
        const active = selectedRubrics.includes(rubric);
        return (
          <button
            key={rubric}
            type="button"
            onClick={() =>
              setSelectedRubrics((prev) => (prev.includes(rubric) ? prev.filter((item) => item !== rubric) : [...prev, rubric]))
            }
            className={
              clientMode
                ? 'ds-btn-ghost text-[11px]'
                : `text-[11px] px-2 py-1 rounded-full border transition-colors ${
                    active
                      ? 'border-violet-200 bg-violet-50 text-violet-700'
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
            {rubric}
          </button>
        );
      })}
    </div>
  ) : null;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!catalogFilters) return;
    // В кабинете объём обязателен — он списывается с тарифа. У оператора это
    // необязательное ограничение: не указал — сервер понимает как «забрать всё,
    // что нашлось». Урезать выдачу по умолчанию незачем, это один SELECT по
    // своей базе, а не тысячи заходов в Яндекс.
    await props.onCreate(clientMode
      ? { catalog_filters: catalogFilters, max_results: maxResults }
      : { catalog_filters: catalogFilters, ...(amount === null ? {} : { max_results: amount }) });
  };

  // ── Client portal: purpose-built editorial form (city × category first).
  // Operators fall through to the full form below.
  if (clientMode) {
    // В кабинете объём задаёт сам клиент (списывается с тарифа), поэтому и до
    // запуска говорить нечего, кроме как что выбрать.
    const countLabel = catalogFilters
      ? `заберём до ${maxResults.toLocaleString('ru-RU')} организаций`
      : 'Выберите города и категорию';
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

        {/* Города и сфера — рядом на широком экране, друг под другом на узком.
            Оба списка высокие: выбор из тысяч пунктов в окошке на 200 px был
            главной жалобой на форму. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="ds-eyebrow">города и регионы</label>
              <div className="flex items-center gap-1">
                <button type="button" className="ds-btn-ghost text-[11px]" style={{ padding: '2px 8px' }} onClick={() => setSelectedCities(allPlaceValues)}>
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
              groupValues={cityGroupValues}
              columns={2}
              clientMode
              // Выше соседнего списка ровно на поле «своя категория» с быстрыми
              // кнопками над ним — так оба столбца заканчиваются на одной линии.
              className="h-[26rem] lg:h-[32rem]"
              testId="city-picker"
              searchPlaceholder="Поиск города или региона…"
              emptyHint={dictLoading ? 'Загружаем список…' : 'Ничего не найдено.'}
            />
            <p className="mt-1.5 text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
              {selectedCities.length > 0
                ? `Выбрано: ${selectedCities.length}`
                : 'Нажмите на город — или возьмите регион целиком кнопкой в его заголовке.'}
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
            {quickRubricRow && <div className="mt-2">{quickRubricRow}</div>}
            <div className="mt-2" style={customKeyword.trim() ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
              <MultiSelect
                options={rubricGroups}
                value={selectedRubrics}
                onChange={setSelectedRubrics}
                disabled={Boolean(customKeyword.trim())}
                columns={2}
                sortModes={hasContactStats ? ['count', 'alpha', 'share'] : ['count', 'alpha']}
                toolbarExtra={contactToggle}
                maxBulkSelect={MAX_RUBRIC_BULK}
                clientMode
                className="h-[22rem]"
                testId="rubric-picker"
                searchPlaceholder="Поиск категории…"
                emptyHint={dictLoading ? 'Загружаем список…' : 'Ничего не найдено.'}
              />
            </div>
            <p className="mt-1.5 text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
              Впишите свою категорию сверху — или выберите из списка. Процент — доля организаций с телефоном или сайтом.
            </p>
          </div>
        </div>

        {/* Объём остаётся только в кабинете: он списывается с тарифа, и без
            поля клиент не смог бы уложиться в остаток. */}
        <div>
          <label className="ds-eyebrow mb-1.5 block">сколько организаций собрать</label>
          <input
            type="number"
            min={10}
            max={1000}
            step={10}
            className="ds-input w-full"
            value={maxResults}
            onChange={(e) => setMaxResults(Math.max(10, Math.min(1000, Number(e.target.value) || 250)))}
          />
          <p className="mt-1.5 text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
            Сколько карточек забрать по выбранным условиям. По умолчанию 250 — золотая середина. Больше = больше данных и больше расход по тарифу.
          </p>
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
                <p>Вы выбираете города и категорию бизнеса — мы ищем организации в своей базе Яндекс.Карт: результат готов через пару секунд, ждать очереди не нужно.</p>
                <p>Регион можно взять целиком — кнопкой в заголовке группы: так в выборку попадут и организации, привязанные к региону без города.</p>
                <p>Для каждой организации собираем карточку: название, адрес, сайт, контакты. Дубли по одному домену объединяем.</p>
                <p>Поиск идёт по нашей базе, а не по сайту Яндекса: результат готов сразу и не зависит от того, сколько городов выбрано.</p>
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
      {/* Фильтры по своей базе — главный блок формы и потому первый и во всю
          ширину. Живой парсинг по вставленным ссылкам ушёл вниз: это редкий
          путь, а прежде он занимал лучшее место на экране. */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-gray-100 bg-gray-50/50">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-violet-100 text-violet-600">
                  <Layers className="h-3.5 w-3.5" />
                </span>
                Поиск по базе организаций
              </h3>
              <p className="text-sm text-gray-500 mt-1">
                Страна, места и сферы — выдача из нашего каталога Яндекс.Карт, без обращений к Яндексу.
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="inline-flex items-center rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-inset ring-violet-700/10">
                {selectedCities.length} мест · {customKeyword.trim() ? 1 : selectedRubrics.length} сфер
              </span>
              <button
                type="button"
                onClick={() => setShowHowItWorks(true)}
                className="mt-1 inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 border border-amber-200 hover:bg-amber-100 hover:border-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-1"
              >
                <Info className="h-3.5 w-3.5 mr-1" />
                <span>Как работает парсер</span>
              </button>
            </div>
          </div>
        </div>

        <div className="p-5 space-y-5">
          {countryPicker && (
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">Страна</label>
              {countryPicker}
            </div>
          )}

          {/* Два высоких списка в ряд. На широком экране каждый рисует пункты
              в две колонки — на месте прежнего окошка на 400 пунктов видно
              разом в несколько раз больше. */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="block text-sm font-medium text-gray-700">Города и регионы</label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-xs px-2 py-1 rounded-md border border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100"
                    onClick={() => setSelectedCities(allPlaceValues)}
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
                groupValues={cityGroupValues}
                columns={2}
                className="h-[34rem] 2xl:h-[44rem] shadow-sm focus-within:ring-1 focus-within:ring-blue-500 focus-within:border-blue-500"
                testId="city-picker"
                searchPlaceholder="Поиск города или региона…"
                emptyHint={dictLoading ? 'Загружаем список…' : 'Ничего не найдено.'}
              />
              <p className="text-xs text-gray-500">
                Цифра справа — сколько организаций в базе. «Весь регион» в заголовке группы берёт регион одним значением:
                так в выборку попадают и организации, привязанные к региону без города.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="block text-sm font-medium text-gray-700">Сфера (рубрики Яндекса)</label>
                {selectedRubrics.length > 0 && (
                  <button
                    type="button"
                    className="text-xs px-2 py-1 rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50"
                    onClick={() => setSelectedRubrics([])}
                  >
                    Очистить
                  </button>
                )}
              </div>
              <input
                className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none sm:text-sm px-3 py-2"
                placeholder="Своё ключевое слово — например: автосервис"
                value={customKeyword}
                onChange={(e) => setCustomKeyword(e.target.value)}
              />
              {quickRubricRow}
              <MultiSelect
                options={rubricGroups}
                value={selectedRubrics}
                onChange={setSelectedRubrics}
                disabled={Boolean(customKeyword.trim())}
                columns={2}
                sortModes={hasContactStats ? ['count', 'alpha', 'share'] : ['count', 'alpha']}
                toolbarExtra={contactToggle}
                maxBulkSelect={MAX_RUBRIC_BULK}
                className={`h-[28rem] 2xl:h-[38rem] shadow-sm focus-within:ring-1 focus-within:ring-blue-500 focus-within:border-blue-500 ${Boolean(customKeyword.trim()) ? 'bg-gray-50 opacity-60' : ''}`}
                testId="rubric-picker"
                searchPlaceholder="Поиск сферы или рубрики…"
                emptyHint={dictLoading ? 'Загружаем список…' : 'Ничего не найдено.'}
              />
              <p className="text-xs text-gray-500">
                Своё ключевое слово отменяет выбор рубрик. Процент — доля организаций с телефоном, сайтом или почтой:
                «только с контактами» убирает скамейки, площадки и парковки, которых в каталоге сотни тысяч.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3 pt-4">
        <div className="min-w-0">
          {/* Необязательное ограничение. Пустое поле — забрать всё. */}
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <span className="whitespace-nowrap">Сколько забрать</span>
            <input
              type="number"
              min={1}
              // Без step: он отсчитывается от min, и «3000» при min=1, step=100
              // становится недопустимым значением — браузер молча отказывается
              // отправлять форму.
              step={1}
              placeholder="все"
              value={amount ?? ''}
              onChange={(e) => {
                const next = Number(e.target.value);
                setAmount(e.target.value.trim() && Number.isFinite(next) && next > 0 ? Math.floor(next) : null);
              }}
              className="w-28 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <span className="text-xs text-gray-400">необязательно</span>
          </label>
          <p className="mt-1 text-xs text-gray-500">
            Укажете число — заберём столько организаций. Оставите пустым — заберём все, сколько найдётся в базе,
            хоть миллион.
          </p>
          <p className="mt-0.5 text-sm text-gray-500">{runLabel}</p>
        </div>
        <button
          type="submit"
          disabled={props.busy || !canSubmit}
          className="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-6 py-3 text-base font-medium text-white shadow-sm hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform active:scale-95"
        >
          {props.busy ? 'Собираем…' : 'Собрать базу'}
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
                организаций Яндекс.Карт — один запрос к своей базе, а не заходы в Яндекс.
              </p>
              <p>
                Поле <span className="font-semibold">«сколько забрать» — необязательное</span>. Укажете число —
                заберём столько организаций. Оставите пустым — заберём все, сколько найдётся по выбранным условиям,
                хоть миллион.
              </p>
              <p>
                Небольшой объём собирается сразу: нажали «Собрать базу» и через пару секунд смотрите результаты.
                Крупный уходит в фон — задача появится в истории и закроется сама, страницу можно не держать открытой.
              </p>
              <p>
                Списки городов и рубрик <span className="font-semibold">построены из самой базы</span>, а цифра рядом с
                пунктом — сколько за ним организаций. По ней и видно, какой объём вас ждёт.
              </p>
              <p>
                Живого парсинга Яндекса в форме больше нет: нет ни прокси, ни часов ожидания, ни лимита «организаций за
                запрос».
              </p>
              <p>
                Сама база <span className="font-semibold">пополняется фоном</span> — понемногу каждый день, поэтому
                новые организации доезжают без нагрузки на Яндекс.
              </p>
              <p>
                Чтобы получить <span className="font-semibold">качественную выдачу</span>:
              </p>
              <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                <li>если по выбранным условиям показано «ничего нет» — поменяйте рубрику: у Яндекса своя формулировка;</li>
                <li>
                  крупные города частью привязаны к региону — берите регион целиком кнопкой «весь регион» в заголовке
                  группы, одним значением вместо сотни городов;
                </li>
                <li>
                  процент рядом с рубрикой — доля организаций с контактами; рубрики без контактов (скамейки, площадки)
                  спрятаны переключателем «только с контактами»;
                </li>
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
