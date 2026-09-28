'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText, Loader2, Trash2, Upload } from 'lucide-react';

import { authFetch, getAccessToken } from '@/lib/authFetch';
import { ACCEPTED_EXTENSIONS } from '@/lib/tgOutreach/firstTouch/attachments';

/**
 * Файлы к первому сообщению базы (28.09.2026).
 *
 * Контакт получает файл из колонки «картинка»/«файл» своей строки таблицы;
 * колонка пустая — файл, отмеченный «для всех»; иначе сообщение уходит текстом.
 * Файл и текст — одно сообщение: текст идёт подписью под файлом.
 */

const API_BASE = '/api/tools/tg-outreach';

interface Attachment {
  id: string;
  file_name: string;
  size_bytes: number;
  kind: 'photo' | 'document';
  is_default: boolean;
  pending_contacts: number;
  preview_url: string | null;
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

export function BaseAttachmentsPanel({ baseId, baseName }: { baseId: string; baseName: string }) {
  const [files, setFiles] = useState<Attachment[] | null>(null);
  const [missing, setMissing] = useState<Array<{ name: string; contacts: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await authFetch(`${API_BASE}/bases/${baseId}/attachments`);
    const d = (await res.json().catch(() => null)) as { attachments?: Attachment[]; missing?: Array<{ name: string; contacts: number }>; error?: string } | null;
    if (!res.ok) {
      setError(d?.error ?? `Не удалось загрузить файлы (${res.status})`);
      return;
    }
    setFiles(d?.attachments ?? []);
    setMissing(d?.missing ?? []);
  }, [baseId]);

  useEffect(() => { void load(); }, [load]);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true); setError(null);
    try {
      const token = await getAccessToken();
      for (const file of Array.from(list)) {
        const form = new FormData();
        form.append('file', file);
        // Первый файл базы сразу «для всех»: чаще всего картинка одна на всю базу.
        if (!files?.length && list.length === 1) form.append('is_default', '1');
        const res = await fetch(`${API_BASE}/bases/${baseId}/attachments`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(`${file.name}: ${d?.error ?? `ошибка загрузки (${res.status})`}`);
          break;
        }
      }
      await load();
    } finally { setBusy(false); }
  };

  const setDefault = async (f: Attachment) => {
    setBusy(true); setError(null);
    try {
      const res = await authFetch(`${API_BASE}/bases/${baseId}/attachments/${f.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_default: !f.is_default }),
      });
      if (!res.ok) setError(`Не удалось сохранить (${res.status})`);
      await load();
    } finally { setBusy(false); }
  };

  const remove = async (f: Attachment) => {
    const warn = f.pending_contacts > 0
      ? `\n\nФайл указан у ${f.pending_contacts} ожидающих контактов — они не уйдут, пока файл не загрузят снова.`
      : '';
    if (!confirm(`Удалить «${f.file_name}»?${warn}`)) return;
    setBusy(true); setError(null);
    try {
      const res = await authFetch(`${API_BASE}/bases/${baseId}/attachments/${f.id}`, { method: 'DELETE' });
      if (!res.ok) setError(`Не удалось удалить (${res.status})`);
      await load();
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2 border-t border-gray-100 bg-gray-50 px-4 py-3">
      <div className="text-[11px] font-medium text-gray-700">Файлы к первому сообщению — база «{baseName}»</div>
      <p className="text-[10px] text-gray-500">
        Картинка (jpg, png, до 10 МБ) или документ (pdf, docx, xlsx, pptx, до 20 МБ) уходит одним сообщением
        с текстом под ним; текст с файлом — до 1024 знаков. Кому какой файл: в таблице базы колонка с
        заголовком «картинка» или «файл» и имя файла в ячейке (например, offer.jpg). У кого ячейка пустая —
        получат файл «для всех», если он отмечен, иначе только текст.
      </p>

      {missing.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          В таблице указаны файлы, которых нет среди загруженных — эти контакты не уйдут, пока файл не загрузят:{' '}
          {missing.map((m) => `«${m.name}» (${m.contacts})`).join(', ')}.
        </div>
      )}

      {files === null ? (
        <div className="flex items-center gap-1 text-[11px] text-gray-500"><Loader2 className="h-3 w-3 animate-spin" /> Загрузка…</div>
      ) : files.length === 0 ? (
        <div className="text-[11px] text-gray-500">Файлов нет — первое сообщение уходит текстом.</div>
      ) : (
        <ul className="space-y-1">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-2 py-1.5">
              {f.preview_url ? (
                // eslint-disable-next-line @next/next/no-img-element -- подписанная ссылка хранилища, оптимизатор Next её не возьмёт
                <img src={f.preview_url} alt="" className="h-8 w-8 rounded object-cover" />
              ) : (
                <FileText className="h-8 w-8 p-1.5 text-gray-400" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-gray-800">{f.file_name}</div>
                <div className="text-[10px] text-gray-500">
                  {f.kind === 'photo' ? 'картинка' : 'документ'} · {sizeLabel(f.size_bytes)}
                  {f.pending_contacts > 0 ? ` · указан у ${f.pending_contacts} ожидающих` : ''}
                </div>
              </div>
              <label className="flex items-center gap-1 text-[10px] text-gray-600 cursor-pointer" title="Файл получат контакты, у которых в таблице своего файла нет">
                <input type="checkbox" checked={f.is_default} disabled={busy} onChange={() => { void setDefault(f); }} />
                для всех
              </label>
              <button type="button" onClick={() => { void remove(f); }} disabled={busy} title="Удалить файл"
                className="p-1 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer disabled:opacity-50">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <label className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 transition cursor-pointer w-fit">
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />} Добавить файлы
        <input type="file" multiple accept={ACCEPTED_EXTENSIONS.join(',')} className="hidden" disabled={busy}
          onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
      </label>
      {error && <div className="text-[11px] text-rose-600">{error}</div>}

      <p className="text-[10px] text-gray-500">
        Разметка в тексте первого сообщения: <code>**жирный**</code>, <code>__курсив__</code>,{' '}
        <code>{'<u>подчёркнутый</u>'}</code>, <code>~~зачёркнутый~~</code>, <code>[текст](https://ссылка)</code>.
      </p>
    </div>
  );
}
