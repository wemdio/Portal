'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  BookOpen,
  Upload,
  FileText,
  MessageSquare,
  Video,
  ShoppingBag,
  ScrollText,
  Layers,
  Search,
  Trash2,
  Loader2,
  Plus,
  Download,
  X,
  ChevronDown,
  AlertTriangle,
  Sparkles,
  Pencil,
  Save,
  Briefcase,
  Landmark,
} from 'lucide-react';
import type { KbCategory, KbDocument } from '@/lib/knowledgeBase/types';
import { KB_CATEGORIES } from '@/lib/knowledgeBase/types';

async function getToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? '';
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = await getToken();
  const res = await fetch(path, {
    ...opts,
    headers: { ...opts?.headers, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const CATEGORY_ICONS: Record<KbCategory | 'all', React.ElementType> = {
  all: Layers,
  sales_chats: MessageSquare,
  video_transcripts: Video,
  product_info: ShoppingBag,
  cases: Briefcase,
  client_chats: ScrollText,
  banks: Landmark,
  other: FileText,
};

const CATEGORY_LABELS: Record<KbCategory | 'all', string> = {
  all: 'Все',
  sales_chats: 'Переписки Сейлз',
  video_transcripts: 'Расшифровки встреч',
  product_info: 'О продукте',
  cases: 'Кейсы',
  client_chats: 'Рабочие чаты',
  banks: 'Банковские выписки',
  other: 'Другое',
};

type ViewMode = 'list' | 'upload' | 'manual' | 'detail';

export default function KnowledgeBasePage() {
  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<KbCategory | 'all'>('all');
  const [view, setView] = useState<ViewMode>('list');
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cat = activeCategory === 'all' ? '' : `&category=${activeCategory}`;
      const data = await apiFetch<{ documents: KbDocument[]; total: number }>(
        `/api/knowledge-base/documents?per_page=100${cat}`,
      );
      setDocs(data.documents);
      setTotal(data.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [activeCategory]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) { setSearchResults(null); return; }
    setSearchLoading(true);
    try {
      const data = await apiFetch<{ chunks: SearchResult[] }>(
        `/api/knowledge-base/search?q=${encodeURIComponent(searchQuery)}&limit=20`,
      );
      setSearchResults(data.chunks);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100">
            <BookOpen className="h-5 w-5 text-emerald-700" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">База знаний</h1>
            <p className="text-xs text-gray-500">
              {total} {docLabel(total)} &middot; Контекст для AI-инструментов
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ImportButton onDone={fetchDocs} />
          <button
            onClick={() => setView(view === 'upload' ? 'list' : 'upload')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-emerald-700"
          >
            <Upload className="h-3.5 w-3.5" />
            Загрузить файл
          </button>
          <button
            onClick={() => setView(view === 'manual' ? 'list' : 'manual')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50"
          >
            <Plus className="h-3.5 w-3.5" />
            Добавить текст
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* AI Brief */}
      <BriefPanel />

      {/* Upload / Manual forms */}
      {view === 'upload' && <UploadForm onDone={() => { setView('list'); fetchDocs(); }} onCancel={() => setView('list')} />}
      {view === 'manual' && <ManualForm onDone={() => { setView('list'); fetchDocs(); }} onCancel={() => setView('list')} />}

      {/* Search */}
      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
          <input
            type="text"
            placeholder="Поиск по базе знаний..."
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); if (!e.target.value.trim()) setSearchResults(null); }}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-3 text-xs text-gray-800 outline-none transition focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={searchLoading || !searchQuery.trim()}
          className="rounded-lg bg-gray-100 px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-50"
        >
          {searchLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Найти'}
        </button>
      </div>

      {/* Search results */}
      {searchResults !== null && (
        <div className="mb-4 space-y-2 rounded-xl border border-gray-200 bg-white p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-600">
              Результаты: {searchResults.length}
            </span>
            <button onClick={() => { setSearchResults(null); setSearchQuery(''); }} className="text-xs text-gray-400 hover:text-gray-600">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {searchResults.length === 0 && (
            <p className="py-4 text-center text-xs text-gray-400">Ничего не найдено</p>
          )}
          {searchResults.map((r, i) => (
            <div key={i} className="rounded-lg border border-gray-100 bg-gray-50 p-2.5">
              <div className="mb-1 flex items-center gap-2 text-[10px] text-gray-500">
                <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-700">
                  {CATEGORY_LABELS[r.category as KbCategory] ?? r.category}
                </span>
                <span>{r.document_title}</span>
              </div>
              <p className="text-xs leading-relaxed text-gray-700 line-clamp-3">{r.content}</p>
            </div>
          ))}
        </div>
      )}

      {/* Category tabs */}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {(['all', ...KB_CATEGORIES.map(c => c.value)] as const).map(cat => {
          const Icon = CATEGORY_ICONS[cat];
          const isActive = activeCategory === cat;
          return (
            <button
              key={cat}
              onClick={() => { setActiveCategory(cat); setSearchResults(null); }}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                isActive
                  ? 'bg-emerald-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              <Icon className="h-3 w-3" />
              {CATEGORY_LABELS[cat]}
            </button>
          );
        })}
      </div>

      {/* Document list */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
        </div>
      ) : docs.length === 0 ? (
        <EmptyState onUpload={() => setView('upload')} onManual={() => setView('manual')} />
      ) : (
        <div className="space-y-2">
          {docs.map(doc => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              onSelect={() => { setSelectedDoc(doc.id); setView('detail'); }}
              onDelete={async () => {
                await apiFetch(`/api/knowledge-base/documents/${doc.id}`, { method: 'DELETE' });
                fetchDocs();
              }}
            />
          ))}
        </div>
      )}

      {/* Document detail modal */}
      {view === 'detail' && selectedDoc && (
        <DocDetailModal docId={selectedDoc} onClose={() => { setView('list'); setSelectedDoc(null); }} />
      )}
    </div>
  );
}

