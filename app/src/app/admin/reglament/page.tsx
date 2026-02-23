'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { useIsTma } from '@/lib/useIsTma';
import { createReglamentSlug, DEFAULT_REGLAMENT_CONTENT } from '@/lib/reglamentEditor';
import type { ReglamentDocument } from '@/types';

type ReglamentListItem = Pick<
  ReglamentDocument,
  'id' | 'title' | 'slug' | 'status' | 'summary' | 'updated_at' | 'published_at'
>;

const dateFormatter = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });

function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

export default function AdminReglamentPage() {
  const isTma = useIsTma();
  const router = useRouter();
  const [documents, setDocuments] = useState<ReglamentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const filteredDocuments = useMemo(() => {
    if (!query.trim()) return documents;
    const lower = query.trim().toLowerCase();
    return documents.filter((doc) => doc.title.toLowerCase().includes(lower));
  }, [documents, query]);

  const loadDocuments = async () => {
    setLoading(true);
    setError(null);
    const { data, error: loadError } = await supabase
      .from('reglament_documents')
      .select('id, title, slug, status, summary, updated_at, published_at')
      .order('updated_at', { ascending: false });

    if (loadError) {
      setError(`Не удалось загрузить документы: ${loadError.message}`);
      setLoading(false);
      return;
    }

    const items = (data ?? []) as ReglamentListItem[];
    setDocuments(items);

    setLoading(false);
  };

  useEffect(() => {
    setTimeout(() => {
      void loadDocuments();
    }, 0);
  }, []);

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    const now = new Date().toISOString();
    const baseSlug = createReglamentSlug('Новый документ') || 'document';
    const slug = `${baseSlug}-${Date.now()}`;

    const { data, error: createError } = await supabase
      .from('reglament_documents')
      .insert({
        title: 'Новый документ',
        slug,
        status: 'draft',
        content: DEFAULT_REGLAMENT_CONTENT,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    setCreating(false);

    if (createError || !data) {
      setError(createError?.message ?? 'Не удалось создать документ');
      return;
    }

    router.push(`/admin/reglament/${data.id}`);
  };

  const togglePublish = async (doc: ReglamentListItem) => {
    const nextStatus = doc.status === 'published' ? 'draft' : 'published';
    const now = new Date().toISOString();

    if (nextStatus === 'published') {
      const { data: publishedDocs, error: publishedError } = await supabase
        .from('reglament_documents')
        .select('id, title')
        .eq('status', 'published')
        .neq('id', doc.id)
        .limit(1);

      if (publishedError) {
        setError(`Не удалось проверить опубликованные документы: ${publishedError.message}`);
        return;
      }

      if (publishedDocs && publishedDocs.length > 0) {
        const already = publishedDocs[0] as { id: string; title: string };
        setError(`Уже опубликован регламент «${already.title}». Сначала снимите его с публикации.`);
        return;
      }
    }

    const { error: updateError } = await supabase
      .from('reglament_documents')
      .update({
        status: nextStatus,
        updated_at: now,
        published_at: nextStatus === 'published' ? now : null,
      })
      .eq('id', doc.id);

    if (updateError) {
      setError(`Не удалось обновить документ: ${updateError.message}`);
      return;
    }

    setDocuments((prev) =>
      prev.map((item) =>
        item.id === doc.id
          ? { ...item, status: nextStatus, updated_at: now, published_at: nextStatus === 'published' ? now : null }
          : item
      )
    );
  };

  return (
    <div className={`max-w-6xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <div className="mb-6">
        <Link href="/admin" className="text-sm font-medium text-blue-600 hover:text-blue-700">
          ← Назад в админку
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className={`${isTma ? 'text-xl' : 'text-3xl'} font-bold text-gray-900`}>Регламенты</h1>
          <p className="text-sm text-gray-500 mt-2">
            Управление документами, публикацией и содержимым регламентов
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-60"
          >
            {creating ? 'Создание...' : 'Создать документ'}
          </button>
          <button
            type="button"
            onClick={loadDocuments}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Обновить
          </button>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Поиск по названию..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full md:w-96 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        <Link
          href="/reglament"
          className="text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          Открыть пользовательский раздел →
        </Link>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500">
          Загрузка документов...
        </div>
      ) : filteredDocuments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-white p-8 text-sm text-gray-500">
          Документы не найдены.
        </div>
      ) : (
        <div className="space-y-4">
          {filteredDocuments.map((doc) => (
            <div
              key={doc.id}
              className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition hover:border-blue-200 hover:shadow-md"
            >
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{doc.title}</h3>
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
                    onClick={() => togglePublish(doc)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    {doc.status === 'published' ? 'Снять с публикации' : 'Опубликовать'}
                  </button>
                  <Link
                    href={`/admin/reglament/${doc.id}`}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
                  >
                    Редактировать
                  </Link>
                  <Link
                    href={`/reglament/${doc.slug}`}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                  >
                    Просмотр
                  </Link>
                </div>
              </div>
              {doc.summary && <p className="mt-3 text-sm text-gray-600">{doc.summary}</p>}
              <div className="mt-3 text-xs text-gray-500">
                Обновлено: {formatDate(doc.updated_at)} · Опубликовано: {formatDate(doc.published_at)}
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
