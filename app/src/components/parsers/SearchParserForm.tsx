'use client';

import { useRef, useState } from 'react';
import { Loader2, Play, Sparkles, Trash2 } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';

export type SearchParserStartPayload = {
  brief?: string;
  queries?: string[];
  /** Запросы текстом через запятую (или с новой строки) — на бэке разбиваются в массив. */
  queries_text?: string;
  /** Текст для отображения в истории (то, что ввёл пользователь). */
  user_query?: string;
  /** Глубина поиска: сколько страниц Google парсить на каждый запрос (1–10, по умолчанию 5). */
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const getAccessToken = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  };

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
    if (!brief.trim()) {
      setGenerateError('Введите бриф или описание задачи.');
      return;
    }
    setGenerateError(null);
    setGeneratingQueries(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Not authenticated');
      const res = await fetch('/api/parsers/search/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ brief: brief.trim() }),
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
    const hasBrief = brief.trim().length > 0;
    const hasQueriesList = queries.length > 0 && queries.some((q) => q.trim().length > 0);
    const hasQueriesText = queriesText.trim().length > 0;

    if (!hasBrief && !hasQueriesList && !hasQueriesText) {
      setError('Введите бриф, сгенерируйте запросы или введите запросы вручную (через запятую).');
      return;
    }
    setError(null);

    const payload: SearchParserStartPayload = {};
    if (hasBrief) payload.brief = brief.trim();
    if (hasQueriesText) payload.queries_text = queriesText.trim();
    if (hasQueriesList && !hasQueriesText) payload.queries = queries.map((q) => q.trim()).filter(Boolean);
    payload.user_query = payload.brief ?? payload.queries_text ?? (payload.queries?.slice(0, 3).join(', ') ?? 'Запросы');
    payload.search_depth = searchDepth;
    onStart(payload);
  };

  const canStart =
    (brief.trim().length > 0 && (queries.length === 0 || queries.some((q) => q.trim().length > 0))) ||
    queriesText.trim().length > 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Поиск Google/Yandex</h2>
        <p className="text-sm text-gray-500 mt-1">
          Сгенерируйте запросы по брифу или вставьте свой список (один запрос на строку), затем запустите парсинг.
        </p>
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
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            className="w-full min-h-[8rem] resize-y rounded-lg border border-gray-300 py-3 px-3 pb-4 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none focus-visible:outline-none"
            placeholder="Вставьте описание компании..."
          />
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
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={pdfUploading}
              className="inline-flex items-center rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-400 hover:shadow-sm disabled:opacity-50"
            >
              {pdfUploading ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : null}
              Загрузить PDF бриф
            </button>
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
              max={10}
              value={searchDepth}
              onChange={(e) => setSearchDepth(Number(e.target.value))}
              className="flex-1 h-2 accent-blue-600"
            />
            <span className="text-sm font-mono font-semibold text-gray-900 w-6 text-center tabular-nums">{searchDepth}</span>
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
            className="w-full inline-flex items-center justify-center px-4 py-3 border border-transparent text-sm font-medium rounded-xl shadow-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
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
    </div>
  );
}
