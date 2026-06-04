'use client';

import { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { tgOutreachFetch } from '@/lib/tgOutreach/fetcher';

interface Props {
  onClose: () => void;
  onCreated?: () => void | Promise<void>;
}

const PLACEHOLDER = `http://login:password@host:port
socks5://login:password@host:port
host:port:login:password
host:port@login:password
host:port`;

export function BulkPasteProxyModal({ onClose, onCreated }: Props) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ count: number; failed: string[] } | null>(null);

  const lineCount = text.split(/\r?\n/).filter((l) => l.trim()).length;

  const handleSubmit = async () => {
    if (!text.trim()) {
      setError('Вставьте строки с прокси');
      return;
    }
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const res = await tgOutreachFetch('/proxies/bulk-text', {
        method: 'POST',
        json: { text },
      }) as { count: number; failed: string[] };
      setResult(res);
      if (res.count > 0) await onCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-gray-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Массовая вставка прокси</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div>
            <label className="block text-sm text-gray-600 mb-1">
              Вставьте список прокси, по одной на строку. Поддерживаемые форматы:
            </label>
            <p className="text-xs text-gray-400 mb-2">
              http://логин:пароль@хост:порт &nbsp;·&nbsp; socks5://логин:пароль@хост:порт &nbsp;·&nbsp; хост:порт:логин:пароль &nbsp;·&nbsp; хост:порт@логин:пароль &nbsp;·&nbsp; хост:порт
            </p>
            <textarea
              value={text}
              onChange={(e) => { setText(e.target.value); setResult(null); }}
              placeholder={PLACEHOLDER}
              rows={12}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono resize-y focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
              autoFocus
            />
            {lineCount > 0 && (
              <p className="mt-1 text-xs text-gray-400">
                Строк с прокси: {lineCount}
              </p>
            )}
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          {result && (
            <div className="space-y-2">
              {result.count > 0 && (
                <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                  Добавлено прокси: {result.count}
                </div>
              )}
              {result.failed.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                  <p className="font-medium mb-1">Не удалось распознать ({result.failed.length}):</p>
                  <ul className="list-disc pl-4 space-y-0.5 font-mono text-xs">
                    {result.failed.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-100 px-6 py-4">
          {result?.count ? (
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Закрыть
            </button>
          ) : (
            <div />
          )}
          <button
            onClick={handleSubmit}
            disabled={saving || !text.trim()}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving ? 'Загрузка...' : `Загрузить${lineCount > 0 ? ` (${lineCount})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
