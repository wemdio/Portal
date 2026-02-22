'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { generateJSON } from '@tiptap/html';
import { supabase } from '@/lib/supabaseClient';
import { useIsTma } from '@/lib/useIsTma';
import { REGLAMENT_EXTENSIONS } from '@/lib/reglamentEditor';
import { LegacyReglamentPage } from '@/app/reglament/page';

export default function ImportLegacyReglamentPage() {
  const isTma = useIsTma();
  const legacyRootRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const handleImport = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setResult(null);

    const container = legacyRootRef.current?.querySelector('.reglament-content') as HTMLElement | null;
    if (!container) {
      setError('Не удалось найти legacy-контент для импорта.');
      setLoading(false);
      return;
    }

    const html = container.innerHTML;
    const json = generateJSON(html, REGLAMENT_EXTENSIONS);

    const now = new Date().toISOString();
    const { data, error: upsertError } = await supabase
      .from('reglament_documents')
      .upsert(
        {
          slug: 'reglament',
          title: 'Регламент',
          status: 'published',
          content: json,
          updated_at: now,
          published_at: now,
        },
        { onConflict: 'slug' }
      )
      .select('id')
      .single();

    if (upsertError || !data) {
      setError(upsertError?.message ?? 'Не удалось импортировать регламент.');
      setLoading(false);
      return;
    }

    setResult(`Импорт завершен. Документ: ${data.id}`);
    setLoading(false);
  };

  return (
    <div className={`max-w-5xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <div className="flex items-center justify-between gap-4 mb-6">
        <div>
          <Link href="/admin/reglament" className="text-sm font-medium text-blue-600 hover:text-blue-700">
            ← Назад к списку
          </Link>
          <h1 className={`${isTma ? 'text-xl' : 'text-3xl'} font-bold text-gray-900 mt-2`}>
            Импорт legacy-регламента
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Импортирует текущую старую страницу регламента в новый документ (slug: <b>reglament</b>).
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-gray-600 mb-4">
          После импорта новая версия появится в пользовательском разделе. Повторный импорт обновит контент.
        </p>
        <button
          type="button"
          onClick={handleImport}
          disabled={loading}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60"
        >
          {loading ? 'Импорт...' : 'Импортировать регламент'}
        </button>
        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {result && (
          <div className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            {result}
          </div>
        )}
      </div>

      <div
        ref={legacyRootRef}
        style={{ position: 'absolute', left: '-99999px', top: 0, width: 1200, pointerEvents: 'none' }}
        aria-hidden="true"
      >
        <LegacyReglamentPage />
      </div>
    </div>
  );
}
