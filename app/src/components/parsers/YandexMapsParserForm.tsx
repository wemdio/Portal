'use client';

import { useMemo, useState } from 'react';
import { CITIES, RUBRICS, generateSearchUrls } from '@/lib/parsers/yandexMapsData';

type ProxyForm = {
  enabled: boolean;
  protocol: 'http' | 'https' | 'socks5';
  host: string;
  port: string;
  username: string;
  password: string;
};

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

  const onSubmit = async (e: React.FormEvent) => {
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
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-gray-900">URL поиска</div>
            <div className="text-xs text-gray-500 mt-0.5">По одному URL в строке (можно несколько).</div>
          </div>
          <div className="text-xs text-gray-500">{searchUrls.length} URL</div>
        </div>

        <textarea
          className="w-full h-28 rounded-md border border-gray-300 p-2 text-sm font-mono"
          placeholder="https://yandex.ru/maps/?text=Москва%20Кафе"
          value={searchUrlsText}
          onChange={(e) => setSearchUrlsText(e.target.value)}
        />

        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <input
            className="rounded-md border border-gray-300 p-2 text-sm"
            placeholder="Город (опц.)"
            value={singleCity}
            onChange={(e) => setSingleCity(e.target.value)}
          />
          <input
            className="rounded-md border border-gray-300 p-2 text-sm md:col-span-2"
            placeholder="Ключевое слово (например: кафе)"
            value={singleKeyword}
            onChange={(e) => setSingleKeyword(e.target.value)}
          />
          <button
            type="button"
            onClick={handleGenerateSingle}
            className="rounded-md bg-gray-900 text-white px-3 py-2 text-sm hover:bg-gray-800"
          >
            Добавить URL
          </button>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="text-sm font-medium text-gray-900">Генератор ссылок</div>
        <div className="text-xs text-gray-500">Выбери города и рубрики (или задай своё ключевое слово) и добавь URL в список.</div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <div className="text-xs font-medium text-gray-700">Города</div>
            <select
              multiple
              className="w-full h-44 rounded-md border border-gray-300 p-2 text-sm"
              value={selectedCities}
              onChange={(e) => {
                const values = Array.from(e.target.selectedOptions).map((o) => o.value);
                setSelectedCities(values);
              }}
            >
              {Object.entries(CITIES).map(([group, cities]) => (
                <optgroup key={group} label={group}>
                  {cities.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <div className="space-y-1">
              <div className="text-xs font-medium text-gray-700">Своё ключевое слово (если заполнено — рубрики игнорируются)</div>
              <input
                className="w-full rounded-md border border-gray-300 p-2 text-sm"
                placeholder="Например: автосервис"
                value={customKeyword}
                onChange={(e) => setCustomKeyword(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <div className="text-xs font-medium text-gray-700">Рубрики</div>
              <select
                multiple
                className="w-full h-32 rounded-md border border-gray-300 p-2 text-sm"
                value={selectedRubrics}
                onChange={(e) => {
                  const values = Array.from(e.target.selectedOptions).map((o) => o.value);
                  setSelectedRubrics(values);
                }}
                disabled={Boolean(customKeyword.trim())}
              >
                {Object.entries(RUBRICS).map(([group, rubrics]) => (
                  <optgroup key={group} label={group}>
                    {rubrics.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={handleGenerateBulk}
              className="rounded-md bg-blue-600 text-white px-3 py-2 text-sm hover:bg-blue-500"
            >
              Сгенерировать и добавить URL
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="text-sm font-medium text-gray-900">Параметры</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1">
            <div className="text-xs font-medium text-gray-700">Макс. ссылок на 1 URL</div>
            <input
              type="number"
              min={1}
              max={5000}
              className="w-full rounded-md border border-gray-300 p-2 text-sm"
              value={maxResults}
              onChange={(e) => setMaxResults(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} />
            Headless (скрытый браузер)
          </label>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-gray-900">Прокси</div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={proxy.enabled}
              onChange={(e) => setProxy((p) => ({ ...p, enabled: e.target.checked }))}
            />
            Использовать
          </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <select
            className="rounded-md border border-gray-300 p-2 text-sm"
            value={proxy.protocol}
            onChange={(e) => setProxy((p) => ({ ...p, protocol: e.target.value as ProxyForm['protocol'] }))}
            disabled={!proxy.enabled}
          >
            <option value="http">http</option>
            <option value="https">https</option>
            <option value="socks5">socks5</option>
          </select>
          <input
            className="rounded-md border border-gray-300 p-2 text-sm"
            placeholder="host"
            value={proxy.host}
            onChange={(e) => setProxy((p) => ({ ...p, host: e.target.value }))}
            disabled={!proxy.enabled}
          />
          <input
            className="rounded-md border border-gray-300 p-2 text-sm"
            placeholder="port"
            value={proxy.port}
            onChange={(e) => setProxy((p) => ({ ...p, port: e.target.value }))}
            disabled={!proxy.enabled}
          />
          <div />
          <input
            className="rounded-md border border-gray-300 p-2 text-sm md:col-span-2"
            placeholder="username (опц.)"
            value={proxy.username}
            onChange={(e) => setProxy((p) => ({ ...p, username: e.target.value }))}
            disabled={!proxy.enabled}
          />
          <input
            className="rounded-md border border-gray-300 p-2 text-sm md:col-span-2"
            placeholder="password (опц.)"
            value={proxy.password}
            onChange={(e) => setProxy((p) => ({ ...p, password: e.target.value }))}
            disabled={!proxy.enabled}
          />
        </div>
      </div>

      <div className="flex items-center justify-end">
        <button
          type="submit"
          disabled={props.busy || searchUrls.length === 0}
          className="rounded-md bg-green-600 text-white px-4 py-2 text-sm font-medium hover:bg-green-500 disabled:opacity-60"
        >
          Создать запуск
        </button>
      </div>
    </form>
  );
}

