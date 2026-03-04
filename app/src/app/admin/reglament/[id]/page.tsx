'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { JSONContent } from '@tiptap/core';
import { generateJSON } from '@tiptap/html';
import { ReglamentEditor } from '@/components/ReglamentEditor';
import { supabase } from '@/lib/supabaseClient';
import { useIsTma } from '@/lib/useIsTma';
import {
  DEFAULT_REGLAMENT_CONTENT,
  REGLAMENT_EXTENSIONS,
  REGLAMENT_STORAGE_BUCKET,
  REGLAMENT_STORAGE_PREFIX,
} from '@/lib/reglamentEditor';
import { wrapSectionsInBlocks } from '@/lib/wrapSectionsInBlocks';
import type { ReglamentDocument, ReglamentStatus } from '@/types';
import { LegacyReglamentPage } from '@/app/reglament/page';

type ReglamentDocState = Pick<
  ReglamentDocument,
  'id' | 'title' | 'slug' | 'status' | 'summary' | 'content' | 'created_at' | 'updated_at' | 'published_at'
>;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const dateFormatter = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });

function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

export default function AdminReglamentEditPage() {
  const isTma = useIsTma();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const docId = params?.id;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<ReglamentStatus>('draft');
  const [content, setContent] = useState<JSONContent>(DEFAULT_REGLAMENT_CONTENT);
  const [metadata, setMetadata] = useState<ReglamentDocState | null>(null);
  const initialRef = useRef<ReglamentDocState | null>(null);
  const legacyRootRef = useRef<HTMLDivElement>(null);
  const scaleContainerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const legacyImportedRef = useRef(false);

  const canPublish = useMemo(() => title.trim().length > 0, [title]);
  const dirty = useMemo(() => {
    if (!metadata) return false;
    const contentSerialized = JSON.stringify(content ?? DEFAULT_REGLAMENT_CONTENT);
    const baselineSerialized = JSON.stringify((metadata.content ?? DEFAULT_REGLAMENT_CONTENT) as JSONContent);
    return title !== (metadata.title ?? '') || status !== metadata.status || contentSerialized !== baselineSerialized;
  }, [content, metadata, status, title]);

  useEffect(() => {
    if (!docId) return;
    let isMounted = true;

    const loadDocument = async () => {
      setLoading(true);
      setError(null);

      const { data, error: loadError } = await supabase
        .from('reglament_documents')
        .select('id, title, slug, status, content, created_at, updated_at, published_at')
        .eq('id', docId)
        .single();

      if (!isMounted) return;

      if (loadError || !data) {
        setError(loadError?.message ?? 'Не удалось загрузить документ');
        setLoading(false);
        return;
      }

      const docData = data as ReglamentDocState;
      setMetadata(docData);
      setTitle(docData.title ?? '');
      setStatus(docData.status ?? 'draft');
      let loadedContent = (docData.content ?? DEFAULT_REGLAMENT_CONTENT) as JSONContent;
      if (
        loadedContent?.type === 'doc' &&
        loadedContent?.content?.length &&
        !JSON.stringify(loadedContent).includes('sectionBlock')
      ) {
        loadedContent = wrapSectionsInBlocks(loadedContent);
      }
      setContent(loadedContent);
      initialRef.current = docData;
      setLoading(false);
    };

    void loadDocument();
    return () => {
      isMounted = false;
    };
  }, [docId]);

  useEffect(() => {
    if (!metadata || legacyImportedRef.current) return;
    if (metadata.slug !== 'reglament') return;

    const importLegacy = () => {
      const nodes = content?.content ?? [];
      const isEmptyDoc =
        !content ||
        content.type !== 'doc' ||
        nodes.length === 0 ||
        (nodes.length === 1 &&
          (nodes[0] as { type?: string; content?: unknown[] }).type === 'paragraph' &&
          (!(nodes[0] as { content?: unknown[] }).content ||
            (nodes[0] as { content?: unknown[] }).content?.length === 0));
      const isLegacyStructureMissing = !JSON.stringify(content ?? {}).includes('sectionBlock');
      const isFresh = metadata.created_at && metadata.updated_at && metadata.created_at === metadata.updated_at;
      if (!isEmptyDoc && !isLegacyStructureMissing) return;
      if (!isFresh && !isEmptyDoc) return;
      const container = legacyRootRef.current?.querySelector('.reglament-content') as HTMLElement | null;
      if (!container) return;
      const json = generateJSON(container.innerHTML, REGLAMENT_EXTENSIONS);
      legacyImportedRef.current = true;
      setContent(json as JSONContent);
    };

    importLegacy();
  }, [content, metadata]);

  useEffect(() => {
    const container = scaleContainerRef.current;
    if (!container) return;
    const baseWidth = 1400;
    const minScale = 0.85;

    const updateScale = () => {
      const width = container.clientWidth;
      if (!width) return;
      if (window.innerWidth < 768) {
        setScale(1);
        return;
      }
      const nextScale = Math.min(1, Math.max(minScale, width / baseWidth));
      setScale(Number(nextScale.toFixed(3)));
    };

    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(container);
    window.addEventListener('resize', updateScale);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateScale);
    };
  }, []);

  const handleSave = async (nextStatus?: ReglamentStatus) => {
    if (!docId || !metadata) return;
    setSaving(true);
    setError(null);
    setSaveMessage(null);

    const now = new Date().toISOString();
    const finalStatus = nextStatus ?? status;
    const publishedAt = finalStatus === 'published' ? (metadata?.published_at ?? now) : null;

    const trimmedTitle = title.trim() || 'Без названия';
    const { error: updateError } = await supabase
      .from('reglament_documents')
      .update({
        title: trimmedTitle,
        slug: metadata.slug,
        status: finalStatus,
        content,
        updated_at: now,
        published_at: publishedAt,
      })
      .eq('id', docId);

    setSaving(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    const updated: ReglamentDocState = {
      id: docId,
      title: trimmedTitle,
      slug: metadata?.slug ?? 'reglament',
      status: finalStatus,
      content,
      created_at: metadata?.created_at ?? now,
      updated_at: now,
      published_at: publishedAt,
    };
    setMetadata(updated);
    initialRef.current = updated;
    setStatus(finalStatus);
    setSaveMessage('Сохранено');
  };

  const handleDeleteClick = () => {
    setShowDeleteModal(true);
  };

  const handleDeleteConfirm = async () => {
    if (!docId || !metadata) return;
    setDeleting(true);
    setError(null);
    setShowDeleteModal(false);
    const { error: deleteError } = await supabase.from('reglament_documents').delete().eq('id', docId);
    setDeleting(false);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    router.push('/admin/reglament');
  };

  const handleUploadImage = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      throw new Error('Файл должен быть изображением');
    }
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error('Файл слишком большой (макс. 5MB)');
    }
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) {
      throw new Error('Необходима авторизация');
    }
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const uploadPath = `${REGLAMENT_STORAGE_PREFIX}/${userId}/${Date.now()}-${safeName}`;
    const { error: uploadError } = await supabase.storage
      .from(REGLAMENT_STORAGE_BUCKET)
      .upload(uploadPath, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || 'image/*',
      });

    if (uploadError) {
      throw new Error(`Не удалось загрузить изображение: ${uploadError.message}`);
    }

    const { data } = supabase.storage.from(REGLAMENT_STORAGE_BUCKET).getPublicUrl(uploadPath);
    if (!data?.publicUrl) {
      throw new Error('Не удалось получить публичный URL');
    }
    return data.publicUrl;
  };

  if (loading) {
    return (
      <div className="max-w-6xl mr-auto px-4 py-8 text-sm text-gray-500">
        Загрузка документа...
      </div>
    );
  }

  if (!metadata) {
    return (
      <div className="max-w-6xl mr-auto px-4 py-8 text-sm text-red-600">
        Документ не найден.
      </div>
    );
  }

  return (
    <div
      ref={scaleContainerRef}
      className={`w-full max-w-none px-3 sm:px-4 overflow-x-hidden ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}
    >
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-6">
        <div>
          <div className="flex items-center gap-3 text-sm text-gray-500">
            <Link href="/admin/reglament" className="text-blue-600 hover:text-blue-700">
              ← Назад
            </Link>
            <span>Обновлено: {formatDate(metadata.updated_at)}</span>
          </div>
          <h1 className={`${isTma ? 'text-xl' : 'text-3xl'} font-bold text-gray-900 mt-2`}>
            Редактирование регламента
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <Link
            href={`/reglament/${metadata.slug}`}
            className="w-full sm:w-auto cursor-pointer rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm transition-all hover:border-gray-300 hover:bg-gray-50 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-gray-300 focus:ring-offset-1"
          >
            Просмотр
          </Link>
          <button
            type="button"
            onClick={() => handleSave()}
            disabled={saving || !dirty}
            className="w-full sm:w-auto cursor-pointer rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:bg-blue-700 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:shadow-sm"
          >
            {saving ? 'Сохранение...' : dirty ? 'Сохранить' : 'Сохранено'}
          </button>
          <button
            type="button"
            onClick={() => handleSave(status === 'published' ? 'draft' : 'published')}
            disabled={saving || !canPublish}
            className="w-full sm:w-auto cursor-pointer rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm transition-all hover:border-gray-300 hover:bg-gray-50 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-gray-300 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {status === 'published' ? 'Снять с публикации' : 'Опубликовать'}
          </button>
          <button
            type="button"
            onClick={handleDeleteClick}
            disabled={deleting}
            title="Удалить документ"
            className="w-full sm:w-auto cursor-pointer rounded-lg border border-red-200 bg-red-50/50 px-4 py-2 text-sm font-semibold text-red-600 shadow-sm transition-all hover:border-red-300 hover:bg-red-50 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deleting ? 'Удаление...' : 'Удалить'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {saveMessage && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {saveMessage}
        </div>
      )}

      <div className="space-y-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <label className="block text-sm font-medium text-gray-700 mb-2">Название документа</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Введите название..."
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-200"
          />
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm text-sm text-gray-600">
          <div className="flex items-center justify-between">
            <span>Статус</span>
            <span className={status === 'published' ? 'text-green-700 font-semibold' : 'text-gray-500'}>
              {status === 'published' ? 'Опубликован' : 'Черновик'}
            </span>
          </div>
          <div className="mt-2 text-xs text-gray-500">
            Опубликовано: {formatDate(metadata.published_at)}
          </div>
        </div>

        <div>
          <ReglamentEditor
            content={content}
            onChange={setContent}
            onUploadImage={handleUploadImage}
            scale={scale}
          />
        </div>
      </div>

      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div
            className="absolute inset-0"
            onClick={() => setShowDeleteModal(false)}
            aria-hidden="true"
          />
          <div className="relative w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Удалить документ?</h3>
            <p className="mt-2 text-sm text-gray-600">
              Документ «{title || metadata?.title || 'Без названия'}» будет удалён. Это действие нельзя отменить.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                className="cursor-pointer rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-700 shadow-sm transition-all hover:border-gray-300 hover:bg-gray-50 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-gray-300 focus:ring-offset-1"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={deleting}
                className="cursor-pointer rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all hover:bg-red-700 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1 disabled:opacity-60 disabled:hover:shadow-sm"
              >
                {deleting ? 'Удаление...' : 'Удалить'}
              </button>
            </div>
          </div>
        </div>
      )}

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
