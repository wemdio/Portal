'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Play, Sparkles, Trash2, Search } from 'lucide-react';
import { authFetch, authFetchJson, getAccessToken } from '@/lib/authFetch';

export type SearchParserStartPayload = {
  brief?: string;
  queries?: string[];
  /** Запросы текстом через запятую (или с новой строки) — на бэке разбиваются в массив. */
  queries_text?: string;
  /** Текст для отображения в истории (то, что ввёл пользователь). */
  user_query?: string;
  /** Глубина поиска: сколько страниц Google парсить на каждый запрос (1–30, по умолчанию 5). */
  search_depth?: number;
};

interface Props {
  onStart: (payload: SearchParserStartPayload) => void;
  busy: boolean;
}

export function SearchParserForm({ onStart, busy }: Props) {
  const [brief, setBrief] = useState('');
  const [queries, setQueries] = useState<string[]>([]);
  const [queriesText, setQueriesText] = useState('');
  const [generatingQueries, setGeneratingQueries] = useState(false);
  const [pdfUploading, setPdfUploading] = useState(false);
  const [pdfStatus, setPdfStatus] = useState<string | null>(null);
  const [searchDepth, setSearchDepth] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Сохранённый бриф с портала (/client/brief). Если есть — становится
  // дефолтным источником: клиенту не надо снова копировать/загружать
  // PDF. Тот же паттерн что в base-constructor и email-sequence-v2.
  //
  // ВАЖНО: savedBriefText и brief — независимые state'ы. brief хранит
  // ТОЛЬКО то что юзер ввёл/загрузил в режиме «Свой». savedBriefText —
  // что прилетело с портала. При переключении табов друг друга НЕ
  // перезаписываем, чтобы не терять ни один из источников. На submit
  // (handleGenerateQueries, handleStart) выбираем effectiveBrief по
  // текущему briefSource.
  const [savedBriefText, setSavedBriefText] = useState('');
  const [savedBriefAvailable, setSavedBriefAvailable] = useState(false);
  const [briefSource, setBriefSource] = useState<'saved' | 'custom'>('custom');
  const savedBriefLoaded = useRef(false);
  useEffect(() => {
    if (savedBriefLoaded.current) return;
    savedBriefLoaded.current = true;
    void (async () => {
      try {
        const res = await authFetchJson<{ compiled_brief_text?: string }>('/api/client/brief');
        const text = (res.compiled_brief_text ?? '').trim();
        if (text) {
          setSavedBriefText(text);
          setSavedBriefAvailable(true);
          setBriefSource('saved');
        }
      } catch { /* non-critical: leave defaults */ }
    })();
  }, []);

  // Effective brief text для отправки в /api/parsers/search/generate
  // (генерация запросов) и в onStart (запуск парсинга по брифу).
  const effectiveBrief = briefSource === 'saved' ? savedBriefText : brief;

  const handlePdfUpload = async (file: File) => {
    setPdfUploading(true);
    setError(null);
    setPdfStatus(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/brief-scoring/parse-pdf', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });
      if (!res.ok) throw new Error('Failed to parse PDF');
      const data = await res.json();
      if (data?.text) {
        setBrief(data.text);
        setPdfStatus(`PDF распознан (${data.pages ?? '—'} стр.)`);
      } else {
        throw new Error('Empty PDF text');
      }
    } catch {
      setError('Не удалось распознать PDF. Попробуйте другой файл.');
    } finally {
      setPdfUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleGenerateQueries = async () => {
    if (!effectiveBrief.trim()) {
      setGenerateError(
        briefSource === 'saved'
          ? 'Сохранённый бриф пуст — заполните его на странице «Бриф» или переключитесь на «Свой».'
          : 'Введите бриф или описание задачи.',
      );
      return;
    }
    setGenerateError(null);
    setGeneratingQueries(true);
    try {
      const res = await authFetch('/api/parsers/search/generate', {
        method: 'POST',
        body: JSON.stringify({ brief: effectiveBrief.trim() }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.error ?? `Ошибка ${res.status}`);
      }
      const data = await res.json();
      const list = Array.isArray(data?.queries) ? data.queries.filter((q: unknown) => typeof q === 'string') : [];
      const cleanQuery = (s: string) =>
        s
          .trim()
          .replace(/"?\s*,?\s*$/, '')
          .trim();
      setQueries(list.map((q: string) => cleanQuery(String(q))).filter(Boolean));
    } catch (e) {
      setGenerateError(e instanceof Error ? e.message : 'Не удалось сгенерировать запросы.');
    } finally {
      setGeneratingQueries(false);
    }
  };

  const updateQuery = (index: number, value: string) => {
    setQueries((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const removeQuery = (index: number) => {
    setQueries((prev) => prev.filter((_, i) => i !== index));
  };

  const handleStart = () => {
    const hasBrief = effectiveBrief.trim().length > 0;
    const hasQueriesList = queries.length > 0 && queries.some((q) => q.trim().length > 0);
    const hasQueriesText = queriesText.trim().length > 0;

    if (!hasBrief && !hasQueriesList && !hasQueriesText) {
      setError('Введите бриф, сгенерируйте запросы или введите запросы вручную (через запятую).');
      return;
    }
    setError(null);

    const payload: SearchParserStartPayload = {};
    if (hasBrief) payload.brief = effectiveBrief.trim();
    if (hasQueriesText) payload.queries_text = queriesText.trim();
    if (hasQueriesList && !hasQueriesText) payload.queries = queries.map((q) => q.trim()).filter(Boolean);
    payload.user_query = payload.brief ?? payload.queries_text ?? (payload.queries?.slice(0, 3).join(', ') ?? 'Запросы');
    payload.search_depth = searchDepth;
    onStart(payload);
  };

  const canStart =
    (effectiveBrief.trim().length > 0 && (queries.length === 0 || queries.some((q) => q.trim().length > 0))) ||
    queriesText.trim().length > 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-6" style={{ borderTop: '3px solid #3B82F6' }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-blue-100 text-blue-600">
              <Search className="h-4 w-4" />
            </span>
            Поиск Google/Yandex
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Сгенерируйте запросы по брифу или вставьте свой список (один запрос на строку), затем запустите парсинг.
          </p>
        </div>
        <div className="shrink-0 text-right max-w-xs text-[11px] leading-4 text-gray-500">
          <button
            type="button"
            onClick={() => setShowHowItWorks(true)}
            className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800 border border-amber-200 hover:bg-amber-100 hover:border-amber-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-1"
          >
            <span className="mr-1">★</span>
            <span>Как работает парсер</span>
          </button>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Запросы вручную (один на строку или через запятую)
          </label>
          <textarea
            value={queriesText}
            onChange={(e) => setQueriesText(e.target.value)}
            placeholder={'веб-студия B2B портфолио site:ru\ndigital агентство корпоративные сайты B2B\nагентство разработки сайтов для производственных компаний'}
            className="w-full min-h-[12rem] resize-y rounded-lg border border-gray-300 py-2 px-3 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none focus-visible:outline-none font-mono placeholder:font-sans"
          />
          <p className="text-xs text-gray-500 mt-1">
            Вставьте список запросов: каждый с новой строки или через запятую. Пустые строки игнорируются.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Бриф / Описание целевой аудитории (для генерации запросов)
          </label>
          {/* Source switcher: «Сохранённый» (из /client/brief) vs «Свой».
              Отображается только когда сохранённый бриф доступен —
              иначе скрываем чтобы не запутывать. */}
          {savedBriefAvailable && (
            <div className="mb-2 flex gap-1 rounded-lg bg-gray-100 p-1 text-xs w-fit">
              <button
                type="button"
                onClick={() => setBriefSource('saved')}
                className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                  briefSource === 'saved'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Из сохранённого брифа
              </button>
              <button
                type="button"
                onClick={() => setBriefSource('custom')}
                className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
                  briefSource === 'custom'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                Свой
              </button>
            </div>
          )}

          {briefSource === 'saved' && savedBriefAvailable ? (
            <>
              <textarea
                value={savedBriefText}
                readOnly
                className="w-full min-h-[8rem] resize-y rounded-lg border border-gray-200 bg-gray-50 py-3 px-3 pb-4 text-sm text-gray-700"
              />
              <p className="text-xs text-gray-500 mt-1">
                Подгружен ваш бриф со{' '}
                <a href="/client/brief" className="underline">страницы «Бриф»</a>.
                Чтобы изменить — отредактируйте там, или переключитесь на «Свой».
              </p>
            </>
          ) : (
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              className="w-full min-h-[8rem] resize-y rounded-lg border border-gray-300 py-3 px-3 pb-4 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none focus-visible:outline-none"
              placeholder="Вставьте описание компании..."
            />
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handlePdfUpload(file);
              }}
            />
            {/* PDF-загрузку прячем в saved-mode: там бриф ридонли,
                загрузка туда не положит ничего. */}
            {briefSource === 'custom' && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={pdfUploading}
                className="inline-flex items-center rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-400 hover:shadow-sm disabled:opacity-50"
              >
                {pdfUploading ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : null}
                Загрузить PDF бриф
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleGenerateQueries()}
              disabled={generatingQueries || !brief.trim()}
              className="inline-flex items-center rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs font-medium text-violet-800 hover:bg-violet-100 hover:border-violet-300 disabled:opacity-50"
            >
              {generatingQueries ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-2" />}
              Сгенерировать запросы
            </button>
            {pdfStatus ? <span className="text-xs text-emerald-600">{pdfStatus}</span> : null}
          </div>
        </div>

        {generateError && (
          <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg">
            {generateError}
          </div>
        )}

        {queries.length > 0 && (
          <div className="rounded-lg border border-gray-200 bg-gray-50/50 overflow-hidden">
            <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">Сгенерированные запросы ({queries.length})</span>
            </div>
            <ul className="max-h-[320px] overflow-y-auto divide-y divide-gray-100">
              {queries.map((q, index) => (
                <li key={index} className="flex items-center gap-2 px-4 py-2 bg-white hover:bg-gray-50/80">
                  <span className="text-xs text-gray-400 shrink-0 w-7 tabular-nums">{index + 1}.</span>
                  <input
                    type="text"
                    value={q}
                    onChange={(e) => updateQuery(index, e.target.value)}
                    className="flex-1 min-w-0 rounded border border-gray-200 py-1.5 px-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                    placeholder="Поисковый запрос"
                  />
                  <button
                    type="button"
                    onClick={() => removeQuery(index)}
                    className="shrink-0 p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"
                    title="Удалить запрос"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Глубина поиска (страниц Google на запрос)
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={30}
              value={searchDepth}
              onChange={(e) => setSearchDepth(Number(e.target.value))}
              className="flex-1 h-2 accent-blue-600"
            />
            <span className="text-sm font-mono font-semibold text-gray-900 w-8 text-center tabular-nums">{searchDepth}</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            По умолчанию: 5. Чем больше — тем глубже поиск, но дольше выполнение.
          </p>
        </div>

        {error && (
          <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg">
            {error}
          </div>
        )}
        <div className="pt-2">
          <button
            onClick={handleStart}
            disabled={busy || !canStart}
            className="w-full inline-flex items-center justify-center px-4 py-3 border border-transparent text-sm font-semibold rounded-xl shadow-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="animate-spin h-5 w-5 mr-2" />
            ) : (
              <Play className="h-5 w-5 mr-2" />
            )}
            Запустить парсинг
          </button>
        </div>
      </div>

      {showHowItWorks && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl">
            <div className="px-6 py-5 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">Как работает парсер поисковой выдачи</h3>
            </div>
            <div className="px-6 py-4 space-y-3 text-sm text-gray-700">
              <p>
                Парсер берёт <span className="font-semibold">список запросов</span> и для каждого запроса
                проходит несколько страниц выдачи Google/Yandex — это&nbsp;
                <span className="font-semibold">глубина поиска</span>.
              </p>
              <p>
                Внутри каждой страницы он находит сайты потенциальных компаний, фильтрует мусор
                (каталоги, статьи, обзоры) и пытается выделить именно <span className="font-semibold">компанию</span>:
                название, сайт, описание.
              </p>
              <p>
                Поэтому итоговое число компаний примерно равно:&nbsp;
                <span className="font-semibold">количество запросов × глубина поиска</span>.
                Если вы сделали 3 запроса и глубина 5, то парсится всего ~15 страниц выдачи — это нормально,
                что получается до нескольких десятков компаний.
              </p>
              <p>
                Чтобы получить <span className="font-semibold">больше выдачи</span>:
              </p>
              <ul className="list-disc list-inside space-y-1 text-sm text-gray-700">
                <li>добавьте больше запросов (вариации формулировок, другие ключевые слова);</li>
                <li>увеличьте глубину поиска (ползунок) — больше страниц Google на каждый запрос;</li>
                <li>избегайте слишком общих запросов вроде «маркетинговое агентство» без уточнений.</li>
              </ul>
              <p className="text-xs text-gray-500 pt-1">
                Больше глубина = больше результатов, но дольше время парсинга.
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
    </div>
  );
}
