'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { CITIES, RUBRICS, generateSearchUrls } from '@/lib/parsers/yandexMapsData';
import { Switch } from '@/components/Switch';

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
  const [maxResults, setMaxResults] = useState(1000);
  const [headless, setHeadless] = useState(true);

  const [proxy, setProxy] = useState<ProxyForm>({
    enabled: false,
    protocol: 'http',
    host: '',
    port: '',
    username: '',
    password: '',
  });

  const [singleCity, setSingleCity] = useState('');
  const [singleKeyword, setSingleKeyword] = useState('');

  const [selectedCities, setSelectedCities] = useState<string[]>([]);
  const [selectedRubrics, setSelectedRubrics] = useState<string[]>([]);
  const [customKeyword, setCustomKeyword] = useState('');

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

  const handleGenerateSingle = () => {
    const city = singleCity.trim();
    const keyword = singleKeyword.trim();
    if (!keyword) return;
    const query = `${city} ${keyword}`.trim();
    const url = `https://yandex.ru/maps/?text=${encodeURIComponent(query)}`;
    appendUrls([url]);
  };

  const handleGenerateBulk = () => {
    const cities = selectedCities.map((s) => s.trim()).filter(Boolean);
    const rubrics = (customKeyword.trim() ? [customKeyword.trim()] : selectedRubrics).map((s) => s.trim()).filter(Boolean);
    if (!cities.length || !rubrics.length) return;
    appendUrls(generateSearchUrls(cities, rubrics));
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const urls = searchUrls;
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
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-gray-900">URL поиска</h3>
              <p className="text-sm text-gray-500 mt-1">Добавьте ссылки на поиск в Яндекс.Картах вручную или сгенерируйте их.</p>
            </div>
            <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-700/10">
              {searchUrls.length} URL
            </span>
          </div>
        </div>
        
        <div className="p-5 space-y-5">
          <textarea
            className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none text-sm font-mono min-h-[120px] p-3"
            placeholder="https://yandex.ru/maps/?text=Москва%20Кафе"
            value={searchUrlsText}
            onChange={(e) => setSearchUrlsText(e.target.value)}
          />

          <div className="bg-gray-50 rounded-lg p-4 border border-gray-100">
            <label className="block text-xs font-medium text-gray-700 mb-2 uppercase tracking-wider">Быстрое добавление</label>
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="w-full sm:w-1/3">
                <input
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none sm:text-sm px-3 py-2"
                  placeholder="Город (опц.)"
                  value={singleCity}
                  onChange={(e) => setSingleCity(e.target.value)}
                />
              </div>
              <div className="w-full sm:w-1/3">
                <input
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none sm:text-sm px-3 py-2"
                  placeholder="Ключевое слово (напр. кафе)"
                  value={singleKeyword}
                  onChange={(e) => setSingleKeyword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleGenerateSingle())}
                />
              </div>
              <button
                type="button"
                onClick={handleGenerateSingle}
                disabled={!singleKeyword}
                className="w-full sm:w-auto inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Добавить
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Generator Section */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-gray-100 bg-gray-50/50">
          <h3 className="text-base font-semibold text-gray-900">Генератор ссылок</h3>
          <p className="text-sm text-gray-500 mt-1">Массовая генерация ссылок по городам и рубрикам.</p>
        </div>
        
        <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">Города</label>
            <MultiSelect
              options={CITIES}
              value={selectedCities}
              onChange={setSelectedCities}
              className="h-60 shadow-sm focus-within:ring-1 focus-within:ring-blue-500 focus-within:border-blue-500"
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
                className={`h-32 shadow-sm focus-within:ring-1 focus-within:ring-blue-500 focus-within:border-blue-500 ${Boolean(customKeyword.trim()) ? 'bg-gray-50 opacity-60' : ''}`}
              />
            </div>

            <button
              type="button"
              onClick={handleGenerateBulk}
              disabled={!selectedCities.length || (!customKeyword.trim() && !selectedRubrics.length)}
              className="w-full inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Сгенерировать и добавить
            </button>
          </div>
        </div>
      </div>

      {/* Settings Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
          <h3 className="text-base font-semibold text-gray-900 border-b border-gray-100 pb-2">Параметры сбора</h3>
          
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Макс. ссылок на 1 URL</label>
              <input
                type="number"
                min={1}
                max={5000}
                className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none sm:text-sm px-3 py-2"
                value={maxResults}
                onChange={(e) => setMaxResults(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))}
              />
            </div>
            
            <div className="pt-2">
              <Switch
                checked={headless}
                onCheckedChange={setHeadless}
                label={<span className="font-medium text-gray-700">Headless режим (скрытый браузер)</span>}
              />
              <p className="text-xs text-gray-500 mt-1 ml-14">Отключите для отладки, если парсер не работает.</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-gray-100 pb-2">
            <h3 className="text-base font-semibold text-gray-900">Прокси</h3>
            <Switch
              checked={proxy.enabled}
              onCheckedChange={(enabled) => setProxy((p) => ({ ...p, enabled }))}
              label="Вкл"
            />
          </div>

          <div className={`space-y-3 transition-opacity duration-200 ${proxy.enabled ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-1">
                <label className="block text-xs font-medium text-gray-500 mb-1">Протокол</label>
                <select
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none text-sm"
                  value={proxy.protocol}
                  onChange={(e) => setProxy((p) => ({ ...p, protocol: e.target.value as ProxyForm['protocol'] }))}
                >
                  <option value="http">http</option>
                  <option value="https">https</option>
                  <option value="socks5">socks5</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-1">Host</label>
                <input
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none text-sm px-3 py-2"
                  placeholder="1.2.3.4"
                  value={proxy.host}
                  onChange={(e) => setProxy((p) => ({ ...p, host: e.target.value }))}
                />
              </div>
            </div>
            
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Port</label>
              <input
                className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none text-sm px-3 py-2"
                placeholder="8080"
                value={proxy.port}
                onChange={(e) => setProxy((p) => ({ ...p, port: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Username</label>
                <input
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none text-sm px-3 py-2"
                  placeholder="user"
                  value={proxy.username}
                  onChange={(e) => setProxy((p) => ({ ...p, username: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Password</label>
                <input
                  type="password"
                  className="block w-full rounded-lg border-gray-300 shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none text-sm px-3 py-2"
                  placeholder="pass"
                  value={proxy.password}
                  onChange={(e) => setProxy((p) => ({ ...p, password: e.target.value }))}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex justify-end pt-4">
        <button
          type="submit"
          disabled={props.busy || searchUrls.length === 0}
          className="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-6 py-3 text-base font-medium text-white shadow-sm hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform active:scale-95"
        >
          {props.busy ? 'Создание...' : 'Создать задачу'}
        </button>
      </div>
    </form>
  );
}