/* ---------- Sub-components ---------- */

interface SearchResult {
  chunk_id: string;
  document_id: string;
  document_title: string;
  category: string;
  content: string;
  rank: number;
}

function docLabel(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return 'документ';
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'документа';
  return 'документов';
}

function EmptyState({ onUpload, onManual }: { onUpload: () => void; onManual: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-gray-50/50 py-16">
      <BookOpen className="mb-3 h-10 w-10 text-gray-300" />
      <p className="mb-1 text-sm font-medium text-gray-600">База знаний пуста</p>
      <p className="mb-4 text-xs text-gray-400">Загрузите переписки, расшифровки или документы</p>
      <div className="flex gap-2">
        <button
          onClick={onUpload}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-emerald-700"
        >
          <Upload className="h-3.5 w-3.5" />
          Загрузить файл
        </button>
        <button
          onClick={onManual}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Добавить текст
        </button>
      </div>
    </div>
  );
}

function DocumentCard({
  doc,
  onSelect,
  onDelete,
}: {
  doc: KbDocument;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const Icon = CATEGORY_ICONS[doc.category] ?? FileText;
  const meta = doc.metadata as Record<string, unknown>;
  const msgCount = meta?.message_count as number | undefined;

  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2.5 transition hover:border-gray-300 hover:shadow-sm">
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-50">
        <Icon className="h-4 w-4 text-emerald-600" />
      </div>
      <button onClick={onSelect} className="min-w-0 flex-1 text-left">
        <p className="truncate text-xs font-medium text-gray-800">{doc.title}</p>
        <div className="flex items-center gap-2 text-[10px] text-gray-400">
          <span className="rounded bg-gray-100 px-1.5 py-0.5 font-medium text-gray-500">
            {CATEGORY_LABELS[doc.category]}
          </span>
          <span>~{doc.token_count.toLocaleString()} токенов</span>
          {msgCount && <span>{msgCount} сообщ.</span>}
          <span>{new Date(doc.created_at).toLocaleDateString('ru-RU')}</span>
        </div>
      </button>
      <button
        onClick={async e => {
          e.stopPropagation();
          if (deleting) return;
          setDeleting(true);
          try { await onDelete(); } finally { setDeleting(false); }
        }}
        className="flex-shrink-0 rounded-lg p-1.5 text-gray-300 transition hover:bg-rose-50 hover:text-rose-500"
      >
        {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function UploadForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<KbCategory>('sales_chats');
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const handleFile = (f: File) => {
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ''));
  };

  const submit = async () => {
    if (!file) return;
    setUploading(true);
    setErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', title || file.name);
      fd.append('category', category);
      fd.append('description', description);
      const token = await getToken();
      const res = await fetch('/api/knowledge-base/documents', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="mb-4 space-y-3 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-800">Загрузка файла</h3>
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
      </div>

      <div
        ref={dropRef}
        onDragOver={e => { e.preventDefault(); dropRef.current?.classList.add('border-emerald-400', 'bg-emerald-50/50'); }}
        onDragLeave={() => dropRef.current?.classList.remove('border-emerald-400', 'bg-emerald-50/50')}
        onDrop={e => {
          e.preventDefault();
          dropRef.current?.classList.remove('border-emerald-400', 'bg-emerald-50/50');
          const f = e.dataTransfer.files[0];
          if (f) handleFile(f);
        }}
        onClick={() => fileRef.current?.click()}
        className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-gray-200 px-4 py-6 transition hover:border-emerald-400"
      >
        <input ref={fileRef} type="file" accept=".csv,.txt,.md" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
        {file ? (
          <div className="flex items-center gap-2 text-xs text-gray-600">
            <FileText className="h-4 w-4 text-emerald-600" />
            <span>{file.name}</span>
            <span className="text-gray-400">({(file.size / 1024).toFixed(1)} KB)</span>
          </div>
        ) : (
          <>
            <Upload className="h-6 w-6 text-gray-300" />
            <p className="text-xs text-gray-500">Перетащите CSV или текстовый файл сюда</p>
            <p className="text-[10px] text-gray-400">CSV, TXT, MD</p>
          </>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-[10px] font-medium text-gray-500">Название</label>
          <input value={title} onChange={e => setTitle(e.target.value)} className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-emerald-400" placeholder="Название документа" />
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-medium text-gray-500">Категория</label>
          <CategorySelect value={category} onChange={setCategory} />
        </div>
      </div>
      <div>
        <label className="mb-1 block text-[10px] font-medium text-gray-500">Описание</label>
        <input value={description} onChange={e => setDescription(e.target.value)} className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-emerald-400" placeholder="Краткое описание (опционально)" />
      </div>

      {err && <p className="text-xs text-rose-600">{err}</p>}

      <button
        onClick={submit}
        disabled={!file || uploading}
        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50"
      >
        {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        {uploading ? 'Загрузка...' : 'Загрузить и обработать'}
      </button>
    </div>
  );
}

function ManualForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<KbCategory>('product_info');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    setErr('');
    try {
      await apiFetch('/api/knowledge-base/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, category, description, content_text: content }),
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-4 space-y-3 rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-800">Добавить текст</h3>
        <button onClick={onCancel} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-[10px] font-medium text-gray-500">Название</label>
          <input value={title} onChange={e => setTitle(e.target.value)} className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-emerald-400" placeholder="Например: Описание продукта" />
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-medium text-gray-500">Категория</label>
          <CategorySelect value={category} onChange={setCategory} />
        </div>
      </div>
      <div>
        <label className="mb-1 block text-[10px] font-medium text-gray-500">Описание</label>
        <input value={description} onChange={e => setDescription(e.target.value)} className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-emerald-400" placeholder="Краткое описание (опционально)" />
      </div>
      <div>
        <label className="mb-1 block text-[10px] font-medium text-gray-500">Содержимое</label>
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={8}
          className="w-full resize-y rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs leading-relaxed outline-none focus:border-emerald-400"
          placeholder="Вставьте текст: описание продукта, скрипт продаж, FAQ, расшифровку встречи..."
        />
        {content && (
          <p className="mt-1 text-[10px] text-gray-400">~{Math.ceil(content.length / 4).toLocaleString()} токенов</p>
        )}
      </div>

      {err && <p className="text-xs text-rose-600">{err}</p>}

      <button
        onClick={submit}
        disabled={!title.trim() || !content.trim() || saving}
        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50"
      >
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
        {saving ? 'Сохранение...' : 'Сохранить'}
      </button>
    </div>
  );
}

function CategorySelect({ value, onChange }: { value: KbCategory; onChange: (v: KbCategory) => void }) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value as KbCategory)}
        className="w-full appearance-none rounded-lg border border-gray-200 px-2.5 py-1.5 pr-7 text-xs outline-none focus:border-emerald-400"
      >
        {KB_CATEGORIES.map(c => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-2 h-3 w-3 text-gray-400" />
    </div>
  );
}

function ImportButton({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const doImport = async (source: 'audio_transcripts' | 'tg_video_transcripts') => {
    setLoading(source);
    setResult(null);
    try {
      const data = await apiFetch<{ imported: number }>('/api/knowledge-base/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      setResult(`Импортировано: ${data.imported}`);
      if (data.imported > 0) onDone();
    } catch (e) {
      setResult(`Ошибка: ${e instanceof Error ? e.message : 'Unknown'}`);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50"
      >
        <Download className="h-3.5 w-3.5" />
        Импорт
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 w-64 rounded-xl border border-gray-200 bg-white p-2 shadow-lg">
          <button
            onClick={() => doImport('audio_transcripts')}
            disabled={!!loading}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
          >
            {loading === 'audio_transcripts' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
            Расшифровки аудио/видео
          </button>
          <button
            onClick={() => doImport('tg_video_transcripts')}
            disabled={!!loading}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
          >
            {loading === 'tg_video_transcripts' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Video className="h-3.5 w-3.5" />}
            Видео из Telegram
          </button>
          {result && <p className="mt-1 px-2.5 text-[10px] text-gray-500">{result}</p>}
        </div>
      )}
    </div>
  );
}

function DocDetailModal({ docId, onClose }: { docId: string; onClose: () => void }) {
  const [doc, setDoc] = useState<KbDocument | null>(null);
  const [chunks, setChunks] = useState<{ id: string; chunk_index: number; content: string; token_count: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const data = await apiFetch<{ document: KbDocument; chunks: typeof chunks }>(
          `/api/knowledge-base/documents/${docId}`,
        );
        setDoc(data.document);
        setChunks(data.chunks);
      } catch { /* ignore */ }
      finally { setLoading(false); }
    })();
  }, [docId]);

  if (loading) {
    return (
      <ModalOverlay onClose={onClose}>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
        </div>
      </ModalOverlay>
    );
  }

  if (!doc) {
    return (
      <ModalOverlay onClose={onClose}>
        <p className="py-8 text-center text-xs text-gray-400">Документ не найден</p>
      </ModalOverlay>
    );
  }

  const Icon = CATEGORY_ICONS[doc.category] ?? FileText;

  return (
    <ModalOverlay onClose={onClose}>
      <div className="flex items-center justify-between border-b border-gray-100 pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50">
            <Icon className="h-4 w-4 text-emerald-600" />
          </div>
          <div>
            <h3 className="text-sm font-medium text-gray-800">{doc.title}</h3>
            <div className="flex items-center gap-2 text-[10px] text-gray-400">
              <span>{CATEGORY_LABELS[doc.category]}</span>
              <span>&middot;</span>
              <span>{doc.token_count.toLocaleString()} токенов</span>
              <span>&middot;</span>
              <span>{chunks.length} чанков</span>
            </div>
          </div>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <X className="h-4 w-4" />
        </button>
      </div>

      {doc.description && (
        <p className="mt-3 text-xs text-gray-500">{doc.description}</p>
      )}

      <div className="mt-4 space-y-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Чанки ({chunks.length})</h4>
        <div className="max-h-[50vh] space-y-2 overflow-auto pr-1">
          {chunks.map(c => (
            <div key={c.id} className="rounded-lg border border-gray-100 bg-gray-50 p-2.5">
              <div className="mb-1 flex items-center justify-between text-[10px] text-gray-400">
                <span>#{c.chunk_index + 1}</span>
                <span>{c.token_count} tok</span>
              </div>
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-gray-700">{c.content}</p>
            </div>
          ))}
        </div>
      </div>
    </ModalOverlay>
  );
}

