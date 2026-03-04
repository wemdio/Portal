'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useIsTma } from '@/lib/useIsTma';
import type { ReglamentDocument } from '@/types';

type ArchiveItem = Pick<
  ReglamentDocument,
  'id' | 'title' | 'slug' | 'status' | 'summary' | 'updated_at' | 'published_at' | 'delete_at'
>;

const dateFormatter = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });

function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

export default function AdminReglamentArchivePage() {
  const isTma = useIsTma();
  const [documents, setDocuments] = useState<ArchiveItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  useEffect(() => {
    const loadDocuments = async () => {
      setLoading(true);
      setError(null);
      const { data, error: loadError } = await supabase
        .from('reglament_documents')
        .select('id, title, slug, status, summary, updated_at, published_at, delete_at')
        .not('delete_at', 'is', null)
        .order('delete_at', { ascending: true });

      if (loadError) {
        setError(`Не удалось загрузить архив: ${loadError.message}`);
        setLoading(false);
        return;
      }

      setDocuments((data ?? []) as ArchiveItem[]);
      setLoading(false);
    };

    void loadDocuments();
  }, []);

  const handleRestore = async (doc: ArchiveItem) => {
    setRestoringId(doc.id);
    setError(null);
    const { error: updateError } = await supabase
      .from('reglament_documents')
      .update({ delete_at: null, updated_at: new Date().toISOString() })
      .eq('id', doc.id);
    setRestoringId(null);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setDocuments((prev) => prev.filter((item) => item.id !== doc.id));
  };

  return (
    <div className={`max-w-6xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <div className="mb-6">
        <Link href="/admin/reglament" className="text-sm font-medium text-blue-600 hover:text-blue-700">
          ← Назад к регламентам
        </Link>
      </div>

      <div className="mb-6">
        <h1 className={`${isTma ? 'text-xl' : 'text-3xl'} font-bold text-gray-900`}>Архив регламентов</h1>
        <p className="text-sm text-gray-500 mt-2">
          Документы в архиве будут безвозвратно удалены через неделю после перемещения. Восстановите документ, чтобы вернуть его в список.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500">
          Загрузка архива...
        </div>
      ) : documents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-white p-8 text-sm text-gray-500">
          В архиве нет документов.
        </div>
      ) : (
        <div className="space-y-4">
          {documents.map((doc) => (
            <div
              key={doc.id}
              className="rounded-xl border border-amber-200 bg-amber-50/30 p-5 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h3 className="text-lg font-semibold text-gray-900 truncate" title={doc.title}>
                    {doc.title}
                  </h3>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      doc.status === 'published'
                        ? 'bg-green-100 text-green-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {doc.status === 'published' ? 'Опубликован' : 'Черновик'}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRestore(doc)}
                    disabled={restoringId === doc.id}
                    className="cursor-pointer rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:opacity-60"
                  >
                    {restoringId === doc.id ? 'Восстановление...' : 'Восстановить'}
                  </button>
                  <Link
                    href={`/admin/reglament/${doc.id}`}
                    className="cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-300 focus:ring-offset-1"
                  >
                    Редактировать
                  </Link>
                </div>
              </div>
              {doc.summary && <p className="mt-3 text-sm text-gray-600">{doc.summary}</p>}
              <div className="mt-3 text-xs text-gray-500">
                Обновлено: {formatDate(doc.updated_at)} · Опубликовано: {formatDate(doc.published_at)} ·{' '}
                <span className="text-amber-700 font-medium">
                  Будет удалён: {formatDate(doc.delete_at)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
