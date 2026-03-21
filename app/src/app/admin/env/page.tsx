'use client';

import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useIsTma } from '@/lib/useIsTma';
import {
  Save,
  Plus,
  Trash2,
  Search,
  Code,
  List,
  RefreshCw,
  AlertTriangle,
  Check,
  GripVertical,
  MessageSquare,
} from 'lucide-react';

interface EnvEntry {
  id: string;
  key: string;
  value: string;
  comment: boolean;
}

let nextEntryId = 0;
function genId() { return `e${++nextEntryId}`; }

function parseEnv(raw: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    if (trimmed.startsWith('#')) {
      const stripped = trimmed.slice(1).trim();
      const eqIdx = stripped.indexOf('=');
      if (eqIdx > 0 && /^[A-Z_][A-Z0-9_]*$/i.test(stripped.slice(0, eqIdx).trim())) {
        entries.push({ id: genId(), key: stripped.slice(0, eqIdx).trim(), value: stripped.slice(eqIdx + 1), comment: true });
      } else {
        entries.push({ id: genId(), key: trimmed, value: '', comment: true });
      }
      continue;
    }

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      entries.push({ id: genId(), key: trimmed.slice(0, eqIdx), value: trimmed.slice(eqIdx + 1), comment: false });
    } else {
      entries.push({ id: genId(), key: trimmed, value: '', comment: true });
    }
  }
  return entries;
}

function serializeEnv(entries: EnvEntry[]): string {
  return entries
    .map((e) => {
      if (e.comment) {
        if (e.value) return `# ${e.key}=${e.value}`;
        return e.key.startsWith('#') ? e.key : `# ${e.key}`;
      }
      return `${e.key}=${e.value}`;
    })
    .join('\n') + '\n';
}