function BriefPanel() {
  const [brief, setBrief] = useState('');
  const [tokenCount, setTokenCount] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const data = await apiFetch<{ brief: string; token_count: number; updated_at: string | null }>(
          '/api/knowledge-base/brief',
        );
        setBrief(data.brief);
        setTokenCount(data.token_count);
        setUpdatedAt(data.updated_at);
      } catch { /* ignore */ }
      finally { setLoading(false); }
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const data = await apiFetch<{ token_count: number }>(
        '/api/knowledge-base/brief',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ brief: editText }),
        },
      );
      setBrief(editText);
      setTokenCount(data.token_count);
      setUpdatedAt(new Date().toISOString());
      setEditing(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  return (
    <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/50 p-3">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-2 text-left"
        >
          <Sparkles className="h-4 w-4 text-amber-600" />
          <span className="text-xs font-medium text-amber-800">
            AI Бриф компании
          </span>
          {tokenCount > 0 && (
            <span className="text-[10px] text-amber-500">
              {tokenCount} tok
              {updatedAt && ` \u00b7 ${new Date(updatedAt).toLocaleDateString('ru-RU')}`}
            </span>
          )}
          <ChevronDown className={`h-3 w-3 text-amber-400 transition ${collapsed ? '' : 'rotate-180'}`} />
        </button>
        {!editing && brief && (
          <button
            onClick={() => { setEditText(brief); setEditing(true); setCollapsed(false); }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-amber-700 transition hover:bg-amber-100"
          >
            <Pencil className="h-3 w-3" />
            Редактировать
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="mt-2">
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={editText}
                onChange={e => setEditText(e.target.value)}
                rows={10}
                className="w-full resize-y rounded-lg border border-amber-200 bg-white px-2.5 py-2 text-xs leading-relaxed text-gray-800 outline-none focus:border-amber-400"
              />
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-amber-500">
                  ~{Math.ceil(editText.length / 4).toLocaleString()} токенов
                </span>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => setEditing(false)}
                    className="rounded-md border border-gray-200 px-2.5 py-1 text-[10px] font-medium text-gray-600 hover:bg-gray-50"
                  >
                    Отмена
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="inline-flex items-center gap-1 rounded-md bg-amber-600 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                    Сохранить
                  </button>
                </div>
              </div>
            </div>
          ) : brief ? (
            <div className="max-h-48 overflow-auto rounded-lg bg-white/70 px-2.5 py-2">
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-gray-700">{brief}</p>
            </div>
          ) : (
            <p className="text-xs text-amber-600">
              Бриф пока не создан.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ModalOverlay({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="mx-4 w-full max-w-2xl rounded-2xl border border-gray-200 bg-white p-5 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
