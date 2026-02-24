'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ReglamentRenderer } from '@/components/ReglamentRenderer';
import { supabase } from '@/lib/supabaseClient';
import { useIsTma } from '@/lib/useIsTma';
import type { ReglamentDocument } from '@/types';
import { LegacyReglamentPage } from '@/app/reglament/page';

type ReglamentDocView = Pick<ReglamentDocument, 'title' | 'content' | 'updated_at' | 'published_at'>;

const dateFormatter = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' });

function formatDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

function isEmptyContent(content?: ReglamentDocument['content'] | null) {
  if (!content || content.type !== 'doc') return true;
  const nodes = content.content ?? [];
  if (nodes.length === 0) return true;
  if (nodes.length === 1) {
    const first = nodes[0] as { type?: string; content?: unknown[] };
    if (first.type === 'paragraph' && (!first.content || first.content.length === 0)) {
      return true;
    }
  }
  return false;
}

export default function ReglamentDocumentPage() {
  const isTma = useIsTma();
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;
  const [doc, setDoc] = useState<ReglamentDocView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    let isMounted = true;

    const loadDocument = async () => {
      setLoading(true);
      setError(null);
      const { data, error: loadError } = await supabase
        .from('reglament_documents')
        .select('title, content, updated_at, published_at')
        .eq('slug', slug)
        .eq('status', 'published')
        .single();

      if (!isMounted) return;

      if (loadError || !data) {
        setError('Документ не найден или не опубликован.');
        setLoading(false);
        return;
      }

      setDoc(data as ReglamentDocView);
      setLoading(false);
    };

    void loadDocument();
    return () => {
      isMounted = false;
    };
  }, [slug]);

  return (
    <div className={`max-w-5xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <div className="mb-6">
        <Link href="/reglament" className="text-sm font-medium text-blue-600 hover:text-blue-700">
          ← Все документы
        </Link>
      </div>

      {loading ? (
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500">
          Загрузка документа...
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">
          {error}
        </div>
      ) : doc ? (
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-2">{doc.title}</h1>
          <p className="text-xs text-gray-500 mb-6">
            Обновлено: {formatDate(doc.updated_at)} · Опубликовано: {formatDate(doc.published_at)}
          </p>
          {isEmptyContent(doc.content) ? <LegacyReglamentPage /> : <ReglamentRenderer content={doc.content} />}
        </div>
      ) : null}
    </div>
  );
}