export default function AdminEnvPage() {
  const isTma = useIsTma();
  const [rawContent, setRawContent] = useState('');
  const [entries, setEntries] = useState<EnvEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [rawMode, setRawMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [envPath, setEnvPath] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);

  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const flipPositions = useRef<Map<string, number>>(new Map());
  const flipActive = useRef(false);
  const dragIdRef = useRef<string | null>(null);
  const lastDragOverTime = useRef(0);
  const handleGrabbedRef = useRef(false);

  function capturePositions() {
    const map = new Map<string, number>();
    rowRefs.current.forEach((el, id) => {
      map.set(id, el.getBoundingClientRect().top);
    });
    flipPositions.current = map;
    flipActive.current = true;
  }

  useLayoutEffect(() => {
    if (!flipActive.current) return;
    flipActive.current = false;

    const oldPositions = flipPositions.current;
    const toAnimate: { el: HTMLDivElement; delta: number }[] = [];

    rowRefs.current.forEach((el, id) => {
      const oldTop = oldPositions.get(id);
      if (oldTop === undefined) return;
      const newTop = el.getBoundingClientRect().top;
      const delta = oldTop - newTop;
      if (Math.abs(delta) < 1) return;
      toAnimate.push({ el, delta });
    });

    for (const { el, delta } of toAnimate) {
      el.style.transition = 'none';
      el.style.transform = `translateY(${delta}px)`;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    document.body.offsetHeight;

    for (const { el } of toAnimate) {
      el.style.transition = 'transform 150ms ease';
      el.style.transform = '';
    }
  });

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token ?? null;
  }, []);

  const loadEnv = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const token = await getToken();
      if (!token) throw new Error('Not authenticated');
      const res = await fetch('/api/admin/env', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j?.error ?? res.statusText);
      }
      const data = await res.json() as { content: string; path: string };
      setRawContent(data.content);
      setEntries(parseEnv(data.content));
      setEnvPath(data.path);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => { void loadEnv(); }, [loadEnv]);

  const saveEnv = useCallback(async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const token = await getToken();
      if (!token) throw new Error('Not authenticated');
      const content = rawMode ? rawContent : serializeEnv(entries);
      const res = await fetch('/api/admin/env', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j?.error ?? 'Ошибка сохранения');
      }
      setSuccess('Файл .env сохранён');
      setDirty(false);
      setSaved(true);
      if (rawMode) {
        setEntries(parseEnv(rawContent));
      } else {
        setRawContent(serializeEnv(entries));
      }
      setTimeout(() => { setSuccess(''); setSaved(false); }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }, [getToken, rawMode, rawContent, entries]);

  const updateEntry = useCallback((id: string, field: 'key' | 'value', val: string) => {
    setEntries((prev) => prev.map((e) => e.id === id ? { ...e, [field]: val } : e));
    setDirty(true);
  }, []);

  const toggleComment = useCallback((id: string) => {
    setEntries((prev) => prev.map((e) => e.id === id ? { ...e, comment: !e.comment } : e));
    setDirty(true);
  }, []);

  const removeEntry = useCallback((id: string) => {
    capturePositions();
    setEntries((prev) => prev.filter((e) => e.id !== id));
    setDirty(true);
  }, []);

  const addEntry = useCallback(() => {
    setEntries((prev) => [...prev, { id: genId(), key: '', value: '', comment: false }]);
    setDirty(true);
  }, []);

  const addComment = useCallback(() => {
    setEntries((prev) => [...prev, { id: genId(), key: '# ', value: '', comment: true }]);
    setDirty(true);
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    if (!handleGrabbedRef.current) {
      e.preventDefault();
      return;
    }
    handleGrabbedRef.current = false;
    dragIdRef.current = id;
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, overIdx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const dragId = dragIdRef.current;
    if (!dragId) return;

    const now = Date.now();
    if (now - lastDragOverTime.current < 80) return;
    lastDragOverTime.current = now;

    setEntries((prev) => {
      const currentIdx = prev.findIndex((en) => en.id === dragId);
      if (currentIdx === -1 || currentIdx === overIdx) return prev;

      capturePositions();
      const next = [...prev];
      const [moved] = next.splice(currentIdx, 1);
      next.splice(overIdx, 0, moved);
      return next;
    });
  }, []);

  const handleDragEnd = useCallback(() => {
    dragIdRef.current = null;
    handleGrabbedRef.current = false;
    setDraggedId(null);
    setDirty(true);
  }, []);


  const filteredEntries = useMemo(() => {
    if (!searchQuery) return entries;
    const q = searchQuery.toLowerCase();
    return entries.filter((e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q));
  }, [entries, searchQuery]);

  const activeCount = useMemo(() => entries.filter((e) => !e.comment).length, [entries]);
  const commentCount = useMemo(() => entries.filter((e) => e.comment).length, [entries]);

  const switchMode = useCallback((toRaw: boolean) => {
    if (toRaw) {
      setRawContent(serializeEnv(entries));
    } else {
      setEntries(parseEnv(rawContent));
    }
    setRawMode(toRaw);
  }, [entries, rawContent]);

  const setRowRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);

  if (loading) {
    return (
      <div className={`max-w-6xl mx-auto px-4 ${isTma ? 'py-6' : 'py-10'}`}>
        <div className="flex items-center gap-3">
          <RefreshCw className="h-5 w-5 animate-spin text-blue-600" />
          <span className="text-gray-500">Загрузка .env...</span>
        </div>
      </div>
    );
  }

  const canDrag = !searchQuery;

  return (
    <div className={`max-w-6xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <div className="mb-6">
        <Link href="/admin" className="text-sm font-medium text-blue-600 hover:text-blue-700">
          ← Назад в админку
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className={`${isTma ? 'text-xl' : 'text-2xl'} font-bold text-gray-900`}>
            Переменные окружения
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            {envPath && <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{envPath}</code>}
            {' '}&mdash; {activeCount} активных, {commentCount} закомментированных
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => switchMode(false)}
            className={`px-3 py-1.5 text-sm rounded-l-lg border transition-colors ${
              !rawMode
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
          >
            <List className="h-4 w-4 inline mr-1" />
            Таблица
          </button>
          <button
            onClick={() => switchMode(true)}
            className={`px-3 py-1.5 text-sm rounded-r-lg border transition-colors ${
              rawMode
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
          >
            <Code className="h-4 w-4 inline mr-1" />
            Текст
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">
          {success}
        </div>
      )}

      {dirty && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          Есть несохранённые изменения
        </div>
      )}

      {rawMode ? (
        <div className="mb-6">
          <textarea
            value={rawContent}
            onChange={(e) => { setRawContent(e.target.value); setDirty(true); }}
            className="w-full h-[60vh] font-mono text-sm border border-gray-300 rounded-lg p-4 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-gray-50 resize-y"
            spellCheck={false}
          />
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Поиск по ключу или значению..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none"
              />
            </div>
            <button
              onClick={addEntry}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Переменная
            </button>
            <button
              onClick={addComment}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <MessageSquare className="h-4 w-4" />
              Комментарий
            </button>
          </div>

          <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
            {/* Header */}
            <div className="grid grid-cols-[32px_35%_1fr_72px] bg-gray-50 border-b border-gray-200 text-sm">
              <div />
              <div className="px-4 py-2.5 font-medium text-gray-600">Ключ</div>
              <div className="px-4 py-2.5 font-medium text-gray-600">Значение</div>
              <div className="px-4 py-2.5 font-medium text-gray-600 text-center">Действия</div>
            </div>

            {/* Rows */}
            {filteredEntries.map((entry, visualIdx) => {
              const isComment = entry.comment;
              const isPlainComment = isComment && !entry.value;
              const isDragging = draggedId === entry.id;

              return (
                <div
                  key={entry.id}
                  ref={(el) => setRowRef(entry.id, el)}
                  draggable={canDrag}
                  onDragStart={(e) => handleDragStart(e, entry.id)}
                  onDragOver={(e) => handleDragOver(e, visualIdx)}
                  onDragEnd={handleDragEnd}
                  className={`grid grid-cols-[32px_35%_1fr_72px] items-center border-b border-gray-100 last:border-b-0 ${
                    isDragging ? 'opacity-30 bg-blue-50' : ''
                  } ${isComment ? 'bg-gray-50/50' : 'hover:bg-blue-50/30'}`}
                >
                  {/* Drag handle */}
                  <div className="pl-2 py-2 flex items-center justify-center">
                    {canDrag && (
                      <div
                        onMouseDown={() => { handleGrabbedRef.current = true; }}
                        className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 transition-colors"
                      >
                        <GripVertical className="h-4 w-4" />
                      </div>
                    )}
                  </div>

                  {/* Key */}
                  <div className="px-4 py-2">
                    {isPlainComment ? (
                      <input
                        type="text"
                        value={entry.key}
                        onChange={(e) => updateEntry(entry.id, 'key', e.target.value)}
                        className="w-full font-mono text-xs px-2 py-1.5 border border-gray-200 rounded bg-gray-50 text-gray-500 italic focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
                        spellCheck={false}
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => toggleComment(entry.id)}
                          title={isComment ? 'Раскомментировать' : 'Закомментировать'}
                          className={`flex-shrink-0 w-2.5 h-2.5 rounded-full transition-colors ${
                            isComment ? 'bg-gray-300 hover:bg-emerald-400' : 'bg-emerald-500 hover:bg-gray-300'
                          }`}
                        />
                        <input
                          type="text"
                          value={entry.key}
                          onChange={(e) => updateEntry(entry.id, 'key', e.target.value)}
                          className={`w-full font-mono text-xs px-2 py-1.5 border border-gray-200 rounded focus:ring-1 focus:ring-blue-400 focus:border-blue-400 ${
                            isComment ? 'bg-gray-50 text-gray-400 line-through' : 'bg-white text-gray-900'
                          }`}
                          spellCheck={false}
                        />
                      </div>
                    )}
                  </div>

                  {/* Value */}
                  <div className="px-4 py-2">
                    {!isPlainComment && (
                      <input
                        type="text"
                        value={entry.value}
                        onChange={(e) => updateEntry(entry.id, 'value', e.target.value)}
                        className={`w-full font-mono text-xs px-2 py-1.5 border border-gray-200 rounded focus:ring-1 focus:ring-blue-400 focus:border-blue-400 ${
                          isComment ? 'bg-gray-50 text-gray-400' : 'bg-white text-gray-900'
                        }`}
                        spellCheck={false}
                      />
                    )}
                  </div>

                  {/* Actions */}
                  <div className="px-4 py-2 text-center">
                    <button
                      onClick={() => removeEntry(entry.id)}
                      className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                      title="Удалить"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}

            {filteredEntries.length === 0 && (
              <div className="px-4 py-8 text-center text-gray-400 text-sm">
                {searchQuery ? 'Ничего не найдено' : 'Файл .env пуст'}
              </div>
            )}
          </div>
        </>
      )}

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={saveEnv}
          disabled={saving || (!dirty && !saved)}
          className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            saved
              ? 'bg-emerald-600 text-white'
              : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed'
          }`}
        >
          {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
          {saving ? 'Сохранение...' : saved ? 'Сохранено' : 'Сохранить'}
        </button>
        <button
          onClick={loadEnv}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Перезагрузить
        </button>
      </div>
    </div>
  );
}
