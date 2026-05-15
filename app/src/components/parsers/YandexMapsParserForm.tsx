'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { Info, Globe, Layers } from 'lucide-react';
import { CITIES, RUBRICS, generateSearchUrls } from '@/lib/parsers/yandexMapsData';

type ProxyForm = {
  enabled: boolean;
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: string;
  username: string;
  password: string;
};

// ... (imports remain the same)

// Custom MultiSelect Component
function MultiSelect({
  options,
  value,
  onChange,
  disabled,
  className,
}: {
  options: Record<string, string[]>;
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  className?: string;
}) {
  const toggleOption = (option: string) => {
    if (disabled) return;
    const next = value.includes(option)
      ? value.filter((v) => v !== option)
      : [...value, option];
    onChange(next);
  };

  return (
    <div className={`border border-gray-300 rounded-lg overflow-hidden bg-white ${className} flex flex-col`}>
      <div className="flex-1 overflow-y-auto custom-scrollbar my-1 mr-1">
        {Object.entries(options).map(([group, items]) => (
          <div key={group}>
            <div className="sticky top-0 bg-gray-100 z-10 py-2 px-3 border-b border-gray-200 shadow-sm">
              <div className="text-xs font-bold text-gray-700 uppercase tracking-wider">
                {group}
              </div>
            </div>
            <div className="p-2 space-y-1">
              {items.map((item) => {
                const isSelected = value.includes(item);
                return (
                  <div
                    key={item}
                    onClick={() => toggleOption(item)}
                    className={`
                      px-3 py-2 rounded-md text-sm cursor-pointer transition-all duration-200 flex items-center justify-between group
                      ${isSelected 
                        ? 'bg-blue-50 text-blue-700 shadow-sm ring-1 ring-blue-100' 
                        : 'text-gray-700 hover:bg-gray-50 hover:text-gray-900'
                      }
                      ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
                    `}
                  >
                    <span className="font-medium">{item}</span>
                    {isSelected && (
                      <span className="text-blue-600 bg-blue-100 rounded-full p-0.5">
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
      </div>
    </div>
  );
}

export function YandexMapsParserForm(props: {
  busy?: boolean;
  onCreate: (payload: {
    search_urls: string[];
    max_results: number;
    headless: boolean;
    proxy: ProxyForm;
  }) => Promise<void> | void;
}) {
  const [searchUrlsText, setSearchUrlsText] = useState('');
  const [maxResults, _setMaxResults] = useState(1000);
  const [headless, _setHeadless] = useState(true);

  const [proxy, _setProxy] = useState<ProxyForm>({
    enabled: false,
    protocol: 'http',
    host: '',
    port: '',
    username: '',
    password: '',
  });

  const [singleCity, _setSingleCity] = useState('');
  const [singleKeyword, _setSingleKeyword] = useState('');

  const [selectedCities, setSelectedCities] = useState<string[]>([]);
  const [selectedRubrics, setSelectedRubrics] = useState<string[]>([]);
  const [customKeyword, setCustomKeyword] = useState('');
  const [showHowItWorks, setShowHowItWorks] = useState(false);

  const allCities = useMemo(
    () => Object.values(CITIES).flat().map((city) => city.trim()).filter(Boolean),
    []
  );

  const searchUrls = useMemo(() => {
    return searchUrlsText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }, [searchUrlsText]);

  const appendUrls = (urls: string[]) => {
    const next = [...searchUrls, ...urls].filter(Boolean);
    setSearchUrlsText(next.join('\n'));
  };

  const _handleGenerateSingle = () => {
    const city = singleCity.trim();
    const keyword = singleKeyword.trim();
    if (!keyword) return;
    const query = `${city} ${keyword}`.trim();
    const url = `https://yandex.ru/maps/?text=${encodeURIComponent(query)}`;
    appendUrls([url]);
  };

  const _handleGenerateBulk = () => {
    const cities = selectedCities.map((s) => s.trim()).filter(Boolean);
    const rubrics = (customKeyword.trim() ? [customKeyword.trim()] : selectedRubrics).map((s) => s.trim()).filter(Boolean);
    if (!cities.length || !rubrics.length) return;
    appendUrls(generateSearchUrls(cities, rubrics));
  };

  const canGenerateBulk = selectedCities.length > 0 && (customKeyword.trim() || selectedRubrics.length > 0);

  const collectAllUrls = (): string[] => {
    let urls = [...searchUrls];
    if (canGenerateBulk) {
      const cities = selectedCities.map((s) => s.trim()).filter(Boolean);
      const rubrics = (customKeyword.trim() ? [customKeyword.trim()] : selectedRubrics).map((s) => s.trim()).filter(Boolean);
      const generated = generateSearchUrls(cities, rubrics);
      urls = [...urls, ...generated];
    }
    return [...new Set(urls.filter(Boolean))];
  };

  const MAX_SEARCH_URLS = 500;
  const totalUrlCount = collectAllUrls().length;
  const canSubmit = totalUrlCount > 0;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const urls = collectAllUrls().slice(0, MAX_SEARCH_URLS);
    if (!urls.length) return;
    await props.onCreate({
      search_urls: urls,
      max_results: maxResults,
      headless,
      proxy,
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {/* URL Search Section */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-gray-100 bg-gray-50/50">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-blue-100 text-blue-600">
                  <Globe className="h-3.5 w-3.5" />
                </span>
                URL поиска
              </h3>
              <p className="text-sm text-gray-500 mt-1">
                Добавьте ссылки на поиск в Яндекс.Картах вручную или сгенерируйте их по городам и рубрикам.
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-700/10">
                {searchUrls.length} URL
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
          <textarea
            className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none text-sm font-mono min-h-[120px] p-3"
            placeholder="https://yandex.ru/maps/?text=Москва%20Кафе"
            value={searchUrlsText}
            onChange={(e) => setSearchUrlsText(e.target.value)}
          />

        </div>
      </div>

      {/* Generator Section */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-gray-100 bg-gray-50/50">
          <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-violet-100 text-violet-600">
              <Layers className="h-3.5 w-3.5" />
            </span>
            Генератор ссылок
          </h3>
          <p className="text-sm text-gray-500 mt-1">Массовая генерация ссылок по городам и рубрикам.</p>
        </div>
        
        <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label className="block text-sm font-medium text-gray-700">Города</label>
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
              options={CITIES}
              value={selectedCities}
              onChange={setSelectedCities}
              className="h-87 shadow-sm focus-within:ring-1 focus-within:ring-blue-500 focus-within:border-blue-500"
            />
            <p className="text-xs text-gray-500">Нажмите для выбора.</p>
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
                options={RUBRICS}
                value={selectedRubrics}
                onChange={setSelectedRubrics}
                disabled={Boolean(customKeyword.trim())}
                className={`h-60 shadow-sm focus-within:ring-1 focus-within:ring-blue-500 focus-within:border-blue-500 ${Boolean(customKeyword.trim()) ? 'bg-gray-50 opacity-60' : ''}`}
              />
            </div>

          </div>
        </div>
      </div>

      {/* Settings Section */}
      <div className="flex items-center justify-between pt-4">
        <div className="text-sm text-gray-500">
          {totalUrlCount > MAX_SEARCH_URLS ? (
            <span className="text-amber-600 font-medium">
              {totalUrlCount} URL — будут обработаны первые {MAX_SEARCH_URLS}
            </span>
          ) : totalUrlCount > 0 ? (
            <span>Итого: {totalUrlCount} URL</span>
          ) : null}
        </div>
        <button
          type="submit"
          disabled={props.busy || !canSubmit}
          className="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-6 py-3 text-base font-medium text-white shadow-sm hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform active:scale-95"
        >
          {props.busy ? 'Запуск...' : 'Запустить парсинг'}
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
                Парсер берёт <span className="font-semibold">список поисковых URL</span> Яндекс.Карт и по каждому урлу
                проходит выдачу организаций.
              </p>
              <p>
                URL можно <span className="font-semibold">вставить руками</span> или
                сгенерировать через блок «Генератор ссылок» по комбинации&nbsp;
                <span className="font-semibold">город × рубрика/ключевое слово</span>.
              </p>
              <p>
                Для каждой найденной организации инструмент пытается вытащить карточку компании: название, адрес, сайт
                и контактные данные. Если одна и та же компания встретилась в нескольких урлах, она будет
                <span className="font-semibold">объединена</span> по домену и названию.
              </p>
              <p>
                Чтобы получить <span className="font-semibold">качественную выдачу</span>:
              </p>
              <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                <li>используйте осмысленные сочетания городов и рубрик (не выбирайте сразу все города без необходимости);</li>
                <li>ограничивайте число URL — лишний мусор только замедляет парсинг и даёт больше дублей;</li>
                <li>после выгрузки проверьте дубли и отсейте нерелевантные рубрики.</li>
              </ul>
              <p className="text-xs text-gray-500 pt-1">
                Чем больше URL и городов, тем дольше будет идти парсинг. Если задача большая — запускайте её партиями.
              </p>
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

