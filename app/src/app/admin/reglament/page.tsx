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
  'id' | 'title' | 'slug' | 'status' | 'summary' | 'updated_at' | 'published_at' | 'delete_at'
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
  const [importing, setImporting] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirmDoc, setDeleteConfirmDoc] = useState<ReglamentListItem | null>(null);

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
      .select('id, title, slug, status, summary, updated_at, published_at, delete_at')
      .is('delete_at', null)
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

  const handleImportFromGoogleDoc = async () => {
    const url = importUrl.trim();
    if (!url || importing) return;
    setImporting(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setError('Необходима авторизация');
        setImporting(false);
        return;
      }
      const res = await fetch('/api/reglament/import-google-doc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error ?? 'Не удалось импортировать документ');
        setImporting(false);
        return;
      }
      setImportUrl('');
      router.push(json.redirectUrl ?? `/admin/reglament/${json.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка при импорте');
    } finally {
      setImporting(false);
    }
  };

  const togglePublish = async (doc: ReglamentListItem) => {
    const nextStatus = doc.status === 'published' ? 'draft' : 'published';
    const now = new Date().toISOString();

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

  const handleDeleteClick = (doc: ReglamentListItem) => {
    setDeleteConfirmDoc(doc);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirmDoc) return;
    setDeletingId(deleteConfirmDoc.id);
    setError(null);
    setDeleteConfirmDoc(null);
    const deleteAt = new Date();
    deleteAt.setDate(deleteAt.getDate() + 7);
    const { error: updateError } = await supabase
      .from('reglament_documents')
      .update({ delete_at: deleteAt.toISOString(), updated_at: new Date().toISOString() })
      .eq('id', deleteConfirmDoc.id);
    setDeletingId(null);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setDocuments((prev) => prev.filter((item) => item.id !== deleteConfirmDoc.id));
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
          <Link
            href="/admin/reglament/archive"
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Архив
          </Link>
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
      </div>

      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Импорт из Google Docs</h3>
        <p className="text-xs text-gray-500 mb-3">
          Вставьте ссылку на Google Doc. Документ должен быть доступен по ссылке (Файл → Поделиться → Доступ по ссылке).
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            type="url"
            placeholder="https://docs.google.com/document/d/..."
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleImportFromGoogleDoc()}
            className="flex-1 min-w-[200px] rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={handleImportFromGoogleDoc}
            disabled={importing || !importUrl.trim()}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
          >
            {importing ? 'Импорт...' : 'Импортировать'}
          </button>
        </div>
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
                    onClick={() => togglePublish(doc)}
                    className="cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-sm transition-all hover:border-gray-300 hover:bg-gray-50 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-gray-300 focus:ring-offset-1"
                  >
                    {doc.status === 'published' ? 'Снять с публикации' : 'Опубликовать'}
                  </button>
                  <Link
                    href={`/admin/reglament/${doc.id}`}
                    className="cursor-pointer rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-all hover:bg-blue-700 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
                  >
                    Редактировать
                  </Link>
                  <Link
                    href={`/reglament/${doc.slug}`}
                    className="cursor-pointer rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 shadow-sm transition-all hover:border-gray-300 hover:bg-gray-50 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-gray-300 focus:ring-offset-1"
                  >
                    Просмотр
                  </Link>
                  <button
                    type="button"
                    onClick={() => handleDeleteClick(doc)}
                    disabled={deletingId === doc.id}
                    title="Удалить документ"
                    className="cursor-pointer rounded-lg border border-red-200 bg-red-50/50 px-3 py-1.5 text-xs font-semibold text-red-600 shadow-sm transition-all hover:border-red-300 hover:bg-red-50 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {deletingId === doc.id ? 'Удаление...' : 'Удалить'}
                  </button>
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

      {deleteConfirmDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div
            className="absolute inset-0"
            onClick={() => setDeleteConfirmDoc(null)}
            aria-hidden="true"
          />
          <div className="relative w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Удалить документ?</h3>
            <p className="mt-2 text-sm text-gray-600">
              Документ «{deleteConfirmDoc.title}» будет перемещён в архив. Через неделю он будет удалён безвозвратно. Восстановить можно из архива.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeleteConfirmDoc(null)}
                className="cursor-pointer rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm transition-all hover:border-gray-300 hover:bg-gray-50 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-gray-300 focus:ring-offset-1"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={deletingId === deleteConfirmDoc.id}
                className="cursor-pointer rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:bg-red-700 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1 disabled:opacity-60 disabled:hover:shadow-sm"
              >
                {deletingId === deleteConfirmDoc.id ? 'Удаление...' : 'Удалить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
