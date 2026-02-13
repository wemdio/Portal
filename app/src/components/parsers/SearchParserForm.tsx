
'use client';

import { useRef, useState } from 'react';
import { Loader2, Sparkles, Play, Plus, Trash2, RefreshCcw } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';

interface Props {
  onStart: (queries: string[]) => void;
  busy: boolean;
}

export function SearchParserForm({ onStart, busy }: Props) {
  const [brief, setBrief] = useState('');
  const [generating, setGenerating] = useState(false);
  const [pdfUploading, setPdfUploading] = useState(false);
  const [pdfStatus, setPdfStatus] = useState<string | null>(null);
  const [queries, setQueries] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [regeneratingQueryIndex, setRegeneratingQueryIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const getAccessToken = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  };

  const handleGenerate = async () => {
    if (!brief.trim()) return;
    setGenerating(true);
    setError(null);
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
      if (!res.ok) throw new Error('Failed to generate queries');
      const data = await res.json();
      if (data.queries && Array.isArray(data.queries)) {
        setQueries(data.queries);
      }
    } catch {
      setError('Ошибка генерации запросов. Попробуйте еще раз.');
    } finally {
      setGenerating(false);
    }
  };

  const handleRegenerateQuery = async (index: number) => {
    if (!brief.trim()) return;
    setRegeneratingQueryIndex(index);
    setError(null);
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
      if (!res.ok) throw new Error('Failed to regenerate query');
      const data = await res.json();
      if (data.queries && Array.isArray(data.queries) && data.queries.length > 0) {
        const newQuery = data.queries[0];
        const nextQueries = [...queries];
        nextQueries[index] = newQuery;
        setQueries(nextQueries);
      }
    } catch {
      setError('Ошибка перегенерации запроса. Попробуйте еще раз.');
    } finally {
      setRegeneratingQueryIndex(null);
    }
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

  const addQuery = () => {
    setQueries([...queries, '']);
  };

  const removeQuery = (index: number) => {
    setQueries(queries.filter((_, i) => i !== index));
  };

  const updateQuery = (index: number, value: string) => {
    const next = [...queries];
    next[index] = value;
    setQueries(next);
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Поиск Google/Yandex</h2>
        <p className="text-sm text-gray-500 mt-1">
          Генерация запросов на основе брифа и парсинг выдачи.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Бриф / Описание целевой аудитории
          </label>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            className="w-full min-h-[8rem] resize-y rounded-lg border border-gray-300 py-3 px-3 pb-4 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            placeholder="Вставьте описание компании, продукта или ЦА из брифа..."
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
            {pdfStatus ? <span className="text-xs text-emerald-600">{pdfStatus}</span> : null}
          </div>
        </div>

        <button
          onClick={handleGenerate}
          disabled={generating || !brief.trim()}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-lg shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
        >
          {generating ? (
            <Loader2 className="animate-spin h-4 w-4 mr-2" />
          ) : (
            <Sparkles className="h-4 w-4 mr-2" />
          )}
          Сгенерировать запросы (AI)
        </button>

        {error && (
          <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg">
            {error}
          </div>
        )}

        {queries.length > 0 && (
          <div className="space-y-3 pt-4 border-t border-gray-100">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-gray-700">
                Поисковые запросы ({queries.length})
              </label>
              <button
                onClick={addQuery}
                className="text-sm text-blue-600 hover:text-blue-800 flex items-center"
              >
                <Plus className="h-4 w-4 mr-1" />
                Добавить
              </button>
            </div>
            
            <div className="space-y-2">
              {queries.map((q, idx) => (
                <div key={idx} className="flex gap-2">
                  <button
                    onClick={() => handleRegenerateQuery(idx)}
                    disabled={generating || regeneratingQueryIndex === idx || !brief.trim()}
                    className="text-gray-400 hover:text-blue-500 p-2 disabled:opacity-50"
                    title="Перегенерировать запрос"
                  >
                    {regeneratingQueryIndex === idx ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCcw className="h-4 w-4" />
                    )}
                  </button>
                  <input
                    value={q}
                    onChange={(e) => updateQuery(idx, e.target.value)}
                    className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:ring-1 focus:ring-blue-500"
                  />
                  <button
                    onClick={() => removeQuery(idx)}
                    className="text-gray-400 hover:text-red-500 p-2"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>

            <div className="pt-4">
              <button
                onClick={() => onStart(queries.filter(q => q.trim()))}
                disabled={busy || queries.filter(q => q.trim()).length === 0}
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
        )}
      </div>
    </div>
  );
}
