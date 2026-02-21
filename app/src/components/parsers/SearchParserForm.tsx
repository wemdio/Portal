
'use client';

import { useRef, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';

interface Props {
  onStart: (brief: string) => void;
  busy: boolean;
}

export function SearchParserForm({ onStart, busy }: Props) {
  const [brief, setBrief] = useState('');
  const [pdfUploading, setPdfUploading] = useState(false);
  const [pdfStatus, setPdfStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  const handleStart = () => {
    if (!brief.trim()) {
      setError('Введите бриф или описание задачи.');
      return;
    }
    setError(null);
    onStart(brief.trim());
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Поиск Google/Yandex</h2>
        <p className="text-sm text-gray-500 mt-1">
          Сформируем 30 поисковых запросов автоматически и запустим парсинг.
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
            className="w-full min-h-[8rem] resize-y rounded-lg border border-gray-300 py-3 px-3 pb-4 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500 focus:outline-none focus-visible:outline-none"
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

        {error && (
          <div className="text-sm text-red-600 bg-red-50 p-3 rounded-lg">
            {error}
          </div>
        )}
        <div className="pt-2">
          <button
            onClick={handleStart}
            disabled={busy || !brief.trim()}
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
